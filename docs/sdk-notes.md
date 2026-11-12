# Cursor SDK notes for this orchestrator

Verified on 2026-11-12 against the published package `@cursor/sdk@1.3.1` (npm, `engines.node >= 22.13`) and the public docs:

- https://cursor.com/docs/sdk/typescript
- https://cursor.com/docs/cloud-agent/api/endpoints
- https://cursor.com/blog/typescript-sdk

The type declarations in the 1.3.1 tarball (`dist/esm/options.d.ts`, `run.d.ts`, `agent.d.ts`, `stubs.d.ts`, `messages.d.ts`) match the shapes below. This environment did not launch a live cloud agent, so the snapshot-vs-stream behavior called out under Polling is an assumption.

## Package and auth

Install `npm install @cursor/sdk`. The bare name `cursor/sdk` is not the package.

```ts
import { Agent } from "@cursor/sdk";
```

Auth resolution order:

1. `apiKey` passed to `Agent.create`, `Agent.resume`, `Agent.getRun`, and the other cloud helpers.
2. `process.env.CURSOR_API_KEY`.
3. A key stored by `Cursor.auth.login()` (interactive browser login, not used here).

The SDK accepts a user API key (Cursor Dashboard → API Keys) and a team service-account key. Team Admin API keys are not supported. Both key kinds use the same `apiKey` / `CURSOR_API_KEY` slot. This service passes `apiKey` explicitly from `CURSOR_API_KEY`.

## Launching a cloud agent on a repo and ref

Runtime is chosen by which key you pass to `Agent.create`. `cloud` runs on a Cursor-hosted VM (or a self-hosted pool or machine). `agent.agentId` is available immediately and uses a `bc-` prefix for cloud agents.

```ts
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY,
  model: { id: "composer-2.5" }, // optional for cloud; the server default is used when omitted
  name: "Security JWF-8",
  idempotencyKey: "wiz-factory:calwatson/payments-api:JWF-8",
  cloud: {
    repos: [{ url: "https://github.com/calwatson/payments-api", startingRef: "main" }],
    autoCreatePR: true,
    skipReviewerRequest: true,
    metadata: { jiraKey: "JWF-8", branch: "security/JWF-8-cve-2022-23540" },
  },
});
const run = await agent.send(prompt, { idempotencyKey: "wiz-factory:...:send" });
```

Relevant `CloudAgentOptions` fields in 1.3.1:

| Field | Role |
|---|---|
| `repos[].url` | Repository URL on a connected source provider. Required on every entry. |
| `repos[].startingRef` | Git ref to clone. |
| `repos[].prUrl` | Attach the agent to an existing PR instead. |
| `autoCreatePR` | Open a PR when the run finishes. Default `false`. |
| `workOnCurrentBranch` | Push to the cloned branch instead of a new one. Default `false`. |
| `skipReviewerRequest` | Do not request the calling user as a reviewer. Does not remove CODEOWNERS. |
| `openAsCursorGithubApp` | Open the PR as the Cursor GitHub App. Default true for service-account keys and false for user keys. Left unset here so that default applies. |
| `envVars` | Session env vars. Names cannot start with `CURSOR_`. Not available for public repositories. |
| `metadata` | Caller-owned string tags persisted on the agent. |
| `env` | `{ type: "cloud" \| "pool" \| "machine", name? }`. Default cloud VM. Named cloud environments and explicit `repos` are mutually exclusive. |

`model` is optional for cloud. Local agents require it. `tools`, `disallowedTools`, and `systemPrompt` are local-only; combining any of them with `cloud` throws `ConfigurationError`. The remediation instructions therefore go in `agent.send()`, not `systemPrompt`.

The caller must already have connected the repository's source provider in Cursor. Repository-scoped keys cannot create no-repo agents; this factory always passes one repo.

## Polling status

There is no separate "GET status" helper beyond reattaching to the run.

- `Run.status` is `"running" | "finished" | "error" | "cancelled"`.
- `run.onDidChangeStatus(listener)` fires when that value changes.
- `run.wait()` resolves with a `RunResult` once the run is terminal.
- `run.stream()` yields `SDKMessage` events. The cloud lifecycle event is `type: "status"` with `status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED"`. `CREATING` covers VM provisioning and clone.
- `Agent.getRun(runId, { runtime: "cloud", agentId, apiKey })` reattaches. Cloud `getRun` requires the parent `agentId`.
- `Agent.get(agentId)` returns agent metadata whose `status` is `"running" | "finished" | "error"` for the latest run, which is coarser than `Run.status`.

`src/sdk/poll.ts` loops on `Agent.getRun` at `AGENT_POLL_INTERVAL_MS`. When the snapshot is terminal and has no PR URL, or when `AGENT_POLL_MAX_MS` elapses while the snapshot stays `running`, it calls `run.wait()`. That fallback is the supported completion API if a reattached handle does not refresh `status` until something subscribes.

Cloud Agents API v1 webhooks are documented as coming soon (legacy v0 still has them). This orchestrator polls instead of waiting for a Cursor webhook.

## PR URL

After `autoCreatePR: true`, the URL is on the terminal result:

```ts
const result = await run.wait();
const prUrl = result.git?.branches.find((branch) => branch.prUrl)?.prUrl;
```

`RunGitInfo` is `{ branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> }`. The same `git` field is on the `Run` handle. `Agent.list({ runtime: "cloud", prUrl })` can find the agent that opened a known PR. There is no separate "get pull request" method.

## MCP

MCP can be attached to a cloud agent. It is not required, and this factory does not attach one.

Cloud agents load servers from:

1. `mcpServers` on `agent.send()` (replaces creation-time inline servers for that run).
2. `mcpServers` on `Agent.create()`.
3. User and team MCP servers configured at cursor.com/agents.

`local.settingSources` does not apply to cloud. HTTP `headers` and `auth` are proxied by Cursor's backend and redacted before the VM sees them. Stdio `env` is injected into the VM. Cloud stdio rejects `cwd`. Inline MCP servers are not persisted across `Agent.resume`. Service-account keys cannot fall back to a user's saved OAuth.

The Cloud Agents REST API accepts the same idea as an `mcpServers` array on `POST /v1/agents` (max 50).

## Gaps this design works around

| Gap | What the orchestrator does |
|---|---|
| No Jira integration in the SDK | Jira REST stays in this process. The agent prompt contains the hydrated ticket text and says not to write to Jira. |
| MCP could carry a Jira token into the VM (stdio) or the Cursor backend (HTTP headers) | No `mcpServers` are set. Handoff writes happen here after the run. |
| No branch-name parameter. `workOnCurrentBranch` only pushes the cloned ref | The prompt tells the agent to create `security/<jira-key>-<slug>`. The recorded branch is `result.git.branches[].branch`, falling back to the requested name. |
| No auto-merge flag | The prompt tells the agent to run `gh pr merge --auto` only when every ticket in the group is labeled `cursor-agent-autopilot`. |
| v1 has no completion webhook | Poll `Agent.getRun`, then `run.wait()`. |
| `systemPrompt` cannot be set on cloud agents | Instructions are the user message. |

Assumption: `autoCreatePR` opens the PR for the branch the agent pushed. If the SDK uses a different branch name than the one in the prompt, the Jira `PR URL` field still receives the URL the SDK reports.
