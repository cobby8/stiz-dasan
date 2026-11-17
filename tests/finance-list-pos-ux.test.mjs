// 수납 목록 POS 사용성(2026-11-08 원장 승인표) — 삭제 막기·메뉴 이름·묶음 표시·학생 미납 모두 현장 결제·선택 막대
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const finance = readFileSync(new URL("../src/app/admin/finance/FinanceClient.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");

// 함수 본문만 잘라 본다(다른 함수의 문자열에 우연히 걸리지 않게)
function body(source, head) {
  const start = source.indexOf(head);
  assert.ok(start >= 0, `${head} 없음`);
  const rest = source.slice(start).replace(/\r\n/g, "\n");
  // 맨 바깥 함수는 "\n}\n", 컴포넌트 안 함수는 같은 들여쓰기의 "\n    }\n" 에서 끝난다
  const indent = head.match(/^ */)[0];
  const end = rest.indexOf(`\n${indent}}\n`);
  return end > 0 ? rest.slice(0, end + indent.length + 2) : rest;
}

test("서버 삭제: 토스 POS·POS 요청에 묶인 청구만 DB 로 확인해 막는다(계좌이체 납부완료는 예전처럼 삭제 가능)", () => {
  const del = body(actions, "export async function deletePayment");
  assert.match(del, /await requireFinanceOwner\(\)/);
  assert.doesNotMatch(del, /p\.status = 'PAID'/, "원장 승인 범위는 POS 결제만");
  assert.match(del, /p\."paidProvider" = 'TOSS_POS'/);
  assert.match(del, /"PosChargeRequestItem"/);
  assert.match(del, /r\."cancelState" IS NOT NULL/);
  // 확인 쿼리가 DELETE 보다 먼저
  assert.ok(del.indexOf("$queryRawUnsafe") < del.indexOf("DELETE FROM"));
  assert.match(del, /if \(blocked\) throw new Error\(PAYMENT_DELETE_BLOCKED_MESSAGE\)/);
  assert.match(actions, /현장 결제\(POS\)로 받았거나 POS 요청에 묶인 청구는 삭제할 수 없어요\. 먼저 결제 취소\(환불\)를 해 주세요\./);
});

test("⚡ 메뉴: «기록 영구 삭제»는 POS 결제·묶인 청구에서 숨긴다", () => {
  assert.match(finance, /p\.paidProvider !== "TOSS_POS" && !p\.posLocked && !p\.posBundleCode \? \[\s*\{\s*key: "delete"/);
  assert.match(finance, /label: "기록 영구 삭제"/);
  assert.doesNotMatch(finance, /label: "삭제"/);
});

test("⚡ 메뉴 이름: «청구서 삭제»(동작은 cancelUnpaidPayment 그대로)·«결제 취소» 유지, 되돌릴 수 없는 것은 위험색", () => {
  assert.match(finance, /key: "cancel",[\s\S]{0,200}label: "청구서 삭제",\s*icon: "cancel",\s*tone: "danger"/);
  assert.doesNotMatch(finance, /label: "청구 취소"/);
  assert.match(finance, /label: "결제 취소",\s*icon: "credit_card_off",\s*tone: "danger"/);
  assert.match(finance, /label: "기록 영구 삭제",\s*icon: "delete",\s*tone: "danger"/);
});

test("묶음 표시: 서버가 결제된 묶음(항목 2개 이상)만 번호·건수를 붙이고, 행·패널이 쓴다", () => {
  assert.match(queries, /posBundleCode: posInfo\.get/);
  assert.match(queries, /paidLike && count >= 2/);
  assert.match(queries, /status === "PAID" \|\| row\.cancel_state != null/);
  assert.match(finance, /묶음 \{p\.posBundleSize\}건/);
  assert.match(finance, /함께 결제한 청구 \{d\.posBundleSize\}건/);
  assert.match(finance, /외 \{bundleOtherCount\}건\(다른 달\)/);
});

test("이 학생 미납 전체 현장 결제(2026-11-17): «모든 달» 미납 2건 이상일 때, 서버에서 모든 달·형제 미납을 읽어 preferPos 로 연다", () => {
  assert.ok(finance.includes("studentOutstanding.count >= 2"));
  assert.ok(finance.includes("이 학생 미납 전체 현장 결제 (${studentOutstanding.count}건 · ${formatAmount(studentOutstanding.amount)})"));
  assert.ok(finance.includes("onSelect: () => void openAllUnpaid(p.studentId)"));
  // 이 달 목록이 아니라 서버(모든 달)에서 읽는다
  assert.ok(finance.includes("/api/admin/finance/student-unpaid?studentId="));
  assert.match(finance, /setRecordPreferPos\(true\);\s*setRecordTargets\(all\)/);
  assert.ok(finance.includes("preferPos={recordPreferPos}"));
  // 형제·나머지는 POS 창을 닫으면 이어서(«납부 처리» 창 다시)
  assert.ok(finance.includes("setPendingFamily(rest.length > 0 ? rest : null)"));
  // 학생 상세 «미납 전체 현장 결제» → ?studentId=…&pay=all 로 바로 연다
  assert.ok(finance.includes(`searchParams.get("pay") === "all"`));
  const detail = readFileSync(new URL("../src/app/admin/students/[id]/StudentDetailClient.tsx", import.meta.url), "utf8");
  assert.ok(detail.includes("/admin/finance?studentId=${encodeURIComponent(student.id)}&pay=all"));
});

test("선택 막대: 고른 것 전부를 넘기고, 화면 밖 선택을 알린다 · label 을 넘긴다", () => {
  const bulk = body(finance, "    function handleBulkPaid()");
  assert.doesNotMatch(bulk, /\["PENDING", "OVERDUE"\]/);
  assert.match(bulk, /payments\.filter\(\(p\) => selectedIds\.has\(p\.id\)\)/);
  assert.match(finance, /화면 밖 \$\{hiddenSelectedCount\}건 포함/);
  assert.match(finance, /label: paymentLabel\(t\)/);
});

test("학생 전체 미납 API(2026-11-17): 관리자만, 미납·연체만, 형제는 같은 보호자·합쳐진 학생 제외, 역할 가림 통과", () => {
  const route = readFileSync(new URL("../src/app/api/admin/finance/student-unpaid/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("await requireTimedAdmin(timing)"));
  assert.ok(route.includes("maskFinancePayloadForRole({ payments: rows, summary: {} }, role)"));
  assert.ok(route.includes(`"Cache-Control": "private, no-store"`));
  assert.ok(queries.includes(`WHERE p."studentId" = ANY($1::text[]) AND p.status IN ('PENDING', 'OVERDUE')`));
  assert.ok(queries.includes(`JOIN "Student" s ON s."parentId" = me."parentId" AND \${notMergedStudent("s")}`));
  // 월 목록 응답에 학생별 «모든 달» 미납 집계가 붙는다(«밀린 미납» 표시)
  const payloads = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
  assert.ok(payloads.includes("return { payments, summary, outstanding, paymentProvider: getPaymentProviderPublicStatus() };"));
  assert.ok(finance.includes("밀린 미납 {all}건"));
});
