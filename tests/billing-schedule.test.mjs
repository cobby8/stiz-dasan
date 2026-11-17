// 월 청구일(전달 «N월 개강» + 14일)·청구일 자동 초안 규칙 실행 테스트(2026-11-17 원장 결정)
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const url = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`;
const kstUrl = url(await readFile("src/lib/datetime/kst.ts", "utf8"));
const classScheduleUrl = url(await readFile("src/lib/classSchedule.ts", "utf8"));
// 청구 검토표 공통 계약(자동 초안 판정·고정 글자) — kst 만 바꿔 끼운다
const modelUrl = url((await readFile("src/lib/billing/workbench.ts", "utf8")).replace('from "@/lib/datetime/kst"', `from "${kstUrl}"`));
const { WORKBENCH_GENERIC_REVIEW_REASON } = await import(modelUrl);
const source = (await readFile("src/lib/billing/billing-schedule.ts", "utf8"))
  .replace('from "@/lib/datetime/kst"', `from "${kstUrl}"`)
  .replace('from "./workbench"', `from "${modelUrl}"`)
  .replace('from "@/lib/classSchedule"', `from "${classScheduleUrl}"`);
const { billingDayFor, billingMonthsDueOn, billingDayNotice, openMonthOf, planAutoDraft, autoDraftRequestId, AUTO_DRAFT_ACTOR, defaultWorkbenchMonth, billingMonthsToTry, undeterminedBillingMonth } = await import(url(source));

// 실제 학원 캘린더 모양: 종일 일정은 «그 날짜의 UTC 자정» ISO 문자열로 들어온다
const ev = (title, ymd) => ({ title, date: `${ymd}T00:00:00.000Z` });
const calendar = [
  ev("11월 개강", "2026-11-03"),
  ev("12월 개강", "2026-12-01"),
  ev("1월 개강", "2027-01-04"),
  ev("겨울방학특강 1차 개강", "2027-01-11"),
  ev("2월 개강", "2027-02-01"),
  ev("3월 개강", "2027-03-02"),
  ev("4월 개강", "2027-03-30"),
  ev("12월 1주차", "2026-12-01"),
];

test("원장 예시 5개: 청구일 = 전달 개강 + 14일", () => {
  const expected = { "2026-12": "2026-11-17", "2027-01": "2026-12-15", "2027-02": "2027-01-18", "2027-03": "2027-02-15", "2027-04": "2027-03-16" };
  for (const [month, date] of Object.entries(expected)) {
    const day = billingDayFor(calendar, month);
    assert.equal(day.status, "OK", month);
    assert.equal(day.billingDate, date, month);
  }
  // 4월 개강이 3/30 에 있어도 «4월 개강»이다 → 5월 청구 = 4/13
  assert.equal(billingDayFor(calendar, "2027-05").billingDate, "2027-04-13");
});

test("연말 경계: 12월 개강 → 다음 해 1월 청구, 12월에 적힌 «1월 개강»은 다음 해 1월", () => {
  const day = billingDayFor(calendar, "2027-01");
  assert.deepEqual(day, { status: "OK", billingMonth: "2027-01", billingDate: "2026-12-15", openMonth: "2026-12", openDate: "2026-12-01" });
  // 1월 개강이 12월 마지막 주(12/28)에 있으면 수강월은 다음 해 1월이다
  assert.deepEqual(openMonthOf(ev("1월 개강", "2026-12-28")), { openMonth: "2027-01", openDate: "2026-12-28" });
  assert.equal(billingDayFor([ev("1월 개강", "2026-12-28")], "2027-02").billingDate, "2027-01-11");
  // 12월 31일 + 14일 = 다음 해 1월 14일
  assert.equal(billingDayFor([ev("12월 개강", "2026-12-31")], "2027-01").billingDate, "2027-01-14");
});

test("개강 일정이 없으면 추정하지 않는다(NO_OPEN)", () => {
  assert.deepEqual(billingDayFor(calendar, "2026-11"), { status: "NO_OPEN", billingMonth: "2026-11", openMonth: "2026-10" });
  assert.equal(billingDayFor([], "2027-01").status, "NO_OPEN");
  assert.equal(billingDayNotice(calendar, "2026-11"), "연간계획표에 10월 개강 일정이 없어 청구일을 정할 수 없습니다.");
});

test("특강·방학 개강은 월 개강이 아니다", () => {
  assert.equal(openMonthOf(ev("겨울방학특강 1차 개강", "2027-01-11")), null);
  assert.equal(openMonthOf(ev("겨울방학특강 1월 개강", "2027-01-11")), null);
  assert.equal(openMonthOf(ev("여름방학 7월 개강", "2027-07-20")), null);
  assert.equal(billingDayFor([ev("겨울방학특강 1월 개강", "2027-01-11")], "2027-02").status, "NO_OPEN");
});

test("같은 달 개강 중복: 같은 날짜면 하나로, 다른 날짜면 정하지 않는다(CONFLICT)", () => {
  // 구글 캘린더와 AnnualEvent 에 같은 일정이 둘 다 있는 경우
  const dup = [...calendar, ev("12월 개강", "2026-12-01")];
  assert.equal(billingDayFor(dup, "2027-01").billingDate, "2026-12-15");
  const conflict = [...calendar, ev("12월 개강일", "2026-12-08")];
  const day = billingDayFor(conflict, "2027-01");
  assert.deepEqual(day, { status: "CONFLICT", billingMonth: "2027-01", openMonth: "2026-12", openDates: ["2026-12-01", "2026-12-08"] });
  assert.match(billingDayNotice(conflict, "2027-01"), /12월 개강 일정이 2개\(12\/1\(화\)·12\/8\(화\)\)라 청구일을 정할 수 없습니다/);
  // 중복된 달은 «오늘이 청구일» 판정에서도 빠진다
  assert.deepEqual(billingMonthsDueOn(conflict, "2026-12-15"), []);
});

test("오늘이 어느 달 청구일인지(KST 날짜 문자열)", () => {
  assert.deepEqual(billingMonthsDueOn(calendar, "2026-11-17"), ["2026-12"]);
  assert.deepEqual(billingMonthsDueOn(calendar, "2026-12-15"), ["2027-01"]);
  assert.deepEqual(billingMonthsDueOn(calendar, "2027-01-18"), ["2027-02"]);
  assert.deepEqual(billingMonthsDueOn(calendar, "2027-02-15"), ["2027-03"]);
  assert.deepEqual(billingMonthsDueOn(calendar, "2027-03-16"), ["2027-04"]);
  assert.deepEqual(billingMonthsDueOn(calendar, "2026-12-14"), []);
  assert.deepEqual(billingMonthsDueOn(calendar, "2026-12-16"), []);
  assert.deepEqual(billingMonthsDueOn(calendar, "잘못된 날짜"), []);
});

test("시각이 있는 일정은 한국 날짜로 읽는다(UTC 전날 15시 = KST 자정)", () => {
  assert.deepEqual(openMonthOf({ title: "12월 개강", date: "2026-11-30T15:00:00.000Z" }), { openMonth: "2026-12", openDate: "2026-12-01" });
});

test("화면 안내 한 줄", () => {
  assert.equal(billingDayNotice(calendar, "2027-01"), "이 달 청구일: 12/15(화) — 12월 개강 12/1(화) + 14일");
  assert.equal(billingDayNotice(calendar, "2026-12"), "이 달 청구일: 11/17(화) — 11월 개강 11/3(화) + 14일");
});

// ── 자동 초안 행 고르기 ──
const row = (over = {}) => ({ id: "s1:c1", status: "READY", draftStatus: null, blockingReasons: [], reviewReasons: [], version: 0,
  baseAmount: 100000, discountAmount: 10000, prorationAmount: 0, carryAmount: 0, shuttleAmount: 20000,
  periodStart: "2027-01-04", periodEnd: "2027-01-25", ...over });

test("자동 초안: 검토 사유 없음·일반 문구 하나뿐인 행만 제안값 그대로 저장, 구체 사유·보류·이미 있음·제외는 손대지 않는다", () => {
  const plan = planAutoDraft([
    row(),
    row({ id: "s2:c1", status: "REVIEW", reviewReasons: [WORKBENCH_GENERIC_REVIEW_REASON, "셔틀 명단 있음 · 다른 청구에 셔틀비가 있을 수 있어 제안하지 않음. 셔틀비가 빠지거나 두 번 들어가지 않았는지 확인해 주세요."] }),
    row({ id: "s9:c1", status: "REVIEW", reviewReasons: [WORKBENCH_GENERIC_REVIEW_REASON] }),
    // 일반 문구뿐이어도 기간 조정(3회 달 차감)·이월 차감이 있으면 사람이 본다(검수 B-2)
    row({ id: "s10:c1", status: "REVIEW", reviewReasons: [WORKBENCH_GENERIC_REVIEW_REASON], prorationAmount: 22500 }),
    row({ id: "s11:c1", status: "REVIEW", reviewReasons: [WORKBENCH_GENERIC_REVIEW_REASON], carryAmount: 25000 }),
    row({ id: "s3:c1", status: "REVIEW", hold: true, blockingReasons: ["보류"] }),
    row({ id: "s4:c1", draftStatus: "DRAFT", version: 1 }),
    row({ id: "s5:c1", status: "REVIEW", draftStatus: "CONFIRMED", version: 2 }),
    row({ id: "s6:c1", status: "ISSUED", draftStatus: "ISSUED" }),
    row({ id: "s7:c1", status: "EXCLUDED" }),
    row({ id: "s8:c1", status: "READY", blockingReasons: ["차단"] }),
  ], "2026-12-15");
  assert.deepEqual(plan.saveRows.map((r) => r.id), ["s1:c1", "s9:c1"], "일반 문구 하나뿐인 행도 자동 초안(2026-11-17 PM 결정)");
  assert.deepEqual(plan.saveRows[0], { id: "s1:c1", expectedVersion: 0, baseAmount: 100000, discountAmount: 10000, prorationAmount: 0, carryAmount: 0, shuttleAmount: 20000,
    reason: "청구일 자동 초안(2026-12-15) — 제안값 그대로 저장, 원장 확인 전", periodStart: "2027-01-04", periodEnd: "2027-01-25" });
  assert.equal(plan.review, 4);
  assert.equal(plan.hold, 1);
  assert.equal(plan.already, 3);
  assert.equal(plan.excluded, 1);
});

test("자동 초안: 두 번 돌아도 같다(저장 뒤엔 draftStatus 가 있어 다시 고르지 않음) · 요청 번호는 원본 지문으로 고정", () => {
  assert.equal(planAutoDraft([row({ draftStatus: "DRAFT", version: 1 })], "2026-12-15").saveRows.length, 0);
  const id = autoDraftRequestId("2027-01", "a".repeat(64));
  assert.equal(id, autoDraftRequestId("2027-01", "a".repeat(64)));
  assert.match(id, /^[a-zA-Z0-9_-]{8,100}$/, "validateWorkbenchCommand 의 요청 번호 규칙");
  assert.match(AUTO_DRAFT_ACTOR, /^SYSTEM_CRON/);
  // 기간이 없는 행은 기간 칸을 보내지 않는다
  assert.equal("periodStart" in planAutoDraft([row({ periodStart: null, periodEnd: null })], "2026-12-15").saveRows[0], false);
});

test("청구 준비 기본 달: 다음 달 청구일 이후면 다음 달, 아니면 이번 달(개강 일정 없으면 이번 달)", () => {
  assert.equal(defaultWorkbenchMonth(calendar, "2026-11-16"), "2026-11");
  assert.equal(defaultWorkbenchMonth(calendar, "2026-11-17"), "2026-12", "12월 청구일 11/17 당일부터 12월");
  assert.equal(defaultWorkbenchMonth(calendar, "2026-11-30"), "2026-12");
  assert.equal(defaultWorkbenchMonth(calendar, "2026-12-14"), "2026-12");
  assert.equal(defaultWorkbenchMonth(calendar, "2026-12-15"), "2027-01", "연말 경계");
  assert.equal(defaultWorkbenchMonth([], "2026-12-20"), "2026-12");
});

test("cron 경로는 확정·발행·학부모 발송을 부르지 않고, 쓰기 스위치와 vercel 등록을 지킨다", async () => {
  const route = await readFile("src/app/api/cron/billing-draft/route.ts", "utf8");
  assert.match(route, /action: "SAVE"/);
  assert.doesNotMatch(route, /"CONFIRM"|"ISSUE"|sendInvoiceLinksForMonth|notifyParents|sendParentSms|notifyAdmins\(/);
  assert.match(route, /STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true"/);
  assert.match(route, /export const GET = withCronAlert\("billing-draft", /);
  const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
  const entry = vercel.crons.find((c) => c.path === "/api/cron/billing-draft");
  assert.equal(entry?.schedule, "25 15 * * *");
  assert.equal(vercel.crons.filter((c) => c.schedule === "25 15 * * *").length, 1);
});

test("청구일 계산의 개강 판정은 제목이 «N월 개강(일)»으로 끝날 때만(검수 B-6)", () => {
  assert.equal(openMonthOf(ev("12월 개강 준비 회의", "2026-11-20")), null);
  assert.equal(openMonthOf(ev("12월 개강 안내 문자 발송", "2026-11-25")), null);
  assert.deepEqual(openMonthOf(ev("STIZ 12월 개강", "2026-12-01")), { openMonth: "2026-12", openDate: "2026-12-01" });
  assert.deepEqual(openMonthOf(ev("12월 개강일", "2026-12-01")), { openMonth: "2026-12", openDate: "2026-12-01" });
  assert.deepEqual(openMonthOf(ev(" 12월개강 ", "2026-12-01")), { openMonth: "2026-12", openDate: "2026-12-01" });
  // 회의 일정이 섞여도 청구일은 그대로(중복으로 보지 않는다)
  assert.equal(billingDayFor([...calendar, ev("12월 개강 준비 회의", "2026-11-20")], "2027-01").billingDate, "2026-12-15");
});

test("따라잡기: 청구일 당일 + 1~3일까지만 시도 대상(검수 B-4)", () => {
  assert.deepEqual(billingMonthsToTry(calendar, "2026-12-15"), [{ month: "2027-01", billingDate: "2026-12-15", catchUp: false }]);
  assert.deepEqual(billingMonthsToTry(calendar, "2026-12-18"), [{ month: "2027-01", billingDate: "2026-12-15", catchUp: true }]);
  assert.deepEqual(billingMonthsToTry(calendar, "2026-12-19"), []);
  assert.deepEqual(billingMonthsToTry(calendar, "2026-12-14"), []);
  // 연말 경계: 12/31 청구일 → 1/3 까지
  assert.deepEqual(billingMonthsToTry([ev("12월 개강", "2026-12-17")], "2027-01-03"), [{ month: "2027-01", billingDate: "2026-12-31", catchUp: true }]);
});

test("다음 달 청구일을 못 정하면 15일부터 알릴 달을 돌려준다(검수 B-4)", () => {
  assert.equal(undeterminedBillingMonth(calendar, "2026-12-20"), null, "12월 개강이 있어 1월 청구일이 정해짐");
  assert.equal(undeterminedBillingMonth([], "2026-12-14"), null, "15일 전에는 알리지 않는다");
  assert.deepEqual(undeterminedBillingMonth([], "2026-12-15"), { month: "2027-01", reason: "연간계획표에 12월 개강 일정이 없어 청구일을 정할 수 없습니다." });
});
