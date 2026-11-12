export interface CliArgs {
  command: "serve" | "intake" | "remediate" | "run-scenario" | "help";
  issueKey?: string;
  scenario?: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((arg) => arg !== "--dry-run");
  const [command, value] = positional;
  if (!command || command === "help" || command === "--help") return { command: "help", dryRun };
  if (command === "serve") return { command, dryRun };
  if (command === "intake" || command === "remediate") {
    if (!value) throw new Error(`${command} requires a Jira issue key.`);
    return { command, issueKey: value, dryRun };
  }
  if (command === "run-scenario") {
    if (!value) throw new Error("run-scenario requires a scenario name. Use: jwt");
    return { command, scenario: value, dryRun };
  }
  throw new Error(`Unknown command ${command}.`);
}

export const USAGE = `wiz-factory (SYNTHETIC demo)

  wiz-factory serve
  wiz-factory intake <JWF-n> [--dry-run]
  wiz-factory remediate <JWF-n> [--dry-run]
  wiz-factory run-scenario jwt [--dry-run]

--dry-run reads enough to build the plan and does not call the Cursor API.
run-scenario jwt --dry-run stays on an in-memory board (no Jira HTTP).
Without --dry-run, run-scenario jwt creates the three synthetic tickets in Jira if they are missing.
`;
