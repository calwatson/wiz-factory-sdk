#!/usr/bin/env node
import { parseArgs, USAGE } from "./args.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { loadEnrichment } from "./factory/enrich.js";
import { HttpJira } from "./jira/http.js";
import { MemoryJira } from "./jira/memory.js";
import { Orchestrator } from "./orchestrator.js";
import { runJwtScenario } from "./scenario.js";
import { createWebhookServer } from "./server.js";
import { CursorSdkLauncher } from "./sdk/cursor-cloud.js";
import type { CloudLauncher } from "./sdk/types.js";

class DryRunLauncher implements CloudLauncher {
  async launch(): Promise<never> {
    throw new Error("Dry run does not launch a Cursor cloud agent.");
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(USAGE);
    return;
  }
  if (args.command === "run-scenario") {
    if (args.scenario !== "jwt") throw new Error(`Unknown scenario ${args.scenario ?? ""}. Use jwt.`);
    if (args.dryRun) {
      const config = loadConfig(process.env, { requireCursor: false, requireJira: false, requireWebhook: false });
      const jira = new MemoryJira(config.jiraProjectKey);
      const orchestrator = new Orchestrator(jira, loadEnrichment(config.dataDir), new DryRunLauncher(), config);
      const report = await runJwtScenario({ orchestrator, jira, dataDir: config.dataDir, dryRun: true });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const config = loadConfig(process.env, { requireCursor: true, requireJira: true, requireWebhook: false });
    const jira = new HttpJira(config);
    const orchestrator = new Orchestrator(jira, loadEnrichment(config.dataDir), new CursorSdkLauncher(), config);
    console.error("SYNTHETIC scenario jwt: creating any missing JWF tickets, then intake and remediate.");
    const report = await runJwtScenario({ orchestrator, jira, dataDir: config.dataDir, dryRun: false });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.command === "serve") {
    const config = loadConfig(process.env, { requireCursor: true, requireJira: true, requireWebhook: true });
    const orchestrator = new Orchestrator(new HttpJira(config), loadEnrichment(config.dataDir), new CursorSdkLauncher(), config);
    const server = createWebhookServer({
      orchestrator,
      webhookSecret: config.webhookSecret,
      logPayloads: config.logPayloads,
    });
    server.listen(config.port, () => {
      console.error(`wiz-factory listening on :${config.port} (SYNTHETIC demo)`);
    });
    return;
  }
  const config = loadConfig(process.env, { requireCursor: !args.dryRun, requireJira: true, requireWebhook: false });
  const orchestrator = new Orchestrator(
    new HttpJira(config),
    loadEnrichment(config.dataDir),
    args.dryRun ? new DryRunLauncher() : new CursorSdkLauncher(),
    config,
  );
  const issueKey = args.issueKey ?? "";
  const result = args.command === "intake"
    ? await orchestrator.intake(issueKey, args.dryRun)
    : await orchestrator.remediate(issueKey, args.dryRun);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
