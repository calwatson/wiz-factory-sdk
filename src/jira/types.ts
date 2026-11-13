export interface CustomFields {
  dedupKey: string;
  fixLocation: string;
  correlationGroup: string;
  crossRepoKey: string;
  riskScore: number | null;
  agentLane: string;
  prUrl: string;
}

export interface IssueComment {
  id: string;
  body: string;
}

export interface IssueLink {
  typeName: string;
  thisIs: "outward" | "inward";
  otherKey: string;
  outward: string;
  inward: string;
}

export interface Issue {
  key: string;
  summary: string;
  description: string;
  status: string;
  resolution: string;
  issueType: string;
  priority: string;
  labels: string[];
  created: string;
  dueDate: string;
  component: string;
  parentKey: string;
  fields: CustomFields;
  comments: IssueComment[];
  links: IssueLink[];
}

export function emptyFields(): CustomFields {
  return {
    dedupKey: "",
    fixLocation: "",
    correlationGroup: "",
    crossRepoKey: "",
    riskScore: null,
    agentLane: "",
    prUrl: "",
  };
}

export interface CreateIssueInput {
  key?: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  labels: string[];
  created?: string;
  dueDate?: string;
  component?: string;
  fields?: Partial<CustomFields>;
}

export interface IssuePatch {
  summary?: string;
  priority?: string;
  labels?: string[];
  dueDate?: string;
  component?: string;
  fields?: Partial<CustomFields>;
}

export type JiraQuery =
  | { kind: "demo-ref"; ref: string }
  | { kind: "wiz-id"; wizId: string }
  | { kind: "dedup-key"; dedupKey: string; unresolved: boolean }
  | { kind: "cross-repo"; crossRepoKey: string; unresolved: boolean; excludeParentLabel: boolean }
  | { kind: "parent"; crossRepoKey: string }
  | { kind: "correlation"; correlationGroup: string; unresolved: boolean };

export interface JiraClient {
  getIssue(key: string): Promise<Issue>;
  search(query: JiraQuery): Promise<Issue[]>;
  searchByJql(jql: string): Promise<Issue[]>;
  deleteIssue(key: string): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  updateIssue(key: string, patch: IssuePatch): Promise<Issue>;
  transition(key: string, status: string, resolution?: string): Promise<void>;
  addComment(key: string, body: string): Promise<IssueComment>;
  updateComment(key: string, commentId: string, body: string): Promise<void>;
  link(input: { typeName: string; outwardKey: string; inwardKey: string }): Promise<void>;
  setParent(childKey: string, parentKey: string): Promise<"parent-field" | "child-link">;
}

export function duplicatesTarget(issue: Issue): string {
  return issue.links.find((link) => link.typeName === "Duplicate" && link.thisIs === "outward")?.otherKey ?? "";
}
