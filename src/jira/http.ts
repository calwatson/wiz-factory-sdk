import type { FactoryConfig } from "../config.js";
import { FactoryError, NotFoundError } from "../errors.js";
import { adfToText, textToAdf } from "./adf.js";
import { jqlFor, matchesQuery } from "./query.js";
import { emptyFields, type CreateIssueInput, type CustomFields, type Issue, type IssueComment, type IssueLink, type IssuePatch, type JiraClient, type JiraQuery } from "./types.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface FieldSchema {
  id: string;
  name: string;
  type: string;
}

const FIELD_NAMES: Record<keyof CustomFields, string> = {
  dedupKey: "Dedup Key",
  fixLocation: "Fix Location",
  correlationGroup: "Correlation Group",
  crossRepoKey: "Cross-Repo Key",
  riskScore: "Risk Score",
  agentLane: "Agent Lane",
  prUrl: "PR URL",
};

const READ_FIELDS = ["summary", "description", "status", "resolution", "issuetype", "priority", "labels", "created", "duedate", "components", "parent", "issuelinks"];

export class HttpJira implements JiraClient {
  private fieldMap: Map<keyof CustomFields, FieldSchema> | undefined;
  private linkTypes: Array<{ name: string; outward: string; inward: string }> | undefined;

  constructor(
    private readonly config: Pick<FactoryConfig, "jiraBaseUrl" | "jiraEmail" | "jiraApiToken" | "jiraProjectKey" | "fieldOverrides">,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async getIssue(key: string): Promise<Issue> {
    const fields = await this.ensureFields();
    const raw = await this.request("GET", `/issue/${encodeURIComponent(key)}?fields=${this.fieldList(fields)}`);
    const issue = this.mapIssue(raw, fields);
    issue.comments = await this.loadComments(key);
    return issue;
  }

  async search(query: JiraQuery): Promise<Issue[]> {
    const fields = await this.ensureFields();
    const jql = jqlFor(this.config.jiraProjectKey, query);
    const rawIssues = await this.searchJql(jql, this.fieldList(fields));
    return rawIssues.map((raw) => this.mapIssue(raw, fields)).filter((issue) => matchesQuery(issue, query));
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const fields = await this.ensureFields();
    const body = {
      fields: {
        project: { key: this.config.jiraProjectKey },
        issuetype: { name: input.issueType },
        summary: input.summary,
        description: textToAdf(input.description),
        priority: input.priority ? { name: input.priority } : undefined,
        labels: input.labels,
        duedate: input.dueDate || undefined,
        ...this.serializeFields(input.fields ?? {}, fields),
      },
    };
    const created = (await this.request("POST", "/issue", body)) as { key?: string };
    if (!created.key) throw new FactoryError("Jira create issue returned no key.", "jira");
    return this.getIssue(created.key);
  }

  async updateIssue(key: string, patch: IssuePatch): Promise<Issue> {
    const fields = await this.ensureFields();
    const write = (includeComponent: boolean): Promise<unknown> => {
      const body: { fields: Record<string, unknown> } = { fields: {} };
      if (patch.summary !== undefined) body.fields.summary = patch.summary;
      if (patch.priority !== undefined) body.fields.priority = { name: patch.priority };
      if (patch.labels !== undefined) body.fields.labels = patch.labels;
      if (patch.dueDate !== undefined) body.fields.duedate = patch.dueDate || null;
      if (includeComponent && patch.component) body.fields.components = [{ name: patch.component }];
      Object.assign(body.fields, this.serializeFields(patch.fields ?? {}, fields));
      return this.request("PUT", `/issue/${encodeURIComponent(key)}`, body);
    };
    try {
      await write(true);
    } catch (error) {
      if (patch.component && error instanceof FactoryError && error.status === 400) {
        await write(false);
      } else {
        throw error;
      }
    }
    return this.getIssue(key);
  }

  async transition(key: string, status: string, resolution?: string): Promise<void> {
    const listed = (await this.request("GET", `/issue/${encodeURIComponent(key)}/transitions`)) as {
      transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
    };
    const transitions = listed.transitions ?? [];
    const match = transitions.find((item) => item.to?.name?.toLowerCase() === status.toLowerCase()) ?? transitions.find((item) => item.name.toLowerCase() === status.toLowerCase());
    if (!match) {
      const available = transitions.map((item) => item.to?.name ?? item.name).join(", ") || "none";
      throw new FactoryError(`No Jira transition to ${status} for ${key}. Available: ${available}.`, "jira-transition");
    }
    const body: { transition: { id: string }; fields?: { resolution: { name: string } } } = { transition: { id: match.id } };
    if (resolution) body.fields = { resolution: { name: resolution } };
    try {
      await this.request("POST", `/issue/${encodeURIComponent(key)}/transitions`, body);
    } catch (error) {
      if (!resolution) throw error;
      await this.request("POST", `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
      await this.request("PUT", `/issue/${encodeURIComponent(key)}`, { fields: { resolution: { name: resolution } } });
    }
  }

  async addComment(key: string, body: string): Promise<IssueComment> {
    const created = (await this.request("POST", `/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(body) })) as { id?: string };
    if (!created.id) throw new FactoryError(`Jira did not return a comment id for ${key}.`, "jira");
    return { id: created.id, body };
  }

  async updateComment(key: string, commentId: string, body: string): Promise<void> {
    await this.request("PUT", `/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`, { body: textToAdf(body) });
  }

  async link(input: { typeName: string; outwardKey: string; inwardKey: string }): Promise<void> {
    await this.request("POST", "/issueLink", {
      type: { name: input.typeName },
      outwardIssue: { key: input.outwardKey },
      inwardIssue: { key: input.inwardKey },
    });
  }

  async setParent(childKey: string, parentKey: string): Promise<"parent-field" | "child-link"> {
    const current = await this.getIssue(childKey);
    if (current.parentKey === parentKey) return "parent-field";
    try {
      await this.request("PUT", `/issue/${encodeURIComponent(childKey)}`, { fields: { parent: { key: parentKey } } });
      return "parent-field";
    } catch (error) {
      if (!(error instanceof FactoryError) || error.status < 400) throw error;
      await this.linkChild(childKey, parentKey);
      return "child-link";
    }
  }

  private async linkChild(childKey: string, parentKey: string): Promise<void> {
    const types = await this.ensureLinkTypes();
    const parentType = types.find((type) => type.inward.toLowerCase() === "is child of" || type.outward.toLowerCase() === "is child of" || type.name.toLowerCase() === "parent");
    if (!parentType) {
      throw new FactoryError("Jira has no Parent / 'is child of' link type, and the Parent field was rejected. Create the link type or allow Epic parents.", "jira-parent");
    }
    const childIsInward = parentType.inward.toLowerCase() === "is child of" || parentType.outward.toLowerCase() !== "is child of";
    await this.link({
      typeName: parentType.name,
      outwardKey: childIsInward ? parentKey : childKey,
      inwardKey: childIsInward ? childKey : parentKey,
    });
  }

  private async ensureFields(): Promise<Map<keyof CustomFields, FieldSchema>> {
    if (this.fieldMap) return this.fieldMap;
    const listed = (await this.request("GET", "/field")) as Array<{ id?: string; name?: string; schema?: { type?: string } }>;
    const map = new Map<keyof CustomFields, FieldSchema>();
    const missing: string[] = [];
    for (const key of Object.keys(FIELD_NAMES) as Array<keyof CustomFields>) {
      const override = this.config.fieldOverrides[key];
      const found = listed.find((field) => (override ? field.id === override : field.name === FIELD_NAMES[key]));
      if (!found?.id) {
        missing.push(FIELD_NAMES[key]);
        continue;
      }
      map.set(key, { id: found.id, name: found.name ?? FIELD_NAMES[key], type: found.schema?.type ?? "string" });
    }
    if (missing.length > 0) {
      throw new FactoryError(
        `Jira project ${this.config.jiraProjectKey} is missing custom fields: ${missing.join(", ")}. Create them or set JIRA_FIELD_* overrides.`,
        "jira-fields",
      );
    }
    this.fieldMap = map;
    return map;
  }

  private async ensureLinkTypes(): Promise<Array<{ name: string; outward: string; inward: string }>> {
    if (this.linkTypes) return this.linkTypes;
    const listed = (await this.request("GET", "/issueLinkType")) as { issueLinkTypes?: Array<{ name: string; outward: string; inward: string }> };
    this.linkTypes = listed.issueLinkTypes ?? [];
    return this.linkTypes;
  }

  private fieldList(fields: Map<keyof CustomFields, FieldSchema>): string {
    return [...READ_FIELDS, ...[...fields.values()].map((field) => field.id)].join(",");
  }

  private serializeFields(values: Partial<CustomFields>, fields: Map<keyof CustomFields, FieldSchema>): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const key of Object.keys(values) as Array<keyof CustomFields>) {
      if (!(key in values)) continue;
      const schema = fields.get(key);
      const value = values[key];
      if (!schema || value === undefined) continue;
      if (schema.type === "option") {
        if (typeof value === "string" && value) payload[schema.id] = { value };
        continue;
      }
      if (schema.type === "number") {
        payload[schema.id] = typeof value === "number" ? value : null;
        continue;
      }
      payload[schema.id] = value ?? "";
    }
    return payload;
  }

  private mapIssue(raw: unknown, fields: Map<keyof CustomFields, FieldSchema>): Issue {
    const record = raw as { key?: string; fields?: Record<string, unknown> };
    const source = record.fields ?? {};
    const custom = emptyFields();
    for (const key of Object.keys(FIELD_NAMES) as Array<keyof CustomFields>) {
      const schema = fields.get(key);
      if (!schema) continue;
      custom[key] = readCustom(source[schema.id], schema.type) as never;
    }
    const links = readLinks(source.issuelinks);
    let parentKey = nestedKey(source.parent);
    if (!parentKey) {
      const childLink = links.find((link) => link.inward.toLowerCase() === "is child of" && link.thisIs === "inward");
      parentKey = childLink?.otherKey ?? "";
    }
    const components = Array.isArray(source.components) ? (source.components as Array<{ name?: string }>) : [];
    return {
      key: record.key ?? "",
      summary: stringField(source.summary),
      description: adfToText(source.description),
      status: nestedName(source.status),
      resolution: nestedName(source.resolution),
      issueType: nestedName(source.issuetype),
      priority: nestedName(source.priority),
      labels: Array.isArray(source.labels) ? source.labels.filter((label): label is string => typeof label === "string") : [],
      created: stringField(source.created),
      dueDate: stringField(source.duedate),
      component: components[0]?.name ?? "",
      parentKey,
      fields: custom,
      comments: [],
      links,
    };
  }

  private async loadComments(key: string): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    let startAt = 0;
    for (;;) {
      const page = (await this.request("GET", `/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`)) as {
        comments?: Array<{ id?: string; body?: unknown }>;
        total?: number;
      };
      const batch = page.comments ?? [];
      for (const comment of batch) {
        if (comment.id) comments.push({ id: comment.id, body: adfToText(comment.body) });
      }
      startAt += batch.length;
      if (batch.length === 0 || startAt >= (page.total ?? startAt)) break;
    }
    return comments;
  }

  private async searchJql(jql: string, fields: string): Promise<unknown[]> {
    const issues: unknown[] = [];
    let nextPageToken: string | undefined;
    try {
      for (;;) {
        const body: { jql: string; maxResults: number; fields: string[]; nextPageToken?: string } = {
          jql,
          maxResults: 50,
          fields: fields.split(","),
        };
        if (nextPageToken) body.nextPageToken = nextPageToken;
        const page = (await this.request("POST", "/search/jql", body)) as { issues?: unknown[]; nextPageToken?: string; isLast?: boolean };
        issues.push(...(page.issues ?? []));
        if (!page.nextPageToken || page.isLast) break;
        nextPageToken = page.nextPageToken;
      }
      return issues;
    } catch (error) {
      if (!(error instanceof FactoryError) || (error.status !== 404 && error.status !== 410)) throw error;
    }
    let startAt = 0;
    for (;;) {
      const page = (await this.request("POST", "/search", { jql, startAt, maxResults: 50, fields: fields.split(",") })) as {
        issues?: unknown[];
        total?: number;
      };
      const batch = page.issues ?? [];
      issues.push(...batch);
      startAt += batch.length;
      if (batch.length === 0 || startAt >= (page.total ?? startAt)) break;
    }
    return issues;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.config.jiraBaseUrl}/rest/api/3${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.jiraEmail}:${this.config.jiraApiToken}`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (response.status === 404) {
      const key = /\/issue\/([^/?]+)/.exec(path)?.[1];
      throw new NotFoundError(key ? decodeURIComponent(key) : path);
    }
    if (!response.ok) {
      throw new FactoryError(`Jira ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`, "jira", response.status);
    }
    if (!text) return undefined;
    return JSON.parse(text) as unknown;
  }
}

function readCustom(value: unknown, type: string): string | number | null {
  if (value == null) return type === "number" ? null : "";
  if (type === "option" && typeof value === "object" && value && "value" in value) {
    return String((value as { value: unknown }).value ?? "");
  }
  if (type === "number") return typeof value === "number" ? value : Number(value);
  return String(value);
}

function readLinks(value: unknown): IssueLink[] {
  if (!Array.isArray(value)) return [];
  const links: IssueLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const link = item as { type?: { name?: string; outward?: string; inward?: string }; outwardIssue?: { key?: string }; inwardIssue?: { key?: string } };
    const typeName = link.type?.name ?? "";
    if (link.inwardIssue?.key) {
      links.push({
        typeName,
        thisIs: "outward",
        otherKey: link.inwardIssue.key,
        outward: link.type?.outward ?? "",
        inward: link.type?.inward ?? "",
      });
    } else if (link.outwardIssue?.key) {
      links.push({
        typeName,
        thisIs: "inward",
        otherKey: link.outwardIssue.key,
        outward: link.type?.outward ?? "",
        inward: link.type?.inward ?? "",
      });
    }
  }
  return links;
}

function nestedName(value: unknown): string {
  if (!value || typeof value !== "object" || !("name" in value)) return "";
  return String((value as { name?: unknown }).name ?? "");
}

function nestedKey(value: unknown): string {
  if (!value || typeof value !== "object" || !("key" in value)) return "";
  return String((value as { key?: unknown }).key ?? "");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
