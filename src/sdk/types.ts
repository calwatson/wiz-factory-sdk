export interface CloudLaunchRequest {
  apiKey: string;
  modelId?: string;
  name: string;
  idempotencyKey: string;
  repoUrl: string;
  startingRef: string;
  autoCreatePR: true;
  skipReviewerRequest: boolean;
  metadata: Record<string, string>;
  prompt: string;
  pollIntervalMs: number;
  pollMaxMs: number;
}

export interface CloudLaunchResult {
  agentId: string;
  runId: string;
  status: "finished" | "error" | "cancelled";
  prUrl?: string;
  branch?: string;
  resultText?: string;
  statusLog: string[];
}

export interface CloudLauncher {
  launch(request: CloudLaunchRequest): Promise<CloudLaunchResult>;
}
