import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultJiraStatuses, type JiraStatuses } from "../src/config.js";
import { loadNativeTickets } from "../src/factory/csv.js";
import { loadEnrichment } from "../src/factory/enrich.js";
import { MemoryJira } from "../src/jira/memory.js";
import { Orchestrator } from "../src/orchestrator.js";
import { shouldTransition } from "../src/intake.js";
import type { CloudLauncher, CloudLaunchResult } from "../src/sdk/types.js";
import { seedTicket, testConfig } from "./support.js";

const launcher: CloudLauncher = {
  async launch(request): Promise<CloudLaunchResult> {
    return {
      agentId: "bc-status",
      runId: "run-status",
      status: "finished",
      prUrl: `https://github.com/${request.metadata.githubRepo}/pull/1`,
      branch: request.metadata.branch,
      resultText: "opened a pull request",
      statusLog: ["running", "finished"],
    };
  },
};

class RecordingJira extends MemoryJira {
  readonly transitions: string[] = [];

  override async transition(key: string, status: string, resolution?: string): Promise<void> {
    this.transitions.push(status);
    await super.transition(key, status, resolution);
  }
}

test("trigger status is an entry point and a second intake does not flip it back", () => {
  const statuses = defaultJiraStatuses();
  assert.equal(shouldTransition("In Progress", "Ready for Agent", statuses), true);
  assert.equal(shouldTransition("To Do", "Human Needed", statuses), true);
  assert.equal(shouldTransition("In Review", "Ready for Agent", statuses), false);
  assert.equal(shouldTransition("Pending Verification", "Ready for Agent", statuses), false);
  assert.equal(shouldTransition("Done", "Ready for Agent", statuses), false);
  assert.equal(shouldTransition("Ready for Agent", "Ready for Agent", statuses), false);
  const custom: JiraStatuses = { ...statuses, agentReady: "Agent Needed", inReview: "Reviewing", done: "Closed" };
  assert.equal(shouldTransition("In Progress", "Agent Needed", custom), true);
  assert.equal(shouldTransition("Reviewing", "Agent Needed", custom), false);
  assert.equal(shouldTransition("Closed", "Agent Needed", custom), false);
});

test("intake moves In Progress to the agent-ready status and stays there on a later intake", async () => {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const ticket = tickets.find((item) => item.ref === "T08");
  assert.ok(ticket);
  const jira = new MemoryJira("JWF");
  await seedTicket(jira, ticket, "JWF-8");
  await jira.transition("JWF-8", "In Progress");
  const config = testConfig();
  config.statuses = { ...defaultJiraStatuses(), agentReady: "Agent Needed" };
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, config);
  const first = await orchestrator.intake("JWF-8", false);
  assert.equal(first.lane, "AGENT_PR_HUMAN_REVIEW");
  assert.equal(first.status, "Agent Needed");
  assert.equal((await jira.getIssue("JWF-8")).status, "Agent Needed");

  await jira.transition("JWF-8", "In Progress");
  const second = await orchestrator.intake("JWF-8", false);
  assert.equal(second.skipped, "already-triaged");
  const after = await jira.getIssue("JWF-8");
  assert.equal(after.status, "In Progress");
  assert.equal(after.comments.filter((comment) => comment.body.includes("[cursor:intake]")).length, 1);
  assert.match(after.comments[0]?.body ?? "", /Status: Agent Needed/);
});

test("remediate starts from In Progress without transitioning to itself, and from Agent Needed", async () => {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const ticket = tickets.find((item) => item.ref === "T08");
  assert.ok(ticket);
  const working = new RecordingJira("JWF");
  await seedTicket(working, ticket, "JWF-8");
  await working.updateIssue("JWF-8", {
    labels: ["wiz", "wiz-vulnerability", "cursor-agent"],
    fields: {
      agentLane: "AGENT_PR_HUMAN_REVIEW",
      dedupKey: "V-test",
      fixLocation: "acme-demo/payments-api:package.json",
      correlationGroup: "",
      crossRepoKey: "",
      riskScore: 40,
      prUrl: "",
    },
  });
  await working.transition("JWF-8", "In Progress");
  working.transitions.length = 0;
  const orchestrator = new Orchestrator(working, loadEnrichment("data"), launcher, testConfig());
  const fromWorking = await orchestrator.remediate("JWF-8", false);
  assert.equal(fromWorking.prUrl?.includes("/pull/"), true);
  assert.equal(working.transitions.includes("In Progress"), false);
  assert.equal(working.transitions.includes("In Review"), true);
  assert.equal((await working.getIssue("JWF-8")).status, "In Review");

  const custom = testConfig();
  custom.statuses = { ...defaultJiraStatuses(), agentReady: "Agent Needed", working: "Building", inReview: "Reviewing" };
  const ready = new RecordingJira("JWF");
  await seedTicket(ready, ticket, "JWF-8");
  await ready.updateIssue("JWF-8", {
    labels: ["wiz", "wiz-vulnerability", "cursor-agent"],
    fields: {
      agentLane: "AGENT_PR_HUMAN_REVIEW",
      dedupKey: "V-test",
      fixLocation: "acme-demo/payments-api:package.json",
      correlationGroup: "",
      crossRepoKey: "",
      riskScore: 40,
      prUrl: "",
    },
  });
  await ready.transition("JWF-8", "Agent Needed");
  ready.transitions.length = 0;
  const customOrchestrator = new Orchestrator(ready, loadEnrichment("data"), launcher, custom);
  await customOrchestrator.remediate("JWF-8", false);
  assert.deepEqual(ready.transitions, ["Building", "Reviewing"]);
  assert.equal((await ready.getIssue("JWF-8")).status, "Reviewing");
});
