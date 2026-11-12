import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadNativeTickets } from "../src/factory/csv.js";
import { loadEnrichment } from "../src/factory/enrich.js";
import { MemoryJira } from "../src/jira/memory.js";
import { duplicatesTarget } from "../src/jira/types.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { CloudLauncher } from "../src/sdk/types.js";
import { seedTicket, testConfig } from "./support.js";

const launcher: CloudLauncher = { async launch() { throw new Error("intake does not launch"); } };

test("incremental intake of all 43 synthetic tickets matches lanes, dedup, and parents", async () => {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const expected = JSON.parse(readFileSync("data/expected_dedup_triage.json", "utf8")) as {
    tickets: Array<{ ref: string; lane: string; jira_status: string; dedup_key: string; duplicate_of: string; correlation: string; cross_repo_key: string; risk_score: number; parent: string }>;
    parents: Array<{ cross_repo_key: string; summary: string; children: Array<{ ref: string }> }>;
  };
  const jira = new MemoryJira("JWF");
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  for (const ticket of tickets) {
    await seedTicket(jira, ticket);
    await orchestrator.intake(ticket.ref, false);
  }
  for (const wanted of expected.tickets) {
    const issue = await jira.getIssue(wanted.ref);
    assert.equal(issue.fields.agentLane, wanted.lane, wanted.ref);
    assert.equal(issue.status, wanted.jira_status, wanted.ref);
    assert.equal(issue.fields.dedupKey, wanted.dedup_key, wanted.ref);
    assert.equal(issue.fields.correlationGroup, wanted.correlation, wanted.ref);
    assert.equal(issue.fields.crossRepoKey, wanted.cross_repo_key, wanted.ref);
    assert.equal(issue.fields.riskScore, wanted.risk_score, wanted.ref);
    assert.equal(duplicatesTarget(issue), wanted.duplicate_of, wanted.ref);
    const intakeComments = issue.comments.filter((comment) => comment.body.includes("[cursor:intake]") || comment.body.includes("[cursor:duplicate]"));
    assert.equal(intakeComments.length, 1, wanted.ref);
    if (wanted.lane !== "DUPLICATE") assert.equal(issue.labels.includes("wiz"), true, wanted.ref);
  }
  for (const wanted of expected.parents) {
    const parents = await jira.search({ kind: "parent", crossRepoKey: wanted.cross_repo_key });
    assert.equal(parents.length, 1, wanted.cross_repo_key);
    const parent = parents[0];
    assert.ok(parent);
    assert.equal(parent.summary, wanted.summary);
    assert.equal(parent.fields.agentLane, "PARENT_TRACKING");
    assert.equal(parent.status, "Human Needed");
    assert.equal(parent.labels.includes("wiz"), false);
    assert.deepEqual(parent.labels.sort(), ["cross-repo", "parent"]);
    const children = [];
    for (const ticket of expected.tickets) {
      if (!ticket.parent) continue;
      const issue = await jira.getIssue(ticket.ref);
      if (issue.parentKey === parent.key) children.push(ticket.ref);
    }
    assert.deepEqual(children.sort(), wanted.children.map((child) => child.ref).sort(), wanted.cross_repo_key);
    assert.equal(parent.comments.filter((comment) => comment.body.includes("[cursor:parent-summary]")).length, 1);
  }
});

test("intake is idempotent and a second pass does not add a comment", async () => {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const ticket = tickets.find((item) => item.ref === "T08");
  assert.ok(ticket);
  const jira = new MemoryJira("JWF");
  await seedTicket(jira, ticket, "JWF-8");
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  await orchestrator.intake("JWF-8", false);
  await orchestrator.intake("JWF-8", false);
  const issue = await jira.getIssue("JWF-8");
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.fields.agentLane, "AGENT_PR_HUMAN_REVIEW");
});
