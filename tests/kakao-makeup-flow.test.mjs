import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// 카카오 「보강 신청·취소」 대화 흐름을 가짜 DB 로 **실제 실행**해 검증한다.
// 보강 규칙(학년·정원 +2·내일부터·만료·취소)은 진짜 parent-makeup.ts / credit-rules.ts 를 그대로 올린다 —
// 웹(/mypage/makeup)과 같은 함수가 같은 결과를 내는지까지 본다. prisma 와 관리자 알림만 가짜다.

const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = (file) => ts.transpileModule(readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

// 테스트마다 새 가짜 DB 를 끼우므로, 불러온 순간이 아니라 호출할 때의 DB 를 본다
const PRISMA_URL = toDataUrl(`export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__makeupDb[key] });`);
const ALERT_URL = toDataUrl(`
  export async function notifyAdminsOfKakaoIntake(input) { globalThis.__makeupDb.alerts.push(input); return 1; }
`);
const RECONFIRM_URL = toDataUrl(`
  export function buildKakaoReconfirmationPayload() { return null; }
  export function kakaoReconfirmationPayloadHash() { return ""; }
`);
const OVERRIDES = {
  "@/lib/prisma": PRISMA_URL,
  "@/lib/kakao-intake-admin-alert": ALERT_URL,
  "@/lib/kakao-parent-reconfirmation": RECONFIRM_URL,
};

/** @/ 와 상대경로 import 를 따라가며 올린다. prisma·알림은 가짜로 바꿔 끼운다. */
const cache = new Map();
function load(file) {
  const key = file.replace(/\\/g, "/");
  if (cache.has(key)) return cache.get(key);
  let out = transpile(file);
  for (const spec of new Set([...out.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]))) {
    let url = OVERRIDES[spec];
    if (!url && (spec.startsWith("@/") || spec.startsWith("."))) {
      const base = spec.startsWith("@/") ? path.join("src", spec.slice(2)) : path.join(path.dirname(file), spec);
      url = load(`${base}.ts`);
    }
    if (url) out = out.split(`"${spec}"`).join(`"${url}"`);
  }
  const url = toDataUrl(out);
  cache.set(key, url);
  return url;
}

const kst = await import(load("src/lib/datetime/kst.ts"));
const contract = await import(load("src/lib/kakao-chatbot-contract.ts"));
const flowModule = await import(load("src/lib/kakao-makeup-flow.ts"));
const chatbot = await import(load("src/lib/kakao-parent-chatbot.ts"));

// ── 가짜 DB ──────────────────────────────────────────────────────────────
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TODAY = kst.todayKst();
const day = (n) => kst.addDaysKst(TODAY, n);
const at = (ymd) => new Date(kst.kstAt(ymd));
const dowOf = (n) => DOW[kst.kstDow(day(n))];

function makeDb({ credits = null, students = null } = {}) {
  const db = {
    students: students ?? [
      { id: "s1", parentId: "p1", name: "지유", grade: "초5" },
      { id: "s9", parentId: "p9", name: "남의집", grade: "초5" },
    ],
    classes: [
      { id: "cA", name: "주중경기반", dayOfWeek: dowOf(1), startTime: "18:00", endTime: "19:30", capacity: 10, slotKey: "A", grades: ["초5", "초6"], enrolled: 8 },
      { id: "cB", name: "주말기본반", dayOfWeek: dowOf(2), startTime: "10:00", endTime: "11:30", capacity: 10, slotKey: "B", grades: ["초5"], enrolled: 11 },
      { id: "cC", name: "중등반", dayOfWeek: dowOf(1), startTime: "20:00", endTime: "21:30", capacity: 10, slotKey: "C", grades: ["중1"], enrolled: 0 },
      { id: "cO", name: "원래반", dayOfWeek: dowOf(3), startTime: "17:00", endTime: "18:30", capacity: 10, slotKey: "O", grades: ["초5"], enrolled: 0 },
    ],
    credits: credits ?? [
      { id: "mc1", studentId: "s1", status: "AVAILABLE", sourceType: "REGULAR", originClassId: "cO", absenceDate: at(day(-7)), expiresAt: at(day(50)), makeupSessionId: null },
      { id: "mc2", studentId: "s1", status: "AVAILABLE", sourceType: "REGULAR", originClassId: "cO", absenceDate: at(day(-3)), expiresAt: at(day(55)), makeupSessionId: null },
      { id: "other", studentId: "s9", status: "AVAILABLE", sourceType: "REGULAR", originClassId: "cO", absenceDate: at(day(-2)), expiresAt: at(day(55)), makeupSessionId: null },
    ],
    sessions: [],
    intakes: [],
    alerts: [],
    calls: [],
    seq: 0,
  };
  const credit = (id) => db.credits.find((row) => row.id === id);
  const student = (id) => db.students.find((row) => row.id === id);
  const owns = (row, parentId) => row && student(row.studentId)?.parentId === parentId;

  async function query(sql, ...args) {
    db.calls.push(sql);
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    // 챗봇: 연결 자녀·재확인 후보·작성 중 접수
    if (/SELECT id,name,grade FROM "Student"/.test(sql)) return db.students.filter((row) => row.parentId === args[0]);
    if (/FROM "KakaoParentIntake" i\s/.test(sql)) return [];
    if (/SELECT id,kind,"sourceText","studentId",status FROM "KakaoParentIntake"/.test(sql)) {
      return db.intakes.filter((row) => row.identityId === args[0] && ["DRAFT", "NEEDS_DETAILS"].includes(row.status));
    }
    if (/FROM "KakaoParentIntake" r LEFT JOIN "Student"/.test(sql)) return [];
    // 보강 대화 상태
    if (/SELECT id,"structuredJson" FROM "KakaoParentIntake"/.test(sql)) {
      return db.intakes
        .filter((row) => row.identityId === args[0] && row.status === "MAKEUP_FLOW" && row.updatedAt > Date.now() - 30 * 60_000)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1)
        .map((row) => ({ id: row.id, structuredJson: structuredClone(row.structuredJson) }));
    }
    if (/INSERT INTO "KakaoParentIntake"/.test(sql) && /kakao:makeup:/.test(sql)) {
      const row = { id: `flow-${++db.seq}`, identityId: args[0], studentId: args[1], kind: "MAKEUP", sourceText: args[2], structuredJson: JSON.parse(args[3]), status: "MAKEUP_FLOW", updatedAt: Date.now() };
      db.intakes.push(row);
      return [{ id: row.id }];
    }
    // 보강권 조회(카카오 흐름)
    if (/mc\.status='AVAILABLE' AND mc\."expiresAt">now\(\)/.test(sql)) {
      return db.credits
        .filter((row) => row.studentId === args[1] && owns(row, args[0]) && row.status === "AVAILABLE" && row.expiresAt.getTime() > Date.now())
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .map((row) => ({ id: row.id, absenceDate: row.absenceDate, expiresAt: row.expiresAt, sourceType: row.sourceType, originClassName: db.classes.find((c) => c.id === row.originClassId)?.name ?? null }));
    }
    if (/mc\.status='RESERVED' AND \(\$2::text IS NULL/.test(sql)) {
      // SQL 의 ms."makeupDate">=$3 (오늘 KST 자정) 를 그대로 흉내 낸다 — 앱의 JS 거르기와 별개로 DB 단계에서 빠지는지 본다
      assert.match(sql, /ms\."makeupDate">=\$3::timestamptz/);
      db.reservationSince = args[2];
      return db.credits
        .filter((row) => owns(row, args[0]) && row.status === "RESERVED" && (args[1] === null || row.studentId === args[1]))
        .map((row) => ({ row, session: db.sessions.find((s) => s.id === row.makeupSessionId && s.status === "BOOKED") }))
        .filter((item) => item.session && item.session.makeupDate.getTime() >= new Date(args[2]).getTime())
        .sort((a, b) => a.session.makeupDate - b.session.makeupDate)
        .map(({ row, session }) => {
          const cls = db.classes.find((c) => c.id === session.makeupClassId);
          return { creditId: row.id, studentName: student(row.studentId).name, expiresAt: row.expiresAt, makeupDate: session.makeupDate, className: cls?.name ?? null, startTime: cls?.startTime ?? null };
        });
    }
    // parent-makeup.ts(웹과 같은 함수)의 쿼리
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2 AND mc\.status = 'AVAILABLE' LIMIT 1/.test(sql)) {
      const row = credit(args[0]);
      return owns(row, args[1]) && row.status === "AVAILABLE"
        ? [{ ...row, studentGrade: student(row.studentId).grade }] : [];
    }
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2 AND mc\.status = 'RESERVED' LIMIT 1/.test(sql)) {
      const row = credit(args[0]);
      if (!owns(row, args[1]) || row.status !== "RESERVED") return [];
      const session = db.sessions.find((s) => s.id === row.makeupSessionId);
      return [{ id: row.id, makeupSessionId: row.makeupSessionId, makeupDate: session?.makeupDate ?? null }];
    }
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2\s+LIMIT 1/.test(sql)) {
      const row = credit(args[0]);
      return owns(row, args[1]) ? [{ ...row, studentGrade: student(row.studentId).grade }] : [];
    }
    if (/JOIN "ScheduleSlot" ss ON ss\."slotKey" = c\."slotKey"/.test(sql)) {
      return db.classes.map((c) => ({
        classId: c.id, className: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, endTime: c.endTime, capacity: c.capacity,
        gradesJson: JSON.stringify(c.grades), enrolled: c.enrolled,
        booked: db.sessions.filter((s) => s.makeupClassId === c.id && s.status === "BOOKED").length,
      }));
    }
    if (/INSERT INTO "MakeupSession"/.test(sql)) {
      const row = { id: `ms-${++db.seq}`, studentId: args[0], originalClassId: args[1], makeupClassId: args[3], makeupDate: new Date(args[4]), status: "BOOKED" };
      db.sessions.push(row);
      return [{ id: row.id }];
    }
    throw new Error(`예상하지 않은 조회: ${sql.slice(0, 120)}`);
  }

  async function execute(sql, ...args) {
    db.calls.push(sql);
    if (/UPDATE "KakaoParentIntake" SET status='CANCELED'.*WHERE "identityId"=\$1 AND status IN/s.test(sql)) {
      const statuses = /'MAKEUP_FLOW'/.test(sql) ? ["DRAFT", "NEEDS_DETAILS", "MAKEUP_FLOW"] : ["DRAFT", "NEEDS_DETAILS"];
      let n = 0;
      for (const row of db.intakes) if (row.identityId === args[0] && statuses.includes(row.status)) { row.status = "CANCELED"; n += 1; }
      return n;
    }
    if (/INSERT INTO "KakaoParentIntake"/.test(sql)) {
      db.intakes.push({ id: args[0], identityId: args[1], studentId: args[2], kind: args[3], sourceText: args[4], status: args[6], updatedAt: Date.now() });
      return 1;
    }
    if (/SET "structuredJson"=\$3::jsonb,"studentId"=\$4/.test(sql)) {
      const row = db.intakes.find((item) => item.id === args[0]);
      if (!row || row.status !== "MAKEUP_FLOW" || row.structuredJson.step !== args[1]) return 0;
      row.structuredJson = JSON.parse(args[2]); row.studentId = args[3]; row.updatedAt = Date.now();
      return 1;
    }
    if (/SET status='APPLIED'/.test(sql) || /SET status='CANCELED',"structuredJson"=COALESCE/.test(sql)) {
      const row = db.intakes.find((item) => item.id === args[0]);
      if (!row) return 0;
      if (/status='CANCELED'/.test(sql) && row.status !== "MAKEUP_FLOW") return 0;
      row.status = /APPLIED/.test(sql) ? "APPLIED" : "CANCELED";
      if (args[1]) row.structuredJson = JSON.parse(args[1]);
      return 1;
    }
    if (/UPDATE "MakeupCredit" SET status='RESERVED'/.test(sql)) {
      const row = credit(args[0]);
      if (!row || row.status !== "AVAILABLE") return 0;
      row.status = "RESERVED"; return 1;
    }
    if (/UPDATE "MakeupCredit" SET "makeupSessionId"=\$2/.test(sql)) { credit(args[0]).makeupSessionId = args[1]; return 1; }
    if (/UPDATE "MakeupCredit" SET status='AVAILABLE', "makeupSessionId"=NULL/.test(sql)) {
      const row = credit(args[0]); row.status = "AVAILABLE"; row.makeupSessionId = null; return 1;
    }
    if (/UPDATE "MakeupSession" SET status='CANCELLED'/.test(sql)) {
      db.sessions.find((s) => s.id === args[0]).status = "CANCELLED"; return 1;
    }
    throw new Error(`예상하지 않은 쓰기: ${sql.slice(0, 120)}`);
  }

  db.$queryRawUnsafe = query;
  db.$executeRawUnsafe = execute;
  db.$transaction = async (fn) => fn(db);
  globalThis.__makeupDb = db;
  return db;
}

const LINK = { label: "보강 예약하기", url: "https://example.test/mypage/makeup" };
const IDENTITY = { id: "i1", parentUserId: "p1", status: "ACTIVE" };
const CHILDREN = [{ id: "s1", name: "지유" }];
const say = (text, children = CHILDREN) => flowModule.handleMakeupConversation({ identityId: "i1", parentUserId: "p1", children, text, webLink: LINK });
const textOf = (res) => res.template.outputs[0].simpleText?.text ?? res.template.outputs[0].textCard.description;
const replies = (res) => res.template.quickReplies.map((item) => item.messageText);

/** 카카오 말풍선 규격(가드 테스트와 같은 기준) + 목록이 말줄임으로 잘리지 않았는지 */
function assertKakaoFormat(res) {
  assert.equal(res.version, "2.0");
  assert.ok(!JSON.stringify(res).includes("basicCard"), "basicCard 금지");
  assert.ok(res.template.quickReplies.length <= contract.KAKAO_MAX_QUICK_REPLIES);
  for (const item of res.template.quickReplies) assert.ok([...item.label].length <= contract.KAKAO_BUTTON_LABEL_MAX, item.label);
  const card = res.template.outputs[0].textCard;
  if (card) {
    assert.ok([...card.description].length <= contract.KAKAO_TEXT_CARD_DESCRIPTION_MAX);
    assert.ok(card.buttons.length <= contract.KAKAO_MAX_CARD_BUTTONS);
  }
  assert.ok(!textOf(res).endsWith("…"), "본문이 잘리면 안 된다");
}
const flowRow = (db) => db.intakes.filter((row) => row.kind === "MAKEUP").at(-1);

// ── 순수 함수 ───────────────────────────────────────────────────────────
test("후보 수업: 내일부터 14일 안, 날짜·시간 순, 최대 8개", () => {
  const options = [
    { classId: "a", className: "주중경기반", startTime: "18:00", dates: [day(0), day(1), day(8), day(15)].map((ymd) => ({ ymd })) },
    { classId: "b", className: "주말기본반", startTime: "10:00", dates: [day(1), day(14)].map((ymd) => ({ ymd })) },
  ];
  const picked = flowModule.buildMakeupCandidates(options, TODAY);
  assert.deepEqual(picked.map((item) => `${item.classId}@${item.dateYmd}`), [`b@${day(1)}`, `a@${day(1)}`, `a@${day(8)}`, `b@${day(14)}`]);
  assert.equal(picked[1].label, `${kst.kstLabel(day(1))} 18:00 주중경기반`);
  const many = [{ classId: "x", className: "반", startTime: "09:00", dates: Array.from({ length: 14 }, (_, i) => ({ ymd: day(i + 1) })) }];
  assert.equal(flowModule.buildMakeupCandidates(many, TODAY).length, 8);
  assert.equal(flowModule.parsePick("보강 수업 3번", "보강 수업"), 3);
  assert.equal(flowModule.parsePick("2", "보강 수업"), 2);
  assert.equal(flowModule.parsePick("보강권 3번", "보강 수업"), null, "다른 단계 버튼은 번호로 읽지 않는다");
});

// ── 전체 흐름 ───────────────────────────────────────────────────────────
test("보강 신청 → 보강권 선택 → 수업 선택 → 확인 → 웹과 같은 함수로 예약 + 원장님 앱 알림", async () => {
  const db = makeDb();
  const list = await say("보강 신청");
  assertKakaoFormat(list);
  assert.match(textOf(list), /지유 학생이 쓸 수 있는 보강권 2장이에요/);
  assert.match(textOf(list), new RegExp(`1\\. ${kst.kstLabel(day(-7)).replace(/[()]/g, "\\$&")} 결석 · 원래반 · ${kst.kstLabel(day(50)).replace(/[()]/g, "\\$&")}까지`));
  assert.deepEqual(replies(list), ["보강권 1번", "보강권 2번", "보강 그만"]);
  assert.equal(list.template.outputs[0].textCard.buttons[0].webLinkUrl, LINK.url, "마이페이지 링크는 보조 버튼");

  const options = await say("보강권 1번");
  assertKakaoFormat(options);
  const lines = textOf(options).split("\n").filter((line) => /^\d\. /.test(line));
  // 학년 안 맞는 중등반·원래 반은 빠지고, 내일부터 14일 안 날짜만 날짜순
  assert.deepEqual(lines, [
    `1. ${kst.kstLabel(day(1))} 18:00 주중경기반`,
    `2. ${kst.kstLabel(day(2))} 10:00 주말기본반`,
    `3. ${kst.kstLabel(day(8))} 18:00 주중경기반`,
    `4. ${kst.kstLabel(day(9))} 10:00 주말기본반`,
  ]);
  // 「다른 보강권」은 학생 이름을 붙여 보낸다(자녀가 여럿이어도 같은 학생으로 돌아간다)
  assert.deepEqual(replies(options), ["보강 수업 1번", "보강 수업 2번", "보강 수업 3번", "보강 수업 4번", "지유 보강 신청", "보강 그만"]);

  const confirm = await say("보강 수업 2번");
  assertKakaoFormat(confirm);
  assert.match(textOf(confirm), /이 수업으로 보강 신청할까요\?/);
  assert.deepEqual(replies(confirm), ["보강 신청 확정", "보강 다른 수업", "보강 그만"]);
  assert.equal(db.sessions.length, 0, "확인 전에는 예약하지 않는다");

  const done = await say("보강 신청 확정");
  assertKakaoFormat(done);
  assert.match(textOf(done), new RegExp(`^보강 예약 완료: 지유 학생 ${kst.kstLabel(day(2)).replace(/[()]/g, "\\$&")} 10:00 주말기본반`));
  assert.match(textOf(done), /당일 취소는 안 되고, 못 오시면 하루 전까지 카톡으로 알려 주세요/);
  // DB: 웹과 같은 결과(보강권 RESERVED + 세션 BOOKED, 날짜는 KST 자정)
  assert.equal(db.credits.find((row) => row.id === "mc1").status, "RESERVED");
  assert.equal(db.sessions.length, 1);
  assert.equal(db.sessions[0].makeupClassId, "cB");
  assert.equal(db.sessions[0].makeupDate.getTime(), kst.kstAt(day(2)));
  assert.equal(flowRow(db).status, "APPLIED");
  assert.equal(db.alerts.length, 1);
  assert.equal(db.alerts[0].kindLabel, "보강 예약 완료");
  assert.equal(db.alerts[0].linkUrl, "/admin/makeup");

  // 같은 확인이 다시 와도(카카오 재전송) 두 번 예약하지 않는다
  const again = await say("보강 신청 확정");
  assert.match(textOf(again), /진행 중인 선택이 없어요/);
  assert.equal(db.sessions.length, 1);
});

test("보강권이 한 장이면 고르지 않고 바로 후보 수업을 보여 준다", async () => {
  const db = makeDb();
  db.credits = db.credits.filter((row) => row.id !== "mc2");
  const res = await say("보강 예약");
  assertKakaoFormat(res);
  assert.match(textOf(res), /결석 1회당 1번, 결석일부터 2개월 안에/);
  assert.match(textOf(res), /앞으로 2주 안에 신청할 수 있는 수업이에요/);
  assert.equal(flowRow(db).structuredJson.step, "OPTION");
});

test("보강권 0장: 발급 안내 + 원장님 문의(기존 상담 접수로 이어짐)", async () => {
  makeDb({ credits: [] });
  const res = await say("보강 신청");
  assertKakaoFormat(res);
  assert.match(textOf(res), /사용할 수 있는 보강권이 없어요\. 보강권은 결석 처리 후 발급됩니다/);
  assert.ok(replies(res).includes("원장님께 보강 문의할게요"));
  // 그 버튼 문장은 상담원 연결(HUMAN)로 분류되어 기존 접수 흐름을 탄다
  assert.equal(contract.classifyParentUtterance("원장님께 보강 문의할게요"), "HUMAN");
});

test("자녀가 둘이면 먼저 자녀를 고른다(이름 + 보강 신청)", async () => {
  makeDb({ students: [{ id: "s1", parentId: "p1", name: "지유", grade: "초5" }, { id: "s2", parentId: "p1", name: "지호", grade: "초5" }] });
  const two = [{ id: "s1", name: "지유" }, { id: "s2", name: "지호" }];
  const ask = await say("보강 신청", two);
  assert.match(textOf(ask), /어느 자녀의 보강을 신청할까요/);
  assert.deepEqual(replies(ask), ["지유 보강 신청", "지호 보강 신청", "보강 그만"]);
  const list = await say("지유 보강 신청", two);
  assert.match(textOf(list), /지유 학생이 쓸 수 있는 보강권 2장/);
});

test("정원 마감 경합: 확인 사이에 자리가 차면 사유를 알리고 남은 후보를 다시 보여 준다", async () => {
  const db = makeDb();
  await say("보강 신청");
  await say("보강권 1번");
  await say("보강 수업 2번"); // 주말기본반: 정원 10 + 2 − 수강 11 = 1자리
  // 다른 가정이 마지막 자리를 먼저 예약
  db.sessions.push({ id: "ms-other", studentId: "s9", makeupClassId: "cB", makeupDate: at(day(2)), status: "BOOKED" });
  const res = await say("보강 신청 확정");
  assertKakaoFormat(res);
  assert.match(textOf(res), /^보강 신청을 못 했어요: 방금 정원이 마감됐거나/);
  assert.doesNotMatch(textOf(res), /주말기본반/, "마감된 반은 다시 보여 주지 않는다");
  assert.equal(db.credits.find((row) => row.id === "mc1").status, "AVAILABLE", "보강권은 그대로");
  assert.equal(db.sessions.length, 1);
  // 다시 고르면 정상 예약
  const done = await say("보강 수업 1번");
  assert.match(textOf(done), /이 수업으로 보강 신청할까요/);
  assert.match(textOf(await say("네")), /^보강 예약 완료/);
});

test("보강권 경합: 확인 사이에 같은 보강권이 다른 곳(웹)에서 예약되면 거절한다", async () => {
  const db = makeDb();
  await say("보강 신청");
  await say("보강권 1번");
  await say("보강 수업 1번");
  db.credits.find((row) => row.id === "mc1").status = "RESERVED";
  const res = await say("보강 신청 확정");
  assert.match(textOf(res), /이 보강권은 지금 사용할 수 없어요/);
  assert.equal(db.sessions.length, 0);
});

test("IDOR: 대화 상태에 다른 가정의 보강권 id 를 넣어도 예약되지 않는다", async () => {
  const db = makeDb();
  await say("보강 신청");
  await say("보강권 1번");
  await say("보강 수업 1번");
  // 상태를 조작해 남의 보강권을 끼워 넣는다
  const row = flowRow(db);
  row.structuredJson.credit = { ...row.structuredJson.credit, id: "other" };
  const res = await say("보강 신청 확정");
  assert.match(textOf(res), /이 보강권은 지금 사용할 수 없어요/);
  assert.equal(db.credits.find((item) => item.id === "other").status, "AVAILABLE");
  assert.equal(db.sessions.length, 0);
  assert.equal(db.alerts.length, 0);

  // 학부모가 보강권 id 를 직접 보내도 번호가 아니면 아무것도 고르지 않는다
  makeDb();
  await say("보강 신청");
  const typed = await say("보강권 other");
  assert.match(textOf(typed), /지유 학생이 쓸 수 있는 보강권 2장/, "목록을 다시 보여 줄 뿐");

  // 다른 보호자로 다시 연결된 카카오면 이전 대화 상태를 쓰지 않는다
  const db3 = makeDb();
  await say("보강 신청");
  flowRow(db3).structuredJson.parentUserId = "p9";
  const stale = await say("보강권 1번");
  assert.match(textOf(stale), /진행 중인 선택이 없어요/);
  // 남의 자녀 보강권은 목록 조회에서부터 안 나온다
  assert.ok(!JSON.stringify(flowRow(db3).structuredJson).includes("\"other\""));
});

test("보강 취소: 하루 전까지는 취소(보강권 복구), 당일은 불가 안내", async () => {
  const db = makeDb();
  db.credits.find((row) => row.id === "mc1").status = "RESERVED";
  db.credits.find((row) => row.id === "mc1").makeupSessionId = "ms-today";
  db.credits.find((row) => row.id === "mc2").status = "RESERVED";
  db.credits.find((row) => row.id === "mc2").makeupSessionId = "ms-later";
  db.sessions.push(
    { id: "ms-today", studentId: "s1", makeupClassId: "cA", makeupDate: at(TODAY), status: "BOOKED" },
    { id: "ms-later", studentId: "s1", makeupClassId: "cB", makeupDate: at(day(2)), status: "BOOKED" },
  );

  const list = await say("보강 취소");
  assertKakaoFormat(list);
  assert.match(textOf(list), /1\. .*주중경기반 \(오늘·취소 불가\)/);
  assert.deepEqual(replies(list), ["보강 취소 1번", "보강 취소 2번", "보강 그만"]);

  const refuse = await say("보강 취소 1번");
  assert.match(textOf(refuse), /오늘이라 취소할 수 없어요\(당일 취소 불가\)/);
  assert.equal(db.sessions.find((s) => s.id === "ms-today").status, "BOOKED");
  assert.equal(contract.classifyParentUtterance(replies(refuse)[0]), "HUMAN", "당일 불참 알림은 원장님 접수로");

  await say("보강 취소");
  const ask = await say("보강 취소 2번");
  assert.match(textOf(ask), /보강 예약을 취소할까요/);
  // 취소 확인 단계의 맨 「취소」는 모호하니 다시 묻는다
  assert.match(textOf(await say("취소")), /「취소할게요」/);
  const done = await say("보강 취소 확정");
  assert.match(textOf(done), /^보강 예약을 취소했어요/);
  assert.equal(db.sessions.find((s) => s.id === "ms-later").status, "CANCELLED");
  assert.equal(db.credits.find((row) => row.id === "mc2").status, "AVAILABLE");
  assert.equal(db.alerts.at(-1).kindLabel, "보강 예약 취소");
});

test("「취소할게요」는 보강 신청 확인으로 읽지 않는다(그만두기)", async () => {
  const db = makeDb();
  await say("보강 신청");
  await say("보강권 1번");
  await say("보강 수업 1번");
  const res = await say("취소할게요");
  assert.match(textOf(res), /보강 신청을 그만했어요/);
  assert.equal(db.sessions.length, 0);
});

test("확인 단계의 긍정 답: 넵·네!·네 신청할게요·좋아요 모두 신청 확정", async () => {
  for (const yes of ["넵", "네!", "네 신청할게요", "좋아요", "예약해주세요", "네~"]) {
    const db = makeDb();
    await say("보강 신청");
    await say("보강권 1번");
    await say("보강 수업 1번");
    assert.match(textOf(await say(yes)), /^보강 예약 완료/, yes);
    assert.equal(db.sessions.length, 1, yes);
  }
});

test("대화 중 짧은 엉뚱한 말은 대화를 닫지 않고 단계를 다시 보여 준다 — 업무 말·메뉴는 기존 흐름", async () => {
  const db = makeDb();
  await say("보강 신청");
  await say("보강권 1번");
  await say("보강 수업 1번");
  for (const stray of ["ㅇㅋ", "글쎄요", "음..", "잠깐만요"]) {
    assert.match(textOf(await say(stray)), /지금 단계의 버튼을 눌러 주세요[\s\S]*보강 신청할까요/, stray);
    assert.equal(flowRow(db).status, "MAKEUP_FLOW", `${stray}: 대화는 살아 있다`);
  }
  // 분류되는 업무(입금)·메뉴 버튼(셔틀)은 붙잡지 않는다
  assert.equal(await say("입금했어요"), null);
  assert.equal(flowRow(db).status, "CANCELED");
  await say("보강 신청");
  assert.equal(await say("셔틀"), null, "메뉴 버튼은 메뉴를 연다");

  // 취소 단계도 같은 원칙: 「네 취소할게요」= 확정, 짧은 엉뚱한 말 = 재질문
  const db2 = makeDb();
  db2.credits.find((row) => row.id === "mc2").status = "RESERVED";
  db2.credits.find((row) => row.id === "mc2").makeupSessionId = "ms-later";
  db2.sessions.push({ id: "ms-later", studentId: "s1", makeupClassId: "cB", makeupDate: at(day(2)), status: "BOOKED" });
  await say("보강 취소");
  await say("보강 취소 1번");
  assert.match(textOf(await say("ㅇㅋ")), /지금 단계의 버튼을 눌러 주세요[\s\S]*취소할까요/);
  assert.match(textOf(await say("네 취소할게요")), /^보강 예약을 취소했어요/);
  assert.equal(db2.sessions[0].status, "CANCELLED");
});

test("자녀 이름: 정확히 일치 먼저, 없으면 가장 긴 이름(이준·이준호 형제)", async () => {
  const kids = [{ id: "a", name: "이준" }, { id: "b", name: "이준호" }];
  assert.equal(flowModule.pickChildByName(kids, "이준 보강 신청").id, "a");
  assert.equal(flowModule.pickChildByName(kids, "이준호 보강 신청").id, "b");
  assert.equal(flowModule.pickChildByName(kids, "이준호보강").id, "b", "붙여 써도 가장 긴 이름");
  assert.equal(flowModule.pickChildByName(kids, "보강 신청"), null);
  // 실제 흐름에서도 이준호 학생 보강권 목록으로 간다
  makeDb({
    students: [{ id: "s1", parentId: "p1", name: "이준", grade: "초5" }, { id: "s2", parentId: "p1", name: "이준호", grade: "초5" }],
    credits: [{ id: "mcB", studentId: "s2", status: "AVAILABLE", sourceType: "REGULAR", originClassId: "cO", absenceDate: at(day(-2)), expiresAt: at(day(50)), makeupSessionId: null }],
  });
  const res = await say("이준호 보강 신청", [{ id: "s1", name: "이준" }, { id: "s2", name: "이준호" }]);
  assert.match(textOf(res), /이준호 학생 · /);
});

test("예약 목록은 DB 에서 오늘 KST 자정 이후만 조회한다", async () => {
  const db = makeDb();
  db.credits.find((row) => row.id === "mc1").status = "RESERVED";
  db.credits.find((row) => row.id === "mc1").makeupSessionId = "ms-past";
  db.sessions.push({ id: "ms-past", studentId: "s1", makeupClassId: "cA", makeupDate: at(day(-1)), status: "BOOKED" });
  const res = await say("보강 취소");
  assert.match(textOf(res), /취소할 수 있는 보강 예약이 없어요/);
  assert.equal(new Date(db.reservationSince).getTime(), kst.kstAt(TODAY), "기준 시각 = 오늘 KST 0시");
});

test("30분 만료 · 대화 중 다른 업무 · 짧은 답", async () => {
  const db = makeDb();
  await say("보강 신청");
  flowRow(db).updatedAt = Date.now() - 31 * 60_000;
  const expired = await say("보강권 1번");
  assert.match(textOf(expired), /진행 중인 선택이 없어요/);
  assert.match(textOf(expired), /보강권 2장/);

  // 확인 단계에서 번호를 치면 단계를 다시 보여 준다(다른 접수로 새지 않음)
  await say("보강권 1번");
  await say("보강 수업 1번");
  assert.match(textOf(await say("1")), /지금 단계의 버튼을 눌러 주세요[\s\S]*보강 신청할까요/);

  // 다른 업무를 말하면 보강 대화는 닫고 null(기존 흐름으로)
  assert.equal(await say("오늘 셔틀 안 타요"), null);
  assert.equal(flowRow(db).status, "CANCELED");
  assert.equal(await say("네"), null, "닫힌 대화의 「네」는 보강 확정이 아니다");
  assert.equal(db.sessions.length, 0);
});

// ── 챗봇 안에서의 우선순위 ─────────────────────────────────────────────
test("챗봇 우선순위: 보강은 대화 흐름, 정책 질문·다른 업무는 기존 그대로", async () => {
  const db = makeDb();
  const neverPolicy = async () => assert.fail("보강 업무는 정책 답변으로 가지 않는다");
  const res = await chatbot.handleLinkedMessage(IDENTITY, "보강 신청", "r1", neverPolicy);
  assert.match(textOf(res), /보강권 2장/);
  // 보강 규정 질문도 원래처럼 정책 답변보다 보강 업무가 먼저(예전엔 화면 링크, 이제는 보강권 안내)
  const q = await chatbot.handleLinkedMessage(IDENTITY, "보강은 몇 번까지 되나요?", "r2", neverPolicy);
  assert.match(textOf(q), /보강권 2장/);

  // 결석·보강 메뉴에 「보강 신청」「보강 취소」
  const menu = await chatbot.handleLinkedMessage(IDENTITY, "결석·보강", "r3");
  assert.deepEqual(replies(menu), ["정규수업 결석", "방학특강 결석", "보강 신청", "보강 취소", "조퇴 상담"]);

  // 보강 대화 중에 정책 질문 → 보강 대화는 닫히고 정책 연결점이 불린다
  await chatbot.handleLinkedMessage(IDENTITY, "보강 신청", "r4");
  let policyCalls = 0;
  await chatbot.handleLinkedMessage(IDENTITY, "환불 규정이 어떻게 되나요?", "r5", async () => { policyCalls += 1; return null; });
  assert.equal(policyCalls, 1);
  assert.ok(db.intakes.filter((row) => row.kind === "MAKEUP").every((row) => row.status !== "MAKEUP_FLOW"));

  // 결석은 기존 화면 링크 그대로
  const absence = await chatbot.handleLinkedMessage(IDENTITY, "오늘 결석할게요", "r6");
  assert.match(absence.template.outputs[0].textCard.buttons[0].webLinkUrl, /\/mypage\/regular-absence$/);

  // 보강 대화를 시작하면 작성 중이던 접수 초안은 닫힌다(남은 「네」가 엉뚱한 접수를 확정하지 않게)
  db.intakes.push({ id: "d1", identityId: "i1", studentId: "s1", kind: "CONSULTATION", sourceText: "문의", status: "DRAFT", updatedAt: Date.now() });
  await chatbot.handleLinkedMessage(IDENTITY, "보강 신청", "r7");
  assert.equal(db.intakes.find((row) => row.id === "d1").status, "CANCELED");
});

test("소스 계약: raw SQL 만, 보호자 조건, 웹과 같은 예약·취소 함수", () => {
  const source = readFileSync("src/lib/kakao-makeup-flow.ts", "utf8");
  assert.doesNotMatch(source, /prisma\.\w+\.(findMany|findFirst|create|update|upsert|delete)\(/);
  assert.match(source, /from "@\/lib\/makeup\/parent-makeup"/);
  assert.match(source, /await bookMakeup\(state\.parentUserId/);
  assert.match(source, /await cancelMakeupBooking\(flow\.state\.parentUserId/);
  assert.equal((source.match(/s\."parentId"=\$1/g) || []).length, 2, "보강권·예약 조회 모두 보호자 조건");
  assert.doesNotMatch(source, /sendMail|sendSms|notifyAdmins\(/);
});
