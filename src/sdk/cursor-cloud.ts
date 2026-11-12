import { Agent, type Run } from "@cursor/sdk";
import { pollUntilSettled, type RunSnapshot } from "./poll.js";
import { cloudCreateOptions } from "./options.js";
import type { CloudLauncher, CloudLaunchRequest, CloudLaunchResult } from "./types.js";

function snapshotOf(run: Pick<Run, "status" | "git" | "result">): RunSnapshot {
  const branch = run.git?.branches.find((item) => item.prUrl) ?? run.git?.branches.find((item) => item.branch);
  const status = run.status === "running" ? "running" : run.status;
  return {
    status,
    prUrl: branch?.prUrl,
    branch: branch?.branch,
    resultText: run.result,
  };
}

export class CursorSdkLauncher implements CloudLauncher {
  async launch(request: CloudLaunchRequest): Promise<CloudLaunchResult> {
    const agent = await Agent.create(cloudCreateOptions(request));
    try {
      const run = await agent.send(request.prompt, { idempotencyKey: `${request.idempotencyKey}:send` });
      const polled = await pollUntilSettled({
        read: async () => snapshotOf(await Agent.getRun(run.id, { runtime: "cloud", agentId: agent.agentId, apiKey: request.apiKey })),
        waitForResult: async () => snapshotOf(await run.wait()),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        intervalMs: request.pollIntervalMs,
        maxMs: request.pollMaxMs,
      });
      const status = polled.snapshot.status === "running" ? "error" : polled.snapshot.status;
      return {
        agentId: agent.agentId,
        runId: run.id,
        status,
        prUrl: polled.snapshot.prUrl,
        branch: polled.snapshot.branch ?? request.metadata.branch,
        resultText: polled.snapshot.resultText,
        statusLog: polled.statusLog,
      };
    } finally {
      agent.close();
    }
  }
}
