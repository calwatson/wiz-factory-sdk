import type { IssueComment, JiraClient } from "./types.js";

export async function upsertComment(jira: JiraClient, key: string, marker: string, body: string): Promise<"created" | "updated"> {
  const issue = await jira.getIssue(key);
  const existing = issue.comments.find((comment) => comment.body.includes(marker));
  if (existing) {
    if (existing.body !== body) await jira.updateComment(key, existing.id, body);
    return "updated";
  }
  await jira.addComment(key, body);
  return "created";
}

export function commentByMarker(comments: IssueComment[], marker: string): IssueComment | undefined {
  return comments.find((comment) => comment.body.includes(marker));
}
