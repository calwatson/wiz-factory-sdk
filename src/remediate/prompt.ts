export interface PromptTicket {
  key: string;
  wizId: string;
  lane: string;
  fixLocation: string;
  fixDifference: string;
  description: string;
  autopilot: boolean;
}

export function remediationPrompt(input: {
  githubRepo: string;
  branch: string;
  repoName: string;
  autoMerge: boolean;
  tickets: PromptTicket[];
}): string {
  const tests = input.tickets
    .map((ticket) =>
      input.repoName === "platform-infra"
        ? `${ticket.key}: add a failing IaC policy test for ${ticket.wizId} before changing the Terraform`
        : `${ticket.key}: write test/security/${ticket.wizId}.test.js and run it so it FAILS on the base branch before the fix`,
    )
    .join("\n");
  const tickets = input.tickets
    .map(
      (ticket) =>
        `### ${ticket.key} (${ticket.wizId}) lane ${ticket.lane}\nFix location: ${ticket.fixLocation}\nHint from intake (confirm against the code; do not skip reading it): ${ticket.fixDifference}\n\n${ticket.description}`,
    )
    .join("\n\n");
  const autoMerge = input.autoMerge
    ? "Every ticket in this pull request is labeled cursor-agent-autopilot. After the PR exists, enable GitHub auto-merge (gh pr merge --auto --squash) and do not request an extra human review beyond CODEOWNERS."
    : "Do not enable GitHub auto-merge. This change needs human review. Leave the PR open for CODEOWNERS.";
  return [
    "You are the remediation agent for a SYNTHETIC security-factory demo. No real customer data is involved.",
    "Do not write to Jira. Do not post to Slack or any chat. The orchestrator records the PR on the Jira ticket after you finish.",
    `Work only in ${input.githubRepo}. Do not push to any other repository.`,
    `Create branch ${input.branch} from the cloned ref and put every commit on that branch.`,
    "One pull request for the whole correlation group listed below. A parent Epic never gets a pull request.",
    "Write the reproduction test first and show it failing before the fix. Then make the smallest change that makes that test pass and keeps the existing suite passing.",
    "Keep the diff inside the fix scope of these tickets.",
    autoMerge,
    "Pull request title: `[<jira-key>] <fix>`. Body: Jira keys, Wiz issue ids, reproduction test name, before/after test result, and the parent key if one was named in the ticket.",
    "",
    "Reproduction tests:",
    tests,
    "",
    "Hydrated tickets:",
    tickets,
  ].join("\n");
}
