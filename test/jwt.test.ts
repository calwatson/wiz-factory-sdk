import assert from "node:assert/strict";
import test from "node:test";
import { loadEnrichment } from "../src/factory/enrich.js";
import { MemoryJira } from "../src/jira/memory.js";
import { Orchestrator } from "../src/orchestrator.js";
import { runJwtScenario } from "../src/scenario.js";
import type { CloudLaunchRequest, CloudLauncher, CloudLaunchResult } from "../src/sdk/types.js";
import { testConfig } from "./support.js";

class FakeLauncher implements CloudLauncher {
  readonly requests: CloudLaunchRequest[] = [];
  async launch(request: CloudLaunchRequest): Promise<CloudLaunchResult> {
    this.requests.push(request);
    const repo = request.metadata.githubRepo ?? "repo";
    return {
      agentId: `bc-fake-${this.requests.length}`,
      runId: `run-fake-${this.requests.length}`,
      status: "finished",
      prUrl: `https://github.com/${repo}/pull/${this.requests.length}`,
      branch: request.metadata.branch,
      resultText: "bumped jsonwebtoken and pinned HS256",
      statusLog: ["running", "finished"],
    };
  }
}

test("jwt scenario creates one parent, duplicates T43, and opens two repo PRs", async () => {
  const jira = new MemoryJira("JWF");
  const launcher = new FakeLauncher();
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  const report = await runJwtScenario({ orchestrator, jira, dataDir: "data", dryRun: false });
  assert.equal(report.synthetic, true);
  assert.equal(report.issues.map((issue) => issue.ref).join(","), "T08,T42,T43");
  const byRef = new Map(report.issues.map((issue) => [issue.ref, issue.key]));
  const t08 = await jira.getIssue(byRef.get("T08") ?? "");
  const t42 = await jira.getIssue(byRef.get("T42") ?? "");
  const t43 = await jira.getIssue(byRef.get("T43") ?? "");
  assert.equal(t43.fields.agentLane, "DUPLICATE");
  assert.equal(t43.status, "Done");
  assert.equal(t08.fields.crossRepoKey, "vuln:cve-2022-23540:jsonwebtoken");
  assert.equal(t42.fields.crossRepoKey, "vuln:cve-2022-23540:jsonwebtoken");
  assert.equal(t43.fields.crossRepoKey, "");
  assert.ok(report.parentKey);
  assert.equal(t08.parentKey, report.parentKey);
  assert.equal(t42.parentKey, report.parentKey);
  assert.equal(t43.parentKey, "");
  const parent = await jira.getIssue(report.parentKey);
  assert.equal(parent.issueType, "Epic");
  assert.equal(parent.summary, "[Parent] CVE-2022-23540 in jsonwebtoken across 2 repos");
  assert.equal(parent.labels.includes("wiz"), false);
  assert.equal(parent.fields.agentLane, "PARENT_TRACKING");
  assert.equal(launcher.requests.length, 2);
  assert.deepEqual(
    launcher.requests.map((request) => request.repoUrl).sort(),
    ["https://github.com/calwatson/orders-service", "https://github.com/calwatson/payments-api"],
  );
  for (const request of launcher.requests) {
    assert.equal(request.autoCreatePR, true);
    assert.equal(request.metadata.branch?.startsWith("security/"), true);
    assert.match(request.prompt, /FAILS on the base branch before the fix/);
    assert.match(request.prompt, /Do not write to Jira/);
    assert.match(request.prompt, /Do not post to Slack/);
    assert.match(request.prompt, /Do not enable GitHub auto-merge/);
    assert.equal(request.prompt.includes("mcp"), false);
  }
  assert.equal(t08.fields.agentLane, "PR_OPEN");
  assert.equal(t08.status, "In Review");
  assert.match(t08.fields.prUrl, /payments-api\/pull\//);
  assert.equal(t42.status, "In Review");
  assert.match(t42.fields.prUrl, /orders-service\/pull\//);
  assert.equal(t08.comments.filter((comment) => comment.body.includes("[cursor:handoff]")).length, 1);
  assert.equal(t42.comments.filter((comment) => comment.body.includes("[cursor:handoff]")).length, 1);
  assert.equal(t43.comments.filter((comment) => comment.body.includes("[cursor:handoff]")).length, 0);
  const parentComments = parent.comments.filter((comment) => comment.body.includes("[cursor:parent-summary]"));
  assert.equal(parentComments.length, 1);
  const before = parentComments[0]?.id;
  await orchestrator.remediate(t08.key, false);
  await orchestrator.remediate(parent.key, false);
  const parentAfter = await jira.getIssue(parent.key);
  const summary = parentAfter.comments.filter((comment) => comment.body.includes("[cursor:parent-summary]"));
  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.id, before);
  assert.match(summary[0]?.body ?? "", /payments-api\/pull\//);
  assert.match(summary[0]?.body ?? "", /orders-service\/pull\//);
  assert.match(summary[0]?.body ?? "", /partnerWebhook/);
  assert.match(summary[0]?.body ?? "", /src\/auth\.js/);
  assert.equal(parentAfter.comments.length, 1);
  assert.equal(launcher.requests.length, 2);
});

test("jwt dry-run does not launch a cloud agent", async () => {
  const jira = new MemoryJira("JWF");
  const launcher = new FakeLauncher();
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  const report = await runJwtScenario({ orchestrator, jira, dataDir: "data", dryRun: true });
  assert.equal(launcher.requests.length, 0);
  assert.equal(report.dryRun, true);
  assert.ok(report.parentKey);
  const launched = report.remediations.filter((item) => item.prompt);
  assert.equal(launched.length, 2);
  assert.equal(report.remediations.some((item) => item.skipped === "duplicate"), true);
});
