import type { ProposalSection } from "../../db/schema.js";

/**
 * Rows 158-159: {{placeholders}} shared by contract and proposal templates.
 * Unknown keys are left visible so nothing silently disappears; a known key
 * with no value renders as a blank line to fill by hand.
 */
export const PLACEHOLDERS = [
  ["{{client}}", "Client company name"],
  ["{{client_address}}", "Client address"],
  ["{{contact}}", "Client signer / contact name"],
  ["{{contact_email}}", "Contact email"],
  ["{{our_company}}", "Our company name"],
  ["{{project}}", "Project name"],
  ["{{fee}}", "Fee / total with currency"],
  ["{{currency}}", "Currency code"],
  ["{{start_date}}", "Start date"],
  ["{{end_date}}", "End date"],
  ["{{date}}", "Date the document is sent"],
  ["{{number}}", "Document number"],
  ["{{title}}", "Document title"],
] as const;

export function renderSections(sections: ProposalSection[], ctx: Record<string, string>): ProposalSection[] {
  return sections.map((s) => ({ ...s, title: fill(s.title, ctx), body: fill(s.body, ctx) }));
}

export function fill(text: string, ctx: Record<string, string>) {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, key: string) => {
    const v = ctx[key];
    return v === undefined ? m : v || "________";
  });
}

export function money(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
