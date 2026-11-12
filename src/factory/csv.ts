export interface NativeTicket {
  ref: string;
  summary: string;
  issueType: string;
  status: string;
  priority: string;
  labels: string[];
  reporter: string;
  created: string;
  description: string;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char ?? "";
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += char ?? "";
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function loadNativeTickets(csvText: string): NativeTicket[] {
  const rows = parseCsv(csvText);
  const header = rows[0];
  if (!header) throw new Error("Ticket CSV is empty.");
  const tickets: NativeTicket[] = [];
  for (const row of rows.slice(1)) {
    const labels: string[] = [];
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      const value = row[index] ?? "";
      if (name === "Labels") {
        if (value) labels.push(value);
      } else if (name) {
        record[name] = value;
      }
    });
    const description = record.Description ?? "";
    const ref = /Demo Ref: (T\d+)/.exec(description)?.[1] ?? "";
    tickets.push({
      ref,
      summary: record.Summary ?? "",
      issueType: record["Issue Type"] ?? "Bug",
      status: record.Status ?? "To Do",
      priority: record.Priority ?? "Medium",
      labels,
      reporter: record.Reporter ?? "",
      created: record.Created ?? "",
      description,
    });
  }
  return tickets;
}
