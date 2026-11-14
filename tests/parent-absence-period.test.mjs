import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 학부모 «여러 날 결석»(기간 결석) — 2026-11-15 원장 결정(한도 4주·모든 사유 허용)
//
// 이 파일: 순수 규칙(기간·수업일 계산·복귀·안내 시점)을 실제로 돌려 보고, 연결부(권한·알림·관리자 불변)를 소스 계약으로 못박는다.
// 알리기·복귀·취소의 실제 실행(가짜 DB)은 tests/change-deadline-and-move.test.mjs «④-2», 증빙 한 묶음은 tests/illness-carry.test.mjs.

const rules = await loadTsModule("src/lib/regular/parentAbsencePeriodRules.ts");
const plan = await loadTsModule("src/lib/regular/absence-period-plan.ts");
const carry = await loadTsModule("src/lib/regular/illnessCarryRules.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const read = (path) => readFileSync(path, "utf8");

/** 가짜 연간 일정: 그 달의 그 요일 전부 − 휴무일. missing 에 든 달은 «일정 없음»(빈 배열) */
const calendar = ({ holidays = [], missing = [] } = {}) => (ym, dow) => {
  if (missing.includes(ym)) return [];
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dow);
  const out = [];
  for (let ymd = `${ym}-01`; ymd.slice(0, 7) === ym; ymd = kst.addDaysKst(ymd, 1)) if (kst.kstDow(ymd) === index && !holidays.includes(ymd)) out.push(ymd);
  return out;
};
const MON_WED = [
  { classId: "cM", className: "월요반", dayOfWeek: "Mon", startTime: "18:00", resumeFrom: null },
  { classId: "cW", className: "수요반", dayOfWeek: "Wed", startTime: "17:00", resumeFrom: null },
];
const planOf = (input) => rules.planParentPeriod({ classes: MON_WED, classDatesForMonth: calendar(), existing: new Set(), now: { ymd: "2026-11-15", hm: "10:00" }, ...input });

// ═════════════════════════════════════════════════════════════════════════
// ① 기간 — 한도 4주
// ═════════════════════════════════════════════════════════════════════════
test("기간: 시작일 포함 28일까지 — 28일째 통과·29일째 «휴원 안내», 월말·연말·윤년 경계", () => {
  const range = (startYmd, endYmd, todayYmd = startYmd) => rules.resolveParentPeriodRange({ startYmd, endYmd, todayYmd });
  assert.equal(rules.PARENT_PERIOD_MAX_DAYS, 28);
  assert.deepEqual(range("2026-11-16", "2026-12-13"), { ok: true, range: { startYmd: "2026-11-16", endYmd: "2026-12-13", openEnded: false } });
  assert.deepEqual(range("2026-11-16", "2026-12-14"), { ok: false, code: "PERIOD_TOO_LONG" });
  assert.deepEqual(range("2026-11-16", "2026-11-16"), { ok: true, range: { startYmd: "2026-11-16", endYmd: "2026-11-16", openEnded: false } }, "하루짜리도 된다");
  // 연말을 넘는 기간: 12/20 + 27일 = 1/16
  assert.equal(range("2026-12-20", "2027-01-16").ok, true);
  assert.deepEqual(range("2026-12-20", "2027-01-17"), { ok: false, code: "PERIOD_TOO_LONG" });
  // 윤년 2월(2028-02-29 가 있다): 2/10 + 27일 = 3/8, 평년은 3/9
  assert.equal(range("2028-02-10", "2028-03-08").ok, true);
  assert.equal(range("2028-02-10", "2028-03-09").code, "PERIOD_TOO_LONG");
  assert.equal(range("2027-02-10", "2027-03-09").ok, true);
  // 끝일 «아직 몰라요» = 4주째 날까지
  assert.deepEqual(range("2026-11-16", ""), { ok: true, range: { startYmd: "2026-11-16", endYmd: "2026-12-13", openEnded: true } });
  assert.deepEqual(range("2026-12-20", null).range, { startYmd: "2026-12-20", endYmd: "2027-01-16", openEnded: true });
});

test("기간: 끝일도 «오늘부터 4주 안» — 뒤늦게 시작해 8주 앞까지 알릴 수 없다(하루 알리기와 같은 범위)", () => {
  const range = (startYmd, endYmd) => rules.resolveParentPeriodRange({ startYmd, endYmd, todayYmd: "2026-11-15" });
  // 오늘 11/15 → 알릴 수 있는 마지막 날 12/12
  assert.equal(range("2026-12-01", "2026-12-12").ok, true);
  assert.deepEqual(range("2026-12-01", "2026-12-13"), { ok: false, code: "PERIOD_TOO_LONG" }, "시작일 기준 4주(12/28)가 아니라 오늘 기준");
  assert.deepEqual(range("2026-12-01", "").range, { startYmd: "2026-12-01", endYmd: "2026-12-12", openEnded: true }, "끝일 미정도 오늘 +27일까지만");
  assert.deepEqual(range("2026-12-12", null).range, { startYmd: "2026-12-12", endYmd: "2026-12-12", openEnded: true });
  // 화면의 날짜 선택 범위도 같은 끝(오늘 +27일)
  const panel = read("src/app/mypage/regular-absence/PeriodAbsencePanel.tsx");
  assert.match(panel, /const maxStart = useMemo\(\(\) => addDaysKst\(today, PARENT_PERIOD_MAX_DAYS - 1\), \[today\]\);\s+const maxEnd = maxStart;/);
});

test("기간: 시작일은 오늘부터 4주 안, 끝일은 시작일 이후, 날짜 형식", () => {
  const range = (startYmd, endYmd) => rules.resolveParentPeriodRange({ startYmd, endYmd, todayYmd: "2026-11-15" });
  assert.equal(range("2026-11-14", "2026-11-20").code, "PERIOD_START_PAST");
  assert.equal(range("2026-11-15", "2026-11-20").ok, true, "오늘부터");
  assert.equal(range("2026-12-12", "2026-12-12").ok, true, "오늘 +27일(시작·끝 모두 이 날까지)");
  assert.equal(range("2026-12-12", "2026-12-13").code, "PERIOD_TOO_LONG");
  assert.equal(range("2026-12-13", "2026-12-20").code, "PERIOD_START_TOO_FAR");
  assert.equal(range("2026-11-20", "2026-11-19").code, "PERIOD_END_BEFORE_START");
  for (const bad of ["", "2026-13-01", "11/20", null, 20261120]) assert.equal(range(bad, "2026-11-20").code, "PERIOD_INVALID_DATE", String(bad));
  assert.equal(range("2026-11-20", "2026-02-30").code, "PERIOD_INVALID_DATE");
});

// ═════════════════════════════════════════════════════════════════════════
// ② 수업일 계산 — 관리자 기간 결석과 같은 함수(휴무일 기준 한 곳)
// ═════════════════════════════════════════════════════════════════════════
test("수업일: 그 사이 반 요일만, 날짜순 — «11/16(월) · 11/18(수) · 11/23(월) 3회»", () => {
  const p = planOf({ range: { startYmd: "2026-11-16", endYmd: "2026-11-24" } });
  assert.deepEqual(p.items.map((i) => [i.date, i.className]), [["2026-11-16", "월요반"], ["2026-11-18", "수요반"], ["2026-11-23", "월요반"]]);
  assert.equal(rules.periodDatesLabel(p.items), "11/16(월) · 11/18(수) · 11/23(월) 3회");
  assert.deepEqual(p.skipped, { already: 0, closed: 0, holiday: 0 });
  assert.equal(rules.periodSkippedNote(p), null);
  assert.equal(rules.periodDatesLabel([]), "");
  // 수업일 계산은 관리자 기간 결석과 같은 함수를 쓴다
  assert.match(read("src/lib/regular/parentAbsencePeriodRules.ts"), /const plan = planAbsencePeriodDates\(\{/);
});

test("수업일: 연간일정 휴무일·이미 알린 날·마감 지난 오늘 수업은 빼고 한 줄로 알린다", () => {
  const p = rules.planParentPeriod({
    classes: MON_WED,
    range: { startYmd: "2026-11-16", endYmd: "2026-11-30" },
    classDatesForMonth: calendar({ holidays: ["2026-11-18"] }), // 수요일 하루 휴무
    existing: new Set(["cM|2026-11-23"]),                        // 11/23 월요반은 이미 알렸다
    now: { ymd: "2026-11-16", hm: "17:01" },                     // 오늘 18:00 수업 — 59분 전(마감 지남)
  });
  assert.deepEqual(p.items.map((i) => i.date), ["2026-11-25", "2026-11-30"]);
  assert.deepEqual(p.skipped, { already: 1, closed: 1, holiday: 1 });
  assert.equal(rules.periodSkippedNote(p), "휴무일 1회 · 이미 알린 날 1회 · 마감 지난 오늘 수업 1회는 뺐어요.");
  // 정확히 1시간 전(17:00)은 아직 알릴 수 있다
  const open = planOf({ range: { startYmd: "2026-11-16", endYmd: "2026-11-16" }, now: { ymd: "2026-11-16", hm: "17:00" } });
  assert.deepEqual(open.items.map((i) => i.date), ["2026-11-16"]);
});

test("수업일: 월말·연말을 넘는 기간과 연간 일정이 아직 없는 달", () => {
  // 12/28(월)~1/6(수): 12/28·12/30·1/4·1/6
  const yearEnd = planOf({ range: { startYmd: "2026-12-28", endYmd: "2027-01-06" }, now: { ymd: "2026-12-20", hm: "10:00" } });
  assert.deepEqual(yearEnd.items.map((i) => i.date), ["2026-12-28", "2026-12-30", "2027-01-04", "2027-01-06"]);
  // 1월 일정이 아직 없으면 추측하지 않고 12월까지만 — 그 사실을 알린다
  const missing = planOf({ range: { startYmd: "2026-12-28", endYmd: "2027-01-06" }, classDatesForMonth: calendar({ missing: ["2027-01"] }), now: { ymd: "2026-12-20", hm: "10:00" } });
  assert.deepEqual(missing.items.map((i) => i.date), ["2026-12-28", "2026-12-30"]);
  assert.equal(missing.missingMonth, "2027-01");
  assert.equal(rules.periodSkippedNote(missing), "1월 일정이 아직 없어 그 전까지만 알려요.");
  assert.equal(missing.skipped.holiday, 0, "일정이 없는 달의 날을 «휴무일»로 세지 않는다");
});

test("수업일: 복귀 예정 반은 복귀일 이후 수업만(그 전은 아직 휴원)", () => {
  const p = rules.planParentPeriod({
    classes: [{ ...MON_WED[0], resumeFrom: "2026-11-23" }, MON_WED[1]],
    range: { startYmd: "2026-11-16", endYmd: "2026-11-25" },
    classDatesForMonth: calendar(), existing: new Set(), now: { ymd: "2026-11-15", hm: "10:00" },
  });
  assert.deepEqual(p.items.map((i) => `${i.date}:${i.classId}`), ["2026-11-18:cW", "2026-11-23:cM", "2026-11-25:cW"]);
  assert.equal(p.skipped.holiday, 0, "복귀일 전 월요일은 휴무일이 아니라 대상이 아닌 날이다");
});

// ═════════════════════════════════════════════════════════════════════════
// ③ 복귀했어요·끝나기 전 안내
// ═════════════════════════════════════════════════════════════════════════
test("복귀했어요: 복귀일은 오늘부터 기간 끝 다음 날까지 — 시작 전에 접으면 «취소», 지난 결석이 남으면 «복귀 처리»", () => {
  const ret = (returnYmd, todayYmd = "2026-11-20") => rules.resolveParentPeriodReturn({ startYmd: "2026-11-16", endYmd: "2026-11-30", returnYmd, todayYmd });
  assert.deepEqual(ret("2026-11-23"), { ok: true, fromYmd: "2026-11-23", outcome: "ENDED" });
  assert.deepEqual(ret("2026-11-20"), { ok: true, fromYmd: "2026-11-20", outcome: "ENDED" }, "오늘 복귀");
  assert.deepEqual(ret("2026-12-01"), { ok: true, fromYmd: "2026-12-01", outcome: "ENDED" }, "끝일 다음 날 = 예정대로 복귀");
  assert.equal(ret("2026-12-02").code, "PERIOD_RETURN_AFTER_END");
  assert.equal(ret("2026-11-19").code, "PERIOD_RETURN_PAST");
  assert.equal(ret("").code, "PERIOD_INVALID_DATE");
  // 시작일 전·당일에 접으면 남는 결석이 없다 → 취소
  assert.deepEqual(ret("2026-11-15", "2026-11-15"), { ok: true, fromYmd: "2026-11-15", outcome: "CANCELLED" });
  assert.deepEqual(ret("2026-11-16", "2026-11-16"), { ok: true, fromYmd: "2026-11-16", outcome: "CANCELLED" });
});

test("끝나기 전 안내: «아직 몰라요» 기간만, 끝나기 3일 전부터 마지막 날까지, 한 번만", () => {
  const base = { openEnded: true, status: "ACTIVE", reminderSent: false, endYmd: "2026-12-13" };
  const due = (todayYmd, extra = {}) => rules.shouldRemindOpenEnded({ ...base, ...extra, todayYmd });
  assert.equal(rules.PARENT_PERIOD_REMIND_DAYS_BEFORE, 3);
  assert.equal(due("2026-12-09"), false, "4일 전");
  assert.equal(due("2026-12-10"), true, "3일 전");
  assert.equal(due("2026-12-13"), true, "마지막 날");
  assert.equal(due("2026-12-14"), false, "지난 뒤에는 보내지 않는다");
  assert.equal(due("2026-12-10", { reminderSent: true }), false);
  assert.equal(due("2026-12-10", { openEnded: false }), false, "끝일을 정한 기간은 안내하지 않는다");
  assert.equal(due("2026-12-10", { status: "ENDED" }), false);
  // 연말을 넘는 기간
  assert.equal(due("2026-12-30", { endYmd: "2027-01-02" }), true);
  // cron SQL 도 같은 조건(DB 시계의 KST 날짜 · «보냈다» 표시를 먼저 찍는다)
  const service = read("src/lib/regular/parent-absence-period.ts");
  const claim = service.slice(service.indexOf("export async function claimOpenEndedPeriodReminders"), service.indexOf("export async function loadParentAbsenceScreen"));
  assert.match(claim, /SET "reminderSentAt" = now\(\)[\s\S]*p\."openEnded" = true AND p\.status = 'ACTIVE' AND p\."reminderSentAt" IS NULL/);
  assert.match(claim, /p\."returnDate" - 1 >= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date\s+AND p\."returnDate" - 1 <= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date \+ \$\{PARENT_PERIOD_REMIND_DAYS_BEFORE\}/);
  assert.doesNotMatch(claim, /AT TIME ZONE 'UTC'/, "returnDate 는 date 칼럼, now() 는 timestamptz — 변환은 한 번");
});

test("학부모 화면 묶음: 같은 기간의 검토는 상태별 한 줄 — «11/16(월)~11/30(월) 3회», 하루 결석은 그대로", () => {
  const row = (absenceId, date, extra = {}) => ({ absenceId, periodId: "per1", status: "PENDING", date, dateLabel: plan.shortDateLabel(date), className: "월요반", ...extra });
  const out = carry.collapseReviewsByPeriod([
    row("d3", "2026-11-30"), row("d2", "2026-11-23", { status: "APPROVED" }), row("d1", "2026-11-16"),
    row("single", "2026-11-11", { periodId: null }),
  ]);
  assert.deepEqual(out.map((r) => [r.absenceId, r.status, r.dateLabel, r.count]), [
    ["d1", "PENDING", "11/16(월)~11/30(월) 2회", 2], // 대표 = 가장 이른 결석(사진을 여기에 올린다)
    ["d2", "APPROVED", "11/23(월)", 1],
    ["single", "PENDING", "11/11(수)", 1],
  ]);
});

// ═════════════════════════════════════════════════════════════════════════
// ④ 저장·연결부(소스 계약)
// ═════════════════════════════════════════════════════════════════════════
test("마이그레이션: 기존 표에 칸 3개만(멱등·timestamptz·되돌림 주석), 스키마 사본 갱신", () => {
  const sql = read("prisma/migrations/20261115100000_parent_absence_period/migration.sql");
  for (const column of [`"reportedByUserId" TEXT`, `"openEnded" BOOLEAN NOT NULL DEFAULT false`, `"reminderSentAt" TIMESTAMPTZ(6)`]) {
    assert.ok(sql.includes(`ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS ${column};`), column);
  }
  assert.doesNotMatch(sql, /CREATE TABLE|DROP TABLE(?! IF)|TIMESTAMP(?!TZ)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "RegularAbsencePeriod_reportedByUserId_idx"/);
  for (const column of ["reminderSentAt", "openEnded", "reportedByUserId"]) {
    assert.match(sql, new RegExp(`--\\s+ALTER TABLE public\\."RegularAbsencePeriod" DROP COLUMN IF EXISTS "${column}";`), `되돌림 주석: ${column}`);
  }
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model RegularAbsencePeriod {"), schema.indexOf("// 질병·부상 결석 «이월 검토»"));
  assert.match(model, /reportedByUserId String\?/);
  assert.match(model, /openEnded\s+Boolean\s+@default\(false\)/);
  assert.match(model, /reminderSentAt\s+DateTime\? @db\.Timestamptz\(6\)/);
});

test("날짜마다 «하루 알리기»와 같은 저장 함수 — 규칙을 둘로 만들지 않는다", () => {
  const service = read("src/lib/regular/parent-absence-period.ts");
  assert.match(service, /result = await saveReportedAbsenceInTx\(tx, \{\s*studentId, classId: item\.classId, date: item\.date, reason, reasonText, source: "PARENT", parentUserId,/);
  assert.doesNotMatch(service, /INSERT INTO "RegularAbsence"|INSERT INTO "MakeupCredit"|issueCreditForReportedAbsence|openIllnessReviewInTx/, "보강권·이월 검토 분기를 여기서 다시 쓰지 않는다");
  // 취소도 하루 취소와 같은 정리 함수
  assert.match(service, /await settleCreditOnAbsenceCancel\(tx, \{\s*actor: "PARENT",/);
  assert.match(service, /if \(reviewReady\) await closeIllnessReviewInTx\(tx, row\.id, \{ canceled: true \}\);/);
  // 하루 알리기도 같은 함수를 쓴다
  assert.match(read("src/lib/regular/parent-regular-absence.ts"), /prisma\.\$transaction\(\(tx\) => saveReportedAbsenceInTx\(tx, /);
  // 권한: 내 아이만(같은 조회·같은 조건), 닫기는 SQL 에 보호자 조건
  assert.match(service, /\(await listParentUsableClasses\(parentUserId\)\)\.filter\(\(row\) => row\.studentId === studentId\)/);
  assert.match(service, /if \(classes\.length === 0\) throw new Error\("NOT_OWNER"\);/);
  assert.match(service, /const access = await childAccessSql\("s", "\$1"\);/);
  assert.match(service, /WHERE \$\{access\} AND \$\{notMergedStudent\("s"\)\}\s+AND p\.id = \$2 AND p\."reportedByUserId" IS NOT NULL\s+FOR UPDATE OF p/);
  // 알리기는 화면이 보낸 날짜 목록을 쓰지 않고 서버가 다시 계산한다
  assert.match(service, /const prepared = await prepareParentPeriod\(parentUserId, input\);/);
});

test("API: 로그인한 학부모만, 오류는 한국어 문구 — 4주 초과는 «휴원 신청» 표시와 함께", () => {
  const route = read("src/app/api/mypage/regular-absence/period/route.ts");
  assert.equal(route.split("await parentOrNull()").length - 1, 2, "GET·POST 모두");
  assert.match(route, /requireVerifiedParent\(\)/);
  assert.match(route, /PERIOD_TOO_LONG: `오늘부터 \$\{WEEKS\}주가 넘으면 휴원 신청을 이용해 주세요\.`/);
  // 하루 만들기 횟수 제한: 글 + 그 자리 전화·문의 버튼
  assert.match(route, /PERIOD_DAILY_LIMIT: "오늘은 더 알릴 수 없어요\. 학원에 문의해 주세요\."/);
  assert.match(route, /needContact: code === "PERIOD_DAILY_LIMIT" \|\| undefined/);
  const panel = read("src/app/mypage/regular-absence/PeriodAbsencePanel.tsx");
  assert.match(panel, /\{problem\.needContact && contact\.phone && \(\s*<a href=\{`tel:\$\{contact\.phone\.replace\(\/\[\^0-9\+\]\/g, ""\)\}`\}/);
  assert.match(read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx"), /onChanged=\{onPeriodChanged\} contact=\{contact\} \/>/);
  assert.equal(rules.PARENT_PERIOD_DAILY_LIMIT, 5);
  assert.match(route, /tooLong: code === "PERIOD_TOO_LONG" \|\| undefined/);
  assert.match(route, /closeParentAbsencePeriod\(parent\.appUserId, \{ periodId: body\.periodId, returnDate: todayKst\(\) \}\)/, "알림 취소 = 오늘부터(오늘은 KST 공용 모듈)");
  assert.doesNotMatch(route, /toISOString\(\)|new Date\(\)\.get/);
  // 건강 정보 — 오류 이름만 기록
  for (const line of route.split("\n").filter((l) => l.includes("console.error("))) assert.match(line, /error instanceof Error \? error\.name : ""\)/);
});

test("알림: 원장·코치·기사는 기간당 1회, 재조정은 날짜마다 다시 보내지 않는다, 고객 발송(문자·알림톡) 없음", () => {
  const service = read("src/lib/regular/parent-absence-period.ts");
  assert.equal(service.split("await notifyOperationalStaff(").length - 1, 1);
  assert.match(service, /stableEventKey: `regular-absence-period:\$\{input\.periodId\}:\$\{input\.kind\}:\$\{input\.version\}`/);
  assert.match(service, /includeCoach: true,\s+includeDriver: true,/);
  // 재조정: 학부모 기간 결석 행(note 머리말)은 건너뛴다 — 관리자 기간 머리말과 다른 글자
  const reconcile = read("src/lib/operational-notification-reconciliation.ts");
  assert.match(reconcile, /AND NOT \(COALESCE\(ra\.note,''\) LIKE \$4\)/);
  assert.match(reconcile, /`\$\{PARENT_PERIOD_NOTE_PREFIX\} · %`,/);
  assert.equal(rules.PARENT_PERIOD_NOTE_PREFIX, "여러 날 결석");
  assert.notEqual(rules.PARENT_PERIOD_NOTE_PREFIX, plan.PERIOD_ABSENCE_NOTE_PREFIX);
  assert.ok(!rules.parentPeriodNote("2026-11-16", "2026-11-30").startsWith(`${plan.PERIOD_ABSENCE_NOTE_PREFIX} · `), "관리자 기간 결석의 취소·재조정 조건(LIKE '기간 결석 · %')에 걸리지 않는다");
  assert.equal(rules.parentPeriodNote("2026-11-16", "2026-11-30"), "여러 날 결석 · 11/16(월)~11/30(월)");
  // 끝나기 전 안내 = 앱 안 알림 함수만
  const cron = read("src/app/api/cron/absence-periods/route.ts");
  assert.match(cron, /for \(const item of await claimOpenEndedPeriodReminders\(\)\) \{\s*try \{\s*await notifyParentsOfStudents\(/);
  for (const path of ["src/lib/regular/parent-absence-period.ts", "src/app/api/cron/absence-periods/route.ts", "src/app/api/mypage/regular-absence/period/route.ts"]) {
    assert.doesNotMatch(read(path), /sendParentSms|sendTrackedSms|sendFailClosedTrackedSms|alimtalk|sendSms/i, path);
  }
});

test("관리자 기간 결석은 그대로 — 학부모 기간은 자동 연장·복귀 처리·등록 취소 대상에서 빠진다(칸이 없으면 예전 그대로)", () => {
  const service = read("src/lib/regular/absence-period-service.ts");
  // 관리자 등록은 여전히 CONFIRMED·학부모 표시 없음(보강권·알림 없음)
  assert.match(service, /VALUES \(\$1,\$2,\$3::date,\$4,'CONFIRMED',\$5,NULL,\$6,\$7\)/);
  assert.doesNotMatch(service, /issueCreditForReportedAbsence|notifyOperationalStaff|saveReportedAbsenceInTx/);
  // 자동 연장 대상에서 학부모 기간 제외 — 칸이 있을 때만 조건을 붙인다
  assert.match(service, /const adminOnly = \(await parentPeriodColumnsReady\(db\)\) \? `AND "reportedByUserId" IS NULL` : "";/);
  assert.match(service, /if \(period\.status !== "ACTIVE" \|\| await isParentPeriod\(db, periodId\)\) return \{ periodId, studentId: period\.studentId, created: 0 \};/);
  assert.equal(service.split("if (await isParentPeriod(db, periodId)) throw new Error(PARENT_PERIOD_ADMIN_MESSAGE);").length - 1, 2, "복귀 처리·등록 취소");
  assert.match(service, /column_name IN \('reportedByUserId', 'openEnded', 'reminderSentAt'\)/);
  // 학생 상세 카드: «학부모 신고» 표시 + 기간째 처리 버튼 숨김
  const panel = read("src/app/admin/students/[id]/AbsencePeriodPanel.tsx");
  assert.match(panel, /\{p\.parentReported && \(\s*<span[^>]*>학부모 신고<\/span>/);
  assert.match(panel, /\{p\.status !== "CANCELLED" && !p\.parentReported && \(/);
  // 신청함: 학부모가 여러 날로 알린 결석도 «결석» 확인 대상(관리자 기간 결석 행은 여전히 제외)
  assert.match(read("src/lib/requests/admin-inbox.ts"), /where: `\(x\."periodId" IS NULL OR x\."reportedByUserId" IS NOT NULL\)`,/);
});

test("관리자 입구: 결석 관리 위쪽 버튼·학생 목록 ⚡ 에서 기존 등록 창을 그대로 연다", () => {
  const quick = read("src/components/admin/AbsencePeriodQuickCreate.tsx");
  assert.match(quick, /import \{ CreatePeriodModal, type AbsencePeriodClassOption \} from "@\/app\/admin\/students\/\[id\]\/AbsencePeriodPanel";/);
  assert.match(quick, /<CreatePeriodModal\s+studentId=\{picked\.id\}/);
  assert.match(quick, /fetch\("\/api\/admin\/student-options"/);
  assert.match(read("src/app/admin/students/[id]/AbsencePeriodPanel.tsx"), /export function CreatePeriodModal\(/);
  const absence = read("src/app/admin/absence/RegularAbsenceAdminClient.tsx");
  assert.match(absence, /onClick=\{\(\) => setPeriodCreateOpen\(true\)\} className="academy-button-secondary whitespace-nowrap">\s*기간 결석 등록\s*<\/button>/);
  assert.match(absence, /\{periodCreateOpen && \(\s*<AbsencePeriodQuickCreate/);
  const students = read("src/app/admin/students/StudentManagementClient.tsx");
  assert.match(students, /key: "absence-period",\s+label: "기간 결석 등록",[\s\S]{0,80}onSelect: \(\) => setAbsencePeriodFor\(s\.id\),/);
  assert.match(students, /<AbsencePeriodQuickCreate\s+presetStudentId=\{absencePeriodFor\}/);
  // 신청함: 같은 기간 n건 함께 승인 — 건마다 [이월 승인]과 같은 함수, 대상은 서버가 다시 고른다
  const action = read("src/app/actions/illness-carry-admin.ts");
  const bulk = action.slice(action.indexOf("export async function approveIllnessCarryPeriodAction"), action.indexOf("/** [보강권으로]"));
  assert.match(bulk, /const admin = await requireAdmin\(\);/);
  assert.match(bulk, /const targets = \[\.\.\.\(detail\.status === "PENDING" && !detail\.blocker \? \[absenceId\] : \[\]\), \.\.\.detail\.periodPeerIds\];/);
  assert.match(bulk, /await approveIllnessCarry\(prisma, \{ absenceId: id, evidenceConfirmed: true \}, admin\.appUserId, writesEnabled\(\), calendar\)/);
  assert.equal(bulk.split("await notifyParentsOfStudents(").length - 1, 1, "학부모 알림은 묶어서 1회");
  assert.match(read("src/lib/regular/illness-carry-admin.ts"), /pa\.reason = \$2 AND pa\.status <> 'CANCELLED' AND pa\.date <= \$3::date\s+AND COALESCE\(pr\.status, 'PENDING'\) = 'PENDING'/);
  assert.match(read("src/app/admin/inbox/IllnessCarryInboxDetail.tsx"), /같은 기간 \{detail\.periodPeerIds\.length \+ \(detail\.blocker \? 0 : 1\)\}건 함께 승인/);
});

test("학부모 화면: 맨 위 «하루 / 여러 날», 미리보기는 서버 계산, 4주 초과는 휴원 신청 버튼, 복귀했어요·알림 취소 — 글자만", () => {
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /\{periodAvailable && \(\s*<div role="group" aria-label="알리는 방법"/);
  assert.match(client, /\[\["day", "하루"\], \["period", "여러 날"\]\] as const/);
  assert.match(client, /\{mode === "period" \? \(\s*<PeriodAbsencePanel kids=\{periodKids\}/);
  assert.match(client, /<ActivePeriodList periods=\{periods\} onChanged=\{onPeriodChanged\} \/>/);
  const panel = read("src/app/mypage/regular-absence/PeriodAbsencePanel.tsx");
  assert.match(panel, /fetch\(`\/api\/mypage\/regular-absence\/period\?\$\{query\}`, \{ cache: "no-store" \}\)/);
  assert.match(panel, /\{problem\.tooLong && <Link href="\/mypage\/enrollment-change" className="academy-button-secondary shrink-0">휴원 신청<\/Link>\}/);
  assert.match(panel, /끝일은 아직 몰라요/);
  assert.match(panel, /복귀했어요/);
  assert.match(panel, /label="알림 취소"/);
  assert.match(panel, /`\$\{preview\.count\}회 알리기`/);
  // 수업일을 화면에서 계산하지 않는다(서버가 준 글자만) · 날짜는 KST 공용 모듈
  assert.doesNotMatch(panel, /getDay\(\)|toISOString\(\)|new Date\(/);
  assert.match(panel, /import \{ addDaysKst, todayKst \} from "@\/lib\/datetime\/kst";/);
  // 아이콘·이모지 없이 글자, 굵기 4단계, 색은 토큰, 화면 용어는 «알리기»(신고 아님)
  for (const source of [panel, read("src/components/admin/AbsencePeriodQuickCreate.tsx")]) {
    assert.doesNotMatch(source, /material-symbols|lucide|font-(extrabold|black)|#[0-9a-fA-F]{6}\b/);
  }
  assert.doesNotMatch(panel.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("{/*")).join("\n"), /신고/);
});
