import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigEnv, FactoryConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { loadNativeTickets, type NativeTicket } from "./factory/csv.js";
import { FactoryError } from "./errors.js";
import type { CreateIssueInput, Issue } from "./jira/types.js";

export const DEMO_REPO_NAMES = ["payments-api", "platform-infra", "orders-service"] as const;

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]+$/;

export interface ResetJira {
  searchByJql(jql: string): Promise<Issue[]>;
  deleteIssue(key: string): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GhRunner {
  which(): boolean;
  exec(args: string[]): Promise<GhResult>;
}

export interface ResetOptions {
  yes: boolean;
  project: string;
  label: string;
  reload: boolean;
  github: boolean;
  dataDir: string;
  githubOwner: string;
  jira: ResetJira;
  gh: GhRunner;
  log?: (line: string) => void;
}

export function configForReset(env: ConfigEnv, project?: string): FactoryConfig {
  const config = loadConfig(env, { requireCursor: false, requireJira: true, requireWebhook: false });
  if (!project) return config;
  if (!PROJECT_KEY.test(project)) throw new Error(`Invalid project key: ${project}`);
  return { ...config, jiraProjectKey: project };
}

export function resetJql(project: string, label: string): string {
  if (!PROJECT_KEY.test(project)) throw new Error(`Invalid project key: ${project}`);
  if (!label) return `project = ${project}`;
  const safe = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `project = ${project} AND labels = "${safe}"`;
}

export function isTrackingParent(issue: Pick<Issue, "issueType" | "labels" | "parentKey">): boolean {
  if (issue.parentKey) return false;
  return issue.issueType.toLowerCase() === "epic" || issue.labels.includes("parent");
}

/** Children first so a parent delete does not fail on remaining children. */
export function deleteOrder(issues: Issue[]): Issue[] {
  return [...issues.filter((issue) => !isTrackingParent(issue)), ...issues.filter((issue) => isTrackingParent(issue))];
}

export function realGh(env: NodeJS.ProcessEnv = process.env): GhRunner {
  return {
    which() {
      return (env.PATH ?? "").split(":").some((dir) => {
        if (!dir) return false;
        try {
          accessSync(join(dir, "gh"), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    },
    exec(args) {
      return new Promise((resolve) => {
        const child = spawn("gh", args, { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
  };
}

export async function resetBoard(options: ResetOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const jql = resetJql(options.project, options.label);
  log(`Searching ${jql}`);
  const found = await options.jira.searchByJql(jql);
  const issues = options.label ? found.filter((issue) => issue.labels.includes(options.label)) : found;
  log(`${issues.length} issue(s)`);
  for (const issue of issues) log(`  ${issue.key}${issue.summary ? `  ${issue.summary}` : ""}`);

  const deleteFailed: string[] = [];
  if (!options.yes) {
    log(`Dry run: nothing deleted. Re-run with --yes to delete${options.reload ? ", then reload" : ""}.`);
  } else if (issues.length === 0) {
    log("Nothing to delete.");
  } else {
    let deleted = 0;
    for (const issue of deleteOrder(issues)) {
      try {
        await options.jira.deleteIssue(issue.key);
        log(`deleted ${issue.key}`);
        deleted += 1;
      } catch (error) {
        log(`FAILED ${issue.key}: ${deleteFailure(error)}`);
        deleteFailed.push(issue.key);
      }
    }
    log(`${deleted} deleted, ${deleteFailed.length} failed`);
  }

  const githubFailed = options.github ? await githubReset({ apply: options.yes, owner: options.githubOwner, gh: options.gh, log }) : 0;

  if (options.reload) {
    if (!options.yes) {
      log("Dry run: would recreate demo tickets from data/jira_wiz_native_tickets.csv after a successful delete.");
      previewTickets(options.dataDir, log);
    } else if (deleteFailed.length > 0) {
      log("Skipping --reload because some deletes failed (reloading would duplicate surviving tickets).");
    } else {
      await reloadTickets(options.jira, options.dataDir, log);
    }
  }

  if (options.yes && (deleteFailed.length > 0 || githubFailed > 0)) return 1;
  return 0;
}

export async function githubReset(options: { apply: boolean; owner: string; gh: GhRunner; log: (line: string) => void }): Promise<number> {
  const repos = DEMO_REPO_NAMES.map((name) => `${options.owner}/${name}`);
  if (!options.gh.which()) {
    options.log("gh is not installed. Close open security/* PRs and delete their branches manually:");
    for (const repo of repos) {
      options.log(`  gh pr list --repo ${repo} --state open`);
      options.log(`  gh pr close <number> --repo ${repo} --delete-branch`);
    }
    return 0;
  }
  let failed = 0;
  for (const repo of repos) {
    const listed = await options.gh.exec(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,url,headRefName"]);
    if (listed.code !== 0) {
      const err = (listed.stderr || listed.stdout || "gh pr list failed").trim().split("\n");
      options.log(`${repo}: could not list open PRs: ${err[err.length - 1] || "unknown error"}`);
      options.log(`  Close them manually: gh pr list --repo ${repo} --state open`);
      options.log(`  then: gh pr close <number> --repo ${repo} --delete-branch`);
      failed += 1;
      continue;
    }
    let prs: Array<{ number?: number; title?: string; headRefName?: string }> = [];
    try {
      const parsed = JSON.parse(listed.stdout || "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("not a list");
      prs = parsed.filter((item): item is { number?: number; title?: string; headRefName?: string } => Boolean(item) && typeof item === "object");
    } catch {
      options.log(`${repo}: could not parse gh pr list output`);
      failed += 1;
      continue;
    }
    const security = prs.filter((pr) => (pr.headRefName ?? "").startsWith("security/"));
    if (security.length === 0) {
      options.log(`${repo}: no open security/* PRs`);
      continue;
    }
    for (const pr of security) {
      const branch = pr.headRefName ?? "";
      const label = `${repo}#${pr.number ?? "?"} ${pr.title ?? ""}${branch ? ` (branch ${branch})` : ""}`;
      if (!options.apply) {
        options.log(`[dry run] would close ${label}`);
        continue;
      }
      const closed = await options.gh.exec(["pr", "close", String(pr.number), "--repo", repo, "--delete-branch"]);
      if (closed.code !== 0) {
        const err = (closed.stderr || closed.stdout || "gh pr close failed").trim().split("\n");
        options.log(`FAILED ${label}: ${err[err.length - 1] || "unknown error"}`);
        failed += 1;
      } else {
        options.log(`closed ${label}`);
      }
    }
  }
  return failed;
}

function previewTickets(dataDir: string, log: (line: string) => void): void {
  const tickets = readDemoTickets(dataDir);
  for (const ticket of tickets) log(`[dry run] ${ticket.ref} ${ticket.priority} ${ticket.summary}`);
  log(`${tickets.length} ticket(s) previewed (dry run)`);
}

async function reloadTickets(jira: ResetJira, dataDir: string, log: (line: string) => void): Promise<void> {
  const tickets = readDemoTickets(dataDir);
  for (const ticket of tickets) {
    const created = await jira.createIssue({
      summary: ticket.summary,
      description: ticket.description,
      issueType: ticket.issueType,
      priority: ticket.priority,
      labels: ticket.labels,
    });
    log(`${ticket.ref} -> ${created.key}`);
  }
  log(`${tickets.length} ticket(s) created`);
}

function readDemoTickets(dataDir: string): NativeTicket[] {
  return loadNativeTickets(readFileSync(join(dataDir, "jira_wiz_native_tickets.csv"), "utf8"));
}

function deleteFailure(error: unknown): string {
  if (error instanceof FactoryError) {
    const hint = error.status === 403 ? " - this Jira user needs the Delete Issues permission on the project" : "";
    return `HTTP ${error.status}: ${error.message}${hint}`;
  }
  return error instanceof Error ? error.message : "delete failed";
}
