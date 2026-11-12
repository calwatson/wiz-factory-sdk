import { isFindingType, isSeverity, type FindingType, type Severity } from "./maps.js";

export interface ParsedTicket {
  demoRef: string;
  wizId: string;
  findingType: FindingType;
  rule: string;
  ruleId: string;
  severity: Severity;
  resourceName: string;
  resourceId: string;
  cloudAccountName: string;
  image: string;
  cve: string;
  packageName: string;
  packageType: string;
  installedVersion: string;
  fixedVersion: string;
  location: string;
  filePath: string;
  functionName: string;
  codeRepository: string;
  iacSource: string;
  secretType: string;
  wizStatus: string;
}

const LINE = /^([A-Za-z ]+): (.*)$/gm;

export function descriptionFields(description: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of description.matchAll(LINE)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) fields[key] = value.trim();
  }
  return fields;
}

export function parseDescription(description: string): ParsedTicket {
  const fields = descriptionFields(description);
  const findingRaw = fields["Finding Type"] ?? "";
  const severityRaw = (fields.Severity ?? "").toUpperCase();
  if (!isFindingType(findingRaw)) {
    throw new Error(`Ticket description has no known Finding Type (got ${findingRaw || "nothing"}).`);
  }
  if (!isSeverity(severityRaw)) {
    throw new Error(`Ticket description has no known Severity (got ${fields.Severity || "nothing"}).`);
  }
  return {
    demoRef: fields["Demo Ref"] ?? "",
    wizId: fields["Wiz Issue ID"] ?? "",
    findingType: findingRaw,
    rule: fields.Rule ?? "",
    ruleId: fields["Rule ID"] ?? "",
    severity: severityRaw,
    resourceName: fields["Resource Name"] ?? "",
    resourceId: fields["Resource ID"] ?? "",
    cloudAccountName: fields["Cloud Account Name"] ?? "",
    image: fields.Image ?? "",
    cve: fields.CVE ?? "",
    packageName: fields.Package ?? "",
    packageType: fields["Package Type"] ?? "",
    installedVersion: fields["Installed Version"] ?? "",
    fixedVersion: fields["Fixed Version"] ?? "",
    location: fields.Location ?? "",
    filePath: fields["File Path"] ?? "",
    functionName: fields.Function ?? "",
    codeRepository: fields["Code Repository"] ?? "",
    iacSource: fields["IaC Source"] ?? "",
    secretType: fields["Secret Type"] ?? "",
    wizStatus: fields["Wiz Status"] ?? "",
  };
}
