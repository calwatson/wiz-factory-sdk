import { defaultJiraStatuses, type JiraStatuses } from "./config.js";
import { assertNever } from "./never.js";
import { dueDateFrom, addLabel } from "./dates.js";
import { tagsOf, type EnrichmentIndex, type RawNode } from "./factory/enrich.js";
import { disposition } from "./factory/gate.js";
import { fixDifference } from "./factory/maps.js";
import { formatParentComment, higherPriority, parentDescription, parentSummary, type ParentChildLine } from "./factory/parents.js";
import { parseDescription, type ParsedTicket } from "./factory/parse.js";
import { repoFromTicket } from "./factory/score.js";
import { asDuplicate, assess, clearClosedCrossRepo, compareCanonical, type Assessment } from "./factory/score.js";
import { upsertComment } from "./jira/comments.js";
import type { Issue, JiraClient } from "./jira/types.js";

export interface IntakeResult {
  issueKey: string;
  dryRun: boolean;
  skipped?: "parent" | "already-remediating" | "already-triaged";
  lane?: string;
  status?: string;
  dedupKey?: string;
  duplicateOf?: string;
  dupReason?: string;
  crossRepoKey?: string;
  correlationGroup?: string;
  riskScore?: number;
  riskFactors?: string[];
  parentKey?: string;
  createdParent?: boolean;
  repo?: string;
  enrichment: "used" | "ticket fields only" | "n/a";
}

interface Candidate {
  key: string;
  wizId: string;
  dedupKey: string;
  severity: string;
  env: string;
  created: string;
  lane: string;
  prUrl: string;
  resolvedFinding: boolean;
  resolution: string;
}

interface Plan {
  issue: Issue;
  parsed: ParsedTicket;
  final: Assessment;
  duplicateOf: string;
  dupReason: string;
  demote: Candidate[];
  siblingKeys: string[];
  parentNeeded: boolean;
  enrichmentUsed: boolean;
  skipped?: "parent" | "already-remediating" | "already-triaged";
}

export class IntakeService {
  constructor(
    private readonly jira: JiraClient,
    private readonly enrichment: EnrichmentIndex,
    private readonly now: () => Date,
    private readonly parentIssueType: string,
    private readonly statuses: JiraStatuses = defaultJiraStatuses(),
  ) {}

  async run(issueKey: string, dryRun: boolean): Promise<IntakeResult> {
    const plan = await this.plan(issueKey);
    if (plan.skipped) {
      return {
        issueKey,
        dryRun,
        skipped: plan.skipped,
        lane: plan.issue.fields.agentLane || undefined,
        status: plan.issue.status,
        enrichment: "n/a",
      };
    }
    if (dryRun) return this.toResult(plan, dryRun, plan.issue.parentKey, false);
    await this.writeFields(plan);
    if (plan.duplicateOf) {
      await this.markDuplicate(plan.issue.key, plan.duplicateOf, plan.final.laneReason, plan.parsed);
      return this.toResult(plan, dryRun, "", false);
    }
    const parent = plan.parentNeeded ? await this.syncParent(plan) : { key: "", created: false };
    for (const other of plan.demote) {
      await this.markDuplicate(
        other.key,
        plan.issue.key,
        `Duplicate of ${plan.issue.key} (same dedup key); linked and resolved as Duplicate.`,
        undefined,
      );
    }
    await this.writeStatusAndComment(plan, parent.key);
    return this.toResult(plan, dryRun, parent.key, parent.created);
  }

  private async plan(issueKey: string): Promise<Plan> {
    const issue = await this.jira.getIssue(issueKey);
    if (isTrackingParent(issue)) {
      return emptyPlan(issue, true);
    }
    if (issue.fields.agentLane === "PR_OPEN" || issue.fields.prUrl) {
      return { ...emptyPlan(issue, false), skipped: "already-remediating" };
    }
    if (alreadyTriaged(issue)) {
      return { ...emptyPlan(issue, false), skipped: "already-triaged" };
    }
    const parsed = parseDescription(issue.description);
    const raw = this.enrichment.get(parsed.wizId);
    const assessment = assess(parsed, raw);
    const enrichmentUsed = raw !== undefined;
    if (assessment.lane === "STALE_CLOSE") {
      return {
        issue,
        parsed,
        final: clearClosedCrossRepo(assessment),
        duplicateOf: "",
        dupReason: "",
        demote: [],
        siblingKeys: [],
        parentNeeded: false,
        enrichmentUsed,
      };
    }
    const related = await this.related(issue.key, parsed.wizId, assessment.dedupKey);
    const others = related
      .map((item) => this.candidate(item))
      .filter((item): item is Candidate => item !== undefined);
    const self = this.candidate(issue, assessment);
    const pool = [self, ...others].filter((item): item is Candidate => item !== undefined && eligible(item));
    pool.sort((a, b) => compareCanonical({ ...a, ref: a.key }, { ...b, ref: b.key }));
    const winner = pool[0];
    if (winner && winner.key !== issue.key) {
      const reason = winner.wizId === parsed.wizId ? "exact: same Wiz Issue ID (ticket re-created)" : "same dedup key";
      return {
        issue,
        parsed,
        final: asDuplicate(assessment, winner.key, reason),
        duplicateOf: winner.key,
        dupReason: reason,
        demote: [],
        siblingKeys: [],
        parentNeeded: false,
        enrichmentUsed,
      };
    }
    const demote = pool.filter((item) => item.key !== issue.key && !item.prUrl && item.lane !== "PR_OPEN");
    const final = clearClosedCrossRepo(assessment);
    const siblings = final.crossRepoKey ? await this.siblings(issue.key, final.crossRepoKey, final) : [];
    const repos = new Set(siblings.map((item) => item.repo).filter((repo) => repo.length > 0));
    return {
      issue,
      parsed,
      final,
      duplicateOf: "",
      dupReason: "",
      demote,
      siblingKeys: siblings.map((item) => item.key),
      parentNeeded: repos.size >= 2,
      enrichmentUsed,
    };
  }

  private async writeFields(plan: Plan): Promise<void> {
    const gate = disposition(plan.final.lane, this.statuses);
    await this.jira.updateIssue(plan.issue.key, {
      labels: addLabel(plan.issue.labels, gate.label),
      dueDate: plan.issue.dueDate || dueDateFrom(this.now(), plan.final.slaDays),
      component: componentFor(this.enrichment.get(plan.parsed.wizId), plan.final.repo) || undefined,
      fields: {
        dedupKey: plan.final.dedupKey,
        fixLocation: plan.final.fixLocation,
        correlationGroup: plan.final.correlation,
        crossRepoKey: plan.final.crossRepoKey,
        riskScore: plan.final.riskScore,
        agentLane: plan.final.lane,
      },
    });
    if (shouldTransition(plan.issue.status, gate.status, this.statuses)) {
      await this.jira.transition(plan.issue.key, gate.status, gate.resolution || undefined);
    }
  }

  private async writeStatusAndComment(plan: Plan, parentKey: string): Promise<void> {
    const folded = await this.foldedLines(plan.issue.key);
    await upsertComment(this.jira, plan.issue.key, "[cursor:intake]", intakeBody(plan, parentKey, folded, disposition(plan.final.lane, this.statuses).status));
  }

  private async markDuplicate(duplicateKey: string, canonicalKey: string, reason: string, parsed: ParsedTicket | undefined): Promise<void> {
    const duplicate = await this.jira.getIssue(duplicateKey);
    const gate = disposition("DUPLICATE", this.statuses);
    await this.jira.updateIssue(duplicateKey, {
      labels: addLabel(duplicate.labels, gate.label),
      fields: {
        agentLane: "DUPLICATE",
        crossRepoKey: "",
        dedupKey: duplicate.fields.dedupKey,
        fixLocation: duplicate.fields.fixLocation,
        correlationGroup: duplicate.fields.correlationGroup,
        riskScore: duplicate.fields.riskScore,
      },
    });
    if (duplicate.status !== this.statuses.done) await this.jira.transition(duplicateKey, this.statuses.done, "Duplicate");
    const already = duplicate.links.some((link) => link.typeName === "Duplicate" && link.thisIs === "outward" && link.otherKey === canonicalKey);
    if (!already) await this.jira.link({ typeName: "Duplicate", outwardKey: duplicateKey, inwardKey: canonicalKey });
    await upsertComment(this.jira, duplicateKey, "[cursor:duplicate]", `[cursor:duplicate] SYNTHETIC DEMO\n${reason}`);
    if (parsed) await this.foldIntoCanonical(canonicalKey, duplicateKey, parsed);
    await this.syncDuplicateGroup(canonicalKey);
  }

  /** One Epic per dedup key for the canonical ticket and its duplicates. A cross-repo parent wins, because a ticket can have only one parent. */
  private async syncDuplicateGroup(canonicalKey: string): Promise<void> {
    const canonical = await this.jira.getIssue(canonicalKey);
    const dedupKey = canonical.fields.dedupKey;
    if (!dedupKey) return;
    const members = await this.duplicateMembers(canonical);
    const duplicates = members.filter((member) => member.key !== canonical.key);
    if (duplicates.length === 0) return;
    const crossRepo = await this.crossRepoParentOf(canonical);
    const epic = crossRepo ?? (await this.findOrCreateDuplicateEpic(canonical, members));
    for (const member of members) {
      if (member.parentKey === epic.key) continue;
      await this.jira.setParent(member.key, epic.key);
    }
    const fresh = await this.duplicateMembers(await this.jira.getIssue(canonicalKey));
    await this.refreshDuplicateGroup(epic, fresh, crossRepo !== undefined);
  }

  private async duplicateMembers(canonical: Issue): Promise<Issue[]> {
    const found = canonical.fields.dedupKey
      ? await this.jira.search({ kind: "dedup-key", dedupKey: canonical.fields.dedupKey, unresolved: false })
      : [];
    const members = new Map<string, Issue>([[canonical.key, canonical]]);
    for (const issue of found) {
      if (isDuplicateGroupEpic(issue) || isTrackingParent(issue)) continue;
      members.set(issue.key, issue);
    }
    return [...members.values()];
  }

  private async crossRepoParentOf(issue: Issue): Promise<Issue | undefined> {
    if (!issue.parentKey) return undefined;
    const parent = await this.jira.getIssue(issue.parentKey);
    if (parent.labels.includes("parent") && parent.labels.includes("cross-repo") && !parent.labels.includes("duplicate-group")) return parent;
    return undefined;
  }

  private async findOrCreateDuplicateEpic(canonical: Issue, members: Issue[]): Promise<Issue> {
    const existing = await this.jira.search({ kind: "duplicate-group", dedupKey: canonical.fields.dedupKey });
    const open = existing
      .filter((issue) => issue.status !== this.statuses.done)
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    const epic = open[0] ?? (await this.createDuplicateEpic(canonical, members));
    for (const extra of open.filter((issue) => issue.key !== epic.key)) {
      await this.jira.transition(extra.key, this.statuses.done, "Duplicate");
      await upsertComment(this.jira, extra.key, "[cursor:duplicate]", `[cursor:duplicate] SYNTHETIC DEMO\nDuplicate group epic of ${epic.key}; members were moved.`);
    }
    return this.jira.getIssue(epic.key);
  }

  private async createDuplicateEpic(canonical: Issue, members: Issue[]): Promise<Issue> {
    let parsed: ParsedTicket | undefined;
    try {
      parsed = parseDescription(canonical.description);
    } catch {
      parsed = undefined;
    }
    const created = await this.jira.createIssue({
      summary: duplicateGroupSummary(parsed, canonical.summary, members.length),
      description: ["[SYNTHETIC DEMO DATA]", `Dedup Key: ${canonical.fields.dedupKey}`, "Duplicate group. Tracking only: remediation runs on the canonical ticket."].join("\n"),
      issueType: this.parentIssueType,
      priority: members.reduce((priority, member) => higherPriority(priority, member.priority), "Low"),
      labels: ["parent", "duplicate-group"],
      dueDate: earliestDue(members),
      fields: {
        dedupKey: canonical.fields.dedupKey,
        agentLane: "PARENT_TRACKING",
        riskScore: maxRisk(members),
      },
    });
    await this.jira.transition(created.key, this.statuses.human);
    return this.jira.getIssue(created.key);
  }

  private async refreshDuplicateGroup(epic: Issue, members: Issue[], crossRepo: boolean): Promise<void> {
    const canonical = members.find((member) => member.fields.agentLane !== "DUPLICATE") ?? members[0];
    if (!canonical) return;
    if (!crossRepo) {
      let parsed: ParsedTicket | undefined;
      try {
        parsed = parseDescription(canonical.description);
      } catch {
        parsed = undefined;
      }
      await this.jira.updateIssue(epic.key, {
        summary: duplicateGroupSummary(parsed, canonical.summary, members.length),
        priority: members.reduce((priority, member) => higherPriority(priority, member.priority), "Low"),
        labels: ["parent", "duplicate-group"],
        ...(earliestDue(members) ? { dueDate: earliestDue(members) } : {}),
        fields: { dedupKey: canonical.fields.dedupKey, agentLane: "PARENT_TRACKING", riskScore: maxRisk(members) },
      });
    }
    await upsertComment(this.jira, epic.key, "[cursor:duplicate-group]", duplicateGroupComment(members));
  }

  private async foldIntoCanonical(canonicalKey: string, duplicateKey: string, parsed: ParsedTicket): Promise<void> {
    const canonical = await this.jira.getIssue(canonicalKey);
    const line = `Duplicate ${duplicateKey} (${parsed.wizId}) resource ${parsed.resourceName} folded into this ticket.`;
    const existing = canonical.comments.find((comment) => comment.body.includes("[cursor:intake]"));
    if (!existing) return;
    if (existing.body.includes(line)) return;
    await this.jira.updateComment(canonicalKey, existing.id, `${existing.body}\n${line}`);
  }

  private async foldedLines(canonicalKey: string): Promise<string[]> {
    const fresh = await this.jira.getIssue(canonicalKey);
    return fresh.links
      .filter((link) => link.typeName === "Duplicate" && link.thisIs === "inward")
      .map((link) => `Duplicate ${link.otherKey} folded into this ticket.`);
  }

  private async syncParent(plan: Plan): Promise<{ key: string; created: boolean }> {
    const siblings = await this.loadSiblings(plan);
    const repos = [...new Set(siblings.map((item) => item.repo))].sort();
    let parents = await this.jira.search({ kind: "parent", crossRepoKey: plan.final.crossRepoKey });
    parents.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    let created = false;
    let parent: Issue;
    const open = parents.find((item) => item.status !== this.statuses.done);
    if (open) parent = open;
    else if (parents[0]) {
      parent = parents[0];
      await this.jira.transition(parent.key, this.statuses.human);
    } else {
      const priority = siblings.reduce((current, item) => higherPriority(current, item.issue.priority), "Low");
      const risk = siblings.reduce((current, item) => Math.max(current, item.issue.fields.riskScore ?? 0), 0);
      const due = siblings.map((item) => item.issue.dueDate).filter((value) => value.length > 0).sort()[0] ?? dueDateFrom(this.now(), plan.final.slaDays);
      parent = await this.jira.createIssue({
        summary: parentSummary(plan.parsed, repos.length),
        description: parentDescription(plan.final.crossRepoKey, repos),
        issueType: this.parentIssueType,
        priority,
        labels: ["parent", "cross-repo"],
        dueDate: due,
        fields: { crossRepoKey: plan.final.crossRepoKey, agentLane: "PARENT_TRACKING", riskScore: risk },
      });
      await this.jira.transition(parent.key, this.statuses.human);
      created = true;
      parents = [parent, ...parents];
    }
    const extras = parents.filter((item) => item.key !== parent.key);
    for (const extra of extras) {
      const children = await this.jira.search({ kind: "cross-repo", crossRepoKey: plan.final.crossRepoKey, unresolved: false, excludeParentLabel: true });
      for (const child of children) {
        if (child.parentKey === extra.key) await this.jira.setParent(child.key, parent.key);
      }
      if (extra.status !== this.statuses.done) await this.jira.transition(extra.key, this.statuses.done, "Duplicate");
      await upsertComment(this.jira, extra.key, "[cursor:duplicate]", `[cursor:duplicate] SYNTHETIC DEMO\nDuplicate parent of ${parent.key}; children were moved.`);
    }
    for (const sibling of siblings) {
      if (sibling.issue.parentKey === parent.key) continue;
      await this.jira.setParent(sibling.issue.key, parent.key);
    }
    for (const sibling of siblings) await this.syncDuplicateGroup(sibling.issue.key);
    const refreshed = await this.loadSiblings(plan);
    const lines: ParentChildLine[] = refreshed.map((item) => ({
      key: item.issue.key,
      wizId: item.wizId,
      repo: item.repo,
      lane: item.issue.fields.agentLane,
      correlation: item.issue.fields.correlationGroup,
      status: item.issue.key === plan.issue.key ? disposition(plan.final.lane, this.statuses).status : item.issue.status,
      prUrl: item.issue.fields.prUrl,
      fixDifference: fixDifference(item.wizId, item.laneReason),
    }));
    const summary = parentSummary(plan.parsed, new Set(refreshed.map((item) => item.repo)).size);
    const risk = refreshed.reduce((current, item) => Math.max(current, item.issue.key === plan.issue.key ? plan.final.riskScore : item.issue.fields.riskScore ?? 0), 0);
    const priority = refreshed.reduce((current, item) => higherPriority(current, item.issue.priority), "Low");
    await this.jira.updateIssue(parent.key, {
      summary,
      priority,
      labels: ["parent", "cross-repo"],
      fields: { crossRepoKey: plan.final.crossRepoKey, agentLane: "PARENT_TRACKING", riskScore: risk },
    });
    let body = formatParentComment(lines);
    if (parents.some((item) => item.key === parent.key && item.status === this.statuses.done)) {
      body += "\nReopened because a child is open again.";
    }
    await upsertComment(this.jira, parent.key, "[cursor:parent-summary]", body);
    return { key: parent.key, created };
  }

  private async loadSiblings(plan: Plan): Promise<Array<{ issue: Issue; repo: string; wizId: string; laneReason: string }>> {
    const found = await this.jira.search({
      kind: "cross-repo",
      crossRepoKey: plan.final.crossRepoKey,
      unresolved: true,
      excludeParentLabel: true,
    });
    const byKey = new Map<string, Issue>();
    for (const issue of found) byKey.set(issue.key, issue);
    const current = byKey.get(plan.issue.key) ?? (await this.jira.getIssue(plan.issue.key));
    byKey.set(plan.issue.key, current);
    const siblings: Array<{ issue: Issue; repo: string; wizId: string; laneReason: string }> = [];
    for (const issue of byKey.values()) {
      if (issue.labels.includes("parent") || issue.fields.agentLane === "DUPLICATE" || issue.fields.agentLane === "STALE_CLOSE") continue;
      let parsed: ParsedTicket;
      try {
        parsed = parseDescription(issue.description);
      } catch {
        continue;
      }
      const repo = repoFromTicket(parsed);
      if (!repo || !issue.fields.crossRepoKey) continue;
      const laneReason = issue.key === plan.issue.key ? plan.final.laneReason : assess(parsed, this.enrichment.get(parsed.wizId)).laneReason;
      siblings.push({ issue, repo, wizId: parsed.wizId, laneReason });
    }
    return siblings;
  }

  private async related(selfKey: string, wizId: string, dedupKey: string): Promise<Issue[]> {
    const [byId, byKey] = await Promise.all([
      wizId ? this.jira.search({ kind: "wiz-id", wizId }) : Promise.resolve([]),
      this.jira.search({ kind: "dedup-key", dedupKey, unresolved: true }),
    ]);
    const map = new Map<string, Issue>();
    for (const issue of [...byId, ...byKey]) {
      if (issue.key !== selfKey) map.set(issue.key, issue);
    }
    return [...map.values()];
  }

  private async siblings(selfKey: string, crossRepoKey: string, final: Assessment): Promise<Array<{ key: string; repo: string }>> {
    const found = await this.jira.search({ kind: "cross-repo", crossRepoKey, unresolved: true, excludeParentLabel: true });
    const siblings = found
      .filter((issue) => issue.fields.agentLane !== "DUPLICATE" && issue.fields.agentLane !== "STALE_CLOSE")
      .map((issue) => {
        try {
          return { key: issue.key, repo: repoFromTicket(parseDescription(issue.description)) };
        } catch {
          return { key: issue.key, repo: "" };
        }
      })
      .filter((item) => item.repo.length > 0);
    if (!siblings.some((item) => item.key === selfKey) && final.repo) siblings.push({ key: selfKey, repo: final.repo });
    return siblings;
  }

  private candidate(issue: Issue, known?: Assessment): Candidate | undefined {
    let parsed: ParsedTicket;
    try {
      parsed = parseDescription(issue.description);
    } catch {
      return undefined;
    }
    const raw = this.enrichment.get(parsed.wizId);
    const assessment = known ?? assess(parsed, raw);
    return {
      key: issue.key,
      wizId: parsed.wizId,
      dedupKey: issue.fields.dedupKey || assessment.dedupKey,
      severity: parsed.severity,
      env: assessment.env,
      created: issue.created,
      lane: issue.fields.agentLane || assessment.lane,
      prUrl: issue.fields.prUrl,
      resolvedFinding: raw?.status === "RESOLVED",
      resolution: issue.resolution,
    };
  }

  private toResult(plan: Plan, dryRun: boolean, parentKey: string, createdParent: boolean): IntakeResult {
    return {
      issueKey: plan.issue.key,
      dryRun,
      lane: plan.final.lane,
      status: disposition(plan.final.lane, this.statuses).status,
      dedupKey: plan.final.dedupKey,
      duplicateOf: plan.duplicateOf || undefined,
      dupReason: plan.dupReason || undefined,
      crossRepoKey: plan.final.crossRepoKey || undefined,
      correlationGroup: plan.final.correlation || undefined,
      riskScore: plan.final.riskScore,
      riskFactors: plan.final.riskFactors,
      parentKey: parentKey || undefined,
      createdParent,
      repo: plan.final.repo || undefined,
      enrichment: plan.enrichmentUsed ? "used" : "ticket fields only",
    };
  }
}

function eligible(candidate: Candidate): boolean {
  return !candidate.resolvedFinding && candidate.lane !== "DUPLICATE" && candidate.lane !== "STALE_CLOSE" && candidate.resolution !== "Duplicate";
}

/** To Do and the trigger status are entry points. In Review, Done, and later verification states are not. */
export function shouldTransition(current: string, target: string, statuses: JiraStatuses = defaultJiraStatuses()): boolean {
  if (current === target) return false;
  const terminal = new Set([statuses.inReview, statuses.done, "Pending Verification", "Reopened"]);
  if (current === "To Do" || current === statuses.trigger) return !terminal.has(current) || target === statuses.done;
  if (terminal.has(current) && target !== statuses.done) return false;
  return true;
}

function duplicateGroupSummary(parsed: ParsedTicket | undefined, summary: string, count: number): string {
  const title = parsed ? findingTitle(parsed) : summary;
  return `Duplicate group: ${title} (${count} tickets)`;
}

function findingTitle(parsed: ParsedTicket): string {
  switch (parsed.findingType) {
    case "Vulnerability":
      return `${parsed.cve} in ${parsed.packageName}`;
    case "Code":
      return parsed.rule || parsed.ruleId;
    case "Secret":
      return parsed.secretType || parsed.rule;
    case "Cloud Configuration":
    case "Toxic Combination":
      return parsed.rule || parsed.wizId;
    default:
      return assertNever(parsed.findingType, "finding type");
  }
}

function duplicateGroupComment(members: Issue[]): string {
  const ordered = [...members].sort((left, right) => {
    const leftDup = left.fields.agentLane === "DUPLICATE" ? 1 : 0;
    const rightDup = right.fields.agentLane === "DUPLICATE" ? 1 : 0;
    if (leftDup !== rightDup) return leftDup - rightDup;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  const lines = ordered.map((member) => {
    const parsed = safeParse(member.description);
    const role = member.fields.agentLane === "DUPLICATE" ? "duplicate" : "canonical";
    return `- ${member.key} (${parsed?.wizId ?? ""}) ${parsed?.resourceName || member.summary}: ${member.status} ${role}`;
  });
  return `[cursor:duplicate-group] ${ordered.length} tickets. Remediation runs on the canonical ticket only.\n${lines.join("\n")}`;
}

function earliestDue(members: Issue[]): string {
  return members.map((member) => member.dueDate).filter((due) => due.length > 0).sort()[0] ?? "";
}

function maxRisk(members: Issue[]): number {
  return members.reduce((risk, member) => Math.max(risk, member.fields.riskScore ?? 0), 0);
}

function safeParse(description: string): ParsedTicket | undefined {
  try {
    return parseDescription(description);
  } catch {
    return undefined;
  }
}

function alreadyTriaged(issue: Issue): boolean {
  return issue.fields.agentLane.length > 0 && issue.comments.some((comment) => comment.body.includes("[cursor:intake]"));
}

function isTrackingParent(issue: Issue): boolean {
  if (issue.labels.includes("duplicate-group")) return true;
  if (issue.issueType.toLowerCase() === "epic") return true;
  return issue.labels.includes("parent") && issue.labels.includes("cross-repo");
}

function isDuplicateGroupEpic(issue: Issue): boolean {
  return issue.labels.includes("duplicate-group");
}

function emptyPlan(issue: Issue, parent: boolean): Plan {
  const parsed = { wizId: "" } as ParsedTicket;
  return {
    issue,
    parsed,
    final: assessPlaceholder(),
    duplicateOf: "",
    dupReason: "",
    demote: [],
    siblingKeys: [],
    parentNeeded: false,
    enrichmentUsed: false,
    skipped: parent ? "parent" : undefined,
  };
}

function assessPlaceholder(): Assessment {
  return {
    repo: "",
    env: "",
    dedupKey: "",
    fixLocation: "",
    correlation: "",
    crossRepoKey: "",
    riskScore: 0,
    riskFactors: [],
    agentPriority: "Low",
    slaDays: 90,
    lane: "HUMAN_ONLY",
    laneReason: "",
    jiraStatus: "Human Needed",
    label: "human-review",
    autoMerge: false,
  };
}

function intakeBody(plan: Plan, parentKey: string, folded: string[], status: string): string {
  return [
    "[cursor:intake] SYNTHETIC DEMO",
    `Risk score: ${plan.final.riskScore} (${plan.final.riskFactors.join("; ")})`,
    `Lane: ${plan.final.lane}`,
    `Status: ${status}`,
    `Reason: ${plan.final.laneReason}`,
    `Enrichment: ${plan.enrichmentUsed ? "used" : "ticket fields only"}`,
    `Dedup Key: ${plan.final.dedupKey}`,
    plan.final.crossRepoKey ? `Cross-Repo Key: ${plan.final.crossRepoKey}` : "",
    plan.final.correlation ? `Correlation Group: ${plan.final.correlation}` : "",
    parentKey ? `Parent: ${parentKey}` : "",
    ...folded,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function componentFor(raw: RawNode | undefined, repo: string): string {
  const owner = tagsOf(raw)["owner-team"];
  if (owner && owner !== "unknown") return owner;
  const project = raw?.projects?.find((item) => item.name)?.name ?? "";
  if (project.includes("Payments")) return "payments";
  if (project.includes("Orders")) return "orders";
  if (project.includes("Platform")) return "platform";
  if (repo.endsWith("/payments-api")) return "payments";
  if (repo.endsWith("/orders-service")) return "orders";
  if (repo.endsWith("/platform-infra")) return "platform";
  return "";
}
