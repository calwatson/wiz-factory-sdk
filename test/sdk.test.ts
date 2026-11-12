import assert from "node:assert/strict";
import test from "node:test";
import { cloudCreateOptions } from "../src/sdk/options.js";
import { pollUntilSettled } from "../src/sdk/poll.js";
import type { CloudLaunchRequest } from "../src/sdk/types.js";

function request(): CloudLaunchRequest {
  return {
    apiKey: "cursor_test",
    modelId: "composer-2.5",
    name: "Security JWF-8",
    idempotencyKey: "wiz-factory:calwatson/payments-api:JWF-8",
    repoUrl: "https://github.com/calwatson/payments-api",
    startingRef: "main",
    autoCreatePR: true,
    skipReviewerRequest: true,
    metadata: { jiraKey: "JWF-8", branch: "security/JWF-8-cve-2022-23540", synthetic: "true" },
    prompt: "fix",
    pollIntervalMs: 5,
    pollMaxMs: 15,
  };
}

test("cloud create options target a repo ref and do not attach MCP", () => {
  const options = cloudCreateOptions(request());
  assert.equal(options.apiKey, "cursor_test");
  assert.deepEqual(options.model, { id: "composer-2.5" });
  assert.equal(options.cloud?.autoCreatePR, true);
  assert.equal(options.cloud?.repos?.[0]?.startingRef, "main");
  assert.equal(options.cloud?.repos?.[0]?.url, "https://github.com/calwatson/payments-api");
  assert.equal(options.mcpServers, undefined);
  assert.equal(options.systemPrompt, undefined);
  assert.equal(options.local, undefined);
});

test("status polling returns the PR url and falls back to wait", async () => {
  const reads = ["running", "running", "finished"] as const;
  let cursor = 0;
  let now = 0;
  let waits = 0;
  const polled = await pollUntilSettled({
    read: async () => {
      const status = reads[cursor] ?? "finished";
      cursor += 1;
      return status === "finished"
        ? { status, prUrl: "https://github.com/calwatson/payments-api/pull/9", branch: "security/JWF-8-cve-2022-23540" }
        : { status };
    },
    waitForResult: async () => {
      waits += 1;
      return { status: "finished", prUrl: "https://github.com/calwatson/payments-api/pull/9" };
    },
    sleep: async (ms) => {
      now += ms;
    },
    intervalMs: 5,
    maxMs: 100,
    now: () => now,
  });
  assert.equal(polled.snapshot.prUrl, "https://github.com/calwatson/payments-api/pull/9");
  assert.deepEqual(polled.statusLog, ["running", "running", "finished"]);
  assert.equal(waits, 0);

  let clock = 0;
  let fallback = 0;
  const timedOut = await pollUntilSettled({
    read: async () => ({ status: "running" }),
    waitForResult: async () => {
      fallback += 1;
      return { status: "finished", prUrl: "https://github.com/calwatson/orders-service/pull/3", branch: "security/JWF-42-cve-2022-23540" };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    intervalMs: 5,
    maxMs: 10,
    now: () => clock,
  });
  assert.equal(fallback, 1);
  assert.equal(timedOut.snapshot.prUrl, "https://github.com/calwatson/orders-service/pull/3");
});
