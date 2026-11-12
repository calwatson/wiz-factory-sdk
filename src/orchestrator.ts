import type { FactoryConfig } from "./config.js";
import type { EnrichmentIndex } from "./factory/enrich.js";
import { IntakeService, type IntakeResult } from "./intake.js";
import type { JiraClient } from "./jira/types.js";
import { RemediateService, type RemediateResult } from "./remediate.js";
import type { CloudLauncher } from "./sdk/types.js";

export class Orchestrator {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly intakeService: IntakeService;
  readonly remediateService: RemediateService;

  constructor(
    private readonly jira: JiraClient,
    enrichment: EnrichmentIndex,
    launcher: CloudLauncher,
    config: FactoryConfig,
    now: () => Date = () => new Date(),
  ) {
    this.intakeService = new IntakeService(jira, enrichment, now, config.parentIssueType);
    this.remediateService = new RemediateService(jira, launcher, config);
  }

  intake(issueKey: string, dryRun: boolean): Promise<IntakeResult> {
    return this.lock(`issue:${issueKey}`, () => this.intakeService.run(issueKey, dryRun));
  }

  remediate(issueKey: string, dryRun: boolean): Promise<RemediateResult> {
    return this.lock(`remediate:${issueKey}`, () => this.remediateService.run(issueKey, dryRun));
  }

  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
