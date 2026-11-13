import type { FactoryConfig } from "../src/config.js";
import type { NativeTicket } from "../src/factory/csv.js";
import { MemoryJira } from "../src/jira/memory.js";

export function testConfig(): FactoryConfig {
  return {
    jiraBaseUrl: "https://fe-anysphere-demo.atlassian.net",
    jiraEmail: "demo-user@example.com",
    jiraApiToken: "replace-with-jira-api-token",
    jiraProjectKey: "JWF",
    parentIssueType: "Epic",
    webhookSecret: "test-secret",
    cursorApiKey: "cursor_test",
    modelId: "composer-2.5",
    githubOwner: "calwatson",
    startingRef: "main",
    port: 0,
    pollIntervalMs: 5,
    pollMaxMs: 20,
    skipReviewerRequest: true,
    dataDir: "data",
    logPayloads: true,
    fieldOverrides: {},
  };
}

export async function seedTicket(jira: MemoryJira, ticket: NativeTicket, key = ticket.ref): Promise<void> {
  await jira.createIssue({
    key,
    summary: ticket.summary,
    description: ticket.description,
    issueType: ticket.issueType,
    priority: ticket.priority,
    labels: ticket.labels,
    created: ticket.created,
  });
}
