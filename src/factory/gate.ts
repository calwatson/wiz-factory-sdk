import { assertNever } from "../never.js";

export const LANES = [
  "AUTO_MERGE_ELIGIBLE",
  "AGENT_PR_HUMAN_REVIEW",
  "HUMAN_ONLY",
  "FALSE_POSITIVE_CANDIDATE",
  "STALE_CLOSE",
  "PARENT_TRACKING",
  "DUPLICATE",
  "PR_OPEN",
] as const;

export type Lane = (typeof LANES)[number];

export interface Disposition {
  status: string;
  label: string;
  resolution: string;
}

export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

/** Intake gate: lane to Jira status. Merge-time /gate stays on GitHub after the PR is open. */
export function disposition(lane: Lane): Disposition {
  switch (lane) {
    case "AUTO_MERGE_ELIGIBLE":
      return { status: "Ready for Agent", label: "cursor-agent-autopilot", resolution: "" };
    case "AGENT_PR_HUMAN_REVIEW":
      return { status: "Ready for Agent", label: "cursor-agent", resolution: "" };
    case "HUMAN_ONLY":
      return { status: "Human Needed", label: "human-review", resolution: "" };
    case "FALSE_POSITIVE_CANDIDATE":
      return { status: "False Positive", label: "false-positive-suspected", resolution: "" };
    case "STALE_CLOSE":
      return { status: "Done", label: "stale", resolution: "Done" };
    case "PARENT_TRACKING":
      return { status: "Human Needed", label: "parent", resolution: "" };
    case "DUPLICATE":
      return { status: "Done", label: "duplicate", resolution: "Duplicate" };
    case "PR_OPEN":
      return { status: "In Review", label: "cursor-agent", resolution: "" };
    default:
      return assertNever(lane, "lane");
  }
}

export function isActionableLane(lane: string): boolean {
  return lane === "AUTO_MERGE_ELIGIBLE" || lane === "AGENT_PR_HUMAN_REVIEW";
}
