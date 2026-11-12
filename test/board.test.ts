import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadNativeTickets } from "../src/factory/csv.js";
import { loadEnrichment } from "../src/factory/enrich.js";
import { classifyBoard } from "../src/factory/board.js";

interface ExpectedTicket {
  ref: string;
  wiz_id: string;
  type: string;
  severity: string;
  what: string;
  resource: string;
  env: string;
  repo: string;
  fix_location: string;
  dedup_key: string;
  duplicate_of: string;
  dup_reason: string;
  correlation: string;
  cross_repo_key: string;
  parent: string;
  risk_score: number;
  risk_factors: string[];
  agent_priority: string;
  sla_days: number;
  lane: string;
  lane_reason: string;
  jira_status: string;
  auto_merge: boolean;
}

interface ExpectedParent {
  ref: string;
  summary: string;
  cross_repo_key: string;
  repos: string[];
  lane: string;
  jira_status: string;
  priority: string;
  risk_score: number;
  children: Array<{ ref: string; wiz_id: string; repo: string; lane: string; fix_location: string; correlation: string; fix_difference: string }>;
}

test("batch intake matches the synthetic answer key", () => {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const expected = JSON.parse(readFileSync("data/expected_dedup_triage.json", "utf8")) as {
    tickets: ExpectedTicket[];
    parents: ExpectedParent[];
  };
  const board = classifyBoard(tickets, loadEnrichment("data"));
  assert.equal(board.tickets.length, 43);
  for (const wanted of expected.tickets) {
    const got = board.tickets.find((ticket) => ticket.ref === wanted.ref);
    assert.ok(got, wanted.ref);
    assert.equal(got.lane, wanted.lane, wanted.ref);
    assert.equal(got.jiraStatus, wanted.jira_status, wanted.ref);
    assert.equal(got.dedupKey, wanted.dedup_key, wanted.ref);
    assert.equal(got.duplicateOf, wanted.duplicate_of, wanted.ref);
    assert.equal(got.dupReason, wanted.dup_reason, wanted.ref);
    assert.equal(got.correlation, wanted.correlation, wanted.ref);
    assert.equal(got.crossRepoKey, wanted.cross_repo_key, wanted.ref);
    assert.equal(got.parent, wanted.parent, wanted.ref);
    assert.equal(got.riskScore, wanted.risk_score, wanted.ref);
    assert.deepEqual(got.riskFactors, wanted.risk_factors, wanted.ref);
    assert.equal(got.repo, wanted.repo, wanted.ref);
    assert.equal(got.fixLocation, wanted.fix_location, wanted.ref);
    assert.equal(got.env, wanted.env, wanted.ref);
    assert.equal(got.autoMerge, wanted.auto_merge, wanted.ref);
    assert.equal(got.laneReason, wanted.lane_reason, wanted.ref);
    assert.equal(got.agentPriority, wanted.agent_priority, wanted.ref);
    assert.equal(got.slaDays, wanted.sla_days, wanted.ref);
  }
  assert.equal(board.parents.length, expected.parents.length);
  for (const wanted of expected.parents) {
    const got = board.parents.find((parent) => parent.ref === wanted.ref);
    assert.ok(got, wanted.ref);
    assert.equal(got.summary, wanted.summary, wanted.ref);
    assert.equal(got.crossRepoKey, wanted.cross_repo_key, wanted.ref);
    assert.deepEqual(got.repos, wanted.repos, wanted.ref);
    assert.equal(got.lane, wanted.lane, wanted.ref);
    assert.equal(got.jiraStatus, wanted.jira_status, wanted.ref);
    assert.equal(got.priority, wanted.priority, wanted.ref);
    assert.equal(got.riskScore, wanted.risk_score, wanted.ref);
    assert.deepEqual(
      got.children.map((child) => ({
        ref: child.ref,
        wizId: child.wizId,
        repo: child.repo,
        lane: child.lane,
        fixLocation: child.fixLocation,
        correlation: child.correlation,
        fixDifference: child.fixDifference,
      })),
      wanted.children.map((child) => ({
        ref: child.ref,
        wizId: child.wiz_id,
        repo: child.repo,
        lane: child.lane,
        fixLocation: child.fix_location,
        correlation: child.correlation,
        fixDifference: child.fix_difference,
      })),
      wanted.ref,
    );
  }
});
