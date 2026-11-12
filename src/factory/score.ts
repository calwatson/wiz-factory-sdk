import { createHash } from "node:crypto";
import { assetOf, tagsOf, type RawNode } from "./enrich.js";
import {
  AGENT_ALLOWLIST,
  CODE_RULE_FAMILY,
  CORRELATION_BY_WIZ_ID,
  FIX_UNITS,
  IMAGE_TO_REPO,
  REPO_DEPLOYS_TO,
  RULE_FAMILY,
  SEV_BASE,
  type FindingType,
} from "./maps.js";
import { assertNever } from "../never.js";
import type { ParsedTicket } from "./parse.js";
import type { Lane } from "./gate.js";
import { disposition } from "./gate.js";

export interface Assessment {
  repo: string;
  env: string;
  dedupKey: string;
  fixLocation: string;
  correlation: string;
  crossRepoKey: string;
  riskScore: number;
  riskFactors: string[];
  agentPriority: "Highest" | "High" | "Medium" | "Low";
  slaDays: number;
  lane: Lane;
  laneReason: string;
  jiraStatus: string;
  label: string;
  autoMerge: boolean;
}

function sha12(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

export function repoFromTicket(parsed: ParsedTicket): string {
  if (parsed.codeRepository) return parsed.codeRepository.replace(/^github\.com\//, "");
  if (parsed.iacSource) {
    return parsed.iacSource.replace(/^github\.com\//, "").split("/").slice(0, 2).join("/");
  }
  if (parsed.image) {
    const slash = parsed.image.indexOf("/");
    const rest = slash === -1 ? parsed.image : parsed.image.slice(slash + 1);
    const name = rest.split(":")[0] ?? "";
    return IMAGE_TO_REPO[name] ?? "";
  }
  return "";
}

export function envFromTicket(parsed: ParsedTicket, repo: string): string {
  if (parsed.cloudAccountName) {
    const name = `${parsed.cloudAccountName} ${parsed.resourceName}`;
    if (name.includes("prod")) return "prod";
    if (name.includes("staging")) return "staging";
    if (name.includes("dev")) return "dev";
    return "unknown";
  }
  const env = /\/envs\/(\w+)\//.exec(parsed.iacSource)?.[1];
  if (env) return env;
  return REPO_DEPLOYS_TO[repo] ?? "unknown";
}

function cloudAnchor(parsed: ParsedTicket, repo: string): string {
  if (!parsed.iacSource) return parsed.resourceId;
  const parts = parsed.iacSource.split("/");
  const anchor = parts.length <= 3 ? (parts[parts.length - 1] ?? parsed.iacSource) : parts.slice(3).join("/");
  return repo ? `${repo}/${anchor}` : anchor;
}

export function dedupIdentity(parsed: ParsedTicket, repo: string): { dedupKey: string; fixLocation: string } {
  const finding = parsed.findingType;
  switch (finding) {
    case "Vulnerability": {
      const manifest =
        parsed.packageType === "os"
          ? "Dockerfile"
          : parsed.packageType === "npm"
            ? "package.json"
            : parsed.packageType === "pypi"
              ? "requirements.txt"
              : "artifact";
      const fixLocation = repo ? `${repo}:${manifest}` : `resource:${parsed.resourceId}`;
      return {
        dedupKey: `V-${sha12(`vuln|${parsed.cve}|${parsed.packageName}|${fixLocation}`)}`,
        fixLocation,
      };
    }
    case "Secret": {
      const path = parsed.filePath.replace(/:\d+$/, "").replace(/^\/app\//, "");
      return {
        dedupKey: `S-${sha12(`secret|${parsed.secretType}|${repo}|${path}`)}`,
        fixLocation: `${repo}:${path}`,
      };
    }
    case "Code":
      return {
        dedupKey: `C-${sha12(`code|${parsed.ruleId}|${repo}|${parsed.filePath}|${parsed.functionName}`)}`,
        fixLocation: `${repo}:${parsed.filePath}`,
      };
    case "Cloud Configuration": {
      const family = RULE_FAMILY[parsed.ruleId];
      if (family) {
        const anchor = cloudAnchor(parsed, repo);
        return { dedupKey: `M-${sha12(`cfg|${family}|${anchor}`)}`, fixLocation: anchor };
      }
      return issueIdentity(parsed);
    }
    case "Toxic Combination":
      return issueIdentity(parsed);
    default: {
      const unknown: never = finding;
      return assertNever(unknown, "finding type");
    }
  }
}

function issueIdentity(parsed: ParsedTicket): { dedupKey: string; fixLocation: string } {
  return {
    dedupKey: `T-${sha12(`issue|${parsed.wizId}`)}`,
    fixLocation: parsed.iacSource || parsed.resourceId,
  };
}

export function crossRepoKey(parsed: ParsedTicket, repo: string): string {
  if (!repo) return "";
  const finding: FindingType = parsed.findingType;
  switch (finding) {
    case "Vulnerability":
      return `vuln:${parsed.cve}:${parsed.packageName}`.toLowerCase();
    case "Code":
      return `code:${CODE_RULE_FAMILY[parsed.ruleId] ?? parsed.ruleId}`.toLowerCase();
    case "Secret":
      return `secret:${parsed.secretType}`.toLowerCase();
    case "Cloud Configuration":
    case "Toxic Combination":
      return "";
    default:
      return assertNever(finding, "finding type");
  }
}

export function correlationGroup(parsed: ParsedTicket, repo: string): string {
  return CORRELATION_BY_WIZ_ID[parsed.wizId] ?? FIX_UNITS[`${repo}|${parsed.packageName}`] ?? "";
}

export interface Ranked {
  severity: string;
  env: string;
  created: string;
  ref: string;
}

export function compareCanonical(a: Ranked, b: Ranked): number {
  const severity = (SEV_BASE[b.severity] ?? 0) - (SEV_BASE[a.severity] ?? 0);
  if (severity !== 0) return severity;
  const env = (a.env === "prod" ? 0 : 1) - (b.env === "prod" ? 0 : 1);
  if (env !== 0) return env;
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return 0;
}

function priorityBand(score: number): Assessment["agentPriority"] {
  if (score >= 70) return "Highest";
  if (score >= 45) return "High";
  if (score >= 20) return "Medium";
  return "Low";
}

const SLA_DAYS: Record<Assessment["agentPriority"], number> = {
  Highest: 7,
  High: 14,
  Medium: 30,
  Low: 90,
};

export function scoreRisk(parsed: ParsedTicket, raw: RawNode | undefined, env: string): {
  score: number;
  factors: string[];
  agentPriority: Assessment["agentPriority"];
  slaDays: number;
} {
  const tags = tagsOf(raw);
  const asset = assetOf(raw);
  const base = SEV_BASE[parsed.severity] ?? 0;
  let score = base;
  const factors = [`severity ${parsed.severity} +${base}`];
  if (raw?.hasCisaKevExploit) {
    score += 25;
    factors.push("CISA KEV +25 (enrichment)");
  } else if (raw?.hasExploit) {
    score += 15;
    factors.push("public exploit +15 (enrichment)");
  }
  if (asset.isInternetFacing) {
    score += 15;
    factors.push("internet facing +15 (enrichment)");
  }
  if (tags["data-classification"] === "pci" || parsed.findingType === "Toxic Combination") {
    score += 10;
    factors.push("sensitive data path +10");
  }
  if (env === "prod") {
    score += 10;
    factors.push("prod +10");
  } else if (env === "staging") {
    score += 3;
    factors.push("staging +3");
  }
  const path = `${parsed.location}${parsed.filePath}`;
  if (raw?.isDevDependency || path.includes("test/fixtures")) {
    score -= 25;
    factors.push("not in runtime (dev or test only) -25");
  }
  if (asset.powerState === "STOPPED") {
    score -= 30;
    factors.push("stopped, decommission tagged -30 (enrichment)");
  }
  if (tags["public-intended"] === "true") {
    score -= 40;
    factors.push("public by design -40 (enrichment tags)");
  }
  if (
    raw?.expectedOutcome === "FALSE_POSITIVE" &&
    parsed.findingType === "Cloud Configuration" &&
    !("public-intended" in tags)
  ) {
    score -= 30;
    factors.push("covered by org control -30");
  }
  if (parsed.findingType === "Secret" && !path.includes("test/fixtures") && score < 70) {
    factors.push(`live credential floor +${70 - score}`);
    score = 70;
  }
  score = Math.max(0, Math.min(100, score));
  const agentPriority = priorityBand(score);
  return { score, factors, agentPriority, slaDays: SLA_DAYS[agentPriority] };
}

function pickLane(parsed: ParsedTicket, raw: RawNode | undefined, score: number, repo: string): { lane: Lane; laneReason: string } {
  const path = `${parsed.location}${parsed.filePath}`;
  if (raw?.expectedOutcome === "FALSE_POSITIVE" || (score < 20 && (path.includes("test/fixtures") || raw?.isDevDependency === true))) {
    return {
      lane: "FALSE_POSITIVE_CANDIDATE",
      laneReason: "Agent attaches evidence and proposes False Positive; a human confirms.",
    };
  }
  if (raw?.status === "RESOLVED") {
    return {
      lane: "STALE_CLOSE",
      laneReason: "Wiz now reports the finding resolved (image tag no longer running); agent confirms through enrichment and closes.",
    };
  }
  if (!repo) return { lane: "HUMAN_ONLY", laneReason: "No source repository mapped; route to owner, no agent PR." };
  if (!AGENT_ALLOWLIST.has(repo)) {
    return { lane: "HUMAN_ONLY", laneReason: "Repository not on the agent allowlist; route to owning team." };
  }
  const finding = parsed.findingType;
  switch (finding) {
    case "Secret":
      return {
        lane: "AGENT_PR_HUMAN_REVIEW",
        laneReason: "Agent removes the secret from code; a human rotates the credential and signs off.",
      };
    case "Vulnerability": {
      if (parsed.packageType === "os") {
        return { lane: "AGENT_PR_HUMAN_REVIEW", laneReason: "Base image change; human review." };
      }
      const installedMajor = parsed.installedVersion.split(".")[0];
      const fixedMajor = parsed.fixedVersion.split(".")[0];
      if (installedMajor !== fixedMajor) {
        return { lane: "AGENT_PR_HUMAN_REVIEW", laneReason: "Major version upgrade; human review." };
      }
      return { lane: "AUTO_MERGE_ELIGIBLE", laneReason: "Patch or minor dependency bump with passing tests." };
    }
    case "Cloud Configuration":
    case "Toxic Combination": {
      const family = RULE_FAMILY[parsed.ruleId] ?? "";
      if (family === "rds-encryption") {
        return { lane: "HUMAN_ONLY", laneReason: "Fix requires resource replacement; human-owned change." };
      }
      if (parsed.iacSource.includes("/envs/prod/") || family === "iam-admin-on-compute") {
        return { lane: "AGENT_PR_HUMAN_REVIEW", laneReason: "Touches prod config or IAM; human review." };
      }
      if (finding === "Toxic Combination") {
        return { lane: "PARENT_TRACKING", laneReason: "Parent ticket; closes when its child fixes verify." };
      }
      return { lane: "AUTO_MERGE_ELIGIBLE", laneReason: "Non-prod IaC fix with passing plan and policy checks." };
    }
    case "Code":
      return {
        lane: "AGENT_PR_HUMAN_REVIEW",
        laneReason: "Application code change; Approval Agent routes to a reviewer.",
      };
    default:
      return assertNever(finding, "finding type");
  }
}

export function assess(parsed: ParsedTicket, raw: RawNode | undefined): Assessment {
  const repo = repoFromTicket(parsed);
  const env = envFromTicket(parsed, repo);
  const identity = dedupIdentity(parsed, repo);
  const risk = scoreRisk(parsed, raw, env);
  const lane = pickLane(parsed, raw, risk.score, repo);
  const gate = disposition(lane.lane);
  return {
    repo,
    env,
    dedupKey: identity.dedupKey,
    fixLocation: identity.fixLocation,
    correlation: correlationGroup(parsed, repo),
    crossRepoKey: crossRepoKey(parsed, repo),
    riskScore: risk.score,
    riskFactors: risk.factors,
    agentPriority: risk.agentPriority,
    slaDays: risk.slaDays,
    lane: lane.lane,
    laneReason: lane.laneReason,
    jiraStatus: gate.status,
    label: gate.label,
    autoMerge: lane.lane === "AUTO_MERGE_ELIGIBLE",
  };
}

export function asDuplicate(assessment: Assessment, canonicalRef: string, reason: string): Assessment {
  const gate = disposition("DUPLICATE");
  return {
    ...assessment,
    lane: "DUPLICATE",
    laneReason: `Duplicate of ${canonicalRef} (${reason}); linked and resolved as Duplicate.`,
    jiraStatus: gate.status,
    label: gate.label,
    autoMerge: false,
    crossRepoKey: "",
  };
}

export function clearClosedCrossRepo(assessment: Assessment): Assessment {
  if (assessment.lane === "DUPLICATE" || assessment.lane === "STALE_CLOSE") {
    return { ...assessment, crossRepoKey: "" };
  }
  return assessment;
}
