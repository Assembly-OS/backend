import { all, get, insert, now, run } from "@/lib/pg";
import type { Trilingual } from "./intake";

/**
 * The Assembly's memory of the companies it talks to.
 *
 * A meeting is an event and gets a conclusion. A relationship is not an event,
 * and this is the part a chairman with four meetings a week actually cannot
 * hold in his head: what was already discussed with this company, what we
 * offered them, what they said they needed, and therefore what is worth
 * proposing next — to them, or to somebody else whose need theirs happens to
 * answer.
 *
 * Nothing here is inferred at read time. Each meeting's analysis writes what it
 * heard about each company, and the *next* meeting's analysis is handed that
 * history before it starts, so it can say "you discussed X with them in June;
 * this new company needs exactly that". Which is retrieval, not training — the
 * distinction that matters is that a fact written down today is in play today.
 */

export interface PartnerNote extends Trilingual {
  kind: string;
}

export interface PartnerIdea {
  proposal: Trilingual;
  why: Trilingual;
  /** Name of the other company, when the idea is to introduce two of them. */
  match?: string;
}

/** One company as the analysis reports it. */
export interface PartnerReport {
  name: string;
  sector?: string;
  notes?: PartnerNote[];
  ideas?: PartnerIdea[];
}

const KINDS = new Set(["muhokama", "taklif", "ehtiyoj", "kelishuv", "xavf"]);

/** Finds a company by name, creating it the first time it is mentioned. */
async function partnerId(
  name: string,
  sector?: string,
): Promise<number | null> {
  const clean = name.trim().slice(0, 160);
  if (clean.length < 2) return null;

  const existing = await get<{ id: number }>(
    "SELECT id FROM partners WHERE lower(name) = lower(?)",
    clean,
  );
  if (existing) {
    await run(
      `UPDATE partners SET last_seen = ?, sector = COALESCE(sector, ?) WHERE id = ?`,
      now(),
      sector?.trim().slice(0, 80) || null,
      existing.id,
    );
    return existing.id;
  }

  // RETURNING gives the new id in the same round trip. Reading it back by name
  // was a second query whose answer a concurrent writer could have changed.
  return insert(
    "INSERT INTO partners (name, sector, first_seen, last_seen) VALUES (?,?,?,?)",
    clean,
    sector?.trim().slice(0, 80) || null,
    now(),
    now(),
  );
}

/** Files everything one meeting had to say about the companies in it. */
export async function recordPartners(
  meetingId: number | null,
  reports: PartnerReport[],
): Promise<{ companies: number; ideas: number }> {
  let companies = 0;
  let ideas = 0;

  // Bounded: a transcript that names thirty companies has misread something.
  for (const report of reports.slice(0, 12)) {
    const id = await partnerId(report.name, report.sector);
    if (!id) continue;
    companies++;

    for (const note of (report.notes ?? []).slice(0, 8)) {
      if (!note.uz?.trim() && !note.ru?.trim()) continue;
      await run(
        `INSERT INTO partner_notes (partner_id, meeting_id, kind, uz, ru, en, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        id,
        meetingId,
        KINDS.has(note.kind) ? note.kind : "muhokama",
        note.uz ?? "",
        note.ru ?? "",
        note.en ?? "",
        now(),
      );
    }

    for (const idea of (report.ideas ?? []).slice(0, 5)) {
      if (!idea.proposal?.uz?.trim() && !idea.proposal?.ru?.trim()) continue;
      // The match is another company; naming it creates it too, so a
      // suggested introduction is a company we now track.
      const matchId = idea.match ? await partnerId(idea.match) : null;
      await run(
        `INSERT INTO partner_ideas
           (partner_id, meeting_id, match_id,
            proposal_uz, proposal_ru, proposal_en,
            why_uz, why_ru, why_en, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'yangi',?)`,
        id,
        meetingId,
        matchId,
        idea.proposal.uz ?? "",
        idea.proposal.ru ?? "",
        idea.proposal.en ?? "",
        idea.why?.uz ?? "",
        idea.why?.ru ?? "",
        idea.why?.en ?? "",
        now(),
      );
      ideas++;
    }
  }

  return { companies, ideas };
}

/* ------------------------------------------------------------------ */
/* Reading it back                                                     */
/* ------------------------------------------------------------------ */

interface DigestRow {
  name: string;
  sector: string | null;
  kind: string;
  text: string;
}

/**
 * The history handed to the next meeting's analysis, as prompt text.
 *
 * Compact on purpose: the most recent companies, a few lines each. The point
 * is to remind the model that these relationships exist and what state they
 * are in — not to reproduce the archive, which would cost more than the
 * meeting being analysed.
 */
export async function partnerHistory(limit = 14): Promise<string> {
  const rows = await all<DigestRow>(
    `SELECT p.name, p.sector, n.kind, n.uz AS text
       FROM partners p
       JOIN partner_notes n ON n.partner_id = p.id
      WHERE p.id IN (SELECT id FROM partners ORDER BY last_seen DESC LIMIT ?)
      ORDER BY p.last_seen DESC, n.id DESC`,
    limit,
  );
  if (rows.length === 0) return "";

  const byCompany = new Map<string, { sector: string | null; lines: string[] }>();
  for (const row of rows) {
    const entry = byCompany.get(row.name) ?? { sector: row.sector, lines: [] };
    // Four lines per company keeps the oldest relationships from crowding out
    // the newest ones inside the same budget.
    if (entry.lines.length < 4) entry.lines.push(`  [${row.kind}] ${row.text}`);
    byCompany.set(row.name, entry);
  }

  const blocks = [...byCompany.entries()].map(
    ([name, entry]) =>
      `- ${name}${entry.sector ? ` (${entry.sector})` : ""}\n${entry.lines.join("\n")}`,
  );
  return `\n\nMa'lum kompaniyalar va ular bilan muzokaralar tarixi:\n${blocks.join("\n")}`;
}

export interface PartnerView {
  id: number;
  name: string;
  sector: string | null;
  last_seen: string;
  notes: { kind: string; text: string; created_at: string }[];
  ideas: { id: number; proposal: string; why: string; match: string | null }[];
}

/** Every company with its history and open suggestions, in one language. */
export async function partnersFor(
  lang: "uz" | "ru" | "en",
): Promise<PartnerView[]> {
  const companies = await all<{
    id: number;
    name: string;
    sector: string | null;
    last_seen: string;
  }>("SELECT id, name, sector, last_seen FROM partners ORDER BY last_seen DESC LIMIT 100");

  if (companies.length === 0) return [];

  const notes = await all<{
    partner_id: number;
    kind: string;
    text: string;
    created_at: string;
  }>(`SELECT partner_id, kind, ${lang} AS text, created_at
        FROM partner_notes ORDER BY id DESC`);

  const ideas = await all<{
    id: number;
    partner_id: number;
    proposal: string;
    why: string;
    match: string | null;
  }>(`SELECT i.id, i.partner_id,
             i.proposal_${lang} AS proposal, i.why_${lang} AS why,
             m.name AS match
        FROM partner_ideas i
        LEFT JOIN partners m ON m.id = i.match_id
       WHERE i.status = 'yangi'
       ORDER BY i.id DESC`);

  return companies.map((company) => ({
    ...company,
    notes: notes
      .filter((note) => note.partner_id === company.id && note.text)
      .slice(0, 8),
    ideas: ideas.filter((idea) => idea.partner_id === company.id && idea.proposal),
  }));
}

/** Open suggestions across all companies — what the daily reminder carries. */
export async function openIdeas(
  lang: "uz" | "ru" | "en",
  limit = 8,
): Promise<
  { partner: string; proposal: string; why: string; match: string | null }[]
> {
  return all(
    `SELECT p.name AS partner,
            i.proposal_${lang} AS proposal, i.why_${lang} AS why,
            m.name AS match
       FROM partner_ideas i
       JOIN partners p ON p.id = i.partner_id
       LEFT JOIN partners m ON m.id = i.match_id
      WHERE i.status = 'yangi'
      ORDER BY i.id DESC LIMIT ?`,
    limit,
  );
}
