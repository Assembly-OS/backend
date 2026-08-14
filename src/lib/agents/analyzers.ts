import type { AgentContext } from "./context";
import type { ActionVerb, AgentId } from "./registry";

/**
 * ANALYSIS — step 4 of the pattern.
 *
 * Findings are produced by ordinary code, not by a model. Everything an agent
 * asserts here ("this task is 6 days overdue", "this person has no deadline on
 * 3 assignments") is a fact read straight out of the context rows, and the
 * `evidence` field names the row it came from — which is what TZ §9.2 asks for
 * when it says every conclusion must carry a source entity.
 *
 * The model's job comes later and is deliberately narrow: `claude.ts` may
 * rewrite these findings into readable prose, but it cannot add a finding,
 * change a number, or invent a subject. That split is what keeps an agent's
 * output checkable — a reader can follow every claim back to a row.
 */

export interface Finding {
  action: ActionVerb;
  title: string;
  body: string;
  severity: "P1" | "P2" | "P3" | "P4";
  subjectKind?: string;
  subjectId?: number;
  /** Human-readable citation: which rows this was computed from. */
  evidence: string;
  payload?: Record<string, unknown>;
}

const OPEN = ["YANGI", "QABUL_QILINDI", "BAJARILMOQDA", "TEKSHIRUVDA", "QAYTARILDI"];

function analyzeTaskControl(context: AgentContext): Finding[] {
  const findings: Finding[] = [];
  const tasks = context.tasks ?? [];

  // Overdue work, worst first. Severity follows TZ §11: P1 the moment a
  // critical task is late, escalating with age for the rest.
  const overdue = tasks
    .filter(
      (task) =>
        task.overdue_days !== null &&
        task.overdue_days > 0 &&
        OPEN.includes(task.status),
    )
    .sort((a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0));

  for (const task of overdue.slice(0, 10)) {
    const days = task.overdue_days ?? 0;
    const critical = task.priority === "KRITIK" || task.priority === "YUQORI";
    findings.push({
      action: days >= 2 || critical ? "escalate" : "notify",
      title: `${task.code}: muddati ${days} kun o'tgan`,
      body:
        `"${task.title}" — mas'ul ${task.to_name}, muddat ${task.deadline}, ` +
        `holat ${task.status}, muhimlik ${task.priority}.`,
      severity: critical ? "P1" : days >= 2 ? "P2" : "P3",
      subjectKind: "task",
      subjectId: task.id,
      evidence: `tasks#${task.id} (${task.code})`,
      payload: { toUserId: task.to_id, code: task.code, days },
    });
  }

  // Work due within 24h — the "deadline -24h" trigger of TZ §11.
  const soon = tasks.filter(
    (task) =>
      task.overdue_days !== null &&
      task.overdue_days <= 0 &&
      task.overdue_days > -2 &&
      OPEN.includes(task.status),
  );
  for (const task of soon.slice(0, 5)) {
    findings.push({
      action: "notify",
      title: `${task.code}: muddat yaqin`,
      body: `"${task.title}" — mas'ul ${task.to_name}, muddat ${task.deadline}.`,
      severity: "P3",
      subjectKind: "task",
      subjectId: task.id,
      evidence: `tasks#${task.id}`,
      payload: { toUserId: task.to_id, code: task.code },
    });
  }

  // Assignments nobody has picked up. `YANGI` older than 2 days means the
  // assignee has not even accepted it.
  const unaccepted = tasks.filter(
    (task) =>
      task.status === "YANGI" &&
      Date.now() - Date.parse(`${task.created_at.replace(" ", "T")}Z`) >
        2 * 86_400_000,
  );
  if (unaccepted.length > 0) {
    findings.push({
      action: "flag",
      title: `${unaccepted.length} ta topshiriq 2 kundan beri qabul qilinmagan`,
      body: unaccepted
        .slice(0, 8)
        .map((task) => `${task.code} — ${task.to_name}`)
        .join("; "),
      severity: "P2",
      evidence: unaccepted.map((task) => `tasks#${task.id}`).join(", "),
    });
  }

  // Workload imbalance — a queue nobody can clear is a management problem,
  // not an individual one.
  const loaded = (context.staff ?? [])
    .filter((person) => person.open_tasks >= 5)
    .sort((a, b) => b.open_tasks - a.open_tasks);
  for (const person of loaded.slice(0, 3)) {
    findings.push({
      action: "flag",
      title: `${person.full_name}: ${person.open_tasks} ta ochiq topshiriq`,
      body: `Shundan ${person.overdue_tasks} tasi muddati o'tgan. Yuklamani qayta taqsimlash kerak bo'lishi mumkin.`,
      severity: person.overdue_tasks > 0 ? "P2" : "P3",
      subjectKind: "user",
      subjectId: person.id,
      evidence: `users#${person.id}`,
    });
  }

  return findings;
}

function analyzeExecutive(context: AgentContext): Finding[] {
  const tasks = context.tasks ?? [];
  const staff = context.staff ?? [];
  const open = tasks.filter((task) => OPEN.includes(task.status));
  const overdue = open.filter((task) => (task.overdue_days ?? 0) > 0);
  const review = tasks.filter((task) => task.status === "TEKSHIRUVDA");
  const idle = staff.filter((person) => person.open_tasks === 0);

  const findings: Finding[] = [
    {
      action: "report",
      title: "Kunlik brief",
      body:
        `Ochiq topshiriqlar: ${open.length}. Muddati o'tgan: ${overdue.length}. ` +
        `Tekshiruvda: ${review.length}. Xodimlar: ${staff.length}, ` +
        `hozircha topshiriqsiz: ${idle.length}.`,
      severity: "P3",
      evidence: `tasks (${tasks.length} qator), users (${staff.length} qator)`,
    },
  ];

  // The decision queue: what actually needs the chairman, not everything.
  if (review.length > 0) {
    findings.push({
      action: "flag",
      title: `Qaror talab qiladi: ${review.length} ta natija tekshiruvda`,
      body: review
        .slice(0, 8)
        .map((task) => `${task.code} — ${task.to_name} (${task.title})`)
        .join("; "),
      severity: "P2",
      evidence: review.map((task) => `tasks#${task.id}`).join(", "),
    });
  }

  if (overdue.length > 0) {
    const worst = overdue.sort(
      (a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0),
    )[0];
    findings.push({
      action: "flag",
      title: `Eng katta risk: ${worst.code}`,
      body: `"${worst.title}" — ${worst.overdue_days} kun kechikkan, mas'ul ${worst.to_name}.`,
      severity: "P1",
      subjectKind: "task",
      subjectId: worst.id,
      evidence: `tasks#${worst.id}`,
    });
  }

  return findings;
}

function analyzeDataQuality(context: AgentContext): Finding[] {
  const findings: Finding[] = [];
  const tasks = context.tasks ?? [];

  const noDeadline = tasks.filter(
    (task) => !task.deadline && OPEN.includes(task.status),
  );
  if (noDeadline.length > 0) {
    findings.push({
      action: "flag",
      title: `${noDeadline.length} ta ochiq topshiriqda muddat yo'q`,
      body: noDeadline
        .slice(0, 10)
        .map((task) => `${task.code} — ${task.to_name}`)
        .join("; "),
      severity: "P2",
      evidence: noDeadline.map((task) => `tasks#${task.id}`).join(", "),
    });
  }

  const orphanProjects = (context.projects ?? []).filter(
    (project) => project.owner_id === null,
  );
  if (orphanProjects.length > 0) {
    findings.push({
      action: "flag",
      title: `${orphanProjects.length} ta loyihada rahbar belgilanmagan`,
      body: orphanProjects
        .slice(0, 10)
        .map((project) => `${project.code} — ${project.name}`)
        .join("; "),
      severity: "P2",
      evidence: orphanProjects.map((p) => `loyihalar#${p.id}`).join(", "),
    });
  }

  const orphanAssoc = (context.associations ?? []).filter(
    (association) => association.head_user_id === null,
  );
  if (orphanAssoc.length > 0) {
    findings.push({
      action: "flag",
      title: `${orphanAssoc.length} ta uyushmada rais belgilanmagan`,
      body: orphanAssoc
        .slice(0, 10)
        .map((association) => association.name)
        .join("; "),
      severity: "P3",
      evidence: orphanAssoc.map((a) => `uyushmalar#${a.id}`).join(", "),
    });
  }

  // Someone who has never signed in cannot be doing the work assigned to them.
  const neverSeen = (context.staff ?? []).filter(
    (person) => !person.last_seen && person.open_tasks > 0,
  );
  if (neverSeen.length > 0) {
    findings.push({
      action: "flag",
      title: `${neverSeen.length} ta xodim tizimga hech kirmagan, lekin topshiriqlari bor`,
      body: neverSeen
        .map((person) => `${person.full_name} (${person.open_tasks} ta)`)
        .join("; "),
      severity: "P2",
      evidence: neverSeen.map((person) => `users#${person.id}`).join(", "),
    });
  }

  if (findings.length === 0) {
    findings.push({
      action: "report",
      title: "Ma'lumot sifati: muammo topilmadi",
      body: "Tekshirilgan maydonlarda bo'sh mas'ul, muddat yoki rahbar aniqlanmadi.",
      severity: "P4",
      evidence: `tasks, users, loyihalar, uyushmalar`,
    });
  }

  return findings;
}

function analyzeRisk(context: AgentContext): Finding[] {
  const findings: Finding[] = [];
  const tasks = context.tasks ?? [];

  // "overdue high-risk" from the TZ table.
  const criticalLate = tasks.filter(
    (task) =>
      (task.priority === "KRITIK" || task.priority === "YUQORI") &&
      (task.overdue_days ?? 0) > 0 &&
      OPEN.includes(task.status),
  );
  for (const task of criticalLate.slice(0, 5)) {
    findings.push({
      action: "escalate",
      title: `Yuqori riskli kechikish: ${task.code}`,
      body: `"${task.title}" — ${task.priority}, ${task.overdue_days} kun kechikkan, mas'ul ${task.to_name}.`,
      severity: "P1",
      subjectKind: "task",
      subjectId: task.id,
      evidence: `tasks#${task.id}`,
      payload: { toUserId: task.to_id, code: task.code },
    });
  }

  // "missing approval": work handed in and left hanging in review.
  const stuck = tasks.filter(
    (task) =>
      task.status === "TEKSHIRUVDA" &&
      (task.overdue_days === null || task.overdue_days > 0),
  );
  if (stuck.length > 0) {
    findings.push({
      action: "flag",
      title: `${stuck.length} ta natija tasdiqlanmay turibdi`,
      body: stuck
        .slice(0, 8)
        .map((task) => `${task.code} — ${task.from_name} tasdig'i kutilmoqda`)
        .join("; "),
      severity: "P2",
      evidence: stuck.map((task) => `tasks#${task.id}`).join(", "),
    });
  }

  if (findings.length === 0) {
    findings.push({
      action: "report",
      title: "Risk signali yo'q",
      body: "Yuqori riskli kechikish va tasdiqlanmagan natija aniqlanmadi.",
      severity: "P4",
      evidence: "tasks, task_events",
    });
  }

  return findings;
}

function analyzeReport(context: AgentContext): Finding[] {
  const tasks = context.tasks ?? [];
  const events = context.task_events ?? [];
  const done = events.filter((event) => event.action === "TASDIQLANDI").length;
  const submitted = events.filter(
    (event) => event.action === "TOPSHIRILDI",
  ).length;
  const created = events.filter((event) => event.action === "YARATILDI").length;

  const byStatus = new Map<string, number>();
  for (const task of tasks) {
    byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
  }

  return [
    {
      action: "report",
      title: "Strukturaviy hisobot",
      body:
        `Jami topshiriq: ${tasks.length}. ` +
        [...byStatus.entries()]
          .map(([status, count]) => `${status}: ${count}`)
          .join(", ") +
        `. So'nggi hodisalar bo'yicha: yaratildi ${created}, topshirildi ${submitted}, tasdiqlandi ${done}.`,
      severity: "P3",
      evidence: `tasks (${tasks.length}), task_events (${events.length})`,
    },
  ];
}

const ANALYZERS: Partial<Record<AgentId, (context: AgentContext) => Finding[]>> =
  {
    executive: analyzeExecutive,
    task_control: analyzeTaskControl,
    data_quality: analyzeDataQuality,
    risk_compliance: analyzeRisk,
    report: analyzeReport,
  };

export function analyze(agent: AgentId, context: AgentContext): Finding[] {
  const analyzer = ANALYZERS[agent];
  return analyzer ? analyzer(context) : [];
}
