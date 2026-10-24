import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 반·요일 변경 / 휴원 / 퇴원 신청 → 원장 승인 → 적용일에 반영.
// 원장 결정(2026-08-09): 세 종류 모두 받는다 · 적용은 다음 달 1일 · 만석 반도 대기로 받는다.

const rulesSource = await readFile("src/lib/enrollment/changeRequestRules.ts", "utf8");
const transpiled = ts.transpileModule(rulesSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { nextMonthStart, validateChangeRequest, isYmd, CHANGE_KINDS } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const parentLib = await readFile("src/lib/enrollment/parent-change-request.ts", "utf8");
const adminLib = await readFile("src/lib/enrollment/admin-change-request.ts", "utf8");
const cron = await readFile("src/app/api/cron/enrollment-changes/route.ts", "utf8");
const vercel = JSON.parse(await readFile("vercel.json", "utf8"));

test("적용일은 언제나 다음 달 1일이다", () => {
  assert.equal(nextMonthStart("2026-08-09"), "2026-09-01");
  assert.equal(nextMonthStart("2026-08-31"), "2026-09-01");
  // 12월 → 다음 해 1월. 여기서 틀리면 한 해에 한 번 크게 터진다.
  assert.equal(nextMonthStart("2026-12-15"), "2027-01-01");
  assert.equal(nextMonthStart("2026-01-01"), "2026-02-01");
});

test("달력에 없는 날짜는 거른다", () => {
  assert.equal(isYmd("2026-02-30"), false);
  assert.equal(isYmd("2026-13-01"), false);
  assert.equal(isYmd("2026-2-1"), false);
  assert.equal(isYmd("2026-02-28"), true);
});

test("세 종류를 모두 받는다", () => {
  assert.deepEqual([...CHANGE_KINDS], ["CLASS_CHANGE", "PAUSE", "WITHDRAW"]);
});

test("반 변경은 옮길 반이 있어야 하고, 같은 반은 막는다", () => {
  const context = { currentClassId: "c1", effectiveFrom: "2026-09-01" };
  assert.equal(validateChangeRequest({ kind: "CLASS_CHANGE" }, context).error, "TO_CLASS_REQUIRED");
  // 같은 반을 고르면 아무것도 안 바뀌는데 원장은 승인 판단을 해야 한다.
  assert.equal(validateChangeRequest({ kind: "CLASS_CHANGE", toClassId: "c1" }, context).error, "SAME_CLASS");
  assert.equal(validateChangeRequest({ kind: "CLASS_CHANGE", toClassId: "c2" }, context).ok, true);
});

test("휴원·퇴원에 반이 붙어 오면 조용히 무시하지 않는다", () => {
  const context = { currentClassId: "c1", effectiveFrom: "2026-09-01" };
  for (const kind of ["PAUSE", "WITHDRAW"]) {
    assert.equal(validateChangeRequest({ kind, toClassId: "c2" }, context).error, "TO_CLASS_NOT_ALLOWED");
    assert.equal(validateChangeRequest({ kind }, context).ok, true);
  }
});

test("복귀일은 휴원 시작일보다 뒤여야 한다", () => {
  const context = { currentClassId: "c1", effectiveFrom: "2026-09-01" };
  assert.equal(validateChangeRequest({ kind: "PAUSE", resumeOn: "2026-08-20" }, context).error, "RESUME_BEFORE_START");
  assert.equal(validateChangeRequest({ kind: "PAUSE", resumeOn: "2026-09-01" }, context).error, "RESUME_BEFORE_START");
  assert.equal(validateChangeRequest({ kind: "PAUSE", resumeOn: "2026-11-01" }, context).ok, true);
});

test("엉뚱한 종류와 지나치게 긴 사유를 거른다", () => {
  const context = { currentClassId: "c1", effectiveFrom: "2026-09-01" };
  assert.equal(validateChangeRequest({ kind: "DELETE_ALL" }, context).error, "INVALID_KIND");
  assert.equal(validateChangeRequest({ kind: "PAUSE", reason: "가".repeat(501) }, context).error, "REASON_TOO_LONG");
});

test("적용일을 클라이언트가 마음대로 정하지 못한다", () => {
  // 학부모가 반 변경 시작일을 고를 수 있게 됐지만, 보낸 값을 그대로 쓰면
  // 이번 달로 앞당겨 **이미 청구된 달**의 반을 바꿀 수 있다.
  // 반드시 규칙 함수를 거쳐 검증된 값만 저장한다.
  assert.match(parentLib, /const resolved = resolveEffectiveFrom\(\{/);
  assert.match(parentLib, /const effectiveFrom = resolved\.effectiveFrom/);
  assert.doesNotMatch(parentLib, /effectiveFrom = (input|body)\.effectiveFrom/);
});

test("본인 자녀의 지금 다니는 반만 신청할 수 있다", () => {
  assert.match(parentLib, /s\."parentId" = \$2 AND e\.status = 'ACTIVE'/);
  assert.match(parentLib, /본인 자녀의 수강만/);
});

test("진행 중인 신청은 한 건만 둔다", () => {
  assert.match(parentLib, /status = 'PENDING' LIMIT 1/);
  assert.match(parentLib, /이미 검토 중인 신청이 있습니다/);
});

test("만석 반도 대기로 받되 표시는 남긴다", () => {
  assert.match(parentLib, /waitlisted = Number\(target\[0\]\.enrolled \?\? 0\) >= Number\(target\[0\]\.capacity \?\? 0\)/);
  assert.doesNotMatch(parentLib, /정원이 찼습니다[\s\S]{0,40}return \{ ok: false/);
});

test("취소는 아직 결정 안 된 건만 가능하다", () => {
  assert.match(parentLib, /r\.status = 'PENDING'/);
  assert.match(parentLib, /이미 처리된 신청은 취소할 수 없습니다/);
});

test("승인은 예약이고 적용일에 삼중 동기화 대기로 이관한다", () => {
  assert.match(adminLib, /"effectiveFrom" <= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.match(adminLib, /"appliedAt" IS NULL/);
  // 원장 결정(2026-10-05): 휴원·퇴원 자동 적용 시에만 appliedAt 을 찍는다 — 반드시 APPLIED 전환과 함께, 조건부로.
  // (예전엔 "appliedAt 을 절대 먼저 찍지 않는다"였다. 사이트 적용 = 관리자 즉시 변경과 같은 의미로 바뀜)
  assert.doesNotMatch(adminLib, /SET "appliedAt" = now\(\)/);
  assert.match(adminLib, /SET status = 'APPLIED', "appliedAt" = now\(\)/);
  assert.match(adminLib, /\["SHEET", "RALLYZ", "WEBSITE"\]/);
});

test("같은 결정을 두 번 눌러도 두 번 반영되지 않는다", () => {
  assert.match(adminLib, /WHERE id = \$1 AND status = 'PENDING'/);
  assert.match(adminLib, /이미 처리된 신청입니다/);
});

test("한 건이 실패해도 나머지는 반영한다", () => {
  // 한 건 때문에 전체가 멈추면 그날 모든 변경이 밀린다.
  assert.match(adminLib, /for \(const candidate of due\)[\s\S]*catch\s*\{/);
});

test("반 변경이 학생·반 유일 제약과 부딪히지 않는다", () => {
  // 그 반에 예전 등록 이력이 있으면 classId 를 바꾸는 UPDATE 가 충돌한다.
  // 원장 결정(2026-10-05): 휴원·퇴원은 status 만 조건부로 바꾼다. 반(classId)을 옮기는 UPDATE 는 여전히 없다.
  assert.doesNotMatch(adminLib, /UPDATE "Enrollment" SET[^`]*"classId"/);
  assert.match(adminLib, /UPDATE "Enrollment" SET status = \$2, "updatedAt" = now\(\) WHERE id = \$1 AND status = \$3/);
  assert.match(adminLib, /operationsCommand\.findUnique\(\{ where: \{ idempotencyKey: key \}/);
});

test("크론이 매일 돌고 아무나 부를 수 없다", () => {
  assert.match(cron, /CRON_SECRET/);
  assert.match(cron, /applyDueEnrollmentChanges/);
  // 응답에 실제 적용 건수와 보류 건수를 함께 낸다(운영 확인용)
  assert.match(cron, /ok: true, applied, held/);
  const job = vercel.crons.find((item) => item.path === "/api/cron/enrollment-changes");
  assert.ok(job, "vercel.json 에 크론이 등록돼야 합니다.");
  assert.equal(job.schedule, "10 15 * * *"); // KST 00:10
});

test("신청은 담당자에게 전달하고 결정 알림은 발송 승인 대기다", () => {
  assert.match(parentLib, /notifyOperationalStaff\(/);
  assert.doesNotMatch(adminLib, /notifyParentsOfStudents\(/);
  // 알림 실패가 신청·승인을 되돌리면 안 된다.
  assert.match(parentLib, /console\.error\("\[parent-change-request\] 원장 알림 실패/);
  assert.match(adminLib, /ENROLLMENT_CHANGE_NOTIFICATION_HELD/);
});

// ── 학부모가 반 변경 시작일을 고를 수 있게 한 뒤 추가된 계약 ──────────────
const rulesModule = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(await readFile("src/lib/enrollment/changeRequestRules.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);
const { resolveEffectiveFrom, addMonths } = rulesModule;

test("반 변경만 학부모가 시작일을 고를 수 있다", () => {
  // 휴원·퇴원은 달 중간에 멈추면 그달 요금을 매번 판단해야 해서 1일로 고정한다.
  assert.equal(
    resolveEffectiveFrom({ kind: "PAUSE", requestedFrom: "2026-08-20", today: "2026-08-09" }).effectiveFrom,
    "2026-09-01",
  );
  assert.equal(
    resolveEffectiveFrom({ kind: "CLASS_CHANGE", requestedFrom: "2026-08-20", today: "2026-08-09" }).effectiveFrom,
    "2026-08-20",
  );
  // 안 고르면 기본값(다음 달 1일)
  assert.equal(
    resolveEffectiveFrom({ kind: "CLASS_CHANGE", today: "2026-08-09" }).effectiveFrom,
    "2026-09-01",
  );
});

test("오늘·지난날과 너무 먼 날짜는 조용히 바꾸지 않고 거절한다", () => {
  // 조용히 바꾸면 학부모가 신청한 날과 실제 적용일이 달라진다.
  assert.equal(
    resolveEffectiveFrom({ kind: "CLASS_CHANGE", requestedFrom: "2026-08-09", today: "2026-08-09" }).error,
    "EFFECTIVE_DATE_TOO_SOON",
  );
  assert.equal(
    resolveEffectiveFrom({ kind: "CLASS_CHANGE", requestedFrom: "2026-08-01", today: "2026-08-09" }).error,
    "EFFECTIVE_DATE_TOO_SOON",
  );
  assert.equal(
    resolveEffectiveFrom({ kind: "CLASS_CHANGE", requestedFrom: "2027-01-01", today: "2026-08-09" }).error,
    "EFFECTIVE_DATE_TOO_FAR",
  );
  assert.equal(
    resolveEffectiveFrom({ kind: "CLASS_CHANGE", requestedFrom: "2026-13-01", today: "2026-08-09" }).error,
    "INVALID_EFFECTIVE_DATE",
  );
});

test("말일 + 개월 계산이 없는 날짜를 만들지 않는다", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28"); // 2/31 이 되면 안 된다
  assert.equal(addMonths("2026-12-15", 3), "2027-03-15");
});

// ── 계획표 연동 + 차액 청구서 발행 ────────────────────────────────────────
const planLib = await readFile("src/lib/enrollment/monthlyClassDates.ts", "utf8");

test("일할 계산은 공개 연간일정표와 같은 함수를 쓴다", () => {
  // 두 곳이 다른 방식으로 계산하면 학부모가 보는 일정과 청구 근거가 어긋난다.
  assert.match(planLib, /computeClassDatesFromRange/);
  assert.match(planLib, /getMonthClassSchedule/);
  assert.match(planLib, /from "@\/lib\/classSchedule"/);
  // 개강~종강 범위를 우선하고 주차 방식이 fallback (/annual 과 같은 순서).
  assert.match(planLib, /if \(openIso && closeIso\)[\s\S]{0,200}if \(weekStarts\.length > 0\)/);
});

test("계획표를 못 읽으면 빈 배열이라 자동 계산이 멈춘다", () => {
  // 추측한 회차로 청구하면 매달 틀린 금액이 나간다.
  assert.match(planLib, /return \[\];/);
  assert.match(adminLib, /loadAnnualPlanEvents\(\)\.catch\(\(\) => \[\]\)/);
});

test("차액 청구서 금액은 서버가 다시 계산한다", () => {
  // 화면 값을 믿으면 브라우저에서 숫자를 바꿔 원하는 금액으로 청구서를 만들 수 있다.
  assert.match(adminLib, /export async function issueProrationInvoice/);
  assert.match(adminLib, /const proration = buildProration\(row, planEvents\)/);
  assert.doesNotMatch(adminLib, /amount: input\.(amount|diff)/);
});

test("차액 청구서를 두 번 발행하지 않는다", () => {
  assert.match(adminLib, /if \(row\.invoicedPaymentId\) return \{ ok: false/);
  assert.match(adminLib, /SET "invoicedPaymentId" = \$2/);
});

test("승인 전이거나 계산 불가·마이너스면 발행하지 않는다", () => {
  assert.match(adminLib, /row\.status !== "APPROVED"/);
  assert.match(adminLib, /proration\.scheduleUnavailable[\s\S]{0,120}return \{ ok: false/);
  // 원장 결정: 마이너스는 환불 청구서가 아니라 다음 달 차감.
  assert.match(adminLib, /proration\.diff <= 0[\s\S]{0,200}다음 달 청구에서 차감/);
});

test("차액 청구서는 반에 묶지 않는다", () => {
  // 적용일 전까지 학생은 아직 새 반 소속이 아니라 반 기준 집계에 잘못 잡힌다.
  assert.match(adminLib, /"classId", amount[\s\S]{0,200}VALUES \(gen_random_uuid\(\)::text, \$1, NULL/);
});

test("관리자 메뉴에서 도달할 수 있다", async () => {
  // 만들어도 메뉴에 없으면 아무도 못 쓴다(이 프로젝트에서 실제로 있었던 문제).
  const { renderAdminNavigation } = await import('./helpers/admin-navigation-render.mjs');
  const shell = renderAdminNavigation('/admin/enrollment-changes');
  assert.match(shell, /href="\/admin\/enrollment-changes"/);
  assert.ok(
    /href="\/admin\/enrollment-changes"[^>]*aria-current="page"/.test(shell),
    "현재 수강 변경 업무가 실제 메뉴에서 활성화되어야 합니다.",
  );
});
