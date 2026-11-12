import assert from "node:assert/strict";
import test from "node:test";
import { loadEnrichment } from "../src/factory/enrich.js";
import { MemoryJira } from "../src/jira/memory.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { CloudLaunchRequest, CloudLauncher, CloudLaunchResult } from "../src/sdk/types.js";
import { testConfig } from "./support.js";

class FakeLauncher implements CloudLauncher {
  readonly requests: CloudLaunchRequest[] = [];
  release: (() => void) | undefined;
  private gate: Promise<void>;
  constructor(private readonly hold: boolean) {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async launch(request: CloudLaunchRequest): Promise<CloudLaunchResult> {
    this.requests.push(request);
    if (this.hold) await this.gate;
    return {
      agentId: "bc-group",
      runId: "run-group",
      status: "finished",
      prUrl: "https://github.com/calwatson/payments-api/pull/4",
      branch: request.metadata.branch,
      resultText: "one group PR",
      statusLog: ["running", "finished"],
    };
  }
}

const DESCRIPTION = [
  "[SYNTHETIC DEMO DATA]",
  "Demo Ref: T03",
  "Wiz Issue ID: vf-0001",
  "Finding Type: Vulnerability",
  "Severity: HIGH",
  "Resource Name: payments-api (prod)",
  "Resource ID: k8s-payments-api-prod",
  "Cloud Account Name: acme-demo-prod",
  "Image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-demo/payments-api:1.4.2",
  "CVE: CVE-2021-23337",
  "Package: lodash",
  "Package Type: npm",
  "Installed Version: 4.17.20",
  "Fixed Version: 4.17.21",
  "Location: /app/node_modules/lodash/package.json",
].join("\n");

async function seeded(key: string, labels: string[], group: string): Promise<{ jira: MemoryJira; key: string }> {
  const jira = new MemoryJira("JWF");
  await jira.createIssue({
    key,
    summary: "[Wiz] lodash",
    description: DESCRIPTION,
    issueType: "Bug",
    priority: "High",
    labels,
    fields: {
      agentLane: "AUTO_MERGE_ELIGIBLE",
      correlationGroup: group,
      dedupKey: `key-${key}`,
      fixLocation: "acme-demo/payments-api:package.json",
      crossRepoKey: "",
      riskScore: 70,
      prUrl: "",
    },
  });
  await jira.transition(key, "Ready for Agent");
  return { jira, key };
}

test("auto-merge is requested only when every grouped ticket is autopilot", async () => {
  const alone = await seeded("JWF-1", ["wiz", "cursor-agent-autopilot"], "");
  const launcher = new FakeLauncher(false);
  const orchestrator = new Orchestrator(alone.jira, loadEnrichment("data"), launcher, testConfig());
  await orchestrator.remediate("JWF-1", false);
  assert.match(launcher.requests[0]?.prompt ?? "", /gh pr merge --auto/);

  const mixed = new MemoryJira("JWF");
  for (const [key, labels] of [
    ["JWF-2", ["wiz", "cursor-agent-autopilot"]],
    ["JWF-3", ["wiz", "cursor-agent"]],
  ] as const) {
    await mixed.createIssue({
      key,
      summary: "[Wiz] lodash",
      description: DESCRIPTION,
      issueType: "Bug",
      priority: "High",
      labels: [...labels],
      fields: {
        agentLane: key === "JWF-2" ? "AUTO_MERGE_ELIGIBLE" : "AGENT_PR_HUMAN_REVIEW",
        correlationGroup: "CG-lodash-4.17.21",
        dedupKey: key,
        fixLocation: "acme-demo/payments-api:package.json",
        crossRepoKey: "",
        riskScore: 70,
        prUrl: "",
      },
    });
    await mixed.transition(key, "Ready for Agent");
  }
  const mixedLauncher = new FakeLauncher(false);
  const mixedOrchestrator = new Orchestrator(mixed, loadEnrichment("data"), mixedLauncher, testConfig());
  await mixedOrchestrator.remediate("JWF-2", false);
  assert.equal(mixedLauncher.requests.length, 1);
  assert.match(mixedLauncher.requests[0]?.prompt ?? "", /Do not enable GitHub auto-merge/);
  assert.match(mixedLauncher.requests[0]?.prompt ?? "", /JWF-3/);
  const second = await mixedOrchestrator.remediate("JWF-3", false);
  assert.equal(mixedLauncher.requests.length, 1);
  assert.equal(second.prUrl, "https://github.com/calwatson/payments-api/pull/4");
});

test("one in-flight agent is shared by a correlation group", async () => {
  const jira = new MemoryJira("JWF");
  for (const key of ["JWF-5", "JWF-6"]) {
    await jira.createIssue({
      key,
      summary: "[Wiz] lodash",
      description: DESCRIPTION,
      issueType: "Bug",
      priority: "High",
      labels: ["wiz", "cursor-agent-autopilot"],
      fields: {
        agentLane: "AUTO_MERGE_ELIGIBLE",
        correlationGroup: "CG-lodash-4.17.21",
        dedupKey: key,
        fixLocation: "acme-demo/payments-api:package.json",
        crossRepoKey: "",
        riskScore: 70,
        prUrl: "",
      },
    });
    await jira.transition(key, "In Progress");
  }
  const launcher = new FakeLauncher(true);
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  const pending = Promise.all([orchestrator.remediate("JWF-5", false), orchestrator.remediate("JWF-6", false)]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(launcher.requests.length, 1);
  launcher.release?.();
  await pending;
  assert.equal(launcher.requests.length, 1);
  assert.equal((await jira.getIssue("JWF-5")).fields.prUrl, (await jira.getIssue("JWF-6")).fields.prUrl);
});
