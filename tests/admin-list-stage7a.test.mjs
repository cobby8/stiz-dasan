// 관리자 목록 개편 7단계 A묶음(나머지 관리 화면) — 1~6단계와 같은 약속을 화면마다 못박는다.
// 약속: ① 한 줄 행(admin-list-table)·말줄임 금지 ② 날짜·숫자 칸은 admin-cell-num
//       ③ 행 클릭 → ListDetailPanel, 행 키보드는 행 자신일 때만, ⚡ 칸은 전파 차단
//       ④ 승인·반려·처리 버튼은 옮겨도 같은 함수·같은 인자·같은 확인 단계
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// 공통 목록 약속(표·패널·키보드·⚡ 전파 차단)
function assertListStandard(source, name) {
  assert.match(source, /<table className="admin-list-table/, `${name}: 공통 목록 표`);
  assert.match(source, /admin-cell-num/, `${name}: 숫자·날짜 오른쪽`);
  assert.match(source, /<ListDetailPanel/, `${name}: 행 클릭 상세 패널`);
  assert.match(source, /if \(event\.target !== event\.currentTarget\) return;/, `${name}: 행 안 버튼의 키는 가로채지 않음`);
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/, `${name}: ⚡ 칸 전파 차단`);
  assert.doesNotMatch(source, /\btruncate\b|text-ellipsis|line-clamp/, `${name}: 말줄임 금지`);
}

test("탈퇴 신청: 한 줄 표 + ⚡·패널, «정말 삭제» 확인 단계와 반려는 같은 함수로 남는다", () => {
  const source = read("../src/app/admin/withdrawals/WithdrawalsClient.tsx");
  assertListStandard(source, "탈퇴");
  assert.match(source, /<AdminQuickActionMenu label=\{`\$\{row\.name\} 탈퇴 신청 빠른 작업`\}/);
  // 탈퇴 처리는 바로 지우지 않고 확인 창을 연다 → 확인 창에서만 approveWithdrawalRequest
  assert.match(source, /label: "탈퇴 처리"[^\n]*onSelect: \(\) => setConfirming\(userId\)/);
  assert.match(source, /onClick=\{\(\) => run\(\(\) => approveWithdrawalRequest\(confirmTarget\.userId\)\)\}/);
  assert.match(source, /label: "신청 반려"[^\n]*rejectWithdrawalRequest\(userId\)/);
  // 이관 대기 회원은 예전처럼 처리 버튼 없음
  assert.match(source, /if \(row\.administrativeHold\) return \[\];/);
  assert.match(source, /업무·권한 이관 후 처리/);
});

test("직원 역할 신청: 두 목록 모두 한 줄 표 + ⚡·패널, 승인·회수는 확인 창에서만 확정", () => {
  const source = read("../src/app/admin/role-requests/RoleRequestsClient.tsx");
  assertListStandard(source, "역할 신청");
  // «이름 (학부모)» 를 붙이지 않고 기본 역할을 칸으로 나눴다
  assert.doesNotMatch(source, /\(\{PRIMARY_LABEL\[row\.primaryRole\]/);
  // 승인·회수는 확인 단계를 연다 → 확인 창에서 approveRoleRequest / revokeRoleGrant
  assert.match(source, /label: "승인"[^\n]*onSelect: \(\) => setConfirming\(id\)/);
  assert.match(source, /label: "회수"[^\n]*onSelect: \(\) => setConfirming\(id\)/);
  assert.match(source, /label: "반려"[^\n]*rejectRoleRequest\(id\)/);
  assert.match(source, /run\(\(\) => approveRoleRequest\(confirmPending\.id\)\)/);
  assert.match(source, /run\(\(\) => revokeRoleGrant\(confirmTarget\.id\)\)/);
  // 원장이 아니면 작업 없음(서버도 다시 막는다)
  assert.match(source, /if \(!canDecide\) return \[\];/);
});

test("입금 확인·영수증 요청: 카드 → 한 줄 표, 입력칸·처리 버튼은 패널로(같은 decide 인자)", () => {
  const source = read("../src/app/admin/payment-requests/PaymentRequestsClient.tsx");
  assertListStandard(source, "입금 확인");
  // 예전 «항목 · 금액 · 기한» 을 칸으로 나눠 금액은 오른쪽
  assert.doesNotMatch(source, /\{row\.description \|\| "수강료"\} · /);
  assert.match(source, /admin-cell-num[^"]*">\{row\.amount\.toLocaleString\(\)\}원/);
  // 처리 함수와 인자(전할 말·영수증 링크)는 그대로
  assert.match(source, /decidePaymentRequest\(\{\s*requestId,\s*approve,\s*note: notes\[requestId\],\s*receiptUrl: receipts\[requestId\],\s*\}\)/);
  assert.match(source, /onSelect: \(\) => decide\(id, true\)/);
  assert.match(source, /onSelect: \(\) => decide\(id, false\)/);
  assert.match(source, /onClick=\{\(\) => decide\(row\.id, true\)\}/);
  assert.match(source, /onClick=\{\(\) => decide\(row\.id, false\)\}/);
  assert.match(source, /학부모에게 전할 말 \(확인 안 됨으로 처리할 때 함께 전달됩니다\)/);
  assert.match(source, /영수증 링크 \(있으면 붙여넣기/);
  // 처리 대상은 확인 중(PENDING) 건만
  assert.match(source, /if \(row\.status !== "PENDING"\) return \[\];/);
});

test("담당자 전달 장부: 카드 → 한 줄 표 + 패널(조회 전용), 필터는 한 줄, 묶음은 tbody", () => {
  const source = read("../src/app/admin/notification-deliveries/OperationalDeliveryClient.tsx");
  assert.match(source, /<table className="admin-list-table/);
  assert.match(source, /admin-cell-num[^"]*"><time>\{formatTime\(row\.updatedAt\)\}<\/time>/);
  assert.match(source, /<ListDetailPanel/);
  assert.match(source, /if \(event\.target !== event\.currentTarget\) return;/);
  assert.doesNotMatch(source, /\btruncate\b|text-ellipsis|line-clamp/);
  // 같은 요청·담당자의 채널 기록 묶음은 그대로(tbody 하나씩)
  assert.match(source, /groupOperationalDeliveries\(rows\)\.map\(\(group\) => <tbody/);
  // 예전 카드의 시각 3종·오류 문구는 패널에서
  for (const field of ["row.sentAt", "row.failedAt", "row.nextAttemptAt", "row.errorMessage"]) {
    assert.ok(source.includes(field), `${field} 는 패널에 남아야 합니다`);
  }
  // 필터를 바꾸면 열린 패널을 닫는다
  assert.match(source, /function changeStatus\(value: string\) \{ setDetailId\(null\); setStatus\(value\); \}/);
});

test("대기자 관리: 반별 묶음 한 줄 표 + ⚡·패널, 상태 칩은 «완료/취소 포함» 체크와 같은 상태값", () => {
  const source = read("../src/app/admin/waitlist/WaitlistClient.tsx");
  assertListStandard(source, "대기자");
  assert.match(source, /scope="rowgroup"/);
  // 체크박스와 칩이 같은 statusFilter 를 쓴다(기본 = 대기중+제안됨)
  assert.match(source, /const showAll = statusFilter === STATUS_ALL;/);
  assert.match(source, /<StatusCountChips[\s\S]*?selected=\{statusFilter\}[\s\S]*?allValue=\{STATUS_ACTIVE\}/);
  assert.match(source, /onChange=\{\(e\) => changeStatusFilter\(e\.target\.checked \? STATUS_ALL : STATUS_ACTIVE\)\}/);
  // 예전 행 버튼(자리 제안·수락·거절·대기 취소)은 같은 함수로 ⚡·패널에
  for (const [label, fn] of [["자리 제안", "handleOffer"], ["수락", "handleAccept"], ["거절", "handleReject"], ["대기 취소", "handleCancel"]]) {
    assert.ok(new RegExp(`label: "${label}"[^\\n]*onSelect: \\(\\) => ${fn}\\(id\\)`).test(source), `${label} → ${fn}`);
  }
  // 각 처리 함수의 확인창은 그대로
  assert.match(source, /confirm\("이 대기자에게 자리를 제안하시겠습니까\?"\)/);
  assert.match(source, /confirm\("수락 처리하시겠습니까\? 수강 등록이 생성됩니다\."\)/);
  // 응답 기한은 KST 모듈로(브라우저 시간대 toLocaleDateString 금지)
  assert.doesNotMatch(source, /toLocaleDateString/);
  assert.match(source, /kstLabel\(w\.respondBy\)/);
});
