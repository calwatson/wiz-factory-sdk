import type { EnrichmentIndex } from "./enrich.js";
import { disposition } from "./gate.js";
import { fixDifference } from "./maps.js";
import { formatParentComment, higherPriority, parentSummary, type ParentChildLine } from "./parents.js";
import { parseDescription } from "./parse.js";
import { asDuplicate, assess, clearClosedCrossRepo, compareCanonical, type Assessment } from "./score.js";
import type { NativeTicket } from "./csv.js";

export interface ClassifiedTicket {
  ref: string;
  wizId: string;
  type: string;
  severity: string;
  what: string;
  resource: string;
  env: string;
  repo: string;
  fixLocation: string;
  dedupKey: string;
  duplicateOf: string;
  dupReason: string;
  correlation: string;
  crossRepoKey: string;
  parent: string;
  riskScore: number;
  riskFactors: string[];
  agentPriority: string;
  slaDays: number;
  lane: string;
  laneReason: string;
  jiraStatus: string;
  autoMerge: boolean;
}

export interface ClassifiedParent {
  ref: string;
  issueType: "Epic";
  summary: string;
  crossRepoKey: string;
  repos: string[];
  lane: "PARENT_TRACKING";
  jiraStatus: string;
  priority: string;
  riskScore: number;
  children: Array<{
    ref: string;
    wizId: string;
    repo: string;
    lane: string;
    fixLocation: string;
    correlation: string;
    fixDifference: string;
  }>;
  summaryComment: string;
}

interface Row {
  ref: string;
  created: string;
  priority: string;
  parsed: ReturnType<typeof parseDescription>;
  assessment: Assessment;
  duplicateOf: string;
  dupReason: string;
  parent: string;
}

function materialize(row: Row): ClassifiedTicket {
  const assessment = row.duplicateOf
    ? asDuplicate(row.assessment, row.duplicateOf, row.dupReason)
    : clearClosedCrossRepo(row.assessment);
  return {
    ref: row.ref,
    wizId: row.parsed.wizId,
    type: row.parsed.findingType,
    severity: row.parsed.severity,
    what: row.parsed.cve || row.parsed.rule,
    resource: row.parsed.resourceName,
    env: assessment.env,
    repo: assessment.repo,
    fixLocation: assessment.fixLocation,
    dedupKey: assessment.dedupKey,
    duplicateOf: row.duplicateOf,
    dupReason: row.dupReason,
    correlation: assessment.correlation,
    crossRepoKey: assessment.crossRepoKey,
    parent: row.parent,
    riskScore: assessment.riskScore,
    riskFactors: assessment.riskFactors,
    agentPriority: assessment.agentPriority,
    slaDays: assessment.slaDays,
    lane: assessment.lane,
    laneReason: assessment.laneReason,
    jiraStatus: assessment.jiraStatus,
    autoMerge: assessment.autoMerge,
  };
}

export function classifyBoard(tickets: NativeTicket[], enrichment: EnrichmentIndex): {
  tickets: ClassifiedTicket[];
  parents: ClassifiedParent[];
} {
  const rows: Row[] = tickets.map((ticket) => {
    const parsed = parseDescription(ticket.description);
    const raw = enrichment.get(parsed.wizId);
    return {
      ref: ticket.ref,
      created: ticket.created,
      priority: ticket.priority,
      parsed,
      assessment: assess(parsed, raw),
      duplicateOf: "",
      dupReason: "",
      parent: "",
    };
  });
  const canonById = new Map<string, string>();
  const canonByKey = new Map<string, string>();
  const order = [...rows].sort((a, b) =>
    compareCanonical(
      { severity: a.parsed.severity, env: a.assessment.env, created: a.created, ref: a.ref },
      { severity: b.parsed.severity, env: b.assessment.env, created: b.created, ref: b.ref },
    ),
  );
  for (const row of order) {
    if (enrichment.get(row.parsed.wizId)?.status === "RESOLVED") continue;
    const byId = canonById.get(row.parsed.wizId);
    if (byId) {
      row.duplicateOf = byId;
      row.dupReason = "exact: same Wiz Issue ID (ticket re-created)";
      continue;
    }
    const byKey = canonByKey.get(row.assessment.dedupKey);
    if (byKey) {
      row.duplicateOf = byKey;
      row.dupReason = "same dedup key";
      if (!canonById.has(row.parsed.wizId)) canonById.set(row.parsed.wizId, byKey);
      continue;
    }
    canonByKey.set(row.assessment.dedupKey, row.ref);
    canonById.set(row.parsed.wizId, row.ref);
  }

  const classified = new Map<string, ClassifiedTicket>();
  for (const row of rows) classified.set(row.ref, materialize(row));

  const groups = new Map<string, ClassifiedTicket[]>();
  for (const ticket of classified.values()) {
    if (!ticket.crossRepoKey || ticket.lane === "DUPLICATE" || ticket.lane === "STALE_CLOSE") continue;
    const list = groups.get(ticket.crossRepoKey) ?? [];
    list.push(ticket);
    groups.set(ticket.crossRepoKey, list);
  }
  const parentSeeds: Array<{ key: string; kids: ClassifiedTicket[]; first: string }> = [];
  for (const [key, kids] of groups) {
    const repos = new Set(kids.map((kid) => kid.repo));
    if (repos.size < 2) continue;
    kids.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    parentSeeds.push({ key, kids, first: kids[0]?.ref ?? "" });
  }
  parentSeeds.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const parents: ClassifiedParent[] = parentSeeds.map((seed, index) => {
    const ref = `P${String(index + 1).padStart(2, "0")}`;
    const parsed = rows.find((row) => row.ref === seed.first)?.parsed;
    if (!parsed) throw new Error(`Missing parsed ticket for ${seed.first}.`);
    const repos = [...new Set(seed.kids.map((kid) => kid.repo))].sort();
    let priority = "Low";
    let risk = 0;
    const children = seed.kids.map((kid) => {
      kid.parent = ref;
      const source = rows.find((row) => row.ref === kid.ref);
      priority = higherPriority(priority, source?.priority ?? "Low");
      risk = Math.max(risk, kid.riskScore);
      return {
        ref: kid.ref,
        wizId: kid.wizId,
        repo: kid.repo,
        lane: kid.lane,
        fixLocation: kid.fixLocation,
        correlation: kid.correlation,
        fixDifference: fixDifference(kid.wizId, kid.laneReason),
      };
    });
    const lines: ParentChildLine[] = children.map((child) => ({
      key: child.ref,
      wizId: child.wizId,
      repo: child.repo,
      lane: child.lane,
      correlation: child.correlation,
      status: classified.get(child.ref)?.jiraStatus ?? "",
      prUrl: "",
      fixDifference: child.fixDifference,
    }));
    return {
      ref,
      issueType: "Epic",
      summary: parentSummary(parsed, repos.length),
      crossRepoKey: seed.key,
      repos,
      lane: "PARENT_TRACKING",
      jiraStatus: disposition("PARENT_TRACKING").status,
      priority,
      riskScore: risk,
      children,
      summaryComment: formatParentComment(lines),
    };
  });
  return { tickets: rows.map((row) => classified.get(row.ref) as ClassifiedTicket), parents };
}
