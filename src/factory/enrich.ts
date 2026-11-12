import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AssetNode {
  isInternetFacing?: boolean;
  powerState?: string;
  tags?: Record<string, string>;
}

export interface RawNode {
  id?: string;
  status?: string;
  hasExploit?: boolean;
  hasCisaKevExploit?: boolean;
  isDevDependency?: boolean;
  expectedOutcome?: string;
  entitySnapshot?: AssetNode;
  vulnerableAsset?: AssetNode;
  resource?: AssetNode;
  projects?: Array<{ name?: string }>;
}

interface Envelope {
  data?: Record<string, { nodes?: RawNode[] }>;
}

export class EnrichmentIndex {
  private readonly byId = new Map<string, RawNode>();

  constructor(nodes: RawNode[]) {
    for (const node of nodes) {
      if (node.id) this.byId.set(node.id, node);
    }
  }

  get(wizId: string): RawNode | undefined {
    return this.byId.get(wizId);
  }

  get size(): number {
    return this.byId.size;
  }
}

function readNodes(file: string, key: string): RawNode[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Envelope;
  const nodes = parsed.data?.[key]?.nodes;
  if (!nodes) throw new Error(`Enrichment file ${file} has no data.${key}.nodes.`);
  return nodes;
}

export function loadEnrichment(dataDir: string): EnrichmentIndex {
  const dir = join(dataDir, "enrichment");
  const nodes = [
    ...readNodes(join(dir, "wiz_vulnerability_findings.json"), "vulnerabilityFindings"),
    ...readNodes(join(dir, "wiz_issues.json"), "issues"),
    ...readNodes(join(dir, "wiz_secret_findings.json"), "secretInstances"),
  ];
  return new EnrichmentIndex(nodes);
}

export function assetOf(raw: RawNode | undefined): AssetNode {
  return raw?.entitySnapshot ?? raw?.vulnerableAsset ?? raw?.resource ?? {};
}

export function tagsOf(raw: RawNode | undefined): Record<string, string> {
  return assetOf(raw).tags ?? {};
}
