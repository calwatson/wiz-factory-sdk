export interface RunSnapshot {
  status: "running" | "finished" | "error" | "cancelled";
  prUrl?: string;
  branch?: string;
  resultText?: string;
}

export async function pollUntilSettled(options: {
  read: () => Promise<RunSnapshot>;
  waitForResult: () => Promise<RunSnapshot>;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  maxMs: number;
  now?: () => number;
}): Promise<{ snapshot: RunSnapshot; statusLog: string[] }> {
  const now = options.now ?? Date.now;
  const started = now();
  const statusLog: string[] = [];
  let latest: RunSnapshot = { status: "running" };
  while (now() - started <= options.maxMs) {
    latest = await options.read();
    statusLog.push(latest.status);
    if (latest.status !== "running") {
      if (latest.status === "finished" && !latest.prUrl) {
        const waited = await options.waitForResult();
        statusLog.push(waited.status);
        return { snapshot: waited, statusLog };
      }
      return { snapshot: latest, statusLog };
    }
    if (now() - started + options.intervalMs > options.maxMs) break;
    await options.sleep(options.intervalMs);
  }
  const waited = await options.waitForResult();
  statusLog.push(waited.status);
  return { snapshot: waited, statusLog };
}
