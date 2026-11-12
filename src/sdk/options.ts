import type { AgentOptions } from "@cursor/sdk";
import type { CloudLaunchRequest } from "./types.js";

/**
 * Shape passed to Agent.create for a cloud remediation run.
 * MCP is intentionally omitted: Jira writes stay in the orchestrator.
 * `tools` and `systemPrompt` are local-only in @cursor/sdk 1.3.1 and throw if combined with `cloud`.
 */
export function cloudCreateOptions(request: CloudLaunchRequest): AgentOptions {
  const options: AgentOptions = {
    apiKey: request.apiKey,
    name: request.name,
    idempotencyKey: request.idempotencyKey,
    cloud: {
      repos: [{ url: request.repoUrl, startingRef: request.startingRef }],
      autoCreatePR: request.autoCreatePR,
      skipReviewerRequest: request.skipReviewerRequest,
      metadata: request.metadata,
    },
  };
  if (request.modelId) options.model = { id: request.modelId };
  return options;
}
