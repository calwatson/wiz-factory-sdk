import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!expected || provided === undefined) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createWebhookServer(options: { orchestrator: Orchestrator; webhookSecret: string }) {
  return createServer((request, response) => {
    void handle(request, response, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Server error";
      send(response, 500, { error: message });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: { orchestrator: Orchestrator; webhookSecret: string },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/healthz") {
    send(response, 200, { ok: true, synthetic: true });
    return;
  }
  if (request.method !== "POST" || (url.pathname !== "/intake" && url.pathname !== "/remediate")) {
    send(response, 404, { error: "Not found" });
    return;
  }
  const header = request.headers["x-webhook-secret"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!secretsMatch(provided, options.webhookSecret)) {
    send(response, 401, { error: "Unauthorized" });
    return;
  }
  const body = await readBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    send(response, 400, { error: "Expected JSON." });
    return;
  }
  const issueKey = issueKeyOf(parsed);
  if (!issueKey) {
    send(response, 400, { error: 'Expected {"issueKey":"JWF-1"}.' });
    return;
  }
  const wait = url.searchParams.get("wait") === "1";
  const run = url.pathname === "/intake"
    ? options.orchestrator.intake(issueKey, false)
    : options.orchestrator.remediate(issueKey, false);
  if (!wait) {
    void run.catch((error: unknown) => {
      console.error(`${url.pathname} ${issueKey} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    send(response, 202, { accepted: true, issueKey, path: url.pathname });
    return;
  }
  try {
    send(response, 200, await run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    send(response, 500, { error: message, issueKey });
  }
}

function issueKeyOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("issueKey" in value)) return undefined;
  const key = (value as { issueKey?: unknown }).issueKey;
  return typeof key === "string" && ISSUE_KEY.test(key) ? key : undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000) {
        reject(new Error("Body too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
