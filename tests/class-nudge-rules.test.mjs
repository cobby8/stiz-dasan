import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 수업 미처리 장치 1단계(2026-11-17) — 순수 판정 규칙을 «실제로 실행»해 경계값을 확인한다.
// «지금»·«오늘»은 전부 여기서 넣는다. 실제 시계·오늘 날짜에 기대는 단정은 없다.
// 기준 수업: 2026-11-17(화) 16:00–17:00.

const rules = await loadTsModule("src/lib/class-nudge/rules.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");

const DAY = "2026-11-17";
const at = (hm) => kst.kstAt(DAY, hm);
const START = at("16:00");
const END = at("17:00");

function status(overrides = {}, thresholds) {
  return rules.classDayStatus({
    kind: "REGULAR", startMs: START, endMs: END, nowMs: at("16:00"),
    holiday: false, cancelled: false, session: null, rosterCount: 8, unmarkedCount: 8,
    ...overrides,
  }, thresholds);
}

// [이름, 입력, 기대 state, 기대 nudge, 기대 reasons]
const TABLE = [
  ["1 기록 없음 15:59", { nowMs: at("15:59") }, "UPCOMING", "NONE", []],
  ["2 기록 없음 16:00 정각", { nowMs: at("16:00") }, "NOT_STARTED", "NONE", ["NOT_STARTED"]],
  ["3 기록 없음 16:09", { nowMs: at("16:09") }, "NOT_STARTED", "NONE", ["NOT_STARTED"]],
  ["4 기록 없음 16:10 정각", { nowMs: at("16:10") }, "NOT_STARTED", "DUE", ["NOT_STARTED"]],
  ["5 기록 없음 16:29", { nowMs: at("16:29") }, "NOT_STARTED", "DUE", ["NOT_STARTED"]],
  ["6 기록 없음 16:30 정각", { nowMs: at("16:30") }, "NOT_STARTED", "ESCALATE", ["NOT_STARTED"]],
  ["7 PLANNED(미리 쓰기만) 16:10", { nowMs: at("16:10"), session: { status: "PLANNED" } }, "NOT_STARTED", "DUE", ["NOT_STARTED"]],
  ["8 PLANNED 출결 일부 16:10", { nowMs: at("16:10"), session: { status: "PLANNED" }, unmarkedCount: 3 }, "NOT_STARTED", "DUE", ["NOT_STARTED"]],
  ["9 PLANNED 출결 전부 16:10", { nowMs: at("16:10"), session: { status: "PLANNED" }, unmarkedCount: 0 }, "RECORDED", "NONE", []],
  ["10 PLANNED 출결 전부 15:00", { nowMs: at("15:00"), session: { status: "PLANNED" }, unmarkedCount: 0 }, "RECORDED", "NONE", []],
  ["11 진행 중 16:30", { nowMs: at("16:30"), session: { status: "IN_PROGRESS" }, unmarkedCount: 5 }, "IN_PROGRESS", "NONE", []],
  ["12 진행 중 17:09", { nowMs: at("17:09"), session: { status: "IN_PROGRESS" }, unmarkedCount: 5 }, "IN_PROGRESS", "NONE", []],
  ["13 진행 중 17:10 정각·미확인", { nowMs: at("17:10"), session: { status: "IN_PROGRESS" }, unmarkedCount: 5 }, "OVERRUN", "DUE", ["UNMARKED"]],
  ["14 진행 중 17:10·출결 전부", { nowMs: at("17:10"), session: { status: "IN_PROGRESS" }, unmarkedCount: 0 }, "OVERRUN", "DUE", ["NOT_ENDED"]],
  ["15 진행 중 17:30 정각", { nowMs: at("17:30"), session: { status: "IN_PROGRESS" }, unmarkedCount: 0 }, "OVERRUN", "ESCALATE", ["NOT_ENDED"]],
  ["16 완료", { nowMs: at("23:00"), session: { status: "COMPLETED" }, unmarkedCount: 0 }, "COMPLETED", "NONE", []],
  ["17 완료인데 미확인 1", { nowMs: at("18:00"), session: { status: "COMPLETED" }, unmarkedCount: 1 }, "COMPLETED", "NONE", []],
  ["18 휴무", { nowMs: at("16:30"), holiday: true }, "HOLIDAY", "NONE", []],
  ["19 휴무인데 진행 중(실제 상태가 이긴다)", { nowMs: at("16:30"), holiday: true, session: { status: "IN_PROGRESS" }, unmarkedCount: 5 }, "IN_PROGRESS", "NONE", []],
  ["20 휴강", { nowMs: at("16:30"), cancelled: true }, "CANCELLED", "NONE", []],
  ["21 휴강인데 진행 중·끝 +30분", { nowMs: at("17:30"), cancelled: true, session: { status: "IN_PROGRESS" }, unmarkedCount: 0 }, "OVERRUN", "ESCALATE", ["NOT_ENDED"]],
  ["22 휴무 + 휴강(휴무가 먼저)", { nowMs: at("16:30"), holiday: true, cancelled: true }, "HOLIDAY", "NONE", []],
  ["23 수강생 0명", { nowMs: at("16:30"), rosterCount: 0, unmarkedCount: 0 }, "NO_STUDENTS", "NONE", []],
  ["24 시작 시각 모름", { nowMs: at("16:30"), startMs: null }, "TIME_UNKNOWN", "NONE", []],
  ["25 진행 중·끝 시각 모름", { nowMs: at("23:00"), endMs: null, session: { status: "IN_PROGRESS" }, unmarkedCount: 5 }, "IN_PROGRESS", "NONE", []],
];

for (const [name, input, state, nudge, reasons] of TABLE) {
  test(`판정 ${name} → ${state}/${nudge}`, () => {
    const got = status(input);
    assert.equal(got.state, state);
    assert.equal(got.nudge, nudge);
    assert.deepEqual(got.reasons, reasons);
    assert.equal(rules.isClassDayOpen(got), nudge !== "NONE");
  });
}

test("시작 정각부터 startPassed(유예 없이) — 2단계 앱 잠금 기준", () => {
  assert.equal(status({ nowMs: at("15:59") }).startPassed, false);
  assert.equal(status({ nowMs: at("16:00") }).startPassed, true);
  // 시각을 모르면 지났다고 보지 않는다
  assert.equal(status({ nowMs: at("16:30"), startMs: null }).startPassed, false);
});

test("미확인 인원은 완료·미시작에서도 그대로 실린다", () => {
  assert.equal(status({ nowMs: at("16:10"), session: { status: "PLANNED" }, unmarkedCount: 3 }).unmarkedCount, 3);
  assert.equal(status({ nowMs: at("18:00"), session: { status: "COMPLETED" }, unmarkedCount: 1 }).unmarkedCount, 1);
});

test("독촉 시각(dueAt·escalateAt)은 시작 전엔 시작 기준, 진행 중엔 끝 기준", () => {
  const before = status({ nowMs: at("15:00") });
  assert.equal(before.dueAtMs, at("16:10"));
  assert.equal(before.escalateAtMs, at("16:30"));
  const running = status({ nowMs: at("16:30"), session: { status: "IN_PROGRESS" } });
  assert.equal(running.dueAtMs, at("17:10"));
  assert.equal(running.escalateAtMs, at("17:30"));
});

test("26 임계값은 인자다 — {5,5,15} 면 16:05 에 미처리, 16:15 에 원장 단계", () => {
  const t = { startGraceMin: 5, endGraceMin: 5, escalateMin: 15 };
  assert.equal(status({ nowMs: at("16:04") }, t).nudge, "NONE");
  assert.equal(status({ nowMs: at("16:05") }, t).nudge, "DUE");
  assert.equal(status({ nowMs: at("16:15") }, t).nudge, "ESCALATE");
  assert.equal(status({ nowMs: at("17:05"), session: { status: "IN_PROGRESS" } }, t).state, "OVERRUN");
  // 기본값은 10·10·30 한 곳
  assert.deepEqual(rules.DEFAULT_THRESHOLDS, { startGraceMin: 10, endGraceMin: 10, escalateMin: 30 });
});

test("이상한 숫자가 와도 판정이 무너지지 않는다", () => {
  assert.equal(status({ rosterCount: Number.NaN, unmarkedCount: Number.NaN }).state, "NO_STUDENTS");
  assert.equal(status({ nowMs: at("16:30"), startMs: Number.NaN }).state, "TIME_UNKNOWN");
  assert.equal(status({ nowMs: at("16:30"), session: { status: "이상한값" } }).state, "NOT_STARTED");
});

test("lessonWindowMs — 정상·한 자리 시·초 포함", () => {
  assert.deepEqual(rules.lessonWindowMs(DAY, "16:00", "17:00"), { startMs: START, endMs: END });
  assert.equal(rules.lessonWindowMs(DAY, "9:30", "10:30").startMs, at("09:30"));
  assert.equal(rules.lessonWindowMs(DAY, "16:00:00", "17:00:00").endMs, END);
});

test("lessonWindowMs — 형식이 틀리면 null(→ 시간 미정, 독촉하지 않는다)", () => {
  for (const bad of ["", null, undefined, "오후 4시", "25:00", "16:60", "1600", "16시"]) {
    assert.equal(rules.lessonWindowMs(DAY, bad, "17:00").startMs, null, `시작 ${bad}`);
  }
  // 끝만 틀리면 끝만 null
  assert.deepEqual(rules.lessonWindowMs(DAY, "16:00", "끝"), { startMs: START, endMs: null });
  // 끝이 시작보다 이르거나 같으면 끝만 null(자정 넘김·입력 실수)
  assert.deepEqual(rules.lessonWindowMs(DAY, "16:00", "16:00"), { startMs: START, endMs: null });
  assert.deepEqual(rules.lessonWindowMs(DAY, "22:00", "00:30"), { startMs: at("22:00"), endMs: null });
  // 틀린 날짜는 둘 다 null
  assert.deepEqual(rules.lessonWindowMs("2026-02-30", "16:00", "17:00"), { startMs: null, endMs: null });
  assert.deepEqual(rules.lessonWindowMs("오늘", "16:00", "17:00"), { startMs: null, endMs: null });
});

test("lessonWindowMs — 자정 경계: KST 00:00 은 전날 15:00Z(서버가 UTC 여도 하루 밀리지 않는다)", () => {
  assert.equal(rules.lessonWindowMs("2026-11-17", "00:00", "01:00").startMs, Date.parse("2026-11-16T15:00:00Z"));
  assert.equal(rules.lessonWindowMs("2026-11-17", "09:40", "10:40").startMs, Date.parse("2026-11-17T00:40:00Z"));
  // 연말·윤년
  assert.equal(rules.lessonWindowMs("2027-01-01", "00:00", "01:00").startMs, Date.parse("2026-12-31T15:00:00Z"));
  assert.equal(rules.lessonWindowMs("2028-02-29", "21:00", "21:55").endMs, Date.parse("2028-02-29T12:55:00Z"));
});

test("요약 — 한 줄은 한 칸에만, 미처리가 먼저", () => {
  const rows = [
    { status: status({ nowMs: at("16:30") }) },                                                       // 미처리
    { status: status({ nowMs: at("17:30"), session: { status: "IN_PROGRESS" }, unmarkedCount: 0 }) }, // 미처리(종료 지연)
    { status: status({ nowMs: at("16:30"), session: { status: "IN_PROGRESS" } }) },                   // 진행 중
    { status: status({ session: { status: "COMPLETED" }, unmarkedCount: 0 }) },                       // 완료
    { status: status({ session: { status: "PLANNED" }, unmarkedCount: 0 }) },                         // 출결만 입력 → 완료 수
    { status: status({ nowMs: at("15:00") }) },                                                       // 시작 전
    { status: status({ nowMs: at("16:05") }) },                                                       // 시작 시각 지남(유예 안) → 시작 전 수
    { status: status({ cancelled: true }) },                                                          // 휴강
    { status: status({ holiday: true }) },                                                            // 휴무
  ];
  assert.deepEqual(rules.summarizeClassDay(rows), { open: 2, inProgress: 1, done: 2, upcoming: 2, off: 2 });
  assert.deepEqual(rules.summarizeClassDay([]), { open: 0, inProgress: 0, done: 0, upcoming: 0, off: 0 });
});

test("정렬 — 미처리가 맨 위(오래 밀린 순), 나머지는 시각순 → 이름순", () => {
  const now = at("18:00");
  const row = (name, hm, extra = {}) => {
    const startMs = at(hm);
    return { name, startMs, status: status({ nowMs: now, startMs, endMs: startMs + 3_600_000, ...extra }) };
  };
  const rows = [
    row("완료반", "14:00", { session: { status: "COMPLETED" }, unmarkedCount: 0 }),
    row("늦게 밀린 반", "17:00"),
    row("나반", "19:00"),
    row("먼저 밀린 반", "15:00"),
    row("가반", "19:00"),
  ];
  const sorted = [...rows].sort(rules.compareClassDayRows).map((r) => r.name);
  assert.deepEqual(sorted, ["먼저 밀린 반", "늦게 밀린 반", "완료반", "가반", "나반"]);
  // 시각을 모르는 줄은 맨 뒤
  const unknown = { name: "미정반", startMs: null, status: status({ nowMs: now, startMs: null }) };
  assert.equal([unknown, ...rows].sort(rules.compareClassDayRows).at(-1).name, "미정반");
});

test("화면 글자 — 영문 상태 이름이 새지 않고, 아이 단위 말은 «미확인 n»", () => {
  for (const [state, label] of Object.entries(rules.CLASS_DAY_STATE_LABEL)) {
    assert.doesNotMatch(label, /[A-Za-z_]/, `${state} 글자에 영문`);
  }
  const text = (o) => rules.classDayStatusText(status(o), o.rosterCount ?? 8);
  assert.equal(text({ nowMs: at("16:10") }), "미시작 · 미확인 8");
  assert.equal(text({ nowMs: at("17:10"), session: { status: "IN_PROGRESS" }, unmarkedCount: 3 }), "종료 지연 · 미확인 3");
  assert.equal(text({ nowMs: at("17:10"), session: { status: "IN_PROGRESS" }, unmarkedCount: 0 }), "종료 지연 · 종료 안 누름");
  assert.equal(text({ nowMs: at("16:30"), session: { status: "IN_PROGRESS" }, unmarkedCount: 3 }), "진행 중 · 출결 5/8");
  assert.equal(text({ session: { status: "COMPLETED" }, unmarkedCount: 0 }), "완료");
  assert.equal(text({ session: { status: "COMPLETED" }, unmarkedCount: 1 }), "완료 · 미확인 1");
  assert.equal(text({ session: { status: "PLANNED" }, unmarkedCount: 0 }), "출결만 입력");
  assert.equal(text({ nowMs: at("15:00") }), "시작 전");
  assert.equal(text({ cancelled: true }), "휴강");
  assert.equal(text({ startMs: null }), "시간 미정");
});

test("상태색 갈래 — 미처리 위험, 유예 안·완료 미확인 주의, 진행 중, 완료 초록, 그 밖 회색", () => {
  const tone = (o) => rules.classDayTone(status(o));
  assert.equal(tone({ nowMs: at("16:10") }), "danger");
  assert.equal(tone({ nowMs: at("17:10"), session: { status: "IN_PROGRESS" } }), "danger");
  assert.equal(tone({ nowMs: at("16:05") }), "warning");
  assert.equal(tone({ session: { status: "COMPLETED" }, unmarkedCount: 1 }), "warning");
  assert.equal(tone({ nowMs: at("16:30"), session: { status: "IN_PROGRESS" } }), "progress");
  assert.equal(tone({ session: { status: "COMPLETED" }, unmarkedCount: 0 }), "success");
  assert.equal(tone({ session: { status: "PLANNED" }, unmarkedCount: 0 }), "success");
  assert.equal(tone({ nowMs: at("15:00") }), "neutral");
  assert.equal(tone({ cancelled: true }), "neutral");
});

test("휴강 입력 확인 — 오늘만(오늘은 인자), 요일 일치, 사유 200자, 특강은 시작 시각", () => {
  const ok = { date: DAY, today: DAY, kind: "REGULAR", classDayOfWeek: "Tue" };
  assert.deepEqual(rules.validateCancelInput(ok), { ok: true, startTime: "", reason: null });
  // 사유는 다듬어 싣는다
  assert.deepEqual(rules.validateCancelInput({ ...ok, reason: "  체육관 공사  " }), { ok: true, startTime: "", reason: "체육관 공사" });
  assert.equal(rules.validateCancelInput({ ...ok, reason: "가".repeat(200) }).ok, true);
  assert.equal(rules.validateCancelInput({ ...ok, reason: "가".repeat(201) }).ok, false);

  // 오늘이 아니면 거부(어제·내일 모두) — «오늘»을 바꾸면 같은 날짜가 거부된다
  assert.equal(rules.validateCancelInput({ ...ok, today: "2026-11-18" }).ok, false);
  assert.equal(rules.validateCancelInput({ ...ok, today: "2026-11-16" }).ok, false);
  // 형식이 틀린 날짜
  for (const bad of ["", "2026-02-30", "2026-11-17T00:00:00Z", null]) {
    assert.equal(rules.validateCancelInput({ ...ok, date: bad, today: String(bad) }).ok, false, `날짜 ${bad}`);
  }
  // 요일 불일치(2026-11-17 은 화요일)
  assert.equal(rules.validateCancelInput({ ...ok, classDayOfWeek: "Wed" }).ok, false);
  assert.equal(rules.validateCancelInput({ ...ok, classDayOfWeek: null }).ok, false);
  // 종류
  assert.equal(rules.validateCancelInput({ ...ok, kind: "OTHER" }).ok, false);

  // 특강 — 시작 시각이 열쇠. 요일은 보지 않는다(방학특강 반은 요일 칸이 다르다)
  const seasonal = { date: DAY, today: DAY, kind: "SEASONAL", classDayOfWeek: "Seasonal" };
  assert.equal(rules.validateCancelInput(seasonal).ok, false);
  assert.equal(rules.validateCancelInput({ ...seasonal, startTime: "9:00" }).ok, false);
  assert.equal(rules.validateCancelInput({ ...seasonal, startTime: "25:00" }).ok, false);
  assert.deepEqual(rules.validateCancelInput({ ...seasonal, startTime: "09:00" }), { ok: true, startTime: "09:00", reason: null });
});

test("규칙 파일은 시계를 읽지 않고 DB·next 를 끌어오지 않는다", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/lib/class-nudge/rules.ts", "src/lib/class-nudge/board.ts"]) {
    const code = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(/, `${file} 가 시계를 읽는다`);
    assert.doesNotMatch(code, /from\s+["'](@\/lib\/prisma|next\/|@prisma)/, `${file} 가 DB·next 를 끌어온다`);
  }
});
