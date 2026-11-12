import { NotFoundError } from "../errors.js";
import { matchesQuery } from "./query.js";
import { emptyFields, type CreateIssueInput, type Issue, type IssueComment, type IssuePatch, type JiraClient, type JiraQuery } from "./types.js";

export class MemoryJira implements JiraClient {
  readonly issues = new Map<string, Issue>();
  private nextNumber = 1;
  parentMode: "parent-field" | "child-link" = "parent-field";

  constructor(
    private readonly projectKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getIssue(key: string): Promise<Issue> {
    const issue = this.issues.get(key);
    if (!issue) throw new NotFoundError(key);
    return structuredClone(issue);
  }

  async search(query: JiraQuery): Promise<Issue[]> {
    return [...this.issues.values()].filter((issue) => matchesQuery(issue, query)).map((issue) => structuredClone(issue)).sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const key = input.key ?? `${this.projectKey}-${this.nextNumber}`;
    const suffix = Number(key.split("-").at(-1));
    if (Number.isFinite(suffix)) this.nextNumber = Math.max(this.nextNumber, suffix + 1);
    else this.nextNumber += 1;
    const issue: Issue = {
      key,
      summary: input.summary,
      description: input.description,
      status: "To Do",
      resolution: "",
      issueType: input.issueType,
      priority: input.priority,
      labels: [...input.labels],
      created: input.created ?? this.now().toISOString(),
      dueDate: input.dueDate ?? "",
      component: input.component ?? "",
      parentKey: "",
      fields: { ...emptyFields(), ...input.fields },
      comments: [],
      links: [],
    };
    this.issues.set(key, issue);
    return structuredClone(issue);
  }

  async updateIssue(key: string, patch: IssuePatch): Promise<Issue> {
    const issue = this.must(key);
    if (patch.summary !== undefined) issue.summary = patch.summary;
    if (patch.priority !== undefined) issue.priority = patch.priority;
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    if (patch.dueDate !== undefined) issue.dueDate = patch.dueDate;
    if (patch.component !== undefined) issue.component = patch.component;
    if (patch.fields) issue.fields = { ...issue.fields, ...patch.fields };
    return structuredClone(issue);
  }

  async transition(key: string, status: string, resolution?: string): Promise<void> {
    const issue = this.must(key);
    issue.status = status;
    if (resolution !== undefined) issue.resolution = resolution;
    else if (status !== "Done") issue.resolution = "";
  }

  async addComment(key: string, body: string): Promise<IssueComment> {
    const issue = this.must(key);
    const comment = { id: `${key}-c${issue.comments.length + 1}`, body };
    issue.comments.push(comment);
    return { ...comment };
  }

  async updateComment(key: string, commentId: string, body: string): Promise<void> {
    const issue = this.must(key);
    const comment = issue.comments.find((item) => item.id === commentId);
    if (!comment) throw new NotFoundError(`${key} comment ${commentId}`);
    comment.body = body;
  }

  async link(input: { typeName: string; outwardKey: string; inwardKey: string }): Promise<void> {
    const outward = this.must(input.outwardKey);
    const inward = this.must(input.inwardKey);
    const names = linkNames(input.typeName);
    if (!outward.links.some((item) => item.typeName === input.typeName && item.thisIs === "outward" && item.otherKey === input.inwardKey)) {
      outward.links.push({ typeName: input.typeName, thisIs: "outward", otherKey: input.inwardKey, outward: names.outward, inward: names.inward });
    }
    if (!inward.links.some((item) => item.typeName === input.typeName && item.thisIs === "inward" && item.otherKey === input.outwardKey)) {
      inward.links.push({ typeName: input.typeName, thisIs: "inward", otherKey: input.outwardKey, outward: names.outward, inward: names.inward });
    }
  }

  async setParent(childKey: string, parentKey: string): Promise<"parent-field" | "child-link"> {
    const child = this.must(childKey);
    this.must(parentKey);
    if (this.parentMode === "child-link") {
      await this.link({ typeName: "Parent", outwardKey: parentKey, inwardKey: childKey });
      child.parentKey = parentKey;
      return "child-link";
    }
    child.parentKey = parentKey;
    return "parent-field";
  }

  private must(key: string): Issue {
    const issue = this.issues.get(key);
    if (!issue) throw new NotFoundError(key);
    return issue;
  }
}

function linkNames(typeName: string): { outward: string; inward: string } {
  if (typeName === "Duplicate") return { outward: "duplicates", inward: "is duplicated by" };
  if (typeName === "Parent") return { outward: "is parent of", inward: "is child of" };
  return { outward: typeName, inward: typeName };
}
