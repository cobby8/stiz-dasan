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
