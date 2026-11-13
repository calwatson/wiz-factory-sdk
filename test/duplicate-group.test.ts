import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadNativeTickets, type NativeTicket } from "../src/factory/csv.js";
import { loadEnrichment } from "../src/factory/enrich.js";
import { MemoryJira } from "../src/jira/memory.js";
import { duplicatesTarget } from "../src/jira/types.js";
import { Orchestrator } from "../src/orchestrator.js";
import { resetBoard } from "../src/reset.js";
import type { CloudLauncher } from "../src/sdk/types.js";
import { seedTicket, testConfig } from "./support.js";

const launcher: CloudLauncher = { async launch() { throw new Error("duplicate groups are not remediated"); } };

function ticket(ref: string): NativeTicket {
  const tickets = loadNativeTickets(readFileSync("data/jira_wiz_native_tickets.csv", "utf8"));
  const found = tickets.find((item) => item.ref === ref);
  if (!found) throw new Error(`missing ${ref}`);
  return found;
}

function cloneTicket(source: NativeTicket, ref: string, wizId: string): NativeTicket {
  return {
    ...source,
    ref,
    created: "2026-11-08T00:00:00.000Z",
    description: source.description.replace(/Demo Ref: T\d+/, `Demo Ref: ${ref}`).replace(/Wiz Issue ID: \S+/, `Wiz Issue ID: ${wizId}`),
  };
}

function epics(jira: MemoryJira): string[] {
  return [...jira.issues.values()].filter((issue) => issue.labels.includes("duplicate-group")).map((issue) => issue.key);
}

test("a duplicate creates one Epic and a second duplicate joins it", async () => {
  const jira = new MemoryJira("JWF");
  const canonical = ticket("T08");
  const firstDup = ticket("T43");
  const secondDup = cloneTicket(firstDup, "T99", "vf-0099");
  await seedTicket(jira, canonical, "T08");
  await seedTicket(jira, firstDup, "T43");
  await seedTicket(jira, secondDup, "T99");
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  await orchestrator.intake("T08", false);
  await orchestrator.intake("T43", false);
  assert.equal(epics(jira).length, 1);
  const epicKey = epics(jira)[0] ?? "";
  const epic = await jira.getIssue(epicKey);
  assert.deepEqual(epic.labels.sort(), ["duplicate-group", "parent"]);
  assert.equal(epic.fields.agentLane, "PARENT_TRACKING");
  assert.equal(epic.fields.dedupKey, (await jira.getIssue("T08")).fields.dedupKey);
  assert.equal(epic.labels.includes("wiz"), false);
  assert.equal(epic.labels.includes("cross-repo"), false);
  assert.match(epic.summary, /^Duplicate group: CVE-2022-23540 in jsonwebtoken \(2 tickets\)$/);
  assert.equal((await jira.getIssue("T08")).parentKey, epicKey);
  assert.equal((await jira.getIssue("T43")).parentKey, epicKey);
  const duplicate = await jira.getIssue("T43");
  assert.equal(duplicate.status, "Done");
  assert.equal(duplicate.resolution, "Duplicate");
  assert.equal(duplicatesTarget(duplicate), "T08");
  assert.equal(duplicate.comments.filter((comment) => comment.body.includes("[cursor:duplicate]")).length, 1);
  assert.equal(epic.comments.filter((comment) => comment.body.includes("[cursor:duplicate-group]")).length, 1);
  assert.match(epic.comments[0]?.body ?? "", /T08 \(vf-0010\)/);
  assert.match(epic.comments[0]?.body ?? "", /T43 \(vf-0021\)/);

  await orchestrator.intake("T99", false);
  assert.equal(epics(jira).length, 1);
  const joined = await jira.getIssue(epicKey);
  assert.equal((await jira.getIssue("T99")).parentKey, epicKey);
  assert.match(joined.summary, /\(3 tickets\)$/);
  assert.equal(joined.comments.filter((comment) => comment.body.includes("[cursor:duplicate-group]")).length, 1);
  assert.match(joined.comments.find((comment) => comment.body.includes("[cursor:duplicate-group]"))?.body ?? "", /vf-0099/);

  await orchestrator.intake("T43", false);
  await orchestrator.intake("T08", false);
  assert.equal(epics(jira).length, 1);
  const again = await jira.getIssue(epicKey);
  assert.equal(again.comments.filter((comment) => comment.body.includes("[cursor:duplicate-group]")).length, 1);
  assert.equal((await jira.getIssue("T43")).comments.filter((comment) => comment.body.includes("[cursor:duplicate]")).length, 1);

  const skipped = await orchestrator.remediate(epicKey, false);
  assert.equal(skipped.skipped, "parent");
});

test("duplicates join an existing cross-repo parent instead of a new Epic", async () => {
  const jira = new MemoryJira("JWF");
  for (const ref of ["T08", "T42", "T43"]) await seedTicket(jira, ticket(ref), ref);
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  await orchestrator.intake("T08", false);
  await orchestrator.intake("T42", false);
  await orchestrator.intake("T43", false);
  assert.equal(epics(jira).length, 0);
  const parentKey = (await jira.getIssue("T08")).parentKey;
  assert.ok(parentKey);
  assert.equal((await jira.getIssue("T43")).parentKey, parentKey);
  assert.equal((await jira.getIssue("T42")).parentKey, parentKey);
  const parent = await jira.getIssue(parentKey);
  assert.equal(parent.labels.includes("cross-repo"), true);
  assert.equal(parent.labels.includes("duplicate-group"), false);
  assert.equal(parent.comments.filter((comment) => comment.body.includes("[cursor:duplicate-group]")).length, 1);
  assert.match(parent.comments.find((comment) => comment.body.includes("[cursor:duplicate-group]"))?.body ?? "", /T43 \(vf-0021\)/);
  await orchestrator.intake("T43", false);
  assert.equal(epics(jira).length, 0);
  assert.equal((await jira.getIssue(parentKey)).comments.filter((comment) => comment.body.includes("[cursor:duplicate-group]")).length, 1);
});

test("reset deletes duplicate-group Epics that are not labeled wiz", async () => {
  const jira = new MemoryJira("JWF");
  await seedTicket(jira, ticket("T08"), "T08");
  await seedTicket(jira, ticket("T43"), "T43");
  const orchestrator = new Orchestrator(jira, loadEnrichment("data"), launcher, testConfig());
  await orchestrator.intake("T08", false);
  await orchestrator.intake("T43", false);
  const epicKey = epics(jira)[0] ?? "";
  assert.ok(epicKey);
  const lines: string[] = [];
  const code = await resetBoard({
    yes: true,
    project: "JWF",
    label: "wiz",
    reload: false,
    github: false,
    dataDir: "data",
    githubOwner: "calwatson",
    jira,
    gh: { which: () => false, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), new RegExp(epicKey));
  assert.equal(jira.issues.has(epicKey), false);
  assert.equal(jira.issues.has("T08"), false);
  assert.equal(jira.issues.has("T43"), false);
});
