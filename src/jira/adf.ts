export interface AdfDoc {
  type: "doc";
  version: 1;
  content: Array<{ type: "paragraph"; content?: Array<{ type: "text"; text: string }> }>;
}

export function textToAdf(text: string): AdfDoc {
  const lines = text.split("\n");
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) =>
      line.length === 0 ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: line }] },
    ),
  };
}

export function adfToText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const record = node as { type?: string; text?: string; content?: unknown[] };
  if (record.type === "text") return record.text ?? "";
  if (record.type === "hardBreak") return "\n";
  const parts = (record.content ?? []).map((child) => adfToText(child));
  if (record.type === "doc") return parts.join("\n");
  if (record.type === "paragraph" || record.type === "heading") return parts.join("");
  return parts.join("");
}
