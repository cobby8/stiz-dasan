import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 부상·질병 «기간 결석» 복귀 정산 3단계(2026-11-15 원장 결정) — 연결·권한·화면 약속을 못박는 테스트.
//
// 실행으로 확인하는 곳은 따로 있다:
//   · 계산 규칙(달 경계·휴무·반올림·제외 사유·지문·학부모 숫자) → tests/illness-period-settlement-plan.test.mjs (순수 모듈 실행)
//   · DB 흐름(미리보기 → 확정 → 청구 준비 이월 한 번 차감 → 확정 취소 · 남의 아이 거절 · 동시 확정) → 실제 PostgreSQL
//       node scripts/test-billing-workbench-postgres.mjs (tests/illness-period-settlement-postgres.mjs)
//   · 청구 준비의 «다닌 만큼만» 제안·반 이동 경고 → tests/billing-workbench.test.mjs (가짜 DB 실행)
// 여기는 «누가 누를 수 있나 · 금액이 누구에게 내려가나 · 잠금과 격리 수준 · 화면 규칙»이 코드에서 빠지지 않게 지킨다.

const rules = await loadTsModule("src/lib/regular/illnessPeriodRules.ts");
const read = (path) => readFileSync(path, "utf8");
const slice = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `구간 시작을 찾지 못함: ${from}`);
  const end = to ? source.indexOf(to, start + from.length) : source.length;
  assert.ok(end > start, `구간 끝을 찾지 못함: ${to}`);
  return source.slice(start, end);
};

const service = read("src/lib/regular/illness-period-settlement.ts");
const actions = read("src/app/actions/illness-period-admin.ts");
const settleLib = slice(service, "export async function settleIllnessPeriod(", "export type CancelSettlementResult");
const cancelLib = slice(service, "export async function cancelIllnessPeriodSettlement(", "/** 확정된 기간의 표 사본(화면용)");
const previewLib = slice(service, "export async function previewIllnessPeriodSettlement(", "export type SettleResult");
const parentLib = slice(service, "export async function previewParentIllnessSettlement(");

test("확정: 저장 스위치 → 전역 잠금 → 기간 행 → 학생 행 → (복귀 처리) → 결석 행 잠금 뒤 다시 계산 → 지문이 같을 때만", () => {
  // 스위치·관리자 확인은 거래를 열기 전에
  assert.ok(settleLib.indexOf("if (!enabled) throw") < settleLib.indexOf("db.$transaction("));
  assert.ok(settleLib.indexOf("if (!actorId) throw") < settleLib.indexOf("db.$transaction("));
  // 잠금 순서(기존 정산과 같게 — 교착 금지)
  const order = ["await lockCompensation(tx);", "WHERE p.id = $1 FOR UPDATE OF p", `FROM "Student" s WHERE s.id = $1 AND \${notMergedStudent("s")} FOR UPDATE`, "await endAbsencePeriodInTx(tx,", "await readSettlementPlan(tx, period, returnDate, omit, ctx, true)"];
  order.reduce((from, piece) => { const at = settleLib.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  // 결석 행은 확정 때만 잠근다(미리보기는 잠그지 않는다)
  assert.match(service, /ORDER BY ra\.date, ra\.id\$\{lock \? " FOR UPDATE OF ra" : ""\}/);
  // 문제(근거 불명·아직 안 지난 결석)가 있으면 먼저 거절, 그다음 지문
  assert.ok(settleLib.indexOf("if (read.plan.problems.length > 0) throw") < settleLib.indexOf("if (read.fingerprint !== expected) throw"));
  assert.ok(settleLib.indexOf("if (read.fingerprint !== expected) throw") < settleLib.indexOf("insertCarryCreditInTx(tx,"));
  assert.match(settleLib, /if \(!\/\^\[a-f0-9\]\{64\}\$\/\.test\(expected\)\) throw/, "지문 모양 확인");
  // 상태 전이는 «지금 APPROVED 일 때만» 조건부 UPDATE — 0행이면 던진다
  assert.match(settleLib, /SET "carryState" = 'SETTLED', "carrySettledAt" = now\(\), "carrySettledByUserId" = \$2,[\s\S]{0,160}WHERE id = \$1 AND "carryState" = 'APPROVED'/);
  assert.match(settleLib, /if \(changed !== 1\) throw new IllnessPeriodError\("기간 상태가 바뀌어 확정하지 않았습니다/);
  // carrySettlement 는 병합 저장 — 승인 때 남긴 approval·보류로 돌린 held 를 지우지 않는다
  assert.match(settleLib, /"carrySettlement" = COALESCE\("carrySettlement", '\{\}'::jsonb\) \|\| \$3::jsonb/);
  assert.match(settleLib, /JSON\.stringify\(\{ settlement, unpaidGuides \}\)/);
  // 감사 기록
  assert.match(settleLib, /'ILLNESS_PERIOD_SETTLED', 'ADMIN', \$1, \$2::jsonb/);
});

test("확정: 이월 INSERT 는 하루짜리와 같은 함수 한 곳 — 쓸 수 있는 달 = 복귀일이 속한 달, 기간 id 를 근거에 남긴다", () => {
  assert.match(settleLib, /const availableMonth = returnDate\.slice\(0, 7\);/);
  assert.match(settleLib, /await insertCarryCreditInTx\(tx, \{[\s\S]{0,260}originMonth: row\.month, eligibility: ILLNESS_REASON, actorId, calendar: ctx\.calendar, evidence, availableMonth, periodId,/);
  assert.doesNotMatch(service, /INSERT INTO "BillingCarryCredit"/, "연결부에 이월 INSERT 문이 따로 없다");
  const absence = read("src/lib/billing/workbench-absence.ts");
  assert.equal((absence.match(/INSERT INTO "BillingCarryCredit"/g) ?? []).length, 1, "이월 INSERT 는 한 곳");
  assert.match(absence, /const availableMonth = input\.availableMonth \?\? `\$\{m === 12 \? y\+1:y\}-/, "하루짜리는 예전처럼 원기간 다음 달");
  assert.match(absence, /\.\.\.\(input\.periodId\?\{periodId:input\.periodId\}:\{\}\)/);
  // 하루짜리 이월과 기간 정산이 같은 근거 함수를 쓴다(반·달 근거는 한 곳)
  assert.match(absence, /const evidence=await readClassMonthEvidenceInTx\(tx,\{studentId:absence\.studentId,classId:absence\.classId,originMonth,calendar\},lock,/);
  assert.match(service, /await readClassMonthEvidenceInTx\(tx, \{ studentId: period\.studentId, classId, originMonth: month, calendar: ctx\.calendar \}, lock, pauseReady\)/);
  // 근거 없음·미납 → 낸 돈이 없는 달 / 그 밖의 사유 → 확정 차단
  assert.match(service, /if \(error\.message !== CARRY_NO_EVIDENCE_MESSAGE && error\.message !== CARRY_UNPAID_MESSAGE\) \{\s+evidence\.set\(key, \{ kind: "BLOCKED", reason: error\.message \}\);/);
  // 정산 기록(이중 보상 방지)은 이월한 날과 낸 돈이 없는 달의 날 모두
  assert.match(settleLib, /INSERT INTO "BillingAbsenceResolution" \("absenceId","studentId",resolution,reason,"evidenceConfirmed",eligibility,"actorUserId"\)\s+VALUES \(\$1,\$2,'CARRY',\$3,true,\$4,\$5\)/);
  // 학부모가 알린 결석(REPORTED)은 확정 때만 CONFIRMED 로(승인 때는 바꾸지 않는다)
  assert.match(settleLib, /UPDATE "RegularAbsence" SET status = 'CONFIRMED', "resolvedByUserId" = \$2, "updatedAt" = now\(\) WHERE id = \$1 AND status = 'REPORTED'/);
  // 미사용 보강권만 회수(예약·사용된 보강은 정산에서 이미 빠졌다)
  assert.match(settleLib, /AND mc\.status IN \('AVAILABLE', 'EXPIRED'\)\s+RETURNING mc\.id/);
});

test("격리 수준: 확정·확정 취소·미리보기는 Serializable·RepeatableRead 를 걸지 않는다 — 잠근 뒤 다시 읽는 납부 상태·결석이 최신이어야 한다", () => {
  assert.doesNotMatch(service.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/isolationLevel\?: "Serializable" \| "RepeatableRead"/, ""), /isolationLevel|Serializable|RepeatableRead/);
  assert.match(service, /const SETTLE_TX_OPTIONS = \{ timeout: 60_000 \};/);
  assert.equal((service.match(/\}, SETTLE_TX_OPTIONS\);/g) ?? []).length, 2, "확정·확정 취소");
  assert.equal((service.match(/\}, READ_TX_OPTIONS\);/g) ?? []).length, 2, "원장 미리보기·학부모 미리보기");
  // prisma 를 직접 쓰지 않는다(db 인자만) · ORM 기본 메서드 없음
  assert.doesNotMatch(service, /from "@\/lib\/prisma"/);
  for (const path of ["src/lib/regular/illness-period-settlement.ts", "src/lib/regular/illness-period-settlement-runner.ts", "src/lib/regular/parent-period-settlement.ts"]) {
    assert.doesNotMatch(read(path), /\.(findMany|findFirst|findUnique|create|update|upsert|delete|count)\(/, path);
    assert.doesNotMatch(read(path), /sendParentSms|sendTrackedSms|sendFailClosedTrackedSms|alimtalk|sendSms/i, path);
    assert.doesNotMatch(read(path), /toISOString\(\)\.slice|getDay\(\)|getDate\(\)|getHours\(\)/, path);
  }
});

test("확정 취소: 이 기간의 이월이 한 번도 쓰이지 않았을 때만 — 지우기 전에 사본을 감사 기록에, 상태는 APPROVED 로", () => {
  assert.ok(cancelLib.indexOf("if (!enabled) throw") < cancelLib.indexOf("db.$transaction("));
  assert.match(cancelLib, /if \(period\.carryState !== "SETTLED"\) throw new IllnessPeriodError\("이월을 확정한 기간만 확정 취소할 수 있습니다\."\);/);
  // 이 기간이 적립한 이월 = basis.periodId. 잠근 뒤 사용 여부를 본다
  assert.match(cancelLib, /WHERE c\."studentId" = \$1 AND c\.basis->>'periodId' = \$2\s+ORDER BY c\.id FOR UPDATE OF c/);
  assert.match(cancelLib, /FROM "BillingCarryUsage" u WHERE u\."studentId" = \$1 AND u\."sourceCreditIds" && \$2::text\[\] LIMIT 1/);
  assert.match(cancelLib, /이미 청구에서 차감된 이월이 있어 확정 취소할 수 없습니다\. 수납 관리에서 직접 조정해 주세요\./);
  // 순서: 사용 여부 확인 → 감사 사본 → 삭제 → 상태
  const order = ["u.\"sourceCreditIds\" && $2::text[]", "'ILLNESS_PERIOD_SETTLEMENT_CANCELED'", "DELETE FROM \"BillingCarryCredit\"", "DELETE FROM \"BillingAbsenceResolution\"", "SET \"carryState\" = 'APPROVED'"];
  order.reduce((from, piece) => { const at = cancelLib.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  assert.match(cancelLib, /JSON\.stringify\(\{ periodId, studentId: period\.studentId, credits, resolutions, settlement: stored\?\.settlement \?\? null \}\)/);
  // 정산 기록 삭제는 «이 기간의 결석»이고 «이 정산이 만든 것»만
  assert.match(cancelLib, /DELETE FROM "BillingAbsenceResolution" r USING "RegularAbsence" ra\s+WHERE ra\.id = r\."absenceId" AND ra\."periodId" = \$1 AND r\."absenceId" = ANY\(\$2::text\[\]\)/);
  // 표 사본·미납 달 안내만 빼고(approval·held 는 남긴다), 지금 SETTLED 일 때만
  assert.match(cancelLib, /"carrySettlement" = \(COALESCE\("carrySettlement", '\{\}'::jsonb\) - 'settlement' - 'unpaidGuides'\) \|\| \$2::jsonb/);
  assert.match(cancelLib, /WHERE id = \$1 AND "carryState" = 'SETTLED'/);
});

test("권한: 미리보기는 원장·부원장, 금액은 원장에게만(서버 응답에서 뺀다) — 이월 확정·확정 취소는 원장만", () => {
  const load = slice(actions, "export async function loadIllnessPeriodSettlement(", "/**\n * [이월 확정]");
  const settle = slice(actions, "export async function settleIllnessPeriodAction(", "/** [확정 취소]");
  const cancel = slice(actions, "export async function cancelIllnessPeriodSettlementAction(");
  assert.match(load, /const admin = await requireAdmin\(\);\s+const money = canSeeAllMoney\(admin\.appUserRole\);/);
  for (const [name, body] of [["확정", settle], ["확정 취소", cancel]]) {
    assert.match(body, /try \{ owner = await requireOwner\(\); \} catch \{ return \{ ok: false, message: "[^"]+원장만 할 수 있습니다\." \}; \}/, name);
    assert.ok(body.indexOf("await requireOwner()") < body.indexOf("(\n      prisma,") || body.indexOf("await requireOwner()") < body.indexOf("(prisma,"), `${name}: 권한 확인이 먼저`);
    assert.match(body, /settlementWritesEnabled\(\)/, `${name}: 저장 스위치`);
  }
  // 금액 칸은 역할이 맞을 때만 채운다 — 화면만 가리지 않는다
  const rows = slice(actions, "function settlementRows(", "/**\n * 정산 칸을 열 때");
  assert.match(rows, /tuition: money && paid \? row\.tuition : null, unit: money && paid \? row\.unitDisplay : null, subtotal: money && paid \? row\.subtotal : null,/);
  assert.equal((load.match(/carryTotal: money \? /g) ?? []).length, 2, "미리보기·확정된 표 모두 합계는 원장만");
  // 금액이 섞이지 않는 칸만 그대로 내려간다(안내 문구에 금액이 없다)
  const planSource = read("src/lib/regular/illnessPeriodSettlementPlan.ts");
  const guideText = slice(planSource, "export function unpaidGuideAdminText(", "export function parentSettlementView(");
  assert.doesNotMatch(guideText, /toLocaleString|원`|tuition|subtotal/);
  // 화면이 보낸 금액은 받지 않는다 — 날짜를 빼고 넣은 목록·복귀일·지문만
  assert.match(settle, /omitAbsenceIds: Array\.isArray\(input\?\.omitAbsenceIds\) \? input\.omitAbsenceIds\.map\(String\) : \[\],\s+expectedFingerprint: String\(input\?\.expectedFingerprint \?\? ""\),\s+returnDate: input\?\.returnDate \? String\(input\.returnDate\) : null,/);
  assert.doesNotMatch(settle, /input\?\.(carryTotal|amount|subtotal|tuition)/);
  // 확정 직전에는 공식 일정을 새로 읽는다(청구 준비의 저장·발행과 같다) — 수업 횟수가 청구 준비와 같아야 이월이 유효하다
  assert.match(settle, /await settlementContext\(owner\.appUserId, true\)/);
  const runner = read("src/lib/regular/illness-period-settlement-runner.ts");
  assert.match(runner, /const calendar = await loadWorkbenchCalendar\(fresh\);/);
  assert.match(runner, /classDatesForMonth: \(yearMonth, dayOfWeek\) => getMonthlyClassDates\(calendar\.events, yearMonth, dayOfWeek\),/);
  assert.match(runner, /process\.env\.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true"/);
});

test("알림: 확정하면 학부모 앱 알림 1회(본문에 아이 이름·24시간 중복 방지) — 문자·알림톡 없음, 확정 취소는 알리지 않는다", () => {
  const settle = slice(actions, "export async function settleIllnessPeriodAction(", "/** [확정 취소]");
  const cancel = slice(actions, "export async function cancelIllnessPeriodSettlementAction(");
  assert.equal((settle.match(/notifyParentOnce\(/g) ?? []).length, 1);
  assert.match(settle, /done\.studentId, "부상 결석 이월 확정",\s+`\$\{await childPrefix\(done\.studentId\)\}\$\{periodRangeText\(done\.startDate, done\.returnDate\)\} 결석 · \$\{periodSettledParentText\(done\.carryTotal\)\}`,\s+"\/mypage\/regular-absence",/);
  assert.doesNotMatch(cancel, /notifyParent/);
  assert.doesNotMatch(actions, /sendParentSms|sendTrackedSms|sendFailClosedTrackedSms|alimtalk|sendSms/i);
  assert.equal(rules.periodSettledParentText(84000), "이월 84,000원 확정 · 다음 수강료에서 빼 드려요");
  assert.equal(rules.periodSettledParentText(0), "부상 결석 정산 완료 · 수강료는 다닌 만큼만 안내해요");
  // 확정 뒤 신청함·청구 준비·학생 상세·학부모 화면을 다시 그린다
  for (const path of ['"/admin/inbox"', '"/admin/finance"', '"/admin/students/[id]", "page"', '"/mypage"']) assert.ok(settle.includes(`revalidatePath(${path})`), path);
});

test("미리보기: 읽기만 한다 — 잠금·쓰기 없음, 복귀일 규칙은 한 곳(진행 중인 학원 등록 기간만 여기서 복귀일을 받는다)", () => {
  assert.doesNotMatch(previewLib, /lockCompensation|\$executeRawUnsafe|FOR UPDATE/);
  assert.match(previewLib, /await readSettlementPlan\(tx, period, returnDate, omit, ctx, false\)/);
  const returnRule = slice(service, "function resolveReturnDate(", "export type SettlementPreview");
  assert.match(returnRule, /if \(requested <= period\.startDate\) throw new IllnessPeriodError\("복귀일은 시작일 다음 날 이후여야 합니다\.", 400\);/);
  assert.match(returnRule, /if \(period\.parentReported\) \{[\s\S]{0,200}학부모가 알린 기간은 여기서 복귀일을 바꿀 수 없습니다/);
  assert.match(returnRule, /if \(period\.status !== "ACTIVE"\) throw new IllnessPeriodError\("이미 복귀 처리된 기간입니다\. 저장된 복귀일로 정산합니다\."\);/);
  assert.equal((service.match(/resolveReturnDate\(period, /g) ?? []).length, 2, "미리보기와 확정이 같은 규칙");
  // 수강월: 달력 월 → 다음 달 → 이전 달 순으로 «그 달 그 요일 수업일에 이 날이 있는가»
  assert.match(service, /return \[calendarMonth, addMonthsYm\(calendarMonth, 1\), addMonthsYm\(calendarMonth, -1\)\]\s+\.find\(\(month\) => datesOf\(month, dayOfWeek\)\.includes\(date\)\) \?\? calendarMonth;/);
});

test("학부모 미리보기: 본인 아이의 기간만(서버가 다시 확인) · 금액은 서버 계산 · 원장이 뺀 날 없이 «예정» — 근거 불명이면 금액 대신 상태", () => {
  // 권한 조각(childAccessSql)과 병합 학생 제외를 한 조회에 건다 — 0행이면 null
  assert.match(parentLib, /WHERE \$\{accessSql\} AND \$\{notMergedStudent\("s"\)\} AND p\.id = \$2 AND p\.reason = '\$\{ILLNESS_REASON\}' AND p\.status <> 'CANCELLED'`,\s+input\.parentUserId, periodId,/);
  assert.match(parentLib, /if \(!period\) return null;/);
  assert.match(parentLib, /const read = await readSettlementPlan\(tx, period, returnDate, \[\], ctx, false\);/, "원장이 뺀 날은 넣지 않는다 · 잠금 없음");
  assert.match(parentLib, /view: parentSettlementView\(read\.plan\)/);
  assert.doesNotMatch(parentLib, /lockCompensation|\$executeRawUnsafe|FOR UPDATE/);
  const wrapper = read("src/lib/regular/parent-period-settlement.ts");
  assert.match(wrapper, /prisma, \{ parentUserId, periodId, returnDate \}, await settlementContext\(parentUserId\), await childAccessSql\("s", "\$1"\),/);
  assert.match(wrapper, /if \(returnDate && returnDate < todayKst\(\)\) throw new Error\("PERIOD_RETURN_PAST"\);/);
  assert.match(wrapper, /if \(!preview\) throw new Error\("PERIOD_NOT_FOUND"\);/);
  // API: 로그인한 학부모만, 남의 기간은 «찾을 수 없어요»
  const route = read("src/app/api/mypage/regular-absence/period/route.ts");
  const get = slice(route, "export async function GET(", "// 알리기(create)");
  assert.ok(get.indexOf("if (!parent) return NextResponse.json") < get.indexOf('if (q.get("settle"))'), "로그인 확인이 먼저");
  assert.match(get, /await previewParentPeriodSettlement\(parent\.appUserId, \{ periodId: q\.get\("periodId"\) \?\? "", returnDate: q\.get\("returnDate"\) \|\| null \}\)/);
  assert.match(route, /PERIOD_NOT_FOUND: "알린 기간을 찾을 수 없어요\."/);
  assert.match(route, /PERIOD_RETURN_BEFORE_START: "복귀일은 결석 시작일 다음 날부터 고를 수 있어요\."/);
  // 화면이 보낸 금액을 받는 칸이 없다
  assert.doesNotMatch(route + wrapper, /body\??\.(amount|total|carryTotal)/);
});

test("학부모 «복귀했어요»: 학원이 등록한 질병·부상 기간도 누를 수 있다 — 본인 아이만, 기존 복귀 처리 함수 그대로, 알림 취소는 없다", () => {
  const wrapper = read("src/lib/regular/parent-period-settlement.ts");
  const fn = slice(wrapper, "export async function returnAcademyIllnessPeriod(");
  assert.match(fn, /WHERE \$\{access\} AND \$\{notMergedStudent\("s"\)\}\s+AND p\.id = \$2 AND p\."reportedByUserId" IS NULL AND p\.reason = '\$\{ILLNESS_REASON\}'\s+FOR UPDATE OF p`/);
  assert.match(fn, /const access = await childAccessSql\("s", "\$1"\);/);
  // 복귀일 규칙: 오늘부터 · 시작일 다음 날 이후 · 정해진 복귀일보다 늦을 수 없다
  for (const code of ["PERIOD_INVALID_DATE", "PERIOD_RETURN_PAST", "PERIOD_RETURN_BEFORE_START", "PERIOD_RETURN_AFTER_END", "PERIOD_ALREADY_CLOSED"]) assert.ok(fn.includes(`throw new Error("${code}")`), code);
  assert.match(fn, /const done = await endAbsencePeriodInTx\(tx, \{ periodId, returnDate \}, \{ \.\.\.ctx, todayYmd \}\);/);
  assert.match(fn, /await lockCompensation\(tx\);/);
  // 원장에게 복귀를 한 번 알린다(앱 안 알림) — 승인된 기간이면 신청함 «정산 필요»로
  assert.equal((fn.match(/await notifyOperationalStaff\(/g) ?? []).length, 1);
  assert.match(fn, /stableEventKey: `illness-period-return:\$\{periodId\}:\$\{returnDate\}`/);
  assert.match(fn, /linkUrl: outcome\.period\.carryState === "APPROVED" \? ILLNESS_PERIOD_INBOX_HREF : "\/admin\/absence"/);
  // API: 학부모가 알린 기간이 아니어서 «찾을 수 없음»일 때만 이 길로 — 알림 취소(cancel)는 이 길이 없다
  const route = read("src/app/api/mypage/regular-absence/period/route.ts");
  const post = slice(route, "export async function POST(");
  assert.match(post, /if \(!\(error instanceof Error\) \|\| error\.message !== "PERIOD_NOT_FOUND"\) throw error;[\s\S]{0,200}await returnAcademyIllnessPeriod\(parent\.appUserId, \{ periodId: body\.periodId, returnDate: body\.returnDate \}\)/);
  const cancelBranch = slice(post, 'if (body?.action === "cancel")', "return NextResponse.json(await createParentAbsencePeriod(");
  assert.doesNotMatch(cancelBranch, /returnAcademyIllnessPeriod/);
  // 목록: 학원 등록 질병·부상 기간(진행 중)과 금액 확정 대기·확정된 기간도 보인다 — 칸이 있을 때만, 본인 아이만
  const list = slice(read("src/lib/regular/parent-absence-period.ts"), "export async function listParentAbsencePeriods(");
  assert.match(list, /WHERE \$\{await childAccessSql\("s", "\$1"\)\} AND \$\{notMergedStudent\("s"\)\}\s+AND \(/);
  assert.match(list, /OR \(p\."reportedByUserId" IS NULL AND p\.reason = '\$\{ILLNESS_REASON\}' AND p\.status = 'ACTIVE'/);
  assert.match(list, /p\."carryState" = 'APPROVED' OR \(p\."carryState" = 'SETTLED' AND p\."carrySettledAt" > now\(\) - interval '60 days'\)/);
  assert.match(list, /\$\{carryReady \? `\s+-- ② 학원이 등록한 질병·부상 기간/, "칸이 없는 DB 는 예전 조건 그대로");
  assert.match(list, /canCancel: active && row\.parentReported === true,/);
  assert.deepEqual([rules.PERIOD_APPROVED_PARENT_LABEL, rules.PERIOD_RETURNED_PARENT_LABEL], ["부상 결석 인정 · 금액은 복귀 뒤 확정", "복귀 · 이월 금액 확정 대기"]);
});

test("관리자 화면: 달별 표(날짜 칩으로 빼기·넣기) · 합계 · 미납 달 안내 · «이월 확정»(확인 창) · 확정 뒤 «청구 준비로 이동»·«확정 취소»", () => {
  const box = read("src/app/admin/inbox/IllnessPeriodSettlementBox.tsx");
  // 금액은 받은 그대로 — null 이면(부원장) 보이지 않는다
  assert.match(box, /\{view\.carryTotal !== null && <span className="ml-2 tabular-nums">\{won\(view\.carryTotal\)\}<\/span>\}/);
  assert.match(box, /\{row\.subtotal !== null && </);
  assert.match(box, /\{!view\.canSeeMoney && <p[^>]*>금액과 이월 확정은 원장만 볼 수 있습니다\.<\/p>\}/);
  // 날짜 칩: 누르면 빼기 / 뺀 날은 다시 넣기 / 다른 이유로 빠진 날은 이유와 함께 흐리게(누를 수 없다) — 터치 44px
  assert.match(box, /aria-pressed=\{true\} onClick=\{\(\) => toggle\(item\.absenceId\)\}/);
  assert.match(box, /\{item\.code === "OMITTED" && !settled \? \(\s+<button\s+type="button" disabled=\{pending\} aria-pressed=\{false\} onClick=\{\(\) => toggle\(item\.absenceId\)\}/);
  assert.match(box, /<span className="text-xs">\{item\.why\}<\/span>/);
  assert.equal((box.match(/inline-flex min-h-11 items-center/g) ?? []).length, 3, "칩 세 가지 모두 44px");
  // 날짜를 빼고 넣으면 서버가 다시 계산한다(화면이 금액을 계산하지 않는다)
  assert.match(box, /startTransition\(async \(\) => \{ await load\(next, returnDate\); \}\);/);
  assert.doesNotMatch(box, /Math\.round|reduce\(\(sum, row\) => sum \+ \(row\.subtotal/);
  // 이월 확정: 확인 창(기존 부품) → 지문·뺀 날·복귀일만 보낸다
  assert.match(box, /useAdminConfirm\(\)/);
  assert.match(box, /confirmLabel: "이월 확정",\s+tone: "primary",/);
  assert.match(box, /periodId, omitAbsenceIds: omit, expectedFingerprint: view\.fingerprint \?\? "", returnDate: view\.canSetReturnDate \? view\.returnDate : null,/);
  assert.match(box, /const canConfirm = view\.state === "READY" && view\.blockers\.length === 0 && view\.canSettle && view\.writesEnabled && includedCount > 0;/);
  // 확정 취소는 위험 작업 — 위험 등급 버튼 + 확인 창, 이월이 쓰였으면 버튼 대신 이유
  assert.match(box, /confirmLabel: "확정 취소",\s+tone: "danger",/);
  assert.match(box, /\{view\.canSettle && !view\.used && view\.writesEnabled && \(\s+<button type="button" disabled=\{pending\} onClick=\{\(\) => void cancelSettlement\(\)\} className="academy-button-danger">확정 취소<\/button>/);
  assert.match(box, /이월이 이미 청구에서 차감돼 확정 취소는 할 수 없습니다\./);
  assert.match(box, /<Link href="\/admin\/finance\/prepare" className="academy-button-primary">청구 준비로 이동<\/Link>/);
  // 자동 발행하지 않는다는 것을 확인 창에서 말한다
  assert.match(box, /청구는 자동으로 나가지 않으니 청구 준비에서 금액을 확인하고 발행해 주세요\./);
  // 결석 중: «지금까지 예상 이월» 한 줄 + [정산하기]
  assert.match(box, /settled \? "이월 확정" : view\.state === "READY" \? "복귀 정산" : "지금까지 예상 이월"/);
  assert.match(box, />\s+정산하기\s+<\/button>/);
  // 아이콘 없이 글자 · 굵기 4단계 · 색은 토큰만 · «학원에 문의» 없음
  assert.doesNotMatch(box, /material-symbols|UiIcon|font-(extrabold|black)|#[0-9a-fA-F]{3,6}\b|lucide|학원에 문의/);
  assert.match(box, /var\(--color-academy-secondary\)/);
  // 상세 칸·학생 상세가 이 칸으로 이어진다
  const detail = read("src/app/admin/inbox/IllnessPeriodInboxDetail.tsx");
  assert.equal((detail.match(/<IllnessPeriodSettlementBox /g) ?? []).length, 2, "승인된 기간·확정된 기간");
  const panel = read("src/app/admin/students/[id]/AbsencePeriodPanel.tsx");
  assert.match(panel, /\{p\.settleNeeded \? PERIOD_CARRY_STUDENT_LABELS\.SETTLE_NEEDED : PERIOD_CARRY_STUDENT_LABELS\.APPROVED\}/);
  assert.match(panel, /\{p\.settleNeeded \? "정산하기" : "신청함에서 보기"\}/);
  assert.match(panel, /\{p\.carryState === "SETTLED" && \(/);
  assert.deepEqual(rules.PERIOD_CARRY_STUDENT_LABELS, { APPROVED: "이월 대상 · 금액 미정", SETTLE_NEEDED: "복귀 · 정산 필요", SETTLED: "이월 확정" });
  // 학생 상세 조회: 칸이 없는 DB 는 읽지 않는다
  const periodService = read("src/lib/regular/absence-period-service.ts");
  assert.match(periodService, /const carrySql = carryReady \? `p\."carryState"` : `NULL::text`;\s+const settleNeededSql = carryReady \? illnessSettleNeededSql\("p"\) : `false`;/);
});

test("학부모 화면: «복귀했어요» → 복귀일 → 예정 금액(서버 계산) → 확정 뒤 «이월 ○원 확정» — 아이콘 없이 글자, «학원에 문의» 없음", () => {
  const panel = read("src/app/mypage/regular-absence/PeriodAbsencePanel.tsx");
  // 예정 금액은 서버에 묻는다 — 고른 복귀일과 함께
  assert.match(panel, /const query = new URLSearchParams\(\{ settle: "1", periodId, \.\.\.\(date \? \{ returnDate: date \} : \{\}\) \}\);/);
  assert.match(panel, /period\.carry === "APPROVED" \|\| askPeriod\.carry === "RETURNED"|askPeriod\.carry === "APPROVED" \|\| askPeriod\.carry === "RETURNED"/);
  assert.match(panel, /<span>이월 예정<\/span>/);
  assert.match(panel, /\{Number\(row\.month\.slice\(5, 7\)\)\}월 \{row\.className\} · \{row\.missed\}회 빠짐/);
  assert.match(panel, /예정 금액이에요\. 학원이 확정하면 알려 드리고, 다음 수강료에서 빼 드려요\./);
  // 근거를 정할 수 없으면 금액 대신 상태를 그대로
  assert.match(panel, /if \(view\.pendingCheck\) \{\s+return <p[^>]*>이월 금액은 \{PERIOD_SETTLE_PARENT_PENDING_CHECK\}<\/p>;/);
  // 학원 등록 기간: «복귀했어요»는 있고 «알림 취소»는 없다 / 복귀 미정이면 달력 위쪽 제한 없음
  assert.match(panel, /\{canReturn && \(\s+<button/);
  assert.match(panel, /\{canCancel && \(\s+<InlineConfirm\s+label="알림 취소"/);
  assert.match(panel, /max=\{period\.endDate \? addDaysKst\(period\.endDate, 1\) : undefined\}/);
  assert.match(panel, /\{period\.carryLabel && \(/);
  // 화면이 금액을 계산하지 않는다 · 아이콘·굵은 글자·색 코드 없음 · 누르는 것은 기존 버튼 등급(44px)
  assert.doesNotMatch(panel, /Math\.round|roundCarryTotal|material-symbols|UiIcon|font-(extrabold|black|bold)|#[0-9a-fA-F]{3,6}\b|lucide|학원에 문의/);
  // «질병·부상 결석» 칸: 확정 뒤 글자·정산에서 빠진 날
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /EXCLUDED: "bg-\[var\(--color-academy-soft\)\] text-\[var\(--color-academy-muted\)\]",/);
  assert.equal(rules.PERIOD_DAY_EXCLUDED_LABEL, "정산 제외");
});

test("크론·기타: «인정 안 함» 기간의 새 날은 매일 보강권으로 — 연장과 따로 실패한다 / 기간 표시 읽기는 모양이 다르면 버린다", () => {
  const cron = read("src/app/api/cron/absence-periods/route.ts");
  assert.ok(cron.indexOf("await extendOpenAbsencePeriods()") < cron.indexOf("await convertDeclinedPeriodNewDays(prisma, isMakeupCreditIssuableYmd)"), "연장 뒤에 전환");
  assert.match(cron, /try \{\s+declinedConverted = \(await convertDeclinedPeriodNewDays\(prisma, isMakeupCreditIssuableYmd\)\)\.converted;\s+\} catch \(error\) \{/);
  const admin = read("src/lib/regular/illness-period-admin.ts");
  const fn = slice(admin, "export async function convertDeclinedPeriodNewDays(", "// ── 청구 발행 보류");
  assert.match(fn, /WHERE \$\{illnessPeriodDeclinedSql\("p"\)\} AND p\.reason = '\$\{ILLNESS_REASON\}' AND p\.status <> 'CANCELLED'\s+AND COALESCE\(r\.status, 'PENDING'\) = 'PENDING'/);
  assert.match(fn, /if \(period\.carryState !== "NONE" \|\| !declined\) return 0;/, "잠근 뒤 다시 확인");
  assert.match(fn, /await convertIllnessToMakeupInTx\(tx, \{ absenceId: absence\.id, by: "ADMIN", actorUserId: declined\.byUserId, issuable \}\)/, "하루짜리 [보강권으로]와 같은 함수");
  assert.equal(rules.illnessPeriodDeclinedSql("p"), `(p."carryState" = 'NONE' AND jsonb_typeof(p."carrySettlement"->'declined') = 'object')`);
  assert.equal(rules.illnessSettleNeededSql("p"),
    `((p.reason = 'ILLNESS_INJURY' AND p."carryState" = 'APPROVED' AND p.status IN ('ACTIVE', 'ENDED')) AND (p.status = 'ENDED'\n            OR (p."returnDate" IS NOT NULL AND p."returnDate" <= (now() AT TIME ZONE 'Asia/Seoul')::date)))`);
  // 기간 행 표시 읽기
  assert.deepEqual(rules.parseUnpaidGuides({ unpaidGuides: [{ month: "2026-12", classId: "m", missedDates: ["2026-12-07", 3] }, { month: "2026-11", classId: "m", missedDates: [] }, { bad: true }] }, "2026-12"),
    [{ month: "2026-12", classId: "m", missedDates: ["2026-12-07"] }]);
  assert.deepEqual(rules.parseUnpaidGuides(null), []);
  assert.deepEqual(rules.parseUnpaidGuides('[{"month":"2026-12","classId":"m","missedDates":["2026-12-07"]}]', "2026-12").length, 1, "jsonb 가 글자로 와도 읽는다");
  assert.deepEqual(rules.parseSettlementSummary({ settlement: { carryTotal: 84000, returnDate: "2026-12-01", availableMonth: "2026-12" } }),
    { carryTotal: 84000, returnDate: "2026-12-01", availableMonth: "2026-12", settledAt: null });
  assert.equal(rules.parseSettlementSummary({ approval: {} }), null);
  assert.equal(rules.parseSettlementSummary({ settlement: { carryTotal: "84000" } }), null, "금액이 숫자가 아니면 읽지 않는다");
});
