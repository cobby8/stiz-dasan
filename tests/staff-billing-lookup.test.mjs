// 선생님 «청구» 탭 조회(달·반·이름) + «내 담당 반 청구만» 규칙을 고정한다.
// 달 값은 주소창으로 들어오는 바깥 입력이고, 달 이동은 연말에서 틀리기 쉬워 실행으로 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  billingMonthLabel,
  canSeeUnlinkedMonthlyBill,
  countBillingLookup,
  matchesBillingLookup,
  resolveBillingMonth,
  shiftBillingMonth,
  splitBillingMonth,
  unlinkedMonthlyBillScopeSql,
} from "../src/lib/staff-billing-lookup.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const query = read("src/lib/staff-portal-queries.ts");
const page = read("src/app/staff/billing/page.tsx");
const client = read("src/app/staff/billing/StaffBillingClient.tsx");
const NOW = "2026-11";

test("달 형식 검사: 정상 값만 통과하고 나머지는 이번 달로 돌린다", () => {
  assert.equal(resolveBillingMonth("2026-10", NOW), "2026-10");
  assert.equal(resolveBillingMonth("2026-11", NOW), "2026-11");
  assert.equal(resolveBillingMonth("2026-01", NOW), "2026-01");
  // 형식 오류
  for (const bad of ["2026-1", "2026/10", "202610", "26-10", "2026-10-01", " 2026-10", "2026-10 ", "abcd-ef"]) {
    assert.equal(resolveBillingMonth(bad, NOW), NOW, bad);
  }
  // 없는 달
  assert.equal(resolveBillingMonth("2026-13", NOW), NOW);
  assert.equal(resolveBillingMonth("2026-00", NOW), NOW);
  // 빈 값·다른 자료형·배열(?month=a&month=b)
  for (const bad of ["", undefined, null, 202610, ["2026-10"], {}]) {
    assert.equal(resolveBillingMonth(bad, NOW), NOW);
  }
  // SQL 조각
  for (const bad of ["2026-10' OR '1'='1", "2026-10;DROP TABLE \"Payment\"", "2026-10\n", "1=1--"]) {
    assert.equal(resolveBillingMonth(bad, NOW), NOW, bad);
  }
});

test("달 범위: 너무 옛날·너무 먼 미래는 이번 달로 돌린다", () => {
  assert.equal(resolveBillingMonth("2024-01", NOW), "2024-01");
  assert.equal(resolveBillingMonth("2023-12", NOW), NOW);
  assert.equal(resolveBillingMonth("1999-05", NOW), NOW);
  // 이번 달 + 2달까지(연말을 넘겨 2027-01)
  assert.equal(resolveBillingMonth("2027-01", NOW), "2027-01");
  assert.equal(resolveBillingMonth("2027-02", NOW), NOW);
  assert.equal(resolveBillingMonth("9999-12", NOW), NOW);
});

test("달 이동: 연말 경계(12월 → 1월, 1월 → 12월)와 범위 끝", () => {
  assert.equal(shiftBillingMonth("2026-11", -1, NOW), "2026-10");
  assert.equal(shiftBillingMonth("2026-11", 1, NOW), "2026-12");
  assert.equal(shiftBillingMonth("2026-12", 1, NOW), "2027-01");
  assert.equal(shiftBillingMonth("2026-01", -1, NOW), "2025-12");
  assert.equal(shiftBillingMonth("2025-12", 1, NOW), "2026-01");
  // 12월이 «이번 달»일 때도 다음 해로 넘어간다
  assert.equal(shiftBillingMonth("2026-12", 1, "2026-12"), "2027-01");
  assert.equal(shiftBillingMonth("2027-02", 1, "2026-12"), null);
  // 범위 끝에서는 null(버튼을 잠근다)
  assert.equal(shiftBillingMonth("2027-01", 1, NOW), null);
  assert.equal(shiftBillingMonth("2024-01", -1, NOW), null);
  assert.equal(shiftBillingMonth("엉뚱한 값", 1, NOW), null);
});

test("달 표시·SQL 숫자", () => {
  assert.deepEqual(splitBillingMonth("2026-09"), { year: 2026, month: 9 });
  assert.equal(billingMonthLabel("2026-09"), "2026년 9월");
  assert.equal(billingMonthLabel("2026-12"), "2026년 12월");
  assert.equal(billingMonthLabel("2026-13"), "");
});

test("구멍 보완 판정: 반 정보 없는 월 청구는 «학생의 활성 수강 반이 전부 내 담당 반»일 때만", () => {
  const mine = ["class-a", "class-b"];
  // 반 1개 · 내 반 → 보인다
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: false, studentActiveClassIds: ["class-a"], accessibleClassIds: mine }), true);
  // 반 2개 · 둘 다 내 반 → 보인다(한 선생님이 두 반을 모두 맡은 경우)
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: false, studentActiveClassIds: ["class-a", "class-b"], accessibleClassIds: mine }), true);
  // 반 2개 · 하나는 남의 반 → 어느 선생님에게도 안 보인다(예전에는 양쪽에 보였다)
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: false, studentActiveClassIds: ["class-a", "class-x"], accessibleClassIds: mine }), false);
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: false, studentActiveClassIds: ["class-a", "class-x"], accessibleClassIds: ["class-x"] }), false);
  // 반 1개지만 내 반이 아니다
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: false, studentActiveClassIds: ["class-x"], accessibleClassIds: mine }), false);
  // 활성 수강 0개 → 선생님도 원장도 이을 반이 없다
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: false, studentActiveClassIds: [], accessibleClassIds: mine }), false);
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: true, studentActiveClassIds: [], accessibleClassIds: [] }), false);
  // 원장·부원장은 지금처럼 전부
  assert.equal(canSeeUnlinkedMonthlyBill({ canAccessAllClasses: true, studentActiveClassIds: ["class-a", "class-x"], accessibleClassIds: [] }), true);
});

test("구멍 보완 SQL 조각: 두 화면이 같은 조각을 쓰고 자리 표시만 받는다", () => {
  const sql = unlinkedMonthlyBillScopeSql("$1", "$2");
  // 반 정보가 있거나 · 원장/부원장이거나 · 내 담당 반에 없는 활성 수강이 하나도 없다
  assert.match(sql, /^\(p\."classId" IS NOT NULL OR \$2::boolean\s+OR NOT EXISTS \(SELECT 1 FROM "Enrollment" e2 WHERE e2\."studentId"=p\."studentId" AND e2\.status='ACTIVE' AND NOT \(e2\."classId"=ANY\(\$1::text\[\]\)\)\)\)$/);
  assert.match(unlinkedMonthlyBillScopeSql("$3", "$4"), /\$4::boolean[\s\S]*ANY\(\$3::text\[\]\)/);
  // 값이나 SQL 조각을 넘기면 거부한다
  for (const bad of ["1", "$", "$1; DROP TABLE x", "'a'", ""]) {
    assert.throws(() => unlinkedMonthlyBillScopeSql(bad, "$2"));
    assert.throws(() => unlinkedMonthlyBillScopeSql("$1", bad));
  }
  // 청구 탭
  assert.match(query, /AND \$\{unlinkedMonthlyBillScopeSql\("\$1", "\$2"\)\}/);
  // 반별 청구 시트: 담당 반 전부($3)·원장 여부($4)를 같은 순서로 넘긴다
  const classBilling = read("src/lib/staff-class-billing.ts");
  assert.match(classBilling, /AND \$\{unlinkedMonthlyBillScopeSql\("\$3", "\$4"\)\}/);
  assert.match(classBilling, /const access = await requireStaffClassAccess\(normalizedClassId\);\s*(\/\/[^\n]*\s*)*const accessibleClassIds = await getAccessibleClassIds\(access\);/);
  assert.match(classBilling, /normalizedClassId,\s*normalizedStudentId,\s*accessibleClassIds,\s*access\.canAccessAllClasses,/);
  // 옛 «하나뿐» 규칙이 남아 있지 않다
  assert.doesNotMatch(query + classBilling, /COUNT\(DISTINCT e2/);
});

test("조회 SQL: 담당 반 범위 + 구멍 보완 + 미납은 달과 상관없이 포함", () => {
  const body = query.slice(query.indexOf("export async function getStaffBilling"));
  // 담당 반 수강으로만 잇는다(반 id 는 화면에서 받지 않는다)
  assert.match(body, /e\.status='ACTIVE' AND e\."classId"=ANY\(\$1::text\[\]\)/);
  assert.match(body, /getStaffBilling\(options: \{ month\?: string \} = \{\}\)/);
  assert.doesNotMatch(body, /options\.classId|classId\?: string/);
  // 구멍 보완 조각(내용은 아래 «SQL 조각» 테스트가 실행으로 확인)
  assert.match(body, /AND \$\{unlinkedMonthlyBillScopeSql\("\$1", "\$2"\)\}/);
  // 미납은 달 조건 밖, 납부 완료·환불만 고른 달
  assert.match(body, /AND \(p\.status IN \('PENDING','OVERDUE'\) OR \(p\.status IN \('PAID','REFUNDED'\) AND p\.year=\$3::int AND p\.month=\$4::int\)\)/);
  // 환불 건만 취소된 청구서를 허용한다
  assert.match(body, /AND \(i\.status <> 'CANCELED' OR p\.status='REFUNDED'\)/);
  // 인자 순서: 담당 반 · 전체 반 여부 · 연 · 월 (달 글자를 SQL 에 이어 붙이지 않는다)
  assert.match(body, /classIds, access\.canAccessAllClasses, year, month,/);
  assert.match(body, /splitBillingMonth\(resolveBillingMonth\(options\.month, currentMonth\)\)/);
  assert.match(body, /const currentMonth = todayKst\(\)\.slice\(0, 7\);/);
  assert.doesNotMatch(body, /\$\{(year|month|options|classIds|access)/);
});

test("페이지: 주소의 달을 검사해 넘기고 역할을 내려 준다", () => {
  assert.match(page, /resolveBillingMonth\(\(await searchParams\)\.month, currentMonth\)/);
  assert.match(page, /todayKst\(\)\.slice\(0, 7\)/);
  assert.match(page, /getStaffBilling\(\{ month \}\)/);
  assert.match(page, /seesAllClasses=\{access\.canAccessAllClasses\}/);
  assert.doesNotMatch(page, /classId/);
});

test("화면: «조회» 버튼 하나 + 모달(달 이동·반·이름·초기화·적용)", () => {
  assert.match(client, /onClick=\{openLookup\} aria-haspopup="dialog" className="academy-button-secondary shrink-0">\s*\{lookupCount > 0 \? `조회 \$\{lookupCount\}` : "조회"\}/);
  assert.match(client, /useStaffDialog\(lookupOpen, lookupRef, closeLookup\)/);
  assert.match(client, /role="dialog" aria-modal="true" aria-labelledby="billing-lookup-title"/);
  // 달 이동은 글자 버튼, 범위 밖은 잠금
  assert.match(client, /disabled=\{!prevMonth\} onClick=\{\(\) => prevMonth && setDraftMonth\(prevMonth\)\} className="academy-button-secondary shrink-0">이전<\/button>/);
  assert.match(client, /disabled=\{!nextMonth\} onClick=\{\(\) => nextMonth && setDraftMonth\(nextMonth\)\} className="academy-button-secondary shrink-0">다음<\/button>/);
  // 반 고르기는 반이 2개 이상일 때만
  assert.match(client, /\{classOptions\.length >= 2 && \(/);
  assert.match(client, /id="billing-lookup-name"/);
  assert.match(client, /onClick=\{resetLookup\} className="academy-button-secondary">초기화<\/button>/);
  assert.match(client, /onClick=\{applyLookup\} className="academy-button-primary">적용<\/button>/);
  // 달은 주소 이동(서버 재조회), 반·이름은 받은 목록을 화면에서 거른다
  assert.match(client, /if \(draftMonth !== month\) router\.push\(draftMonth === currentMonth \? "\/staff\/billing" : `\/staff\/billing\?month=\$\{draftMonth\}`\)/);
  assert.match(client, /const scoped = bills\.filter\(\(bill\) => matchesBillingLookup\(bill, lookup\)\)/);
  assert.match(client, /const visible = scoped\.filter\(\(bill\) => matchesFilter\(bill, filter\)\)/);
  // 지금 보는 달·범위 안내·행의 반 이름
  assert.match(client, /\{billingMonthLabel\(month\)\} · 지난 미납 포함/);
  assert.match(client, /seesAllClasses \? "전체 반 보기\(원장·부원장\)" : "내가 맡은 반의 청구만 보입니다"/);
  assert.match(client, /\{bill\.className\} · \{bill\.title\}/);
  assert.doesNotMatch(client, /담당 수업 전용/);
});

test("화면에서 거르기·적용 개수", () => {
  const bill = { classId: "class-a", studentName: "김하늘" };
  assert.equal(matchesBillingLookup(bill, { classId: "", name: "" }), true);
  assert.equal(matchesBillingLookup(bill, { classId: "class-a", name: " 하늘 " }), true);
  assert.equal(matchesBillingLookup(bill, { classId: "class-b", name: "" }), false);
  assert.equal(matchesBillingLookup(bill, { classId: "", name: "바다" }), false);
  assert.equal(countBillingLookup(NOW, NOW, { classId: "", name: "  " }), 0);
  assert.equal(countBillingLookup("2026-10", NOW, { classId: "class-a", name: "김" }), 3);
  assert.equal(countBillingLookup(NOW, NOW, { classId: "class-a", name: "" }), 1);
});
