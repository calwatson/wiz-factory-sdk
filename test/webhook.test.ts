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

test("request logs never include the webhook secret value", async () => {
  const secret = "webhook-secret-do-not-log-9f3a";
  const wrong = "other-secret-also-hidden-zz";
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const ticket = tickets.find((item) => item.ref === "T08");
  assert.ok(ticket);
  const jira = new MemoryJira("JWF");
  await seedTicket(jira, ticket, "JWF-8");
  const launcher: CloudLauncher = { async launch() { throw new Error("not launched"); } };
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const server = createWebhookServer({ orchestrator, webhookSecret: secret, logPayloads: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    const denied = await fetch(`http://127.0.0.1:${address.port}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": wrong },
      body: JSON.stringify({ issueKey: "JWF-8" }),
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`http://127.0.0.1:${address.port}/intake?wait=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify({ issueKey: "JWF-8" }),
    });
    assert.equal(accepted.status, 200);
  } finally {
    console.log = original;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  const output = lines.join("\n");
  const requestAt = output.indexOf('"method":"POST"');
  const authAt = output.indexOf('"auth":"401"');
  assert.ok(requestAt >= 0 && authAt > requestAt);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(wrong), false);
  assert.match(output, new RegExp(`"x-webhook-secret":"present len=${secret.length}"`));
  assert.match(output, new RegExp(`"x-webhook-secret":"present len=${wrong.length}"`));
  assert.match(output, /"method":"POST"/);
  assert.match(output, /"path":"\/intake\?wait=1"/);
  assert.match(output, /"body":"\{\\"issueKey\\":\\"JWF-8\\"\}"/);
  assert.match(output, /"auth":"401"/);
  assert.match(output, /"auth":"ok"/);
  assert.match(output, /"status":401/);
  assert.match(output, /"status":200/);

  const quiet: string[] = [];
  console.log = (...args: unknown[]) => {
    quiet.push(args.map((arg) => String(arg)).join(" "));
  };
  const silent = createWebhookServer({ orchestrator, webhookSecret: secret, logPayloads: false });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
  const silentAddress = silent.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${silentAddress.port}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify({ issueKey: "JWF-8" }),
    });
    assert.equal(response.status, 202);
  } finally {
    console.log = original;
    await new Promise<void>((resolve, reject) => silent.close((error) => (error ? reject(error) : resolve())));
  }
  assert.equal(quiet.join("\n").includes(secret), false);
  assert.equal(quiet.length, 0);
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
