import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadNativeTickets } from "../src/factory/csv.js";
import { loadEnrichment } from "../src/factory/enrich.js";
import { MemoryJira } from "../src/jira/memory.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createWebhookServer, secretsMatch } from "../src/server.js";
import type { CloudLauncher } from "../src/sdk/types.js";
import { seedTicket, testConfig } from "./support.js";

test("webhook secret compare rejects a mismatch and accepts the shared secret", () => {
  assert.equal(secretsMatch("nope", "test-secret"), false);
  assert.equal(secretsMatch(undefined, "test-secret"), false);
  assert.equal(secretsMatch("", "test-secret"), false);
  assert.equal(secretsMatch("test-secret", "test-secret"), true);
  assert.equal(secretsMatch("test-secret", ""), false);
});

test("POST /intake and /remediate require the shared secret", async () => {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const ticket = tickets.find((item) => item.ref === "T08");
  assert.ok(ticket);
  const jira = new MemoryJira("JWF");
  await seedTicket(jira, ticket, "JWF-8");
  const launcher: CloudLauncher = { async launch() { throw new Error("not launched"); } };
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  const server = createWebhookServer({ orchestrator, webhookSecret: "test-secret" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    const denied = await fetch(`http://127.0.0.1:${address.port}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "wrong" },
      body: JSON.stringify({ issueKey: "JWF-8" }),
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`http://127.0.0.1:${address.port}/intake?wait=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "test-secret" },
      body: JSON.stringify({ issueKey: "JWF-8" }),
    });
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as { lane?: string };
    assert.equal(body.lane, "AGENT_PR_HUMAN_REVIEW");
    const bad = await fetch(`http://127.0.0.1:${address.port}/remediate?wait=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "test-secret" },
      body: JSON.stringify({ issueKey: "not-a-key" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
