/**
 * The agent ecosystem of TZ §10, declared as data.
 *
 * The specification's binding constraint (§10.1, "MUHIM") is that agents must
 * not become an open-ended autonomous system that talks to itself: the
 * orchestrator holds every agent's tool access, token/cost ceiling, data scope,
 * action scope and approval requirement, and enforces them.
 *
 * That is only true if those limits live somewhere the orchestrator can read
 * and an agent cannot edit. They live here. An agent is a *declaration* — it
 * cannot widen its own scope, spawn another agent, or invent an action verb,
 * because the pipeline in `orchestrator.ts` only ever consults this table.
 */

/** The data an agent may read. Each maps to one reader in `context.ts`. */
export type DataScope =
  | "tasks"
  | "task_events"
  | "staff"
  | "messages"
  | "projects"
  | "associations";

/** What an agent may propose. Anything not listed here is refused. */
export type ActionVerb =
  | "report" // produce a written summary; touches nothing
  | "notify" // send a message to a person through the bot
  | "flag" // raise a risk for a human to look at
  | "suggest_task" // draft an assignment for a human to confirm
  | "escalate"; // route an overdue item up the management line

/** Every agent named in TZ §10, in the order the specification lists them. */
export type AgentId =
  | "executive"
  | "task_control"
  | "crm"
  | "kpi"
  | "project_pmo"
  | "gr"
  | "br"
  | "fr_country"
  | "pr_media"
  | "meeting"
  | "document"
  | "risk_compliance"
  | "data_quality"
  | "report";

export interface AgentSpec {
  id: AgentId;
  /** The agent's name and remit, quoted from the TZ table. */
  title: string;
  task: string;
  /** Tables this agent may read — the orchestrator passes nothing else. */
  dataScope: DataScope[];
  /** Verbs it may propose. */
  actionScope: ActionVerb[];
  /**
   * Whether a proposal needs a human before it takes effect. Read-only
   * verbs ("report", "flag") are safe to auto-apply because applying them
   * means only "write it down"; anything that reaches a person or changes
   * a record waits for approval — TZ §16, AI-03.
   */
  approval: "always" | "for_side_effects";
  /**
   * Verbs this agent may carry out immediately, overriding `approval`.
   *
   * Only the two intake agents have this, and only because the approval already
   * happened outside the system: a director hands in a signed order or the
   * minutes of a meeting he chaired, and the instruction to distribute the work
   * *is* the document. Asking him to re-confirm each line adds a click, not a
   * decision. The limits that actually protect anything are unchanged — the
   * agent may still only name someone the submitter is allowed to assign to,
   * and every created task carries the run it came from.
   */
  autoExecute?: ActionVerb[];
  /** Ceiling for one run, in tokens. Enforced before and after the call. */
  tokenBudget: number;
  /**
   * Live agents have an analyzer and real data behind them. The rest are
   * declared but dormant: their modules (CRM, KPI, PPM, country desks,
   * meetings, documents) are Phase-2 in the delivery roadmap, and pretending
   * otherwise would produce confident output over data that does not exist.
   */
  status: "active" | "planned";
  /** For planned agents: what the platform still lacks. */
  blockedBy?: string;
  /**
   * Agents that analyse something a person submitted. They cannot be started
   * from the console with no material, and the submitter — not the
   * administrator — is who approves what comes back.
   */
  requiresSource?: "pdf" | "transcript";
}

export const AGENTS: AgentSpec[] = [
  {
    id: "executive",
    title: "Executive Agent",
    task: "Rais uchun daily brief, decision queue, top risks, top opportunities, next-7-days.",
    dataScope: ["tasks", "task_events", "staff"],
    actionScope: ["report", "flag"],
    approval: "for_side_effects",
    tokenBudget: 30_000,
    status: "active",
  },
  {
    id: "task_control",
    title: "Task Control Agent",
    task: "Deadline monitoring, overdue, dependency, blocker, workload; reminder va escalation draft.",
    dataScope: ["tasks", "task_events", "staff"],
    actionScope: ["report", "flag", "notify", "escalate"],
    approval: "for_side_effects",
    tokenBudget: 20_000,
    status: "active",
  },
  {
    id: "data_quality",
    title: "Data Quality Agent",
    task: "Missing owners/deadlines, inconsistent fields, duplicate org/person, stale records.",
    dataScope: ["tasks", "staff", "projects", "associations"],
    actionScope: ["report", "flag"],
    approval: "for_side_effects",
    tokenBudget: 15_000,
    status: "active",
  },
  {
    id: "risk_compliance",
    title: "Risk & Compliance Agent",
    task: "Confidentiality check, unusual access, overdue high-risk, missing approval, policy violation signal.",
    dataScope: ["tasks", "task_events", "staff", "messages"],
    actionScope: ["report", "flag", "escalate"],
    approval: "always",
    tokenBudget: 20_000,
    status: "active",
  },
  {
    id: "report",
    title: "Report Agent",
    task: "Daily/weekly/monthly/quarterly structured reports and export to Word/PDF/Excel.",
    dataScope: ["tasks", "task_events", "staff"],
    actionScope: ["report"],
    approval: "for_side_effects",
    tokenBudget: 25_000,
    status: "active",
  },

  /* -------- declared by the TZ, waiting on their data modules -------- */
  {
    id: "crm",
    title: "CRM Agent",
    task: "Contact summary, next action, stale relationship, duplicate, pipeline probability, follow-up draft.",
    dataScope: [],
    actionScope: ["report", "flag", "notify"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "CRM moduli (kontakt, tashkilot, pipeline) hali yo'q",
  },
  {
    id: "kpi",
    title: "KPI Agent",
    task: "Target/fact/evidence check, score draft, anomaly, low-performance root cause.",
    dataScope: ["tasks", "task_events", "staff"],
    actionScope: ["report", "flag"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "KPI moduli (target/fakt/dalil) hali yo'q",
  },
  {
    id: "project_pmo",
    title: "Project PMO Agent",
    task: "Milestone health, critical path, risk register, cross-department dependencies.",
    dataScope: ["projects", "tasks"],
    actionScope: ["report", "flag", "escalate"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "Loyiha milestone va risk reyestri hali yo'q",
  },
  {
    id: "gr",
    title: "GR Agent",
    task: "Gov stakeholder map, letter/protocol summary, approval chain, regulatory issue tracker.",
    dataScope: [],
    actionScope: ["report", "flag"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "Stakeholder va hujjat reyestri hali yo'q",
  },
  {
    id: "br",
    title: "BR Agent",
    task: "Association/company intake, business diagnostics, service routing, B2B match.",
    dataScope: ["associations"],
    actionScope: ["report", "flag", "suggest_task"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "Uyushma kartasi (muammo/imkoniyat) hali to'ldirilmagan",
  },
  {
    id: "fr_country",
    title: "FR / Country Agent",
    task: "Country brief, embassy/IFI/investor prep, deal pipeline, delegation follow-up.",
    dataScope: [],
    actionScope: ["report", "flag"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "Country desk moduli hali yo'q",
  },
  {
    id: "pr_media",
    title: "PR / Media Agent",
    task: "Content calendar, factual brief, sentiment, media risk, approval-ready drafts.",
    dataScope: [],
    actionScope: ["report", "flag"],
    approval: "always",
    tokenBudget: 20_000,
    status: "planned",
    blockedBy: "Media monitoring integratsiyasi hali yo'q",
  },
  {
    id: "meeting",
    title: "Meeting Agent",
    task: "Bayonnoma import, key point, qaror va topshiriq ajratish; Rais va yordamchisiga xulosa.",
    // Needs the staff list to name an owner for each extracted task, and the
    // task list so it does not re-raise work that already exists.
    dataScope: ["staff", "tasks"],
    actionScope: ["report", "suggest_task", "notify"],
    approval: "always",
    // The brief is sent rather than queued — a summary nobody has read yet is
    // the one thing that must not wait. Assignments are not on that list: they
    // go to the head of the assignee's department first, who can correct them.
    autoExecute: ["notify"],
    tokenBudget: 25_000,
    status: "active",
    // Started from a submitted transcript, never on a timer: the orchestrator
    // refuses a run with no source (see `requiresSource`).
    requiresSource: "transcript",
  },
  {
    id: "document",
    title: "Document Agent",
    task: "PDF hujjatni tahlil qilish, topshiriqlarni ajratib olish va mas'ullarga taqsimlash.",
    dataScope: ["staff", "tasks"],
    actionScope: ["report", "suggest_task"],
    approval: "always",
    tokenBudget: 30_000,
    status: "active",
    requiresSource: "pdf",
  },
];

export function agentById(id: string): AgentSpec | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

/** Verbs that touch something outside the agent log and so need a human. */
const SIDE_EFFECT_VERBS: ActionVerb[] = ["notify", "suggest_task", "escalate"];

/**
 * Whether one proposed action may be applied without a human.
 *
 * `autoExecute` is the only way past the gate, and it is granted per verb in
 * the table above — never inferred. Everything else keeps the strict rule: an
 * agent marked `approval: "always"` never auto-applies, and no agent
 * auto-applies a verb that reaches a person or writes a record.
 */
export function needsApproval(agent: AgentSpec, action: ActionVerb): boolean {
  if (agent.autoExecute?.includes(action)) return false;
  if (agent.approval === "always") return true;
  return SIDE_EFFECT_VERBS.includes(action);
}
