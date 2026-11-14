import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// 카카오 「결석 신청·취소」「당일 셔틀 변경」「정규 셔틀 변경」 대화 흐름을 가짜 DB 로 **실제 실행**해 검증한다.
// 저장 함수(reportRegularAbsence·cancelRegularAbsence·submitShuttleException·cancelShuttleException)는
// 웹과 같은 함수를 부르는지만 본다 — 그 함수들의 규칙은 각자의 테스트가 고정한다. prisma·알림만 가짜다.

const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = (file) => ts.transpileModule(readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const PRISMA_URL = toDataUrl(`export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__careDb[key] });`);
const ABSENCE_URL = toDataUrl(`
  const db = () => globalThis.__careDb;
  export async function getUpcomingRegularClassDates(parentUserId, weeks) { db().calls.push(["upcoming", parentUserId, weeks]); return db().upcoming.filter((c) => c.parentId === parentUserId); }
  export async function reportRegularAbsence(parentUserId, input) { db().calls.push(["report", parentUserId, input]); if (db().reportError) throw new Error(db().reportError); return { ok: true }; }
  export async function cancelRegularAbsence(parentUserId, input) { db().calls.push(["cancelAbsence", parentUserId, input]); if (db().cancelError) throw new Error(db().cancelError); return { ok: true }; }
`);
const SHUTTLE_URL = toDataUrl(`
  const db = () => globalThis.__careDb;
  export async function submitShuttleException(parentUserId, input) { db().calls.push(["submitShuttle", parentUserId, input]); return db().shuttleResult ?? { ok: true, id: "x1" }; }
  export async function cancelShuttleException(parentUserId, id) { db().calls.push(["cancelShuttle", parentUserId, id]); return { ok: true, id }; }
`);
const ALERT_URL = toDataUrl(`export async function notifyAdminsOfKakaoIntake(input) { globalThis.__careDb.alerts.push(input); return 1; }`);
const OVERRIDES = {
  "@/lib/prisma": PRISMA_URL,
  "@/lib/regular/parent-regular-absence": ABSENCE_URL,
  "@/lib/shuttle/parent-shuttle-exception": SHUTTLE_URL,
  "@/lib/kakao-intake-admin-alert": ALERT_URL,
};

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
const store = await import(load("src/lib/kakao-flow-store.ts"));
const absenceFlow = await import(load("src/lib/kakao-absence-flow.ts"));
const shuttleFlow = await import(load("src/lib/kakao-shuttle-flow.ts"));

const TODAY = kst.todayKst();
const day = (n) => kst.addDaysKst(TODAY, n);

// ── 가짜 DB ──────────────────────────────────────────────────────────────
function makeDb() {
  const db = {
    upcoming: [{
      parentId: "p1", studentId: "s1", studentName: "지유",
      classes: [
        { classId: "cA", className: "주중경기반", startTime: "18:00", dates: [{ date: day(1), reported: false }, { date: day(8), reported: false }] },
        { classId: "cB", className: "주말기본반", startTime: "10:00", dates: [{ date: day(3), reported: true }, { date: day(10), reported: false }] },
      ],
    }],
    absences: [
      { id: "ra1", parentId: "p1", studentId: "s1", studentName: "지유", date: day(2), status: "REPORTED", className: "주중경기반", startTime: "18:00" },
      { id: "ra-other", parentId: "p9", studentId: "s9", studentName: "남의집", date: day(2), status: "REPORTED", className: "주중경기반", startTime: "18:00" },
      // 2026-11-14 결석 당일 취소·보강 연결: 오늘 결석도 «수업 시작 1시간 전»까지는 취소 목록에 나온다.
      // 이 줄은 00:30 수업이라 하루 중 언제 돌려도 이미 마감(1시간 전 = 전날 23:30)이다 → 목록에 없어야 한다.
      { id: "ra-past", parentId: "p1", studentId: "s1", studentName: "지유", date: TODAY, status: "REPORTED", className: "주중경기반", startTime: "00:30" },
    ],
    exceptions: [],
    intakes: [],
    alerts: [],
    calls: [],
    seq: 0,
  };
  async function query(sql, ...args) {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT id,"structuredJson" FROM "KakaoParentIntake"/.test(sql)) {
      const status = /status='([A-Z_]+)'/.exec(sql)?.[1];
      return db.intakes
        .filter((row) => row.identityId === args[0] && row.status === status && row.updatedAt > Date.now() - 30 * 60_000)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1)
        .map((row) => ({ id: row.id, structuredJson: structuredClone(row.structuredJson) }));
    }
    if (/INSERT INTO "KakaoParentIntake"/.test(sql) && /kakao:flow:/.test(sql)) {
      const status = /'([A-Z_]+_FLOW)'/.exec(sql)?.[1];
      const kind = /,'([A-Z_]+)',\$3/.exec(sql)?.[1];
      const row = { id: `flow-${++db.seq}`, identityId: args[0], studentId: args[1], kind, sourceText: args[2], structuredJson: JSON.parse(args[3]), status, updatedAt: Date.now() };
      db.intakes.push(row);
      return [{ id: row.id }];
    }
    if (/FROM "RegularAbsence" ra/.test(sql)) {
      // 보호자 조건(s."parentId"=$1)·REPORTED·오늘 이후(ra.date>=$2)·자녀 조건을 SQL 그대로 흉내 낸다
      // 2026-11-14 결석 당일 취소·보강 연결: 예전 «내일 이후(>)» → «오늘 이후(>=)». 오늘 것은 앱이 마감(1시간 전)으로 다시 거른다.
      assert.match(sql, /s\."parentId"=\$1/);
      assert.match(sql, /ra\.date>=\$2::date/);
      return db.absences
        .filter((row) => row.parentId === args[0] && row.status === "REPORTED" && row.date >= args[1] && (args[2] === null || row.studentId === args[2]))
        .map(({ id, studentName, date, className, startTime }) => ({ id, studentName, date, className, startTime }));
    }
    if (/FROM "ShuttleDayException" x/.test(sql)) {
      assert.match(sql, /s\."parentId"=\$1/);
      return db.exceptions
        .filter((row) => row.parentId === args[0] && !row.canceled && row.serviceDate >= args[1])
        .map(({ id, studentName, serviceDate, direction, kind, location }) => ({ id, studentName, serviceDate, direction, kind, location }));
    }
    if (/kind IN \('SHUTTLE_START_STOP','SHUTTLE_CHANGE'\)/.test(sql)) {
      // 같은 학생의 처리 전(SUBMITTED·PROCESSING·HELD) 정규 셔틀 접수
      assert.match(sql, /status IN \('SUBMITTED','PROCESSING','HELD'\)/);
      return db.intakes
        .filter((row) => row.studentId === args[0] && row.id !== args[1] && ["SHUTTLE_START_STOP", "SHUTTLE_CHANGE"].includes(row.kind) && ["SUBMITTED", "PROCESSING", "HELD"].includes(row.status))
        .map((row) => ({ id: row.id }));
    }
    if (/FROM "Enrollment" e/.test(sql) && /"dayOfWeek"/.test(sql)) {
      assert.match(sql, /s\."parentId"=\$1/);
      return (db.classDays ?? []).filter((row) => row.parentId === args[0] && row.studentId === args[1]).map(({ dayOfWeek }) => ({ dayOfWeek }));
    }
    throw new Error(`예상하지 않은 조회: ${sql.slice(0, 120)}`);
  }
  async function execute(sql, ...args) {
    if (/pg_advisory_xact_lock/.test(sql)) return 1;
    if (/SET status='CANCELED'.*WHERE "identityId"=\$1 AND status IN \(/s.test(sql)) {
      const statuses = [...sql.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).filter((s) => s !== "CANCELED");
      let n = 0;
      for (const row of db.intakes) if (row.identityId === args[0] && statuses.includes(row.status)) { row.status = "CANCELED"; n += 1; }
      return n;
    }
    if (/SET "structuredJson"=\$3::jsonb,"studentId"=\$4/.test(sql)) {
      const status = /status='([A-Z_]+)'/.exec(sql)?.[1];
      const row = db.intakes.find((item) => item.id === args[0]);
      if (!row || row.status !== status || row.structuredJson.step !== args[1]) return 0;
      row.structuredJson = JSON.parse(args[2]); row.studentId = args[3]; row.updatedAt = Date.now();
      return 1;
    }
    if (/SET status='SUBMITTED',kind=\$2/.test(sql)) {
      const status = /AND status='([A-Z_]+)'/.exec(sql)?.[1];
      const row = db.intakes.find((item) => item.id === args[0]);
      if (!row || row.status !== status) return 0;
      row.status = "SUBMITTED"; row.kind = args[1]; row.structuredJson = JSON.parse(args[2]);
      return 1;
    }
    if (/SET status='APPLIED'/.test(sql) || /SET status='CANCELED',"structuredJson"=COALESCE/.test(sql)) {
      const row = db.intakes.find((item) => item.id === args[0]);
      if (!row) return 0;
      const flowStatus = /AND status='([A-Z_]+)'/.exec(sql)?.[1];
      if (/status='CANCELED'/.test(sql) && row.status !== flowStatus) return 0;
      row.status = /APPLIED/.test(sql) ? "APPLIED" : "CANCELED";
      if (args[1]) row.structuredJson = JSON.parse(args[1]);
      return 1;
    }
    throw new Error(`예상하지 않은 쓰기: ${sql.slice(0, 120)}`);
  }
  db.$queryRawUnsafe = query;
  db.$executeRawUnsafe = execute;
  db.$transaction = async (fn) => fn({ $queryRawUnsafe: query, $executeRawUnsafe: execute });
  globalThis.__careDb = db;
  return db;
}

const ONE_CHILD = [{ id: "s1", name: "지유" }];
const TWO_CHILDREN = [{ id: "s1", name: "지유" }, { id: "s2", name: "지호" }];
const textOf = (res) => res.template.outputs[0].simpleText?.text ?? res.template.outputs[0].textCard.description;
const sends = (res) => res.template.quickReplies.map((reply) => reply.messageText);
const absenceSay = (text, children = ONE_CHILD, parentUserId = "p1") =>
  absenceFlow.handleAbsenceConversation({ identityId: "i1", parentUserId, children, text, webLink: { label: "결석 날짜 선택하기", url: "https://x.test/mypage/regular-absence" } });

// ── 순수 함수 ────────────────────────────────────────────────────────────
test("날짜 말 읽기: 오늘·내일·모레·월/일, 지난 날짜는 내년, 번호는 날짜가 아니다", () => {
  assert.equal(store.parseKoreanDateYmd("오늘 셔틀 안 타요", "2026-11-07"), "2026-11-07");
  assert.equal(store.parseKoreanDateYmd("내일 결석할게요", "2026-11-07"), "2026-11-08");
  assert.equal(store.parseKoreanDateYmd("내일모레요", "2026-11-07"), "2026-11-09");
  assert.equal(store.parseKoreanDateYmd("모레", "2026-11-30"), "2026-12-02");
  assert.equal(store.parseKoreanDateYmd("11월 20일", "2026-11-07"), "2026-11-20");
  assert.equal(store.parseKoreanDateYmd("11/20 결석", "2026-11-07"), "2026-11-20");
  assert.equal(store.parseKoreanDateYmd("1/5", "2026-12-28"), "2027-01-05");
  assert.equal(store.parseKoreanDateYmd("12.31", "2026-12-31"), "2026-12-31");
  assert.equal(store.parseKoreanDateYmd("2/30", "2026-11-07"), null);
  assert.equal(store.parseKoreanDateYmd("1번", "2026-11-07"), null);
  assert.equal(store.parseKoreanDateYmd("결석할게요", "2026-11-07"), null);
});

test("결석 사유 읽기: 버튼·번호·흔한 표현, 모르는 말은 null(기타로 삼키지 않는다)", () => {
  assert.equal(absenceFlow.parseAbsenceReason("결석 사유 질병/부상"), "ILLNESS_INJURY");
  assert.equal(absenceFlow.parseAbsenceReason("가족 여행"), "FAMILY_TRIP");
  assert.equal(absenceFlow.parseAbsenceReason("감기 걸려서요"), "ILLNESS_INJURY");
  assert.equal(absenceFlow.parseAbsenceReason("학교 행사가 있어요"), "SCHOOL_EVENT");
  assert.equal(absenceFlow.parseAbsenceReason("2번"), "PERSONAL");
  assert.equal(absenceFlow.parseAbsenceReason("기타"), "ETC");
  assert.equal(absenceFlow.parseAbsenceReason("입금했어요"), null);
});

test("결석 후보: 이미 신청된 날은 빼고 날짜·시간 순", () => {
  const list = absenceFlow.buildAbsenceCandidates(makeDb().upcoming[0].classes);
  assert.deepEqual(list.map((item) => item.date), [day(1), day(8), day(10)]);
  assert.match(list[0].label, /18:00 주중경기반$/);
});

// 2026-11-14 결석 당일 취소·보강 연결
test("결석 후보: 마감(수업 1시간 전)이 지난 날(changeOpen=false)은 빼고, 열린 오늘 수업은 후보에 넣는다", () => {
  const list = absenceFlow.buildAbsenceCandidates([
    { classId: "cA", className: "주중경기반", startTime: "18:00", dates: [
      { date: TODAY, reported: false, changeOpen: false },
      { date: day(7), reported: false, changeOpen: true },
    ] },
    { classId: "cB", className: "주말기본반", startTime: "20:00", dates: [{ date: TODAY, reported: false, changeOpen: true }] },
  ]);
  assert.deepEqual(list.map((item) => [item.classId, item.date]), [["cB", TODAY], ["cA", day(7)]]);
});

test("결석 대화의 마감 판정은 웹과 같은 함수(isAbsenceChangeOpen) — 날짜 비교를 따로 만들지 않는다", () => {
  const source = readFileSync("src/lib/kakao-absence-flow.ts", "utf8");
  assert.match(source, /import \{ isAbsenceChangeOpen,[^}]*\} from "@\/lib\/regular\/regularAbsenceRules"/);
  // 취소 목록·취소 확정 두 곳 모두
  assert.equal((source.match(/isAbsenceChangeOpen\(/g) || []).length, 2);
  assert.doesNotMatch(source, /item\.date <= today/, "옛 «오늘이면 무조건 거절» 판정은 없다");
  assert.match(source, /code === "ABSENCE_CHANGE_CLOSED"/);
});

// ── 결석 신청 ────────────────────────────────────────────────────────────
test("결석 신청: 날짜 → 사유 → 확정 → reportRegularAbsence 한 번, 두 번 눌러도 한 번", async () => {
  const db = makeDb();
  const first = await absenceSay("정규수업 결석");
  assert.match(textOf(first), /결석할 날 번호/);
  assert.ok(sends(first).includes("결석 날짜 1번"));
  assert.ok(sends(first).includes("원장님께 오늘 결석 알릴게요"), "오늘 결석은 원장님께 바로 알리는 길");
  assert.ok(sends(first).length <= 10);

  const reason = await absenceSay("결석 날짜 2번");
  assert.match(textOf(reason), /사유를 골라/);
  const confirm = await absenceSay("결석 사유 가족 여행");
  assert.match(textOf(confirm), /결석 신청할까요/);
  assert.equal(db.calls.filter((c) => c[0] === "report").length, 0, "확정 전에는 저장하지 않는다");

  const done = await absenceSay("결석 신청 확정");
  assert.match(textOf(done), /결석 신청 완료/);
  const reports = db.calls.filter((c) => c[0] === "report");
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], ["report", "p1", { studentId: "s1", classId: "cA", date: day(8), reason: "FAMILY_TRIP", source: "KAKAO" }]);
  assert.equal(db.intakes.find((row) => row.status === "APPLIED")?.kind, "REGULAR_ABSENCE");

  // 같은 확정 버튼을 다시 눌러도 두 번 신청되지 않는다(처음부터 다시 안내)
  const again = await absenceSay("결석 신청 확정");
  assert.match(textOf(again), /진행 중인 선택이 없어요/);
  assert.equal(db.calls.filter((c) => c[0] === "report").length, 1);
});

test("「내일 결석할게요」는 내일 수업이 하나면 날짜를 건너뛰고 사유로", async () => {
  const db = makeDb();
  const res = await absenceSay("내일 결석할게요");
  assert.match(textOf(res), /사유를 골라/);
  await absenceSay("아파서요");
  await absenceSay("네");
  assert.deepEqual(db.calls.find((c) => c[0] === "report")[2], { studentId: "s1", classId: "cA", date: day(1), reason: "ILLNESS_INJURY", source: "KAKAO" });
});

test("「오늘 결석」은 목록 + 원장님께 알리기, 그 버튼은 결석 흐름이 붙잡지 않는다", async () => {
  const db = makeDb();
  const res = await absenceSay("오늘 결석할게요");
  // 2026-11-14 결석 당일 취소·보강 연결: 오늘 수업도 1시간 전까지는 받는다. 이 가짜 목록에는 오늘 후보가 없으므로
  // (= 오늘 수업이 없거나 마감) «1시간 전이 지나» 안내가 나온다.
  assert.match(textOf(res), /오늘 수업은 시작 1시간 전이 지나 여기서 신청할 수 없어요/);
  const pass = await absenceSay("원장님께 오늘 결석 알릴게요");
  assert.equal(pass, null, "원장님 접수(기존 흐름)로 넘어간다");
  assert.ok(db.intakes.every((row) => row.status !== "ABSENCE_FLOW"), "결석 대화는 닫힌다");
});

test("저장 함수가 거절하면 이유를 알리고 대화를 닫는다", async () => {
  const db = makeDb();
  db.reportError = "NOT_REPORTABLE_DATE";
  await absenceSay("결석 신청");
  await absenceSay("1번");
  await absenceSay("개인 사정");
  const res = await absenceSay("신청할게요");
  assert.match(textOf(res), /결석 신청을 못 했어요: 지난 날짜이거나/);
  assert.ok(db.intakes.every((row) => row.status !== "ABSENCE_FLOW"));
});

test("자녀가 둘이면 먼저 자녀를 고르고, 이름이 있으면 바로 그 자녀", async () => {
  makeDb();
  const ask = await absenceSay("결석할게요", TWO_CHILDREN);
  assert.match(textOf(ask), /어느 자녀/);
  assert.ok(sends(ask).includes("지유 결석 신청"));
  const named = await absenceSay("지유 결석 신청", TWO_CHILDREN);
  assert.match(textOf(named), /지유 학생의 다가오는 수업/);
});

test("대화 중 다른 업무·그만", async () => {
  const db = makeDb();
  await absenceSay("결석 신청");
  assert.equal(await absenceSay("입금했어요"), null, "다른 업무는 기존 흐름으로");
  assert.ok(db.intakes.every((row) => row.status !== "ABSENCE_FLOW"));
  await absenceSay("결석 신청");
  const stop = await absenceSay("그만");
  assert.match(textOf(stop), /그만했어요/);
  // 짧은 엉뚱한 말은 지금 단계를 다시 보여 준다
  await absenceSay("결석 신청");
  assert.match(textOf(await absenceSay("ㅇㅋ")), /지금 단계의 버튼/);
});

test("다른 보호자로 다시 연결되면 이전 대화 상태를 쓰지 않는다", async () => {
  const db = makeDb();
  await absenceSay("결석 신청");
  await absenceSay("1번");
  const other = await absenceSay("1번", ONE_CHILD, "p9");
  assert.equal(other, null);
  assert.equal(db.calls.filter((c) => c[0] === "report").length, 0);
});

// ── 결석 취소 ────────────────────────────────────────────────────────────
test("결석 취소: 내 자녀의 마감 전(수업 1시간 전까지) 신청분만 → 확정 → cancelRegularAbsence(id)", async () => {
  const db = makeDb();
  const list = await absenceSay("결석 취소할게요");
  assert.match(textOf(list), /취소할 번호/);
  assert.doesNotMatch(textOf(list), /남의집/);
  assert.equal(sends(list).filter((s) => /^결석 취소 \d번$/.test(s)).length, 1, "마감이 지난 오늘 결석·남의 결석은 목록에 없다");
  const confirm = await absenceSay("결석 취소 1번");
  assert.match(textOf(confirm), /취소할까요/);
  // 「취소」 한 마디는 그만두기가 아니라 다시 묻기
  assert.match(textOf(await absenceSay("취소")), /「취소할게요」/);
  const done = await absenceSay("취소할게요");
  assert.match(textOf(done), /결석 신청을 취소했어요/);
  assert.deepEqual(db.calls.filter((c) => c[0] === "cancelAbsence"), [["cancelAbsence", "p1", { id: "ra1" }]]);
});

test("결석 취소: 원장님 확정건은 거절 메시지", async () => {
  const db = makeDb();
  db.cancelError = "ABSENCE_NOT_CANCELABLE";
  await absenceSay("결석 취소");
  await absenceSay("1번");
  const res = await absenceSay("네");
  assert.match(textOf(res), /이미 확인\(확정\)한 결석/);
});

test("소스 계약: raw SQL 만, 웹과 같은 결석 함수, 보호자 조건", () => {
  const source = readFileSync("src/lib/kakao-absence-flow.ts", "utf8");
  assert.doesNotMatch(source, /prisma\.\w+\.(findMany|findFirst|create|update|upsert|delete)\(/);
  assert.match(source, /await reportRegularAbsence\(state\.parentUserId/);
  assert.match(source, /await cancelRegularAbsence\(flow\.state\.parentUserId/);
  assert.match(source, /s\."parentId"=\$1/);
  const storeSource = readFileSync("src/lib/kakao-flow-store.ts", "utf8");
  assert.match(storeSource, /pg_advisory_xact_lock/);
  assert.match(storeSource, /"structuredJson"->>'step'=\$2/, "단계 선점(중복 방지)");
});

// ── 당일 셔틀 변경 ───────────────────────────────────────────────────────
const shuttleSay = (text, children = ONE_CHILD, parentUserId = "p1") =>
  shuttleFlow.handleShuttleConversation({ identityId: "i1", parentUserId, children, text, webLink: { label: "오늘 셔틀 변경하기", url: "https://x.test/mypage/shuttle" } });

test("셔틀 의도 경계: 당일 변경·취소만 이 흐름, 정규 이용·셔틀비·주차는 아니다", () => {
  const cases = [
    ["내일 셔틀 안 타요", "DAY"],
    ["오늘 하원 셔틀은 안 타요", "DAY"],
    ["오늘 다른 곳에서 차 탈게요", "DAY"],
    ["오늘 다른 곳에서 타요", "DAY"],
    ["내일 탑승 장소 변경할게요", "DAY"],
    ["셔틀 변경 취소", "DAY_CANCEL"],
    ["내일 셔틀 안 타는 거 취소할게요", "DAY_CANCEL"],
    ["셔틀 이용 중단할게요", "REGULAR"],
    ["정규 셔틀 신청·중단", "REGULAR"],
    ["탑승 장소·시간 변경", "REGULAR"],
    ["셔틀 타는 곳 바꾸고 싶어요", "REGULAR"],
    ["셔틀 몇 시에 와요?", null],
    // 묻는 말은 정규 변경 흐름이 아니라 예전처럼 원문 접수(검수 2026-11-07)
    ["셔틀 시간 바뀌었나요?", null],
    ["셔틀 노선 바뀌었어요?", null],
    ["셔틀 신청 가능한가요", null],
    ["셔틀 시간 바꿔 주세요", "REGULAR"],
    ["셔틀비 얼마예요?", null],
    ["주차 가능한가요?", null],
    ["대관 차량 되나요?", null],
    ["셔틀", null],
  ];
  for (const [text, expected] of cases) assert.equal(shuttleFlow.shuttleIntentOf(text), expected, text);
});

test("방향·종류 말 읽기", () => {
  assert.equal(shuttleFlow.parseShuttleDirection("셔틀변경 등하원"), "BOTH");
  assert.equal(shuttleFlow.parseShuttleDirection("등·하원 둘 다요"), "BOTH");
  assert.equal(shuttleFlow.parseShuttleDirection("하원만요"), "DROPOFF");
  assert.equal(shuttleFlow.parseShuttleDirection("등원"), "PICKUP");
  assert.equal(shuttleFlow.parseShuttleDirection("올 때요"), null, "누구 기준인지 모호한 말은 버튼으로 다시 묻는다");
  assert.equal(shuttleFlow.parseShuttleKind("안 타요"), "SKIP");
  assert.equal(shuttleFlow.parseShuttleKind("셔틀변경 다른 장소"), "LOCATION");
  assert.deepEqual(shuttleFlow.shuttleDateChoices("2026-12-30", 3), ["2026-12-30", "2026-12-31", "2027-01-01"]);
});

test("「내일 셔틀 안 타요」: 날짜·종류는 첫 문장에서, 방향만 묻고 확정 → submitShuttleException", async () => {
  const db = makeDb();
  const ask = await shuttleSay("내일 셔틀 안 타요");
  assert.match(textOf(ask), /등원·하원 중 어느 쪽/);
  const confirm = await shuttleSay("셔틀변경 하원");
  assert.match(textOf(confirm), /이대로 바꿀까요/);
  // 2026-11-14 묶음 B: 확인 글의 «안 타요»는 화면과 같은 자차 문구(하원 = 직접 데리러 가요)
  assert.match(textOf(confirm), /직접 데리러 가요\(자차\)/);
  assert.equal(db.calls.filter((c) => c[0] === "submitShuttle").length, 0, "확정 전에는 저장하지 않는다");
  const done = await shuttleSay("셔틀변경 확정");
  assert.match(textOf(done), /셔틀 변경 완료/);
  assert.deepEqual(db.calls.filter((c) => c[0] === "submitShuttle"), [["submitShuttle", "p1", { studentId: "s1", serviceDate: day(1), direction: "DROPOFF", kind: "SKIP", location: undefined }]]);
  // 같은 확정을 다시 눌러도 한 번만
  await shuttleSay("셔틀변경 확정");
  assert.equal(db.calls.filter((c) => c[0] === "submitShuttle").length, 1);
});

test("다른 곳 탑승: 날짜 번호 → 방향 → 종류 → 장소 글 → 확정", async () => {
  const db = makeDb();
  const dates = await shuttleSay("셔틀 탈 장소가 달라요 다른 곳에서 타요");
  assert.match(textOf(dates), /바꿀 날을 골라/);
  assert.ok(sends(dates).length <= 10);
  await shuttleSay("셔틀변경 날짜 3번");
  const kindAsk = await shuttleSay("등원");
  assert.match(textOf(kindAsk), /타실 곳을 적어/, "첫 문장의 「다른 곳」은 다시 묻지 않는다");
  const confirm = await shuttleSay("푸르지오 2단지 정문");
  assert.match(textOf(confirm), /푸르지오 2단지 정문/);
  await shuttleSay("네");
  assert.deepEqual(db.calls.find((c) => c[0] === "submitShuttle")[2], { studentId: "s1", serviceDate: day(2), direction: "PICKUP", kind: "LOCATION", location: "푸르지오 2단지 정문" });
});

test("14일 넘는 날짜는 받지 않는다, 저장 함수 거절은 그대로 알린다", async () => {
  const db = makeDb();
  await shuttleSay("오늘 셔틀 안 타요");
  await shuttleSay("그만");
  await shuttleSay("셔틀 안 타요");
  const far = await shuttleSay(kst.kstLabel(day(20)).replace(/\(.+\)/, ""));
  assert.match(textOf(far), /14일 안의 날짜/);
  db.shuttleResult = { ok: false, message: "본인 자녀만 신청할 수 있습니다." };
  await shuttleSay("1번");
  await shuttleSay("등하원");
  const res = await shuttleSay("확정");
  assert.match(textOf(res), /셔틀 변경을 못 했어요: 본인 자녀만/);
});

test("당일 변경 취소: 내 자녀 것만 목록 → 확정 → cancelShuttleException(id)", async () => {
  const db = makeDb();
  db.exceptions = [
    { id: "x1", parentId: "p1", studentName: "지유", serviceDate: day(1), direction: "DROPOFF", kind: "SKIP", location: null },
    { id: "x9", parentId: "p9", studentName: "남의집", serviceDate: day(1), direction: "DROPOFF", kind: "SKIP", location: null },
  ];
  const list = await shuttleSay("셔틀 변경 취소");
  assert.match(textOf(list), /취소할 번호/);
  assert.doesNotMatch(textOf(list), /남의집/);
  await shuttleSay("셔틀변경 취소 1번");
  const done = await shuttleSay("취소할게요");
  assert.match(textOf(done), /셔틀 변경을 취소했어요/);
  assert.deepEqual(db.calls.filter((c) => c[0] === "cancelShuttle"), [["cancelShuttle", "p1", "x1"]]);
});

test("셔틀 대화 중 다른 업무는 닫고 넘긴다, 자녀가 둘이면 이름 붙여 원래 문장을 돌려받는다", async () => {
  const db = makeDb();
  await shuttleSay("내일 셔틀 안 타요");
  assert.equal(await shuttleSay("영수증 요청"), null);
  assert.ok(db.intakes.every((row) => row.status !== "SHUTTLE_FLOW"));
  const ask = await shuttleSay("내일 셔틀 안 타요", TWO_CHILDREN);
  assert.deepEqual(sends(ask).slice(0, 2), ["지유 내일 셔틀 안 타요", "지호 내일 셔틀 안 타요"]);
});

// ── 정규 셔틀 변경(원장님 승인 접수) ─────────────────────────────────────
test("정규 셔틀 말 읽기: 종류·요일·시작일", () => {
  assert.equal(shuttleFlow.parseRegularShuttleAction("정규 셔틀 신청·중단"), null, "둘 다 걸리면 버튼으로 묻는다");
  assert.equal(shuttleFlow.parseRegularShuttleAction("셔틀 이용 중단할게요"), "STOP");
  assert.equal(shuttleFlow.parseRegularShuttleAction("셔틀변경 정규 장소"), "PLACE");
  assert.equal(shuttleFlow.parseRegularShuttleAction("셔틀 시간 바꿔주세요"), "TIME");
  assert.deepEqual(shuttleFlow.parseWeekdays("월수금"), ["월", "수", "금"]);
  assert.deepEqual(shuttleFlow.parseWeekdays("수요일, 월요일"), ["월", "수"]);
  assert.deepEqual(shuttleFlow.parseWeekdays("셔틀변경 요일 전체"), ["전체"]);
  assert.equal(shuttleFlow.parseWeekdays("푸르지오"), null);
  // 2026-11-07 은 토요일 → 다음 화요일 수업 11/10, 다음 주 월요일 11/9
  assert.deepEqual(shuttleFlow.regularStartChoices("2026-11-07", ["화"]), { nextClass: "2026-11-10", nextWeek: "2026-11-09" });
  // 월요일 당일이면 다음 주 월요일(오늘 제외)
  assert.deepEqual(shuttleFlow.regularStartChoices("2026-11-09", ["월"]), { nextClass: "2026-11-16", nextWeek: "2026-11-16" });
});

test("정규 셔틀 장소 변경: 종류 → 요일 → 방향 → 장소 → 시작일 → 확정 → 원장님 승인 접수(SUBMITTED) 한 건", async () => {
  const db = makeDb();
  db.classDays = [{ parentId: "p1", studentId: "s1", dayOfWeek: "Wed" }, { parentId: "p1", studentId: "s1", dayOfWeek: "Mon" }];
  const action = await shuttleSay("탑승 장소·시간 변경");
  assert.match(textOf(action), /정규 셔틀을 어떻게 바꿀까요/);
  const days = await shuttleSay("셔틀변경 정규 장소");
  assert.deepEqual(sends(days).slice(0, 3), ["셔틀변경 요일 월", "셔틀변경 요일 수", "셔틀변경 요일 전체"]);
  // 다니지 않는 요일은 받지 않는다
  assert.match(textOf(await shuttleSay("금요일")), /금요일은 지금 다니는 수업이 없어요/);
  await shuttleSay("월 수");
  await shuttleSay("하원");
  const start = await shuttleSay("푸르지오 2단지 정문");
  assert.match(textOf(start), /언제부터/);
  const startButton = sends(start)[0];
  assert.match(startButton, /^셔틀변경 시작 \d{4}-\d{2}-\d{2}$/);
  const confirm = await shuttleSay(startButton);
  assert.match(textOf(confirm), /원장님께 접수할까요/);
  assert.match(textOf(confirm), /탑승 장소: 푸르지오 2단지 정문/);
  await shuttleSay("접수할게요");
  const row = db.intakes.find((item) => item.status === "SUBMITTED");
  assert.equal(row.kind, "SHUTTLE_CHANGE");
  assert.equal(row.structuredJson.shuttleIntent, "CHANGE");
  assert.equal(row.structuredJson.effectiveDate, startButton.slice(-10));
  assert.equal(row.structuredJson.studentId, "s1");
  assert.deepEqual(row.structuredJson.regularShuttle.days, ["월", "수"]);
  assert.equal(row.structuredJson.regularShuttle.direction, "DROPOFF");
  assert.match(row.structuredJson.details, /요일: 월·수/);
  assert.equal(db.alerts.length, 1, "원장님 앱 알림 한 번");
  assert.equal(db.calls.filter((c) => c[0] === "submitShuttle").length, 0, "정규 변경은 바로 반영하지 않는다");
  // 같은 확정을 다시 눌러도 접수는 한 건
  await shuttleSay("셔틀변경 정규 확정");
  assert.equal(db.intakes.filter((item) => item.status === "SUBMITTED").length, 1);
});

test("정규 셔틀 중단: 장소는 묻지 않고, 다니는 요일이 하나면 요일도 건너뛴다", async () => {
  const db = makeDb();
  db.classDays = [{ parentId: "p1", studentId: "s1", dayOfWeek: "Tue" }];
  const dir = await shuttleSay("셔틀 이용 중단할게요");
  assert.match(textOf(dir), /등원·하원 중 어느 쪽/);
  const start = await shuttleSay("등하원 모두");
  assert.match(textOf(start), /언제부터/);
  // 오늘·지난 날짜는 시작일로 받지 않는다
  assert.match(textOf(await shuttleSay("오늘부터요")), /내일부터 90일 안/);
  assert.match(textOf(await shuttleSay("다음 주부터요")), /원장님께 접수할까요/);
  await shuttleSay("네");
  const row = db.intakes.find((item) => item.status === "SUBMITTED");
  assert.equal(row.kind, "SHUTTLE_START_STOP");
  assert.equal(row.structuredJson.shuttleIntent, "STOP");
  assert.equal(row.structuredJson.effectiveDate, shuttleFlow.regularStartChoices(TODAY, ["화"]).nextWeek);
  assert.deepEqual(row.structuredJson.regularShuttle.days, ["화"]);
});

// ── 검수 반영(2026-11-07) ───────────────────────────────────────────────
test("날짜 단계에서 다른 업무 문장은 날짜로 삼키지 않고 대화를 닫는다", async () => {
  const db = makeDb();
  await absenceSay("결석 신청");
  assert.equal(await absenceSay("내일 셔틀 안 타요"), null, "셔틀 업무로 넘어간다");
  assert.equal(await absenceSay("11/20 청구 금액 확인"), null);
  assert.ok(db.intakes.every((row) => row.status !== "ABSENCE_FLOW"));
  assert.equal(db.calls.filter((c) => c[0] === "report").length, 0);
  // 결석 자신의 날짜 말은 그대로 받는다
  await absenceSay("결석 신청");
  assert.match(textOf(await absenceSay(kst.kstLabel(day(1)).replace(/\(.+\)/, "") + " 결석")), /사유를 골라/);

  await shuttleSay("셔틀 안 타요");
  assert.equal(await shuttleSay("11/20 청구 금액 확인"), null);
  assert.ok(db.intakes.every((row) => row.status !== "SHUTTLE_FLOW"));
  assert.equal(db.calls.filter((c) => c[0] === "submitShuttle").length, 0);
});

test("정규 셔틀 시작일 단계도 다른 업무 문장은 닫고 넘긴다", async () => {
  const db = makeDb();
  db.classDays = [{ parentId: "p1", studentId: "s1", dayOfWeek: "Tue" }];
  await shuttleSay("셔틀 이용 중단할게요");
  const start = await shuttleSay("하원");
  assert.match(textOf(start), /언제부터/);
  assert.equal(await shuttleSay("다음 주 영수증 요청"), null);
  assert.ok(db.intakes.every((row) => row.status !== "SHUTTLE_FLOW"));
});

test("같은 학생에게 처리 전 정규 셔틀 접수가 있으면 «이미 접수되어 있어요»", async () => {
  const db = makeDb();
  db.classDays = [{ parentId: "p1", studentId: "s1", dayOfWeek: "Tue" }];
  db.intakes.push({ id: "old", identityId: "i-other", studentId: "s1", kind: "SHUTTLE_CHANGE", sourceText: "셔틀 장소 변경", structuredJson: {}, status: "HELD", updatedAt: Date.now() });
  await shuttleSay("셔틀 이용 중단할게요");
  await shuttleSay("하원");
  await shuttleSay("다음 주부터");
  const res = await shuttleSay("접수할게요");
  assert.match(textOf(res), /이미 접수되어 있어요/);
  assert.equal(db.intakes.filter((row) => row.status === "SUBMITTED").length, 0, "새 접수를 만들지 않는다");
  assert.equal(db.alerts.length, 0);
  assert.ok(db.intakes.every((row) => row.status !== "SHUTTLE_FLOW"), "대화는 닫힌다");
  // 원장님이 처리를 끝낸(APPLIED·REJECTED 등) 접수는 막지 않는다
  db.intakes.find((row) => row.id === "old").status = "REJECTED";
  await shuttleSay("셔틀 이용 중단할게요");
  await shuttleSay("하원");
  await shuttleSay("다음 주부터");
  await shuttleSay("접수할게요");
  assert.equal(db.intakes.filter((row) => row.status === "SUBMITTED").length, 1);
});
