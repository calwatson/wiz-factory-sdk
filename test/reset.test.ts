import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";
import { FactoryError } from "../src/errors.js";
import { HttpJira } from "../src/jira/http.js";
import { MemoryJira } from "../src/jira/memory.js";
import { emptyFields, type CreateIssueInput, type Issue } from "../src/jira/types.js";
import { configForReset, deleteOrder, resetBoard, resetJql, type GhRunner, type ResetJira } from "../src/reset.js";
import { testConfig } from "./support.js";

const TOKEN = "jira-token-must-not-be-logged";

function issue(partial: Partial<Issue> & Pick<Issue, "key">): Issue {
  return {
    summary: partial.summary ?? "",
    description: "",
    status: "To Do",
    resolution: "",
    issueType: partial.issueType ?? "Bug",
    priority: "Medium",
    labels: partial.labels ?? [],
    created: partial.created ?? "2026-01-01T00:00:00.000Z",
    dueDate: "",
    component: "",
    parentKey: partial.parentKey ?? "",
    fields: emptyFields(),
    comments: [],
    links: [],
    ...partial,
  };
}

test("reset config and flags do not require a Cursor key or webhook secret", () => {
  const config = configForReset(
    {
      JIRA_BASE_URL: "https://fe-anysphere-demo.atlassian.net",
      JIRA_EMAIL: "demo@example.com",
      JIRA_API_TOKEN: TOKEN,
    },
    "JWF",
  );
  assert.equal(config.cursorApiKey, "");
  assert.equal(config.webhookSecret, "");
  assert.equal(config.jiraProjectKey, "JWF");
  const args = parseArgs(["reset", "--label", "wiz", "--reload", "--github", "--project", "JWF"]);
  assert.equal(args.command, "reset");
  assert.equal(args.dryRun, true);
  assert.equal(args.reset?.yes, false);
  assert.equal(args.reset?.label, "wiz");
  assert.equal(args.reset?.project, "JWF");
  assert.equal(parseArgs(["reset", "--yes"]).reset?.yes, true);
  assert.throws(() => configForReset({ JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" }, "1bad"));
});

test("dry run lists issues and does not delete or reload", async () => {
  const jira = new MemoryJira("JWF");
  await jira.createIssue({ key: "JWF-1", summary: "child", description: "d", issueType: "Bug", priority: "Medium", labels: ["wiz"] });
  await jira.createIssue({ key: "JWF-2", summary: "other", description: "d", issueType: "Bug", priority: "Medium", labels: ["cursor-agent"] });
  const lines: string[] = [];
  const code = await resetBoard({
    yes: false,
    project: "JWF",
    label: "wiz",
    reload: true,
    github: false,
    dataDir: "data",
    githubOwner: "calwatson",
    jira,
    gh: { which: () => false, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /Searching project = JWF AND labels = "wiz"/);
  assert.match(lines.join("\n"), /JWF-1 {2}child/);
  assert.equal(lines.some((line) => line.includes("JWF-2")), false);
  assert.match(lines.join("\n"), /Dry run: nothing deleted/);
  assert.match(lines.join("\n"), /previewed \(dry run\)/);
  assert.equal((await jira.searchByJql("project = JWF")).length, 2);
  assert.equal(lines.join("\n").includes(TOKEN), false);
});

test("yes deletes children before parents and skips reload when a delete fails", async () => {
  const deleted: string[] = [];
  const created: string[] = [];
  const child = issue({ key: "JWF-3", summary: "child", parentKey: "JWF-9", labels: ["wiz"] });
  const parent = issue({ key: "JWF-9", summary: "parent", issueType: "Epic", labels: ["parent", "cross-repo"] });
  const jira: ResetJira = {
    async searchByJql() {
      return [parent, child];
    },
    async deleteIssue(key) {
      deleted.push(key);
      if (key === "JWF-9") throw new FactoryError("Jira DELETE failed (403): forbidden", "jira", 403);
    },
    async createIssue(input: CreateIssueInput) {
      created.push(input.summary);
      return issue({ key: "JWF-100", summary: input.summary });
    },
  };
  assert.deepEqual(deleteOrder([parent, child]).map((item) => item.key), ["JWF-3", "JWF-9"]);
  const lines: string[] = [];
  const code = await resetBoard({
    yes: true,
    project: "JWF",
    label: "",
    reload: true,
    github: false,
    dataDir: "data",
    githubOwner: "calwatson",
    jira,
    gh: { which: () => false, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(deleted, ["JWF-3", "JWF-9"]);
  assert.match(lines.join("\n"), /Delete Issues permission/);
  assert.match(lines.join("\n"), /Skipping --reload/);
  assert.equal(created.length, 0);
});

test("reload recreates the synthetic csv after a successful delete", async () => {
  const jira = new MemoryJira("JWF");
  await jira.createIssue({ key: "JWF-1", summary: "old", description: "d", issueType: "Bug", priority: "Low", labels: ["wiz"] });
  const lines: string[] = [];
  const code = await resetBoard({
    yes: true,
    project: "JWF",
    label: "",
    reload: true,
    github: false,
    dataDir: "data",
    githubOwner: "calwatson",
    jira,
    gh: { which: () => false, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  const reloaded = await jira.searchByJql("project = JWF");
  assert.equal(reloaded.length, 43);
  assert.equal(reloaded.some((item) => item.key === "JWF-1"), false);
  assert.match(lines.join("\n"), /T08 -> JWF-/);
  assert.equal(lines.join("\n").includes("Skipping --reload"), false);
});

test("github cleanup closes only security branches and prints instructions without gh", async () => {
  const calls: string[][] = [];
  const gh: GhRunner = {
    which: () => true,
    async exec(args) {
      calls.push(args);
      if (args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 4, title: "jwt", headRefName: "security/JWF-1-cve-2022-23540" },
            { number: 5, title: "unrelated", headRefName: "feature/readme" },
          ]),
          stderr: "",
        };
      }
      return { code: 0, stdout: "closed", stderr: "" };
    },
  };
  const lines: string[] = [];
  const dry = await resetBoard({
    yes: false,
    project: "JWF",
    label: "",
    reload: false,
    github: true,
    dataDir: "data",
    githubOwner: "calwatson",
    jira: { async searchByJql() { return []; }, async deleteIssue() { return undefined; }, async createIssue(input) { return issue({ key: "JWF-1", summary: input.summary }); } },
    gh,
    log: (line) => lines.push(line),
  });
  assert.equal(dry, 0);
  assert.match(lines.join("\n"), /\[dry run\] would close calwatson\/payments-api#4/);
  assert.equal(lines.some((line) => line.includes("feature/readme")), false);
  assert.equal(calls.some((args) => args[1] === "close"), false);

  calls.length = 0;
  lines.length = 0;
  const applied = await resetBoard({
    yes: true,
    project: "JWF",
    label: "",
    reload: false,
    github: true,
    dataDir: "data",
    githubOwner: "calwatson",
    jira: { async searchByJql() { return []; }, async deleteIssue() { return undefined; }, async createIssue(input) { return issue({ key: "JWF-1", summary: input.summary }); } },
    gh,
    log: (line) => lines.push(line),
  });
  assert.equal(applied, 0);
  const close = calls.filter((args) => args[1] === "close");
  assert.equal(close.length, 3);
  assert.deepEqual(close[0], ["pr", "close", "4", "--repo", "calwatson/payments-api", "--delete-branch"]);

  lines.length = 0;
  const missing = await resetBoard({
    yes: true,
    project: "JWF",
    label: "",
    reload: false,
    github: true,
    dataDir: "data",
    githubOwner: "calwatson",
    jira: { async searchByJql() { return []; }, async deleteIssue() { return undefined; }, async createIssue(input) { return issue({ key: "JWF-1", summary: input.summary }); } },
    gh: { which: () => false, exec: async () => { throw new Error("gh should not be called"); } },
    log: (line) => lines.push(line),
  });
  assert.equal(missing, 0);
  assert.match(lines.join("\n"), /gh is not installed/);
  assert.match(lines.join("\n"), /calwatson\/orders-service/);
});

test("search pages with nextPageToken and delete uses deleteSubtasks", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let jqlPage = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, method, body });
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const decoded = Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString("utf8");
    assert.equal(decoded.endsWith(`:${TOKEN}`), true);
    if (url.endsWith("/search/jql") && method === "POST") {
      jqlPage += 1;
      if (jqlPage === 1) return json({ issues: [rawIssue("JWF-2", "Bug")], nextPageToken: "page-2", isLast: false });
      return json({ issues: [rawIssue("JWF-8", "Epic", ["parent"])], isLast: true });
    }
    if (url.endsWith("/search") && method === "POST") {
      return json({ issues: [rawIssue("JWF-2", "Bug"), rawIssue("JWF-8", "Epic", ["parent"])], total: 2 });
    }
    if (method === "DELETE" && url.includes("/issue/JWF-2")) return new Response(null, { status: 204 });
    if (method === "DELETE" && url.includes("/issue/JWF-8")) return json({ errorMessages: ["forbidden"] }, 403);
    if (method === "POST" && url.endsWith("/issue")) return json({ key: "JWF-50" });
    return json({ errorMessages: ["unexpected"] }, 500);
  };
  const jira = new HttpJira({ ...testConfig(), jiraApiToken: TOKEN }, fetchImpl);
  const lines: string[] = [];
  const code = await resetBoard({
    yes: true,
    project: "JWF",
    label: "",
    reload: false,
    github: false,
    dataDir: "data",
    githubOwner: "calwatson",
    jira,
    gh: { which: () => false, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  const searchBodies = calls.filter((call) => call.url.endsWith("/search/jql")).map((call) => call.body as { nextPageToken?: string });
  assert.equal(searchBodies[1]?.nextPageToken, "page-2");
  assert.equal(calls.some((call) => call.url.endsWith("/rest/api/3/search") && !call.url.endsWith("/search/jql")), false);
  const deleted = calls.filter((call) => call.method === "DELETE").map((call) => call.url);
  assert.match(deleted[0] ?? "", /\/issue\/JWF-2\?deleteSubtasks=true/);
  assert.match(deleted[1] ?? "", /\/issue\/JWF-8\?deleteSubtasks=true/);
  const output = lines.join("\n");
  assert.match(output, /Delete Issues permission/);
  assert.equal(output.includes(TOKEN), false);
  assert.equal(resetJql("JWF", 'wiz"x'), 'project = JWF AND labels = "wiz\\"x"');
});

test("enhanced search falls back to /rest/api/3/search", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/search/jql")) return json({ errorMessages: ["unsupported"] }, 404);
    if (url.endsWith("/search")) return json({ issues: [rawIssue("JWF-4", "Bug")], total: 1 });
    return json({ errorMessages: ["unexpected"] }, 500);
  };
  const found = await new HttpJira({ ...testConfig(), jiraApiToken: TOKEN }, fetchImpl).searchByJql("project = JWF");
  assert.deepEqual(found.map((item) => item.key), ["JWF-4"]);
  assert.equal(calls.some((call) => call.includes("/rest/api/3/search/jql")), true);
  assert.equal(calls.some((call) => call.endsWith("/rest/api/3/search")), true);
});

function rawIssue(key: string, type: string, labels: string[] = ["wiz"]): unknown {
  return { key, fields: { summary: key, labels, issuetype: { name: type }, parent: type === "Bug" ? { key: "JWF-8" } : undefined } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
