/** Demo maps from the kit /config and /dedup skills. SYNTHETIC. */

export const AGENT_ALLOWLIST = new Set([
  "acme-demo/payments-api",
  "acme-demo/platform-infra",
  "acme-demo/orders-service",
]);

export const WRITABLE_REPO_NAMES = ["payments-api", "platform-infra", "orders-service"] as const;

export type WritableRepoName = (typeof WRITABLE_REPO_NAMES)[number];

export const IMAGE_TO_REPO: Record<string, string> = {
  "acme-demo/payments-api": "acme-demo/payments-api",
  "acme-demo/orders-service": "acme-demo/orders-service",
  "acme-demo/report-worker": "acme-demo/report-worker",
};

export const REPO_DEPLOYS_TO: Record<string, string> = {
  "acme-demo/payments-api": "prod",
  "acme-demo/report-worker": "prod",
  "acme-demo/orders-service": "prod",
};

export const CODE_RULE_FAMILY: Record<string, string> = {
  "wc-sast-js-089": "sql-injection",
  "wc-sast-py-089": "sql-injection",
  "wc-sast-js-022": "path-traversal",
  "wc-sast-js-041": "template-injection",
};

export const RULE_FAMILY: Record<string, string> = {
  "wc-s3-001": "s3-public-read",
  "wc-iac-s3-001": "s3-public-read",
  "wc-ec2-022": "sg-open-ssh",
  "wc-ec2-031": "sg-open-db",
  "wc-s3-014": "s3-encryption-versioning",
  "wc-rds-004": "rds-encryption",
  "wc-iam-010": "iam-admin-on-compute",
  "wc-ct-001": "cloudtrail-all-regions",
};

/** One package bump or one module change closes several tickets in the same repo. */
export const FIX_UNITS: Record<string, string> = {
  "acme-demo/payments-api|lodash": "CG-lodash-4.17.21",
  "acme-demo/payments-api|express": "CG-express-4.19.2",
  "acme-demo/payments-api|qs": "CG-express-4.19.2",
};

export const CORRELATION_BY_WIZ_ID: Record<string, string> = {
  "wiz-iss-0111": "CG-lodash-4.17.21",
  "wiz-iss-0113": "CG-lodash-4.17.21",
};

export const SEV_BASE: Record<string, number> = {
  CRITICAL: 40,
  HIGH: 30,
  MEDIUM: 15,
  LOW: 5,
};

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_TYPES = [
  "Vulnerability",
  "Secret",
  "Code",
  "Cloud Configuration",
  "Toxic Combination",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** Per-repo fix difference shown on the parent. The live agent confirms this from the repo. */
export const FIX_NOTES: Record<string, string> = {
  "vf-0001":
    "bump lodash to 4.17.21 AND stop compiling user input in src/notify.js: the CVE sink is reachable here (wiz-iss-0113). One PR for the correlation group (fallback 01 + 05).",
  "vf-0018":
    "bump lodash to 4.17.21 only. lodash is used for groupBy and sumBy, never _.template, so no code change (fallback 12).",
  "vf-0010":
    "calls jwt.verify(token, secret) sync with one static env secret and no algorithms: bump to 9.0.0 AND pin algorithms HS256 and fail closed when the secret is unset (src/auth/partnerWebhook.js). Human review, major bump (fallback 14).",
  "vf-0020":
    "calls jwt.verify(token, getKey, callback) with a kid-based key lookup and no algorithms: bump to 9.0.0 AND make an unknown kid an error and pin HS256 in the callback form (src/auth.js). Human review, major bump (fallback 15).",
  "vf-0012": "base image upgrade for glibc in the Dockerfile; human review.",
  "vf-0013": "repo not agent-writable; the owning team upgrades the base image.",
  "wiz-iss-0114": "the input is a VALUE in a WHERE clause: bind it with a ? placeholder (fallback 10).",
  "wiz-iss-0115":
    "the input is an IDENTIFIER in ORDER BY, which ? cannot bind: allowlist sort column and direction (fallback 13).",
  "sf-0205":
    "live key in runtime config src/config/billing.js: read it from the environment, a human rotates it (fallback 11).",
  "sf-0206": "placeholder in a test fixture never loaded at runtime: false positive candidate, a human confirms, no PR.",
};

export function fixDifference(wizId: string, laneReason: string): string {
  return FIX_NOTES[wizId] ?? laneReason;
}

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

export function isFindingType(value: string): value is FindingType {
  return (FINDING_TYPES as readonly string[]).includes(value);
}
