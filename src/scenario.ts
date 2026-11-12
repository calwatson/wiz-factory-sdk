import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadNativeTickets, type NativeTicket } from "./factory/csv.js";
import type { IntakeResult } from "./intake.js";
import type { JiraClient } from "./jira/types.js";
import type { Orchestrator } from "./orchestrator.js";
import type { RemediateResult } from "./remediate.js";

const JWT_REFS = [
  { ref: "T08", wizId: "vf-0010" },
  { ref: "T42", wizId: "vf-0020" },
  { ref: "T43", wizId: "vf-0021" },
] as const;

export interface JwtScenarioReport {
  scenario: "jwt";
  synthetic: true;
  dryRun: boolean;
  crossRepoKey: "vuln:cve-2022-23540:jsonwebtoken";
  issues: Array<{ ref: string; wizId: string; key: string }>;
  intakes: IntakeResult[];
  remediations: RemediateResult[];
  parentKey?: string;
}

export function loadJwtTickets(dataDir: string): NativeTicket[] {
  const csv = readFileSync(join(dataDir, "jira_wiz_native_tickets.csv"), "utf8");
  const tickets = loadNativeTickets(csv);
  return JWT_REFS.map((spec) => {
    const ticket = tickets.find((item) => item.ref === spec.ref);
    if (!ticket) throw new Error(`SYNTHETIC ticket ${spec.ref} is missing from the CSV.`);
    return ticket;
  });
}

export async function runJwtScenario(options: {
  orchestrator: Orchestrator;
  jira: JiraClient;
  dataDir: string;
  dryRun: boolean;
}): Promise<JwtScenarioReport> {
  const tickets = loadJwtTickets(options.dataDir);
  const issues: JwtScenarioReport["issues"] = [];
  for (const ticket of tickets) {
    const wizId = /Wiz Issue ID: (\S+)/.exec(ticket.description)?.[1] ?? "";
    const existing = await options.jira.search({ kind: "wiz-id", wizId });
    const issue = existing[0] ?? (await options.jira.createIssue({
      summary: ticket.summary,
      description: ticket.description,
      issueType: ticket.issueType,
      priority: ticket.priority,
      labels: ticket.labels,
      created: ticket.created,
    }));
    issues.push({ ref: ticket.ref, wizId, key: issue.key });
  }
  const intakes: IntakeResult[] = [];
  for (const issue of issues) {
    intakes.push(await options.orchestrator.intake(issue.key, false));
  }
  const remediations: RemediateResult[] = [];
  for (const issue of issues) {
    remediations.push(await options.orchestrator.remediate(issue.key, options.dryRun));
  }
  const parents = await options.jira.search({ kind: "parent", crossRepoKey: "vuln:cve-2022-23540:jsonwebtoken" });
  const report: JwtScenarioReport = {
    scenario: "jwt",
    synthetic: true,
    dryRun: options.dryRun,
    crossRepoKey: "vuln:cve-2022-23540:jsonwebtoken",
    issues,
    intakes,
    remediations,
  };
  const parentKey = parents[0]?.key;
  if (parentKey) report.parentKey = parentKey;
  return report;
}
