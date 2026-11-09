import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-09 원장 결정 «기간 결석 만들기» — 부상·질병을 휴원이 아니라 기간 결석으로.
// 수업일 계산(요일·휴무·월말·연말·윤년)은 눈으로 읽어서는 틀린 걸 못 찾으므로 모듈을 실제로 돌린다.

const plan = await loadTsModule("src/lib/regular/absence-period-plan.ts");
const rules = await loadTsModule("src/lib/regular/regularAbsenceRules.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * 가짜 연간 일정: 수강월 = 달력 월, 그 달 그 요일 날짜 전부(휴무일 제외).
 * known 에 없는 달은 «연간 일정에 아직 없음»(빈 배열) — getMonthlyClassDates 와 같은 신호.
 */
function calendar({ known, closed = [] }) {
  const calls = [];
  const fn = (ym, dow) => {
    calls.push(`${ym}:${dow}`);
    if (!known.includes(ym)) return [];
    const out = [];
    for (let d = `${ym}-01`; d.startsWith(ym); d = kst.addDaysKst(d, 1)) {
      if (kst.kstDow(d) === DOW[dow] && !closed.includes(d)) out.push(d);
    }
    return out;
  };
  fn.calls = calls;
  return fn;
}

test("달 계산: 다음 달 말일 — 월말·연말·윤년 경계", () => {
  assert.equal(plan.nextMonthEnd("2026-11-09"), "2026-12-31");
  assert.equal(plan.nextMonthEnd("2026-11-30"), "2026-12-31");
  assert.equal(plan.nextMonthEnd("2026-12-01"), "2027-01-31"); // 연말 → 다음 해
  assert.equal(plan.nextMonthEnd("2026-12-31"), "2027-01-31");
  assert.equal(plan.nextMonthEnd("2028-01-15"), "2028-02-29"); // 윤년 2월
  assert.equal(plan.nextMonthEnd("2027-01-31"), "2027-02-28"); // 평년 2월
  assert.equal(plan.nextMonthEnd("2100-01-01"), "2100-02-28"); // 100의 배수 평년
  assert.equal(plan.nextMonthEnd("2000-01-01"), "2000-02-29"); // 400의 배수 윤년
  assert.equal(plan.addMonthsYm("2026-12", 1), "2027-01");
  assert.equal(plan.addMonthsYm("2027-01", -1), "2026-12");
  assert.equal(plan.addMonthsYm("2026-01", -13), "2024-12");
});

test("목표 끝: 복귀일 전날, 복귀 미정이면 KST 다음 달 말일", () => {
  assert.equal(plan.periodTargetEnd({ returnDate: "2026-12-01", todayYmd: "2026-11-09" }), "2026-11-30");
  assert.equal(plan.periodTargetEnd({ returnDate: "2028-03-01", todayYmd: "2028-02-10" }), "2028-02-29");
  assert.equal(plan.periodTargetEnd({ returnDate: null, todayYmd: "2026-11-09" }), "2026-12-31");
});

test("날짜 검사: 복귀일은 시작일 다음 날 이후, 실재하는 날짜만", () => {
  assert.equal(plan.validatePeriodDates("2026-11-06", null), null);
  assert.equal(plan.validatePeriodDates("2026-11-06", ""), null);
  assert.equal(plan.validatePeriodDates("2026-11-06", "2026-11-07"), null);
  assert.match(plan.validatePeriodDates("2026-11-06", "2026-11-06"), /복귀일/);
  assert.match(plan.validatePeriodDates("2026-11-06", "2026-11-01"), /복귀일/);
  assert.match(plan.validatePeriodDates("2026-02-30", null), /시작일/);
  assert.match(plan.validatePeriodDates("2026-11-06", "2027-02-29"), /복귀일/); // 평년 2/29 없음
});

test("기간 겹침: [시작, 복귀) — 복귀일 당일 새로 시작하는 건 겹치지 않는다", () => {
  const open = { startDate: "2026-11-06", returnDate: null };
  assert.equal(plan.periodsOverlap(open, { startDate: "2027-03-01", returnDate: null }), true);
  assert.equal(plan.periodsOverlap(open, { startDate: "2026-10-01", returnDate: "2026-11-06" }), false);
  assert.equal(plan.periodsOverlap(open, { startDate: "2026-10-01", returnDate: "2026-11-07" }), true);
  const closed = { startDate: "2026-11-06", returnDate: "2026-11-20" };
  assert.equal(plan.periodsOverlap(closed, { startDate: "2026-11-20", returnDate: null }), false);
  assert.equal(plan.periodsOverlap(closed, { startDate: "2026-11-19", returnDate: "2026-11-25" }), true);
});

test("수업일: 11/6(금)부터 복귀 미정 — 금·화 두 반, 휴무일 제외, 개시일 전 제외, 다음 달 말일까지", () => {
  const cal = calendar({ known: ["2026-10", "2026-11", "2026-12", "2027-01"], closed: ["2026-12-25"] });
  const r = plan.planAbsencePeriodDates({
    classes: [
      { classId: "fri", dayOfWeek: "Fri", startsOn: null },
      { classId: "tue", dayOfWeek: "Tue", startsOn: "2026-11-17" }, // 11/17 개시 → 11/10 은 빼야 한다
    ],
    fromDate: "2026-11-06",
    targetEnd: plan.nextMonthEnd("2026-11-09"),
    classDatesForMonth: cal,
  });
  const fri = r.items.filter((i) => i.classId === "fri").map((i) => i.date);
  const tue = r.items.filter((i) => i.classId === "tue").map((i) => i.date);
  assert.deepEqual(fri, ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04", "2026-12-11", "2026-12-18"]); // 12/25 휴무
  assert.deepEqual(tue, ["2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"]);
  assert.equal(r.coveredUntil, "2026-12-31");
  assert.equal(r.complete, true);
  assert.equal(r.missingMonth, null);
  // 모든 날짜가 그 반 요일과 맞는다(요일 하루 밀림 방지)
  for (const i of r.items) assert.equal(kst.kstDow(i.date), i.classId === "fri" ? 5 : 2, i.date);
  // 날짜순 정렬
  assert.deepEqual(r.items.map((i) => i.date), [...r.items.map((i) => i.date)].sort());
});

test("수업일: 복귀일이 있으면 복귀일 당일은 결석이 아니다", () => {
  const cal = calendar({ known: ["2026-10", "2026-11", "2026-12"] });
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "fri", dayOfWeek: "Fri", startsOn: null }],
    fromDate: "2026-11-06",
    targetEnd: plan.periodTargetEnd({ returnDate: "2026-11-20", todayYmd: "2026-11-09" }),
    classDatesForMonth: cal,
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-06", "2026-11-13"]);
  assert.equal(r.coveredUntil, "2026-11-19");
});

test("수업일: 연말을 넘는 기간 — 12월·1월 모두", () => {
  const cal = calendar({ known: ["2026-11", "2026-12", "2027-01", "2027-02"] });
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "thu", dayOfWeek: "Thu", startsOn: null }],
    fromDate: "2026-12-24",
    targetEnd: "2027-01-14",
    classDatesForMonth: cal,
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-12-24", "2026-12-31", "2027-01-07", "2027-01-14"]);
});

test("수업일: 윤년 2/29(화)도 수업일로 잡힌다", () => {
  const cal = calendar({ known: ["2028-01", "2028-02", "2028-03"] });
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "tue", dayOfWeek: "Tue", startsOn: null }],
    fromDate: "2028-02-20",
    targetEnd: "2028-03-07",
    classDatesForMonth: cal,
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2028-02-22", "2028-02-29", "2028-03-07"]);
});

test("연간 일정에 없는 달에서 멈춘다 — 추측해서 만들지 않고, 그 앞 달 마지막 수업일까지만 덮는다", () => {
  const cal = calendar({ known: ["2026-10", "2026-11"] }); // 12월 일정 아직 없음
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "fri", dayOfWeek: "Fri", startsOn: null }],
    fromDate: "2026-11-06",
    targetEnd: "2026-12-31",
    classDatesForMonth: cal,
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
  assert.equal(r.missingMonth, "2026-12");
  assert.equal(r.complete, false);
  assert.equal(r.coveredUntil, "2026-11-30"); // 11월 마지막 수업일(월 11/30) — 그 뒤는 크론이 다시 본다
  assert.match(plan.createResultMessage({ created: 4, existing: 0, attended: 0, protectedCount: 0 }, { missingMonth: r.missingMonth }), /12월 수업일이 아직 없어/);
});

test("첫 달부터 일정이 없으면 진척 없음(coveredUntil = 시작 전날)", () => {
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "fri", dayOfWeek: "Fri", startsOn: null }],
    fromDate: "2026-11-06",
    targetEnd: "2026-12-31",
    classDatesForMonth: calendar({ known: [] }),
  });
  assert.deepEqual(r.items, []);
  assert.equal(r.coveredUntil, "2026-11-05");
  assert.equal(r.complete, false);
});

test("수강월이 달력 월과 어긋나도 잡는다 — 12월 1주차가 11/30(월)에 시작", () => {
  // 수강월 2026-12 의 월요일 반 수업일에 11/30 이 들어 있다(getMonthlyClassDates 의 주차 방식에서 실제로 생긴다)
  const fn = (ym, dow) => {
    if (dow !== "Mon") return ym === "2026-11" || ym === "2027-01" ? ["2026-11-02"] : ym === "2026-12" ? ["2026-12-07"] : [];
    if (ym === "2026-11") return ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"];
    if (ym === "2026-12") return ["2026-11-30", "2026-12-07", "2026-12-14", "2026-12-21"];
    return [];
  };
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "mon", dayOfWeek: "Mon", startsOn: null }],
    fromDate: "2026-11-20",
    targetEnd: "2026-11-30",
    classDatesForMonth: fn,
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-23", "2026-11-30"]);
});

test("끝 달 다음 수강월이 비었으면 끝 달 마지막 수업일까지만 덮는다(다음 수강월 1주차가 말일에 걸칠 수 있다)", () => {
  const cal = calendar({ known: ["2026-11", "2026-12"] }); // 2027-01 없음
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "fri", dayOfWeek: "Fri", startsOn: null }],
    fromDate: "2026-12-01",
    targetEnd: "2026-12-31",
    classDatesForMonth: cal,
  });
  assert.equal(r.coveredUntil, "2026-12-31"); // 12월 마지막 수업일(목 12/31) — 여기선 말일과 같다
  const r2 = plan.planAbsencePeriodDates({
    classes: [{ classId: "fri", dayOfWeek: "Fri", startsOn: null }],
    fromDate: "2026-12-01",
    targetEnd: "2026-12-31",
    classDatesForMonth: (ym, dow) => (ym === "2026-12" && dow === "Fri" ? ["2026-12-04", "2026-12-11", "2026-12-18"] : []),
  });
  assert.equal(r2.coveredUntil, "2026-12-18");
  assert.equal(r2.complete, false); // 크론이 1월 일정이 들어오면 12/19 부터 다시 본다
  assert.equal(r2.missingMonth, null); // 화면 경고는 내지 않는다
});

test("같은 반·날짜는 한 번만", () => {
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "fri", dayOfWeek: "Fri", startsOn: null }],
    fromDate: "2026-11-01",
    targetEnd: "2026-11-30",
    classDatesForMonth: (ym, dow) => (dow === "Fri" && ym >= "2026-10" && ym <= "2026-12" ? ["2026-11-06", "2026-11-13"] : []),
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-06", "2026-11-13"]);
});

test("날짜 한 칸 판정: 출석 기록 > 살아 있는 행 > 취소 행 되살리기(정산된 취소 행은 보호)", () => {
  assert.equal(plan.decideCreate({ existing: null, attended: false }), "INSERT");
  assert.equal(plan.decideCreate({ existing: null, attended: true }), "ATTENDED");
  assert.equal(plan.decideCreate({ existing: { status: "REPORTED", resolved: false }, attended: false }), "EXISTS");
  assert.equal(plan.decideCreate({ existing: { status: "CONFIRMED", resolved: false }, attended: false }), "EXISTS");
  assert.equal(plan.decideCreate({ existing: { status: "CANCELLED", resolved: false }, attended: false }), "REACTIVATE");
  assert.equal(plan.decideCreate({ existing: { status: "CANCELLED", resolved: true }, attended: false }), "PROTECTED");
  assert.equal(plan.decideCreate({ existing: { status: "CANCELLED", resolved: false }, attended: true }), "ATTENDED");
});

test("취소 판정: 정산·보강·학부모 신고 행은 지우지 않는다", () => {
  const base = { status: "CONFIRMED", reportedByUserId: null, resolved: false, makeupBooked: false };
  assert.equal(plan.decideCancel(base), "CANCEL");
  assert.equal(plan.decideCancel({ ...base, status: "CANCELLED" }), "ALREADY");
  assert.equal(plan.decideCancel({ ...base, resolved: true }), "PROTECTED_BILLING");
  assert.equal(plan.decideCancel({ ...base, makeupBooked: true }), "PROTECTED_MAKEUP");
  assert.equal(plan.decideCancel({ ...base, reportedByUserId: "parent-1" }), "PROTECTED_PARENT_REPORT");
});

test("결과 문구 — 0인 항목은 빼고 표면화", () => {
  assert.equal(plan.createResultMessage({ created: 4, existing: 1, attended: 1, protectedCount: 0 }), "4회 결석 등록 · 이미 있음 1 · 출석 기록 있어 제외 1");
  assert.equal(plan.createResultMessage({ created: 0, existing: 0, attended: 0, protectedCount: 0 }), "0회 결석 등록");
  assert.equal(plan.cancelResultMessage({ cancelled: 3, billing: 1, makeup: 0, parent: 0 }), "결석 3회 취소 · 청구 정산돼 유지 1");
});

test("결석 행 note 와 알림 재조정 제외 조건이 같은 머리말을 쓴다", () => {
  const note = plan.periodAbsenceNote("ILLNESS_INJURY", "2026-11-06");
  assert.equal(note, "기간 결석 · 질병/부상 · 11/6(금)부터");
  assert.ok(note.startsWith(`${plan.PERIOD_ABSENCE_NOTE_PREFIX} · `));
  const rec = readFileSync("src/lib/operational-notification-reconciliation.ts", "utf8");
  assert.match(rec, /COALESCE\(ra\.note,''\) LIKE \$3 AND ra\."reportedByUserId" IS NULL/);
  assert.match(rec, /`\$\{PERIOD_ABSENCE_NOTE_PREFIX\} · %`/);
});

test("마이그레이션 CHECK 제약 = 코드 사유·상태 집합", () => {
  const sql = readFileSync("prisma/migrations/20261109180000_add_regular_absence_period/migration.sql", "utf8");
  const reasons = /reason IN \(([^)]+)\)/.exec(sql)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual([...reasons].sort(), [...rules.VALID_REASONS].sort());
  assert.deepEqual([...plan.PERIOD_REASONS].sort(), [...rules.VALID_REASONS].sort());
  const statuses = /status IN \(([^)]+)\)/.exec(sql)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(statuses, [...plan.PERIOD_STATUSES]);
  // 재실행 안전
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "RegularAbsencePeriod"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "periodId"/);
  assert.match(sql, /ON DELETE SET NULL/);
});

test("크론: vercel.json 하루 1회 + CRON_SECRET 확인", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  const job = vercel.crons.find((c) => c.path === "/api/cron/absence-periods");
  assert.ok(job, "vercel.json 에 크론이 없습니다");
  assert.match(job.schedule, /^\d+ \d+ \* \* \*$/, "하루 1회");
  const route = readFileSync("src/app/api/cron/absence-periods/route.ts", "utf8");
  assert.match(route, /authorization"\) !== `Bearer \$\{secret\}`/);
  // 크론용 연장은 화면에서 부를 수 있는 "use server" 액션으로 노출하지 않는다
  const action = readFileSync("src/app/actions/absence-period-admin.ts", "utf8");
  assert.doesNotMatch(action, /export async function extendOpenAbsencePeriods/);
  assert.match(action, /export async function extendAbsencePeriodsNow\(\) \{\s*await requireAdmin\(\);/);
});

test("검수 반영: 반마다 기간 시작일부터 다시 보고, 이미 이 기간이 다룬 날은 건너뛴다(기간 도중 새 반 채움)", () => {
  const svc = readFileSync("src/lib/regular/absence-period-service.ts", "utf8");
  assert.match(svc, /const fromDate = period\.startDate;/, "coveredUntil 다음 날이 아니라 시작일부터");
  assert.match(svc, /if \(row && row\.periodId === period\.id\) continue;/, "개별 취소한 기간 행을 되살리지 않는다");
  // 크론: 복귀 전 진행 중 기간은 다 덮었어도 다시 본다(새 반)
  assert.match(svc, /\|\| !r\.returnDate \|\| r\.returnDate > todayYmd/);
  // 같은 반·날짜는 계획 단계에서도 한 번만 — 개시일 전 제외
  const r = plan.planAbsencePeriodDates({
    classes: [{ classId: "mon", dayOfWeek: "Mon", startsOn: "2026-11-16" }],
    fromDate: "2026-11-06", targetEnd: "2026-11-30",
    classDatesForMonth: (ym, dow) => (ym === "2026-11" && dow === "Mon" ? ["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"] : ym === "2026-12" || ym === "2026-10" ? ["2026-10-05"] : []),
  });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-16", "2026-11-23", "2026-11-30"]);
});

test("검수 반영: 기간 취소 UPDATE 는 note 가 «기간 결석 · »인 행만(출석부가 되살린 행 보호)", () => {
  const svc = readFileSync("src/lib/regular/absence-period-service.ts", "utf8");
  assert.match(svc, /const PERIOD_NOTE_LIKE = `\$\{PERIOD_ABSENCE_NOTE_PREFIX\} · %`;/);
  assert.match(svc, /AND COALESCE\(ra\.note,''\) LIKE \$3\s+FOR UPDATE OF ra/, "고를 때");
  assert.match(svc, /"reportedByUserId" IS NULL\s+AND COALESCE\(note,''\) LIKE \$4`/, "UPDATE 할 때");
});

test("검수 반영: 화면 — 복귀일 지난 진행 중 기간은 «복귀함»·복귀 처리 숨김, 복귀일 최소 = 시작일 다음 날", () => {
  const ui = readFileSync("src/app/admin/students/[id]/AbsencePeriodPanel.tsx", "utf8");
  assert.match(ui, /p\.returnDate && p\.returnDate <= today/);
  assert.match(ui, /label: "복귀함"/);
  assert.match(ui, /p\.status === "ACTIVE" && !hasReturned\(p, today\) &&/);
  assert.match(ui, /min=\{startDate \? addDaysKst\(startDate, 1\) : undefined\}/);
  assert.match(ui, /min=\{addDaysKst\(period\.startDate, 1\)\}/);
});

test("재검수 반영: 취소된 행 되살리기는 처음 등록에서만 — 크론 연장·복귀 처리는 일부러 취소한 날을 건너뛴다", () => {
  const svc = readFileSync("src/lib/regular/absence-period-service.ts", "utf8");
  assert.match(svc, /if \(row && row\.status === "CANCELLED" && mode !== "CREATE"\) continue;/);
  assert.match(svc, /await fillPeriodRows\(db, period, ctx, "CREATE"\);/, "등록만 CREATE");
  assert.match(svc, /fill = await fillPeriodRows\(db, ended, ctx, "EXTEND"\);/, "복귀 처리는 EXTEND");
  assert.match(svc, /actorUserId: period\.createdByUserId \}, "EXTEND"\);/, "크론 연장은 EXTEND");
  assert.equal((svc.match(/fillPeriodRows\(db, /g) ?? []).length, 3, "부르는 곳은 세 곳뿐");
});
