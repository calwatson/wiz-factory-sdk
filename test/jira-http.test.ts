import assert from "node:assert/strict";
import test from "node:test";
import { HttpJira } from "../src/jira/http.js";
import { jqlFor, matchesQuery } from "../src/jira/query.js";
import { emptyFields, type Issue } from "../src/jira/types.js";
import { testConfig } from "./support.js";

test("dedup JQL is quoted and exact equality drops fuzzy hits", () => {
  const jql = jqlFor("JWF", { kind: "dedup-key", dedupKey: "V-325cd7253e23", unresolved: true });
  assert.match(jql, /project = JWF/);
  assert.match(jql, /"Dedup Key" ~ "V-325cd7253e23"/);
  assert.match(jql, /resolution is EMPTY/);
  const issue = (dedupKey: string): Issue => ({
    key: dedupKey,
    summary: "",
    description: "",
    status: "To Do",
    resolution: "",
    issueType: "Bug",
    priority: "Medium",
    labels: ["wiz"],
    created: "2026-01-01T00:00:00.000Z",
    dueDate: "",
    component: "",
    parentKey: "",
    fields: { ...emptyFields(), dedupKey },
    comments: [],
    links: [],
  });
  const query = { kind: "dedup-key" as const, dedupKey: "V-325cd7253e23", unresolved: true };
  assert.equal(matchesQuery(issue("V-325cd7253e23"), query), true);
  assert.equal(matchesQuery(issue("V-325cd7253e230"), query), false);
});

test("parent field failure falls back to an is-child-of link and the token stays out of errors", async () => {
  const calls: Array<{ url: string; method: string; authorization: string; body?: unknown }> = [];
  const fields = [
    { id: "customfield_1", name: "Dedup Key", schema: { type: "string" } },
    { id: "customfield_2", name: "Fix Location", schema: { type: "string" } },
    { id: "customfield_3", name: "Correlation Group", schema: { type: "string" } },
    { id: "customfield_4", name: "Cross-Repo Key", schema: { type: "string" } },
    { id: "customfield_5", name: "Risk Score", schema: { type: "number" } },
    { id: "customfield_6", name: "Agent Lane", schema: { type: "option" } },
    { id: "customfield_7", name: "PR URL", schema: { type: "string" } },
  ];
  const issue = {
    key: "JWF-8",
    fields: {
      summary: "child",
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Wiz Issue ID: vf-0010" }] }] },
      status: { name: "To Do" },
      issuetype: { name: "Bug" },
      priority: { name: "Medium" },
      labels: ["wiz"],
      created: "2026-10-21T09:12:00.000Z",
    },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, method, authorization, body });
    if (url.endsWith("/field")) return json(fields);
    if (url.includes("/issue/JWF-8/comment")) return json({ comments: [], total: 0 });
    if (url.includes("/issue/JWF-8") && method === "GET") return json(issue);
    if (url.includes("/issue/JWF-8") && method === "PUT") return json({ errorMessages: ["parent not on screen"] }, 400);
    if (url.endsWith("/issueLinkType")) {
      return json({ issueLinkTypes: [{ name: "Parent", outward: "is parent of", inward: "is child of" }] });
    }
    if (url.endsWith("/issueLink") && method === "POST") return json({}, 201);
    return json({ errorMessages: ["unexpected"] }, 500);
  };
  const config = testConfig();
  const jira = new HttpJira(config, fetchImpl);
  const mode = await jira.setParent("JWF-8", "JWF-99");
  assert.equal(mode, "child-link");
  const link = calls.find((call) => call.url.endsWith("/issueLink"));
  assert.deepEqual(link?.body, {
    type: { name: "Parent" },
    outwardIssue: { key: "JWF-99" },
    inwardIssue: { key: "JWF-8" },
  });
  const expected = `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString("base64")}`;
  assert.equal(calls.every((call) => call.authorization === expected), true);
  await assert.rejects(jira.getIssue("JWF-missing"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(config.jiraApiToken), false);
    return true;
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
