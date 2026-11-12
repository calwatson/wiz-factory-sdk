import { assertNever } from "../never.js";
import { parseDescription } from "../factory/parse.js";
import type { Issue, JiraQuery } from "./types.js";

function parsedWiz(description: string): { demoRef: string; wizId: string } | undefined {
  try {
    const parsed = parseDescription(description);
    return { demoRef: parsed.demoRef, wizId: parsed.wizId };
  } catch {
    return undefined;
  }
}

export function matchesQuery(issue: Issue, query: JiraQuery): boolean {
  switch (query.kind) {
    case "demo-ref":
      return parsedWiz(issue.description)?.demoRef === query.ref;
    case "wiz-id":
      return parsedWiz(issue.description)?.wizId === query.wizId;
    case "dedup-key":
      return issue.fields.dedupKey === query.dedupKey && (!query.unresolved || issue.resolution === "");
    case "cross-repo":
      return (
        issue.fields.crossRepoKey === query.crossRepoKey &&
        (!query.unresolved || issue.resolution === "") &&
        (!query.excludeParentLabel || !issue.labels.includes("parent"))
      );
    case "parent":
      return issue.labels.includes("cross-repo") && issue.fields.crossRepoKey === query.crossRepoKey;
    case "correlation":
      return issue.fields.correlationGroup === query.correlationGroup && (!query.unresolved || issue.resolution === "");
    default:
      return assertNever(query, "jira query");
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function jqlFor(project: string, query: JiraQuery): string {
  const base = `project = ${project}`;
  switch (query.kind) {
    case "demo-ref":
      return `${base} AND text ~ ${quote(`Demo Ref: ${query.ref}`)} ORDER BY created ASC`;
    case "wiz-id":
      return `${base} AND text ~ ${quote(query.wizId)} ORDER BY created ASC`;
    case "dedup-key":
      return `${base} AND "Dedup Key" ~ ${quote(query.dedupKey)}${query.unresolved ? " AND resolution is EMPTY" : ""} ORDER BY created ASC`;
    case "cross-repo":
      return `${base} AND "Cross-Repo Key" ~ ${quote(query.crossRepoKey)}${query.unresolved ? " AND resolution is EMPTY" : ""}${query.excludeParentLabel ? " AND labels != parent" : ""} ORDER BY created ASC`;
    case "parent":
      return `${base} AND labels = cross-repo AND "Cross-Repo Key" ~ ${quote(query.crossRepoKey)} ORDER BY created ASC`;
    case "correlation":
      return `${base} AND "Correlation Group" ~ ${quote(query.correlationGroup)}${query.unresolved ? " AND resolution is EMPTY" : ""} ORDER BY created ASC`;
    default:
      return assertNever(query, "jira query");
  }
}
