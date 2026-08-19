/**
 * Seeds data/assambleya.db with a demo org chart, associations, projects,
 * assignments and chat history. Deterministic: re-running gives the same DB.
 *
 *   npm run seed        — create/refresh (drops existing rows)
 *   npm run reset-db    — delete the file and rebuild from scratch
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DB_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DB_DIR, "assambleya.db");
const DEMO_PASSWORD = "12345678";

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8"));

// Wipe rows but keep the schema, so re-seeding is idempotent.
db.exec(`
  DELETE FROM task_events;
  DELETE FROM task_stages;
  DELETE FROM messages;
  DELETE FROM tasks;
  DELETE FROM loyihalar;
  DELETE FROM uyushmalar;
  DELETE FROM users;
  DELETE FROM sqlite_sequence;
`);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// One hash for every demo account — scrypt is slow, 43 of them would crawl.
const DEMO_HASH = hashPassword(DEMO_PASSWORD);

// Deterministic PRNG so the demo data set never shifts between runs.
let seed = 20260721;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

const BASE = new Date("2026-07-23T09:00:00Z").getTime();
const ts = (daysFromNow, hour = 10) => {
  const d = new Date(BASE + daysFromNow * 86400000);
  d.setUTCHours(hour, int(0, 59), 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
};
const day = (daysFromNow) =>
  new Date(BASE + daysFromNow * 86400000).toISOString().slice(0, 10);

const insertUser = db.prepare(`
  INSERT INTO users (login, password_hash, full_name, role, department, position,
                     uyushma_id, loyiha_id, manager_id, phone, email, lang, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

let phoneSeq = 90;
function addUser(u) {
  phoneSeq += 1;
  const email = `${u.login.replace(/\./g, "_")}@assambleya.uz`;
  const phone = `+998 ${phoneSeq} ${int(100, 999)}-${int(10, 99)}-${int(10, 99)}`;
  insertUser.run(
    u.login,
    DEMO_HASH,
    u.full_name,
    u.role,
    u.department ?? null,
    u.position ?? null,
    u.uyushma_id ?? null,
    u.loyiha_id ?? null,
    u.manager_id ?? null,
    phone,
    email,
    u.lang ?? "uz",
    ts(-200, 9),
  );
  return Number(
    db.prepare("SELECT id FROM users WHERE login = ?").get(u.login).id,
  );
}

/* ---------------------------------------------------------------- */
/* 1. Rais + departments + AI Lab                                    */
/* ---------------------------------------------------------------- */

const raisId = addUser({
  login: "rais",
  full_name: "Muhtor Umarov",
  role: "RAIS",
  position: "Assambleya Raisi",
});

const DEPARTMENTS = [
  {
    code: "GR",
    login: "gr.rahbar",
    name: "Bekzod Rustamovich Tursunov",
    position: "GR bo'limi rahbari",
    staff: [
      ["gr.xodim1", "Dilshod Anvarovich Yo'ldoshev", "GR bo'limi bosh mutaxassisi"],
      ["gr.xodim2", "Nilufar Baxtiyorovna Ergasheva", "GR bo'limi mutaxassisi"],
      ["gr.xodim3", "Sardor Ilhomovich Nazarov", "Huquqiy monitoring mutaxassisi"],
    ],
  },
  {
    code: "FR",
    login: "fr.rahbar",
    name: "Kamola Shuhratovna Inoyatova",
    position: "FR bo'limi rahbari",
    staff: [
      ["fr.xodim1", "Jasur Farhodovich Umarov", "Xalqaro loyihalar mutaxassisi"],
      ["fr.xodim2", "Malika Otabekovna Rashidova", "Investorlar bilan ishlash mutaxassisi"],
      ["fr.xodim3", "Temur Alisherovich Xolmatov", "Protokol va delegatsiyalar mutaxassisi"],
    ],
  },
  {
    code: "BR",
    login: "br.rahbar",
    name: "Otabek Zafarovich Mirzayev",
    position: "BR bo'limi rahbari",
    staff: [
      ["br.xodim1", "Shahzod Rustamovich Kenjayev", "Uyushmalar bilan ishlash mutaxassisi"],
      ["br.xodim2", "Zilola Muzaffarovna Sattorova", "Tadbirkorlik qo'llab-quvvatlash mutaxassisi"],
      ["br.xodim3", "Anvar Doniyorovich Rahimov", "Soha tahlili mutaxassisi"],
    ],
  },
  {
    code: "PR",
    login: "pr.rahbar",
    name: "Gulnora Sanjarovna Yusupova",
    position: "PR bo'limi rahbari",
    staff: [
      ["pr.xodim1", "Aziza Komiljonovna Tosheva", "AI MediaNet kontent muharriri"],
      ["pr.xodim2", "Rustam Baxodirovich Qodirov", "Media aloqalar mutaxassisi"],
      ["pr.xodim3", "Lola Farrux qizi Ismoilova", "SMM va raqamli kommunikatsiya"],
    ],
  },
];

const deptHeadId = {};
const staffIds = {};

for (const dep of DEPARTMENTS) {
  const headId = addUser({
    login: dep.login,
    full_name: dep.name,
    role: "BOLIM_RAHBARI",
    department: dep.code,
    position: dep.position,
    manager_id: raisId,
  });
  deptHeadId[dep.code] = headId;
  staffIds[dep.code] = dep.staff.map(([login, name, position]) =>
    addUser({
      login,
      full_name: name,
      role: "ISHCHI",
      department: dep.code,
      position,
      manager_id: headId,
    }),
  );
}

const aiLabId = addUser({
  login: "ailab.rahbar",
  full_name: "Shohruh Islomovich Karimov",
  role: "AI_LAB",
  department: "AI_LAB",
  position: "AI Lab rahbari — raqamli shtab",
  manager_id: raisId,
});
deptHeadId.AI_LAB = aiLabId;
staffIds.AI_LAB = [
  ["ailab.xodim1", "Javohir Ulug'bekovich Sobirov", "AI-agentlar muhandisi"],
  ["ailab.xodim2", "Madina Rustamovna Abdullayeva", "Ma'lumotlar tahlilchisi"],
  ["ailab.xodim3", "Doniyor Sherzodovich Hakimov", "Integratsiyalar muhandisi"],
].map(([login, name, position]) =>
  addUser({
    login,
    full_name: name,
    role: "ISHCHI",
    department: "AI_LAB",
    position,
    manager_id: aiLabId,
  }),
);

/* ---------------------------------------------------------------- */
/* 2. Uyushmalar + their heads                                       */
/* ---------------------------------------------------------------- */

const UYUSHMALAR = [
  ["O'zbekiston To'qimachilik va Tikuvchilik Sanoati Uyushmasi", "Tekstil", "To'qimachilik", "Toshkent", 184, "tekstil.rais", "Farrux Odilovich Yusupov"],
  ["Agrosanoat va Qishloq Xo'jaligi Uyushmasi", "Agro", "Agrosanoat", "Samarqand", 246, "agro.rais", "Bahodir Ne'matovich Sultonov"],
  ["Qurilish Materiallari Ishlab Chiqaruvchilar Uyushmasi", "Qurilish", "Qurilish", "Navoiy", 132, "qurilish.rais", "Ulug'bek Toirovich Ergashev"],
  ["Axborot Texnologiyalari va IT Uyushmasi", "IT Park", "Axborot texnologiyalari", "Toshkent", 312, "it.rais", "Sanjar Muzaffarovich Xolmirzayev"],
  ["Turizm va Mehmondo'stlik Uyushmasi", "Turizm", "Turizm", "Buxoro", 158, "turizm.rais", "Dilnoza Akmalovna Nazarova"],
  ["Energetika va Qayta Tiklanuvchi Manbalar Uyushmasi", "Energetika", "Energetika", "Toshkent", 94, "energetika.rais", "Rustam Xayrullayevich Ochilov"],
  ["Farmatsevtika Sanoati Uyushmasi", "Farm", "Farmatsevtika", "Toshkent", 76, "farm.rais", "Nodira Alisherovna Qodirova"],
  ["Logistika va Transport Uyushmasi", "Logistika", "Logistika", "Termiz", 121, "logistika.rais", "Shavkat Turg'unovich Boymatov"],
  ["Oziq-ovqat Sanoati Uyushmasi", "Oziq-ovqat", "Oziq-ovqat", "Andijon", 203, "oziqovqat.rais", "Iroda Bahromovna Yo'ldosheva"],
  ["Kimyo Sanoati Uyushmasi", "Kimyo", "Kimyo sanoati", "Farg'ona", 68, "kimyo.rais", "Alisher Nodirovich Tojiboyev"],
  ["Metallurgiya va Mashinasozlik Uyushmasi", "Metall", "Metallurgiya", "Olmaliq", 89, "metall.rais", "Jamshid Qahramonovich Sodiqov"],
  ["Ta'lim va Kadrlar Tayyorlash Uyushmasi", "Ta'lim", "Ta'lim", "Toshkent", 174, "talim.rais", "Zebo Ikromovna Mirzayeva"],
];

const insertUyushma = db.prepare(`
  INSERT INTO uyushmalar (name, short_name, sector, region, members_count, head_user_id, created_at)
  VALUES (?,?,?,?,?,?,?)
`);

const uyushmaIds = [];
for (const [name, short, sector, region, members, login, head] of UYUSHMALAR) {
  insertUyushma.run(name, short, sector, region, members, null, ts(-300, 9));
  const uyushmaId = Number(
    db.prepare("SELECT id FROM uyushmalar WHERE short_name = ?").get(short).id,
  );
  const headId = addUser({
    login,
    full_name: head,
    role: "UYUSHMA_RAISI",
    position: `${short} uyushmasi raisi`,
    uyushma_id: uyushmaId,
    manager_id: deptHeadId.BR,
  });
  db.prepare("UPDATE uyushmalar SET head_user_id = ? WHERE id = ?").run(
    headId,
    uyushmaId,
  );
  uyushmaIds.push({ id: uyushmaId, headId, short });
}

/* ---------------------------------------------------------------- */
/* 3. Loyihalar + project managers                                   */
/* ---------------------------------------------------------------- */

const LOYIHALAR = [
  ["CASC", "Central Asian Smart City", 42, 1250, "casc.rahbar", "Akmal Zoirovich Nurmatov", 3],
  ["KNG", "Konglomerat", 61, 890, "kng.rahbar", "Sherzod Ravshanovich Aliyev", 10],
  ["SO", "Sokin Osmon", 28, 430, "so.rahbar", "Nargiza Uktamovna Yusupova", 5],
  ["YBIY", "Yangi Buyuk Ipak Yo'li", 55, 1620, "ybiy.rahbar", "Bobur Shermatovich Nazarov", 8],
  ["IHUB", "Invest HUB", 73, 2100, "ihub.rahbar", "Aziza Rustamovna Karimova", 4],
  ["EJOB", "Edu-Job", 66, 340, "ejob.rahbar", "Umid Sardorovich Tolipov", 12],
  ["RDH", "R&D HUB", 37, 760, "rdh.rahbar", "Feruza Muhammadovna Sattarova", 4],
  ["TIH", "Termiz Industrial HUB", 49, 1480, "tih.rahbar", "Xurshid Anvarovich Berdiyev", 8],
  ["MOEX", "MOEX", 22, 950, "moex.rahbar", "Ravshan Ilhomovich Sattorov", 11],
  ["WUP", "WomanUP", 81, 210, "wup.rahbar", "Sevara Jamshidovna Umarova", 12],
];

const insertLoyiha = db.prepare(`
  INSERT INTO loyihalar (code, name, status, progress, budget, owner_id, uyushma_id, deadline, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

const loyihaIds = [];
for (const [code, name, progress, budget, login, owner, uyushmaIndex] of LOYIHALAR) {
  const uyushma = uyushmaIds[uyushmaIndex - 1];
  insertLoyiha.run(
    code,
    name,
    progress >= 70 ? "YAKUNLANMOQDA" : "FAOL",
    progress,
    budget,
    null,
    uyushma.id,
    day(int(60, 400)),
    ts(-250, 9),
  );
  const loyihaId = Number(
    db.prepare("SELECT id FROM loyihalar WHERE code = ?").get(code).id,
  );
  const ownerId = addUser({
    login,
    full_name: owner,
    role: "LOYIHA_RAHBARI",
    position: `${name} loyihasi rahbari`,
    loyiha_id: loyihaId,
    uyushma_id: uyushma.id,
    manager_id: raisId,
  });
  db.prepare("UPDATE loyihalar SET owner_id = ? WHERE id = ?").run(
    ownerId,
    loyihaId,
  );
  loyihaIds.push({ id: loyihaId, ownerId, code, uyushmaId: uyushma.id });
}

/* ---------------------------------------------------------------- */
/* 4. Tasks                                                          */
/* ---------------------------------------------------------------- */

const TASK_TITLES = {
  GR: [
    "Yangi soliq imtiyozlari bo'yicha vazirlikka taklif tayyorlash",
    "Qonun loyihasiga Assambleya xulosasini shakllantirish",
    "Hukumat komissiyasi majlisiga ma'lumotnoma tayyorlash",
    "Tadbirkorlar murojaatlarini davlat organlariga yo'naltirish",
    "Litsenziyalash tartibini soddalashtirish bo'yicha tahlil",
    "Vazirlik bilan qo'shma hujjat loyihasini kelishish",
  ],
  FR: [
    "Xitoy delegatsiyasi tashrifi dasturini tayyorlash",
    "Turkiya investorlari bilan MOU loyihasini tayyorlash",
    "Xalqaro grant dasturi bo'yicha ariza to'plash",
    "Yevropa Ittifoqi eksport talablarini tahlil qilish",
    "Qozog'iston bilan qo'shma logistika loyihasini ishlab chiqish",
    "BAA investitsiya forumiga ishtirokchilar ro'yxatini shakllantirish",
  ],
  BR: [
    "50 ta uyushma bo'yicha choraklik hisobotni yig'ish",
    "Yangi uyushma a'zolarini ro'yxatga olish",
    "Soha muammolari bo'yicha so'rovnoma o'tkazish",
    "Uyushmalar KPI ko'rsatkichlarini yangilash",
    "Tadbirkorlar uchun ma'lumotnoma bazasini to'ldirish",
    "Eksport salohiyati bo'yicha soha tahlilini tayyorlash",
  ],
  PR: [
    "Loyiha natijalari bo'yicha matbuot relizini tayyorlash",
    "AI MediaNet uchun kontent-reja tuzish",
    "Rais nutqi uchun tezislar tayyorlash",
    "Ijtimoiy tarmoqlarda yoritish hisobotini tayyorlash",
    "Media hamkorlar bilan uchrashuvni tashkil qilish",
    "Yillik hisobot dizayn-maketini kelishish",
  ],
  AI_LAB: [
    "Chairman AI kunlik brifing shablonini sozlash",
    "PMO AI Agent uchun risk modelini kalibrlash",
    "Document AI Agent shartnoma shablonlarini yangilash",
    "Knowledge AI bazasiga yangi reglamentlarni yuklash",
    "KPI & Risk Agent bildirishnomalarini sozlash",
    "Telegram integratsiyasi uchun bot ulanishini tekshirish",
  ],
};

const TASK_DESCRIPTIONS = [
  "Ma'lumotlarni yig'ib, tahlil qilib, yakuniy hujjatni tayyorlang. Natijani tizim orqali topshiring.",
  "Barcha manfaatdor tomonlar bilan kelishing va yakuniy variantni taqdim eting.",
  "Muddat qat'iy. Har bir bosqich bo'yicha oraliq holatni tizimda belgilab boring.",
  "Tegishli bo'limlar bilan hamkorlikda bajarilsin, yakunda qisqacha xulosa taqdim etilsin.",
  "Avvalgi chorak ma'lumotlari bilan solishtirib, o'zgarishlar dinamikasini ko'rsating.",
];

const RESULT_COMMENTS = [
  "Bajarildi. Hujjat tayyorlanib, kelishuvga yuborildi.",
  "Tahlil yakunlandi, natijalar ilova qilindi.",
  "Barcha bandlar bo'yicha ish yakunlandi, izohlar hisobga olindi.",
  "Ma'lumotlar yig'ildi va tizimga kiritildi.",
];

const insertTask = db.prepare(`
  INSERT INTO tasks (code, title, description, from_user_id, to_user_id, to_department,
                     priority, status, deadline, loyiha_id, uyushma_id, result_comment,
                     created_at, accepted_at, submitted_at, closed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const insertEvent = db.prepare(`
  INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position)
  VALUES (?,?,?,?,?,1)
`);
// A demo assignment is a chain of one. Seeding the stage row too keeps the
// per-person counts (completed, the team table) reading the same numbers a
// migrated production database reports.
const insertStage = db.prepare(`
  INSERT INTO task_stages (task_id, position, to_user_id, reviewer_user_id, instruction,
                           status, result_comment, accepted_at, submitted_at, closed_at, created_at)
  VALUES (?,1,?,NULL,NULL,?,?,?,?,?,?)
`);

let taskSeq = 0;
function addTask({
  title,
  description,
  fromId,
  toId,
  department,
  status,
  priority,
  createdDay,
  deadlineDay,
  loyihaId = null,
  uyushmaId = null,
}) {
  taskSeq += 1;
  const code = `T-${String(taskSeq).padStart(4, "0")}`;
  const createdAt = ts(createdDay, int(9, 17));
  const acceptedAt =
    status === "YANGI" || status === "RAD_ETILDI"
      ? null
      : ts(createdDay + 1, int(9, 17));
  const submittedAt = ["TEKSHIRUVDA", "BAJARILDI", "QAYTARILDI"].includes(status)
    ? ts(createdDay + 3, int(9, 17))
    : null;
  const closedAt = ["BAJARILDI", "RAD_ETILDI"].includes(status)
    ? ts(createdDay + 4, int(9, 17))
    : null;
  const result = submittedAt ? pick(RESULT_COMMENTS) : null;

  insertTask.run(
    code,
    title,
    description,
    fromId,
    toId,
    department,
    priority,
    status,
    deadlineDay === null ? null : day(deadlineDay),
    loyihaId,
    uyushmaId,
    result,
    createdAt,
    acceptedAt,
    submittedAt,
    closedAt,
  );
  const taskId = Number(
    db.prepare("SELECT id FROM tasks WHERE code = ?").get(code).id,
  );

  insertStage.run(
    taskId,
    toId,
    status,
    result,
    acceptedAt,
    submittedAt,
    closedAt,
    createdAt,
  );

  insertEvent.run(taskId, fromId, "YARATILDI", null, createdAt);
  if (acceptedAt) insertEvent.run(taskId, toId, "QABUL_QILINDI", null, acceptedAt);
  if (submittedAt) insertEvent.run(taskId, toId, "TOPSHIRILDI", result, submittedAt);
  if (status === "BAJARILDI")
    insertEvent.run(taskId, fromId, "TASDIQLANDI", "Ish sifatli bajarildi.", closedAt);
  if (status === "RAD_ETILDI")
    insertEvent.run(taskId, toId, "RAD_ETILDI", "Hozircha resurs yo'q.", closedAt);
  if (status === "QAYTARILDI")
    insertEvent.run(
      taskId,
      fromId,
      "QAYTARILDI",
      "Raqamlar aniqlashtirilsin va qayta topshirilsin.",
      ts(createdDay + 4, int(9, 17)),
    );
  return taskId;
}

const PRIORITIES = ["PAST", "ORTA", "ORTA", "YUQORI", "YUQORI", "KRITIK"];

// Rais -> department heads and AI Lab (some fresh, some already in flight)
const HEAD_CODES = ["GR", "FR", "BR", "PR", "AI_LAB"];
for (const code of HEAD_CODES) {
  const headId = deptHeadId[code];
  const titles = TASK_TITLES[code];

  // 2 fresh ones waiting to be accepted
  for (let i = 0; i < 2; i += 1) {
    addTask({
      title: titles[i],
      description: pick(TASK_DESCRIPTIONS),
      fromId: raisId,
      toId: headId,
      department: code,
      status: "YANGI",
      priority: pick(PRIORITIES),
      createdDay: -int(0, 2),
      deadlineDay: int(3, 21),
      loyihaId: pick(loyihaIds).id,
    });
  }
  // in progress / under review / done
  const flow = ["QABUL_QILINDI", "BAJARILMOQDA", "BAJARILMOQDA", "TEKSHIRUVDA", "BAJARILDI", "BAJARILDI", "QAYTARILDI"];
  flow.forEach((status, i) => {
    addTask({
      title: titles[(i + 2) % titles.length],
      description: pick(TASK_DESCRIPTIONS),
      fromId: raisId,
      toId: headId,
      department: code,
      status,
      priority: pick(PRIORITIES),
      createdDay: -int(4, 30),
      deadlineDay: status === "BAJARILDI" ? -int(1, 8) : int(-4, 20),
      loyihaId: pick(loyihaIds).id,
    });
  });

  // Department head -> own staff, the "accept results from workers" pipeline
  const staff = staffIds[code];
  const staffFlow = [
    "YANGI", "YANGI", "QABUL_QILINDI", "BAJARILMOQDA",
    "TEKSHIRUVDA", "TEKSHIRUVDA", "TEKSHIRUVDA", "BAJARILDI",
    "BAJARILDI", "BAJARILDI", "QAYTARILDI", "RAD_ETILDI",
  ];
  staffFlow.forEach((status, i) => {
    addTask({
      title: titles[i % titles.length],
      description: pick(TASK_DESCRIPTIONS),
      fromId: headId,
      toId: staff[i % staff.length],
      department: code,
      status,
      priority: pick(PRIORITIES),
      createdDay: -int(2, 35),
      deadlineDay: int(-6, 18),
      loyihaId: rnd() > 0.5 ? pick(loyihaIds).id : null,
    });
  });
}

// Cross-department: heads ask each other for input
addTask({
  title: "PR bo'limi uchun loyiha natijalari statistikasini taqdim etish",
  description: "AI MediaNet kontent-rejasi uchun raqamlar kerak.",
  fromId: deptHeadId.PR,
  toId: deptHeadId.BR,
  department: "BR",
  status: "YANGI",
  priority: "YUQORI",
  createdDay: -1,
  deadlineDay: 5,
});
addTask({
  title: "Xalqaro forum uchun huquqiy xulosa tayyorlash",
  description: "FR bo'limi so'roviga ko'ra huquqiy pozitsiya kerak.",
  fromId: deptHeadId.FR,
  toId: deptHeadId.GR,
  department: "GR",
  status: "QABUL_QILINDI",
  priority: "ORTA",
  createdDay: -6,
  deadlineDay: 9,
});
addTask({
  title: "Dashboard uchun uyushmalar ma'lumotlarini AI Lab ga uzatish",
  description: "RAIS Dashboard vidjetlari uchun manba ma'lumot.",
  fromId: aiLabId,
  toId: deptHeadId.BR,
  department: "BR",
  status: "TEKSHIRUVDA",
  priority: "YUQORI",
  createdDay: -9,
  deadlineDay: 2,
});

// Rais -> project managers and association heads
loyihaIds.forEach((loyiha, i) => {
  addTask({
    title: `${LOYIHALAR[i][1]} loyihasi bo'yicha choraklik holat hisoboti`,
    description: "Bosqichlar, risklar, byudjet ijrosi va keyingi qadamlar.",
    fromId: raisId,
    toId: loyiha.ownerId,
    department: null,
    status: ["YANGI", "BAJARILMOQDA", "TEKSHIRUVDA", "BAJARILDI"][i % 4],
    priority: pick(PRIORITIES),
    createdDay: -int(3, 25),
    deadlineDay: int(-3, 25),
    loyihaId: loyiha.id,
    uyushmaId: loyiha.uyushmaId,
  });
});

uyushmaIds.forEach((uyushma, i) => {
  addTask({
    title: `${uyushma.short} uyushmasi a'zolari bo'yicha yangilangan reyestrni taqdim etish`,
    description: "Yagona CRM bazasini yangilash uchun ma'lumot.",
    fromId: deptHeadId.BR,
    toId: uyushma.headId,
    department: "BR",
    status: ["YANGI", "QABUL_QILINDI", "BAJARILMOQDA", "TEKSHIRUVDA", "BAJARILDI", "BAJARILDI"][i % 6],
    priority: pick(PRIORITIES),
    createdDay: -int(2, 28),
    deadlineDay: int(-5, 20),
    uyushmaId: uyushma.id,
  });
});

/* ---------------------------------------------------------------- */
/* 5. Chat history                                                   */
/* ---------------------------------------------------------------- */

const insertMessage = db.prepare(`
  INSERT INTO messages (from_user_id, to_user_id, body, created_at, read_at) VALUES (?,?,?,?,?)
`);

function chat(aId, bId, lines, startDay) {
  lines.forEach(([who, body], i) => {
    const fromId = who === "a" ? aId : bId;
    const toId = who === "a" ? bId : aId;
    const created = ts(startDay, 9 + i);
    const read = i < lines.length - 1 ? created : null;
    insertMessage.run(fromId, toId, body, created, read);
  });
}

chat(raisId, deptHeadId.GR, [
  ["a", "Bekzod, soliq imtiyozlari bo'yicha taklif qay holatda?"],
  ["b", "Assalomu alaykum. Loyiha tayyor, ertaga kelishuvga yuboraman."],
  ["a", "Yaxshi. Vazirlik majlisigacha ulgurish kerak."],
  ["b", "Tushundim, nazoratda."],
], -2);

chat(raisId, deptHeadId.FR, [
  ["a", "Xitoy delegatsiyasi tashrifi dasturi tayyormi?"],
  ["b", "Dastur loyihasi tayyor, protokol bo'yicha aniqlashtirmoqdamiz."],
  ["a", "Investitsiya paketini ham qo'shing."],
], -3);

chat(raisId, aiLabId, [
  ["a", "Kunlik brifing formatini soddalashtiring — 5 ta asosiy raqam yetarli."],
  ["b", "Chairman AI shablonini shunga moslayapmiz, ertaga ko'rsataman."],
], -1);

chat(deptHeadId.GR, staffIds.GR[0], [
  ["a", "Dilshod, ma'lumotnomani bugun tugatib bering."],
  ["b", "Xo'p, kechqurungacha topshiraman."],
], -1);

chat(deptHeadId.BR, uyushmaIds[0].headId, [
  ["a", "Farrux aka, a'zolar reyestrini yangilashingiz kerak."],
  ["b", "Xo'p, ro'yxatni to'plab tizimga yuklaymiz."],
], -4);

chat(raisId, loyihaIds[4].ownerId, [
  ["a", "Invest HUB bo'yicha byudjet ijrosi qanday?"],
  ["b", "73% — grafikdan oldinda ketyapmiz, batafsil hisobotni yubordim."],
], -5);

chat(staffIds.AI_LAB[0], staffIds.GR[1], [
  ["a", "Nilufar, GR bo'limi hujjat shablonlari qaysi formatda kerak?"],
  ["b", "DOCX, Assambleya blankasi bilan. Namuna yuboraman."],
], -2);

/* ---------------------------------------------------------------- */

const count = (table) =>
  Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);

console.log("Seed complete:", {
  users: count("users"),
  uyushmalar: count("uyushmalar"),
  loyihalar: count("loyihalar"),
  tasks: count("tasks"),
  task_events: count("task_events"),
  messages: count("messages"),
  password: DEMO_PASSWORD,
});
db.close();
