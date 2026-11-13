import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { payloadsEnabled, type ConfigEnv } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const BODY_LOG_BYTES = 4096;

export interface WebhookServerOptions {
  orchestrator: Orchestrator;
  webhookSecret: string;
  logPayloads?: boolean;
  env?: ConfigEnv;
}

export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!expected || provided === undefined) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

/** Header dump for logs. x-webhook-secret is presence and length only. */
export function headersForLog(headers: IncomingHttpHeaders): Record<string, string> {
  const dump: Record<string, string> = {};
  let sawSecret = false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-webhook-secret") {
      sawSecret = true;
      dump[name] = secretPresence(value);
      continue;
    }
    dump[name] = value === undefined ? "" : Array.isArray(value) ? value.join(", ") : value;
  }
  if (!sawSecret) dump["x-webhook-secret"] = "absent";
  return dump;
}

export function truncateForLog(body: string): string {
  const bytes = Buffer.from(body);
  if (bytes.length <= BODY_LOG_BYTES) return body;
  return `${bytes.subarray(0, BODY_LOG_BYTES).toString("utf8")}…[truncated ${bytes.length} bytes]`;
}

export function createWebhookServer(options: WebhookServerOptions) {
  const logPayloads = options.logPayloads ?? payloadsEnabled(options.env);
  return createServer((request, response) => {
    void handle(request, response, { ...options, logPayloads }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Server error";
      reply(response, 500, { error: message }, logPayloads);
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, options: WebhookServerOptions & { logPayloads: boolean }): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  let body = "";
  try {
    body = await readBody(request);
  } catch (error) {
    logRequest(request, url, "", options.logPayloads);
    const message = error instanceof Error ? error.message : "Body could not be read.";
    reply(response, 500, { error: message }, options.logPayloads);
    return;
  }
  logRequest(request, url, body, options.logPayloads);

  if (request.method === "GET" && url.pathname === "/healthz") {
    reply(response, 200, { ok: true, synthetic: true }, options.logPayloads);
    return;
  }
  if (request.method !== "POST" || (url.pathname !== "/intake" && url.pathname !== "/remediate")) {
    reply(response, 404, { error: "Not found" }, options.logPayloads);
    return;
  }

  const header = request.headers["x-webhook-secret"];
  const provided = Array.isArray(header) ? header[0] : header;
  const authorized = secretsMatch(provided, options.webhookSecret);
  logLine(options.logPayloads, { at: new Date().toISOString(), auth: authorized ? "ok" : "401" });
  if (!authorized) {
    reply(response, 401, { error: "Unauthorized" }, options.logPayloads);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    reply(response, 400, { error: "Expected JSON." }, options.logPayloads);
    return;
  }
  const issueKey = issueKeyOf(parsed);
  if (!issueKey) {
    reply(response, 400, { error: 'Expected {"issueKey":"JWF-1"}.' }, options.logPayloads);
    return;
  }
  const wait = url.searchParams.get("wait") === "1";
  const run = url.pathname === "/intake" ? options.orchestrator.intake(issueKey, false) : options.orchestrator.remediate(issueKey, false);
  if (!wait) {
    void run.catch((error: unknown) => {
      console.error(`${url.pathname} ${issueKey} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    reply(response, 202, { accepted: true, issueKey, path: url.pathname }, options.logPayloads);
    return;
  }
  try {
    reply(response, 200, await run, options.logPayloads);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    reply(response, 500, { error: message, issueKey }, options.logPayloads);
  }
}

function logRequest(request: IncomingMessage, url: URL, body: string, logPayloads: boolean): void {
  logLine(logPayloads, {
    at: new Date().toISOString(),
    method: request.method ?? "",
    path: `${url.pathname}${url.search}`,
    headers: headersForLog(request.headers),
    body: truncateForLog(body),
  });
}

function logLine(logPayloads: boolean, record: Record<string, unknown>): void {
  if (!logPayloads) return;
  console.log(JSON.stringify(record));
}

function reply(response: ServerResponse, status: number, payload: unknown, logPayloads: boolean): void {
  logLine(logPayloads, { at: new Date().toISOString(), status });
  send(response, status, payload);
}

function secretPresence(value: string | string[] | undefined): string {
  if (value === undefined) return "absent";
  const text = Array.isArray(value) ? value.join(",") : value;
  return `present len=${text.length}`;
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
