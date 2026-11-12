import type { FindingType } from "./maps.js";
import { assertNever } from "../never.js";
import type { ParsedTicket } from "./parse.js";

export interface ParentChildLine {
  key: string;
  wizId: string;
  repo: string;
  lane: string;
  correlation: string;
  status: string;
  prUrl: string;
  fixDifference: string;
}

const PRIORITY_RANK: Record<string, number> = { Highest: 4, High: 3, Medium: 2, Low: 1 };

export function higherPriority(left: string, right: string): string {
  return (PRIORITY_RANK[left] ?? 0) >= (PRIORITY_RANK[right] ?? 0) ? left : right;
}

export function parentSummary(parsed: ParsedTicket, repoCount: number): string {
  const finding: FindingType = parsed.findingType;
  let what: string;
  switch (finding) {
    case "Vulnerability":
      what = `${parsed.cve} in ${parsed.packageName}`;
      break;
    case "Code":
      what = `${parsed.rule} (${parsed.ruleId})`;
      break;
    case "Secret":
      what = `${parsed.secretType} exposed`;
      break;
    case "Cloud Configuration":
    case "Toxic Combination":
      what = parsed.rule || parsed.wizId;
      break;
    default:
      return assertNever(finding, "finding type");
  }
  return `[Parent] ${what} across ${repoCount} repos`;
}

export function parentDescription(crossRepoKey: string, repos: string[]): string {
  return [
    "[SYNTHETIC DEMO DATA]",
    `Cross-Repo Key: ${crossRepoKey}`,
    `Repos: ${[...repos].sort().join(", ")}`,
    "Created by the security factory orchestrator (cross-repo grouping). Tracking only: remediation runs on the children.",
  ].join("\n");
}

export function formatParentComment(children: ParentChildLine[]): string {
  const ordered = [...children].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const repos = new Set(ordered.map((child) => child.repo).filter((repo) => repo.length > 0));
  const lines = ordered.map((child) => {
    const correlation = child.correlation ? `, Correlation Group ${child.correlation}` : "";
    const pr = child.prUrl ? `, PR ${child.prUrl}` : "";
    return `- ${child.key} (${child.wizId}) ${child.repo}: lane ${child.lane}${correlation}, status ${child.status}${pr}. Fix: ${child.fixDifference}`;
  });
  return `[cursor:parent-summary] ${ordered.length} children across ${repos.size} repos. Remediation runs on children only; one PR per child repo.\n${lines.join("\n")}`;
}
