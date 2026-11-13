import { existsSync, readFileSync } from "node:fs";

export interface FactoryConfig {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  jiraProjectKey: string;
  parentIssueType: string;
  webhookSecret: string;
  cursorApiKey: string;
  modelId: string | undefined;
  githubOwner: string;
  startingRef: string;
  port: number;
  pollIntervalMs: number;
  pollMaxMs: number;
  skipReviewerRequest: boolean;
  dataDir: string;
  logPayloads: boolean;
  statuses: JiraStatuses;
  fieldOverrides: Partial<Record<FieldOverrideKey, string>>;
}

/** Jira workflow names. Defaults match the demo project; rename them to the site's statuses. */
export interface JiraStatuses {
  trigger: string;
  agentReady: string;
  human: string;
  falsePositive: string;
  working: string;
  inReview: string;
  done: string;
}

export function defaultJiraStatuses(): JiraStatuses {
  return {
    trigger: "In Progress",
    agentReady: "Ready for Agent",
    human: "Human Needed",
    falsePositive: "False Positive",
    working: "In Progress",
    inReview: "In Review",
    done: "Done",
  };
}

export type FieldOverrideKey =
  | "dedupKey"
  | "fixLocation"
  | "correlationGroup"
  | "crossRepoKey"
  | "riskScore"
  | "agentLane"
  | "prUrl";

const FIELD_ENV: Record<FieldOverrideKey, string> = {
  dedupKey: "JIRA_FIELD_DEDUP_KEY",
  fixLocation: "JIRA_FIELD_FIX_LOCATION",
  correlationGroup: "JIRA_FIELD_CORRELATION_GROUP",
  crossRepoKey: "JIRA_FIELD_CROSS_REPO_KEY",
  riskScore: "JIRA_FIELD_RISK_SCORE",
  agentLane: "JIRA_FIELD_AGENT_LANE",
  prUrl: "JIRA_FIELD_PR_URL",
};

export interface ConfigEnv {
  [key: string]: string | undefined;
}

function required(env: ConfigEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example and fill the placeholder.`);
  }
  return value;
}

function intEnv(env: ConfigEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

/** Request logging is on unless LOG_PAYLOADS is false, 0, or no. */
export function payloadsEnabled(env: ConfigEnv = process.env): boolean {
  const raw = env.LOG_PAYLOADS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  throw new Error(`LOG_PAYLOADS must be true or false, got ${env.LOG_PAYLOADS}.`);
}

export function loadConfig(env: ConfigEnv = process.env, opts?: { requireCursor?: boolean; requireJira?: boolean; requireWebhook?: boolean }): FactoryConfig {
  const requireJira = opts?.requireJira ?? true;
  const requireCursor = opts?.requireCursor ?? true;
  const requireWebhook = opts?.requireWebhook ?? false;
  const fieldOverrides: FactoryConfig["fieldOverrides"] = {};
  for (const key of Object.keys(FIELD_ENV) as FieldOverrideKey[]) {
    const value = env[FIELD_ENV[key]]?.trim();
    if (value) fieldOverrides[key] = value;
  }
  const project = (env.JIRA_PROJECT_KEY ?? "JWF").trim();
  if (!/^[A-Z][A-Z0-9_]+$/.test(project)) {
    throw new Error(`JIRA_PROJECT_KEY must look like JWF, got ${project}.`);
  }
  return {
    jiraBaseUrl: (requireJira ? required(env, "JIRA_BASE_URL") : env.JIRA_BASE_URL ?? "https://fe-anysphere-demo.atlassian.net").replace(/\/$/, ""),
    jiraEmail: requireJira ? required(env, "JIRA_EMAIL") : env.JIRA_EMAIL ?? "",
    jiraApiToken: requireJira ? required(env, "JIRA_API_TOKEN") : env.JIRA_API_TOKEN ?? "",
    jiraProjectKey: project,
    parentIssueType: env.JIRA_PARENT_ISSUE_TYPE?.trim() || "Epic",
    webhookSecret: requireWebhook ? required(env, "WEBHOOK_SECRET") : env.WEBHOOK_SECRET?.trim() ?? "",
    cursorApiKey: requireCursor ? required(env, "CURSOR_API_KEY") : env.CURSOR_API_KEY?.trim() ?? "",
    modelId: env.CURSOR_MODEL?.trim() || undefined,
    githubOwner: env.GITHUB_OWNER?.trim() || "calwatson",
    startingRef: env.CURSOR_STARTING_REF?.trim() || "main",
    port: intEnv(env, "PORT", 8787),
    pollIntervalMs: intEnv(env, "AGENT_POLL_INTERVAL_MS", 5_000),
    pollMaxMs: intEnv(env, "AGENT_POLL_MAX_MS", 60 * 60 * 1000),
    skipReviewerRequest: env.CURSOR_SKIP_REVIEWER_REQUEST !== "false",
    dataDir: env.FACTORY_DATA_DIR?.trim() || "data",
    logPayloads: payloadsEnabled(env),
    statuses: loadStatuses(env),
    fieldOverrides,
  };
}

function loadStatuses(env: ConfigEnv): JiraStatuses {
  const defaults = defaultJiraStatuses();
  return {
    trigger: statusEnv(env, "JIRA_STATUS_TRIGGER", defaults.trigger),
    agentReady: statusEnv(env, "JIRA_STATUS_AGENT_READY", defaults.agentReady),
    human: statusEnv(env, "JIRA_STATUS_HUMAN", defaults.human),
    falsePositive: statusEnv(env, "JIRA_STATUS_FALSE_POSITIVE", defaults.falsePositive),
    working: statusEnv(env, "JIRA_STATUS_WORKING", defaults.working),
    inReview: statusEnv(env, "JIRA_STATUS_IN_REVIEW", defaults.inReview),
    done: statusEnv(env, "JIRA_STATUS_DONE", defaults.done),
  };
}

function statusEnv(env: ConfigEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value || fallback;
}

/** Load KEY=VALUE pairs from a local env file without overriding variables already set. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
