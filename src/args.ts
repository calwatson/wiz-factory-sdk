export interface ResetFlags {
  yes: boolean;
  project?: string;
  label: string;
  reload: boolean;
  github: boolean;
}

export interface CliArgs {
  command: "serve" | "intake" | "remediate" | "run-scenario" | "reset" | "help";
  issueKey?: string;
  scenario?: string;
  dryRun: boolean;
  reset?: ResetFlags;
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
  if (command === "reset") {
    const yes = argv.includes("--yes");
    return {
      command,
      dryRun: !yes,
      reset: {
        yes,
        project: option(argv, "--project"),
        label: option(argv, "--label") ?? "",
        reload: argv.includes("--reload"),
        github: argv.includes("--github"),
      },
    };
  }
  throw new Error(`Unknown command ${command}.`);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export const USAGE = `wiz-factory (SYNTHETIC demo)

  wiz-factory serve
  wiz-factory intake <JWF-n> [--dry-run]
  wiz-factory remediate <JWF-n> [--dry-run]
  wiz-factory run-scenario jwt [--dry-run]
  wiz-factory reset [--yes] [--project JWF] [--label wiz] [--reload] [--github]

--dry-run reads enough to build the plan and does not call the Cursor API.
reset is a dry run unless --yes. It does not need CURSOR_API_KEY or WEBHOOK_SECRET.
run-scenario jwt --dry-run stays on an in-memory board (no Jira HTTP).
Without --dry-run, run-scenario jwt creates the three synthetic tickets in Jira if they are missing.
`;
