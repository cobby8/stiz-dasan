import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// 원장이 재학 중 학부모의 탈퇴를 확인·처리하는 화면.
// 여기서 가장 조용히 깨지는 것은 ①사이드바 링크 ②권한 가드 ③두 경로의 분기다.

const shell = fs.readFileSync("src/app/admin/AdminShellClient.tsx", "utf8");
const action = fs.readFileSync("src/app/actions/account-withdrawal-admin.ts", "utf8");
const page = fs.readFileSync("src/app/admin/withdrawals/page.tsx", "utf8");
const client = fs.readFileSync("src/app/admin/withdrawals/WithdrawalsClient.tsx", "utf8");
const parentAction = fs.readFileSync("src/app/actions/parent-account.ts", "utf8");

test("관리자 메뉴에서 탈퇴 신청 화면에 도달할 수 있다", () => {
  // 화면·액션·권한을 다 만들고 메뉴만 빠지면 URL 을 직접 치지 않는 한 아무도 못 쓴다.
  // 빌드·tsc·테스트가 모두 통과해 아무 신호가 없다 — 이 프로젝트에서 2회 실측된 사고다.
  // 🚫 이 단언을 "화면 파일이 존재한다"로 바꾸지 말 것. 사라지는 것은 언제나 링크 쪽이다.
  assert.match(shell, /\["\/admin\/withdrawals", "회원 탈퇴 신청"/);
  // 학부모 요청 계열과 같은 묶음에 있어야 원장이 찾는다.
  // 사이드바 묶음 개편(게슈탈트 A-11): «업무별 상세 메뉴» → «요청·신청함» 묶음
  const group = shell.slice(shell.indexOf('label: "요청·신청함"'), shell.indexOf('label: "수업 운영"'));
  assert.match(group, /\/admin\/withdrawals/, "학부모 요청 묶음 안에 있어야 한다");
});

test("목록·처리·반려가 모두 관리자 권한을 거친다", () => {
  for (const fn of ["getPendingWithdrawalRequests", "approveWithdrawalRequest", "rejectWithdrawalRequest"]) {
    const start = action.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} 가 없다`);
    const body = action.slice(start, start + 300);
    assert.match(body, /await requireAdmin\(\)/, `${fn} 가 관리자 권한을 확인하지 않는다`);
  }
});

test("처리 대기 중인 신청만 목록에 오른다", () => {
  // 이미 처리된 계정이 목록에 남으면 원장이 또 누른다.
  assert.match(action, /WHERE u\."withdrawRequestedAt" IS NOT NULL\s*\n\s*AND u\."withdrawnAt" IS NULL/);
  // 오래 기다린 신청이 위로 와야 한다.
  assert.match(action, /ORDER BY u\."withdrawRequestedAt" ASC/);
  // 누구의 보호자인지 보여야 판단할 수 있다. 병합된 유령 학생은 제외한다.
  assert.match(action, /"mergedIntoStudentId" IS NULL/);
});

test("목록이 낡았을 때의 오조작을 서버가 막는다", () => {
  // 화면이 보내는 값만 믿으면, 이미 처리된 계정이나 신청하지 않은 계정을 지울 수 있다.
  assert.match(action, /if \(row\.withdrawnAt\) return \{ error: "이미 탈퇴 처리된 계정입니다\." \}/);
  assert.match(action, /if \(!row\.withdrawRequestedAt\) return \{ error: "탈퇴를 신청하지 않은 계정입니다\." \}/);
  // 반려도 «신청이 살아 있는» 행에만 걸려야 한다.
  assert.match(action, /WHERE id = \$1 AND "withdrawRequestedAt" IS NOT NULL AND "withdrawnAt" IS NULL/);
  assert.match(action, /if \(affected !== 1\) throw new OwnAccountError\("처리할 탈퇴 신청이 없습니다\."/);
});

test("원장 처리와 학부모 즉시 탈퇴가 같은 함수를 쓴다", () => {
  // 두 경로가 갈리면 한쪽만 고쳐지는 사고가 난다(이 프로젝트에서 이미 겪었다).
  assert.match(action, /import \{ executeAccountWithdrawal \} from "@\/app\/actions\/parent-account"/);
  assert.match(action, /await executeAccountWithdrawal\(target\)/);
  assert.match(parentAction, /export async function executeAccountWithdrawal/);
  // 관리자 파일이 익명화 SQL 을 따로 들고 있으면 안 된다.
  assert.doesNotMatch(action, /SET email = \$2, name = \$3/);
  assert.doesNotMatch(action, /auth\.admin\.deleteUser/);
});

test("화면은 되돌릴 수 없음을 알리고 한 번 더 확인받는다", () => {
  assert.match(client, /되돌릴 수 없습니다/);
  // 목록에서 바로 지워지면 오조작이 난다 — 행마다 확인 단계를 둔다.
  assert.match(client, /confirming === row\.userId/);
  assert.match(client, /정말 삭제/);
  // 수업이 남아 있다는 사실이 눈에 띄어야 한다.
  assert.match(client, /개 반/);
  // 남는 기록도 함께 적어야 "출결까지 지워지나" 하는 오해가 없다.
  assert.match(client, /출결·납부\s*\n?\s*기록은 그대로 남습니다|출결·납부 기록은 그대로 남습니다/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
});

test("시각은 KST 공용 모듈로 표시한다", () => {
  // 서버는 UTC 로 돌아 toLocaleString 등을 쓰면 새벽에 날짜가 하루 밀린다.
  assert.match(client, /from "@\/lib\/datetime\/kst"/);
  assert.match(client, /kstLabel\(row\.requestedAt\)/);
});
