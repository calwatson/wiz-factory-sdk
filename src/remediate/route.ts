import { WRITABLE_REPO_NAMES, type WritableRepoName } from "../factory/maps.js";
import type { ParsedTicket } from "../factory/parse.js";
import { repoFromTicket } from "../factory/score.js";

export interface Route {
  source: "code-repository" | "iac-source" | "image";
  wizRepo: string;
  githubRepo: string;
  repoName: WritableRepoName;
}

export function routeTicket(parsed: ParsedTicket, githubOwner: string): { ok: true; route: Route } | { ok: false; reason: string } {
  const wizRepo = repoFromTicket(parsed);
  const source = parsed.codeRepository ? "code-repository" : parsed.iacSource ? "iac-source" : parsed.image ? "image" : undefined;
  if (!wizRepo || !source) {
    return { ok: false, reason: "No Code Repository, IaC Source, or mapped Image on the ticket." };
  }
  const name = wizRepo.split("/")[1] ?? "";
  if (!wizRepo.startsWith("acme-demo/") || !isWritable(name)) {
    return { ok: false, reason: `Repository ${wizRepo} is not agent-writable.` };
  }
  return {
    ok: true,
    route: { source, wizRepo, githubRepo: `${githubOwner}/${name}`, repoName: name },
  };
}

export function securityBranch(issueKey: string, parsed: ParsedTicket): string {
  const raw = parsed.cve || parsed.ruleId || parsed.secretType || parsed.packageName || "fix";
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `security/${issueKey}-${slug || "fix"}`;
}

function isWritable(name: string): name is WritableRepoName {
  return (WRITABLE_REPO_NAMES as readonly string[]).includes(name);
}
