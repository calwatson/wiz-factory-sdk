import type { FactoryConfig } from "./config.js";
import { isActionableLane } from "./factory/gate.js";
import { fixDifference } from "./factory/maps.js";
import { formatParentComment, type ParentChildLine } from "./factory/parents.js";
import { parseDescription, type ParsedTicket } from "./factory/parse.js";
import { repoFromTicket } from "./factory/score.js";
import { upsertComment } from "./jira/comments.js";
import type { Issue, JiraClient } from "./jira/types.js";
import { remediationPrompt, type PromptTicket } from "./remediate/prompt.js";
import { routeTicket, securityBranch } from "./remediate/route.js";
import type { CloudLauncher, CloudLaunchRequest, CloudLaunchResult } from "./sdk/types.js";

export interface RemediateResult {
  issueKey: string;
  dryRun: boolean;
  skipped?: "parent" | "duplicate" | "not-actionable" | "unroutable" | "no-pr";
  reason?: string;
  githubRepo?: string;
  branch?: string;
  autoMerge?: boolean;
  agentId?: string;
  runId?: string;
  prUrl?: string;
  prompt?: string;
  members?: string[];
}

export class RemediateService {
  private readonly inflight = new Map<string, Promise<CloudLaunchResult>>();

  constructor(
    private readonly jira: JiraClient,
    private readonly launcher: CloudLauncher,
    private readonly config: Pick<FactoryConfig, "cursorApiKey" | "modelId" | "githubOwner" | "startingRef" | "pollIntervalMs" | "pollMaxMs" | "skipReviewerRequest">,
  ) {}

  async run(issueKey: string, dryRun: boolean): Promise<RemediateResult> {
    const issue = await this.jira.getIssue(issueKey);
    if (isParent(issue)) {
      const existing = issue.comments.find((comment) => comment.body.includes("[cursor:parent-summary]") || comment.body.includes("[cursor:remediate-skip]"));
      if (!existing && !dryRun) {
        await this.jira.addComment(issue.key, "[cursor:remediate-skip] Parent ticket: remediation runs on its children.");
      }
      return { issueKey, dryRun, skipped: "parent", reason: "Parent ticket: remediation runs on its children." };
    }
    if (issue.fields.agentLane === "DUPLICATE" || issue.resolution === "Duplicate") {
      return { issueKey, dryRun, skipped: "duplicate", reason: "Duplicate tickets are not remediated." };
    }
    if (!isActionableLane(issue.fields.agentLane) && issue.fields.agentLane !== "PR_OPEN") {
      const reason = `Lane ${issue.fields.agentLane || "unset"} is not launched as a cloud agent.`;
      if (!dryRun) await upsertComment(this.jira, issue.key, "[cursor:remediate-skip]", `[cursor:remediate-skip] SYNTHETIC DEMO\n${reason}`);
      return { issueKey, dryRun, skipped: "not-actionable", reason };
    }
    let parsed: ParsedTicket;
    try {
      parsed = parseDescription(issue.description);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unreadable ticket.";
      return { issueKey, dryRun, skipped: "unroutable", reason };
    }
    const routed = routeTicket(parsed, this.config.githubOwner);
    if (!routed.ok) {
      if (!dryRun) await upsertComment(this.jira, issue.key, "[cursor:remediate-skip]", `[cursor:remediate-skip] SYNTHETIC DEMO\n${routed.reason}`);
      return { issueKey, dryRun, skipped: "unroutable", reason: routed.reason };
    }
    const members = await this.members(issue, routed.route.wizRepo);
    const branch = securityBranch(issue.key, parsed);
    const autoMerge = members.every((member) => member.labels.includes("cursor-agent-autopilot"));
    const prompt = remediationPrompt({
      githubRepo: routed.route.githubRepo,
      branch,
      repoName: routed.route.repoName,
      autoMerge,
      tickets: members.map((member) => toPromptTicket(member)),
    });
    const existingPr = members.find((member) => member.fields.prUrl)?.fields.prUrl ?? "";
    if (existingPr) {
      if (!dryRun) await this.handoff(members, existingPr, branch, "Joined the correlation group's existing pull request.");
      return { issueKey, dryRun, githubRepo: routed.route.githubRepo, branch, autoMerge, prUrl: existingPr, members: members.map((member) => member.key), prompt };
    }
    const request: CloudLaunchRequest = {
      apiKey: this.config.cursorApiKey,
      modelId: this.config.modelId,
      name: `Security ${issue.key}`,
      idempotencyKey: `wiz-factory:${routed.route.githubRepo}:${issue.fields.correlationGroup || issue.key}`,
      repoUrl: `https://github.com/${routed.route.githubRepo}`,
      startingRef: this.config.startingRef,
      autoCreatePR: true,
      skipReviewerRequest: this.config.skipReviewerRequest,
      metadata: {
        synthetic: "true",
        jiraKey: issue.key,
        correlationGroup: issue.fields.correlationGroup,
        branch,
        githubRepo: routed.route.githubRepo,
      },
      prompt,
      pollIntervalMs: this.config.pollIntervalMs,
      pollMaxMs: this.config.pollMaxMs,
    };
    if (dryRun) {
      return { issueKey, dryRun, githubRepo: routed.route.githubRepo, branch, autoMerge, prompt, members: members.map((member) => member.key) };
    }
    for (const member of members) {
      if (member.status === "Ready for Agent" || member.status === "To Do") {
        await this.jira.transition(member.key, "In Progress");
      }
    }
    const lockKey = `${routed.route.githubRepo}:${issue.fields.correlationGroup || issue.key}`;
    const launched = await this.launchOnce(lockKey, request);
    if (launched.status !== "finished" || !launched.prUrl) {
      const reason = launched.resultText || `Cloud agent ${launched.agentId} ended ${launched.status} without a pull request URL.`;
      await this.handoff(members, "", launched.branch || branch, reason, true);
      return {
        issueKey,
        dryRun,
        skipped: "no-pr",
        reason,
        githubRepo: routed.route.githubRepo,
        branch,
        autoMerge,
        agentId: launched.agentId,
        runId: launched.runId,
        members: members.map((member) => member.key),
      };
    }
    await this.handoff(members, launched.prUrl, launched.branch || branch, launched.resultText ?? "Cloud agent finished.");
    return {
      issueKey,
      dryRun,
      githubRepo: routed.route.githubRepo,
      branch: launched.branch || branch,
      autoMerge,
      agentId: launched.agentId,
      runId: launched.runId,
      prUrl: launched.prUrl,
      members: members.map((member) => member.key),
    };
  }

  private async members(issue: Issue, wizRepo: string): Promise<Issue[]> {
    if (!issue.fields.correlationGroup) return [issue];
    const found = await this.jira.search({ kind: "correlation", correlationGroup: issue.fields.correlationGroup, unresolved: true });
    const group = found.filter((member) => {
      if (!isActionableLane(member.fields.agentLane) && member.fields.agentLane !== "PR_OPEN" && member.key !== issue.key) return false;
      try {
        return repoFromTicket(parseDescription(member.description)) === wizRepo;
      } catch {
        return false;
      }
    });
    if (!group.some((member) => member.key === issue.key)) group.push(issue);
    return group;
  }

  private launchOnce(lockKey: string, request: CloudLaunchRequest): Promise<CloudLaunchResult> {
    const existing = this.inflight.get(lockKey);
    if (existing) return existing;
    const pending = this.launcher.launch(request);
    this.inflight.set(lockKey, pending);
    pending.then(
      () => this.inflight.delete(lockKey),
      () => this.inflight.delete(lockKey),
    );
    return pending;
  }

  private async handoff(members: Issue[], prUrl: string, branch: string, summary: string, failed = false): Promise<void> {
    const parents = new Set<string>();
    for (const member of members) {
      const fresh = await this.jira.getIssue(member.key);
      if (!failed && prUrl) {
        await this.jira.updateIssue(fresh.key, { fields: { ...fresh.fields, prUrl, agentLane: "PR_OPEN" } });
        if (fresh.status !== "In Review" && fresh.status !== "Pending Verification" && fresh.status !== "Done") {
          await this.jira.transition(fresh.key, "In Review");
        }
      }
      const parsed = safeParse(fresh.description);
      const testName = parsed ? `test/security/${parsed.wizId}.test.js` : "reproduction test";
      const body = failed
        ? `[cursor:handoff] SYNTHETIC DEMO\nCloud agent did not open a pull request.\n${summary}`
        : `[cursor:handoff] SYNTHETIC DEMO\nPR: ${prUrl}\nBranch: ${branch}\nReproduction test: ${testName}\nWhat changed: ${summary.slice(0, 700)}`;
      await upsertComment(this.jira, fresh.key, "[cursor:handoff]", body);
      if (fresh.parentKey) parents.add(fresh.parentKey);
    }
    for (const parentKey of parents) await this.refreshParent(parentKey);
  }

  private async refreshParent(parentKey: string): Promise<void> {
    const parent = await this.jira.getIssue(parentKey);
    if (!parent.fields.crossRepoKey) return;
    const children = await this.jira.search({
      kind: "cross-repo",
      crossRepoKey: parent.fields.crossRepoKey,
      unresolved: false,
      excludeParentLabel: true,
    });
    const linked = children.filter((child) => child.parentKey === parentKey && child.fields.agentLane !== "DUPLICATE");
    const lines: ParentChildLine[] = [];
    for (const child of linked) {
      const parsed = safeParse(child.description);
      if (!parsed) continue;
      lines.push({
        key: child.key,
        wizId: parsed.wizId,
        repo: repoFromTicket(parsed),
        lane: child.fields.agentLane,
        correlation: child.fields.correlationGroup,
        status: child.status,
        prUrl: child.fields.prUrl,
        fixDifference: fixDifference(parsed.wizId, child.fields.fixLocation),
      });
    }
    if (lines.length === 0) return;
    await upsertComment(this.jira, parent.key, "[cursor:parent-summary]", formatParentComment(lines));
  }
}

function isParent(issue: Issue): boolean {
  return issue.issueType.toLowerCase() === "epic" || issue.labels.includes("parent") || issue.fields.agentLane === "PARENT_TRACKING";
}

function toPromptTicket(issue: Issue): PromptTicket {
  const parsed = safeParse(issue.description);
  return {
    key: issue.key,
    wizId: parsed?.wizId ?? "",
    lane: issue.fields.agentLane,
    fixLocation: issue.fields.fixLocation,
    fixDifference: fixDifference(parsed?.wizId ?? "", issue.fields.fixLocation),
    description: issue.description,
    autopilot: issue.labels.includes("cursor-agent-autopilot"),
  };
}

function safeParse(description: string): ParsedTicket | undefined {
  try {
    return parseDescription(description);
  } catch {
    return undefined;
  }
}
