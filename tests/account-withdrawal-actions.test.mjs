import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 회원 탈퇴는 한 번 실행하면 되돌릴 수 없고 개인정보가 걸려 있다.
// 그래서 판정은 **실제로 돌려서** 확인하고, 지우지 말아야 할 것은 소스 계약으로 못박는다.

const {
  withdrawalState,
  canRequestWithdrawal,
  canCancelWithdrawalRequest,
  decideWithdrawal,
  anonymizedEmail,
  ANONYMIZED_NAME,
  CLEARED_USER_COLUMNS,
  RETAINED_TABLES,
} = await loadTsModule("src/lib/account/withdrawal.ts");

const action = fs.readFileSync("src/app/actions/parent-account.ts", "utf8");

// ── 상태 판정 ────────────────────────────────────────────────────────────────
test("두 시각으로 계정 상태를 정한다", () => {
  assert.equal(withdrawalState({}), "ACTIVE");
  assert.equal(withdrawalState({ withdrawRequestedAt: null, withdrawnAt: null }), "ACTIVE");
  assert.equal(withdrawalState({ withdrawRequestedAt: new Date() }), "PENDING");
  assert.equal(withdrawalState({ withdrawnAt: new Date() }), "WITHDRAWN");
  // 신청 시각이 비어 있어도 처리됐으면 탈퇴 완료다(재학 중이 아니어서 한 번에 끝난 경우).
  assert.equal(withdrawalState({ withdrawRequestedAt: null, withdrawnAt: new Date() }), "WITHDRAWN");
  // 문자열로 와도 같게 읽는다(raw SQL 결과가 문자열일 수 있다).
  assert.equal(withdrawalState({ withdrawnAt: "2026-10-24T01:00:00+09:00" }), "WITHDRAWN");
  // 쓰레기 값은 «없음»으로 본다 — 모르면 탈퇴로 단정하지 않는다.
  assert.equal(withdrawalState({ withdrawnAt: "   " }), "ACTIVE");
  assert.equal(withdrawalState({ withdrawnAt: "이건날짜아님" }), "ACTIVE");
});

test("이미 신청·탈퇴한 계정은 다시 신청하지 못하고, 처리된 탈퇴는 못 되돌린다", () => {
  assert.equal(canRequestWithdrawal({}), true);
  assert.equal(canRequestWithdrawal({ withdrawRequestedAt: new Date() }), false);
  assert.equal(canRequestWithdrawal({ withdrawnAt: new Date() }), false);

  assert.equal(canCancelWithdrawalRequest({ withdrawRequestedAt: new Date() }), true);
  assert.equal(canCancelWithdrawalRequest({}), false);
  // 되돌릴 수 없는 것을 되돌릴 수 있다고 하면 안 된다.
  assert.equal(canCancelWithdrawalRequest({ withdrawRequestedAt: new Date(), withdrawnAt: new Date() }), false);
});

// ── 즉시 처리 / 신청만 ────────────────────────────────────────────────────────
test("재학 중이면 즉시 지우지 않고 신청만 받는다", () => {
  // 원장 결정 2026-10-24: 수업 다니는 아이의 보호자 연락이 끊기면 현장 사고가 된다.
  assert.deepEqual(decideWithdrawal({ activeEnrollmentCount: 0 }), { action: "EXECUTE_NOW" });
  assert.deepEqual(decideWithdrawal({ activeEnrollmentCount: 1 }), { action: "REQUEST_ONLY", activeEnrollmentCount: 1 });
  assert.deepEqual(decideWithdrawal({ activeEnrollmentCount: 3 }), { action: "REQUEST_ONLY", activeEnrollmentCount: 3 });
});

test("수강 건수가 이상한 값이면 지우지 않는 쪽으로 판단한다", () => {
  // 모르면 «재학 중»으로 본다. 반대로 틀리면 되돌릴 수 없다.
  for (const bad of [NaN, undefined, null, "", "abc", -1, Infinity]) {
    const decision = decideWithdrawal({ activeEnrollmentCount: bad });
    assert.equal(decision.action, "REQUEST_ONLY", `${String(bad)} 에서 즉시 삭제로 판단하면 안 된다`);
  }
});

// ── 익명화 값 ────────────────────────────────────────────────────────────────
test("익명 이메일은 존재할 수 없는 도메인을 쓰고 사용자마다 다르다", () => {
  const a = anonymizedEmail("abc-123");
  // RFC 2606 예약 도메인 — 실수로 메일이 나가지 않는다.
  assert.match(a, /@deleted\.invalid$/);
  assert.match(a, /^withdrawn\+abc-123@/);
  // 유니크 컬럼이라 사용자마다 달라야 한다(같으면 두 번째 탈퇴가 실패한다).
  assert.notEqual(a, anonymizedEmail("abc-124"));
  // 같은 사용자는 몇 번 불러도 같은 값(재시도해도 안전).
  assert.equal(a, anonymizedEmail("abc-123"));
  // SQL·메일 주소를 깨뜨리는 문자는 걸러낸다.
  assert.equal(anonymizedEmail("a'b\"c; DROP--"), "withdrawn+abcDROP--@deleted.invalid");
  // ID 가 비면 조용히 넘기지 않고 멈춘다 — 엉뚱한 행을 익명화하면 안 된다.
  assert.throws(() => anonymizedEmail(""), /사용자 ID/);
  assert.throws(() => anonymizedEmail("!!!"), /사용자 ID/);
});

test("익명 이름은 비어 있지 않다", () => {
  // 빈 문자열이면 장부·화면이 깨진다.
  assert.ok(ANONYMIZED_NAME.trim().length > 0);
});

// ── 서버 액션 계약 ───────────────────────────────────────────────────────────
test("Auth 계정을 DB 익명화보다 먼저 지운다", () => {
  // 반대 순서면 «이름·이메일은 익명인데 로그인은 되는» 상태가 생겨 자녀 정보가 노출된다.
  const authAt = action.indexOf("auth.admin.deleteUser");
  const anonymizeAt = action.indexOf('UPDATE "User"\n            SET email = $2');
  assert.ok(authAt > 0, "Auth 삭제 호출이 없다");
  assert.ok(anonymizeAt > 0, "익명화 UPDATE 를 찾지 못했다");
  assert.ok(authAt < anonymizeAt, "Auth 삭제가 익명화보다 뒤에 있으면 로그인 가능한 익명 계정이 생긴다");
});

test("법령·장부 보관 대상은 지우지 않는다", () => {
  // 가장 위험한 실수 — 학생·출결·결제를 지우면 학원 장부가 깨지고 전자상거래법 5년 보관도 위반한다.
  for (const table of RETAINED_TABLES) {
    assert.doesNotMatch(
      action,
      new RegExp(`DELETE\\s+FROM\\s+"${table}"`),
      `${table} 를 지우고 있다 — 장부이자 법령 보관 대상이다`,
    );
  }
  // 학생 테이블은 조회(SELECT)로만 쓰여야 한다 — 셔틀 좌표를 찾는 용도.
  assert.match(action, /SELECT id FROM "Student" WHERE "parentId" = \$1/);
});

test("지우는 것은 로그인 수단·연락 수단·위치정보뿐이다", () => {
  assert.match(action, /DELETE FROM "PushSubscription" WHERE "userId" = \$1/);
  assert.match(action, /DELETE FROM "StudentShuttleLocation"/);
  // 카카오는 행을 지우지 않고 연결만 끊는다(Cascade 로 운영 기록이 함께 사라지는 것을 막는다).
  assert.match(action, /UPDATE "KakaoParentIdentity"[\s\S]*?"parentUserId" = NULL[\s\S]*?status = 'REVOKED'/);
  assert.doesNotMatch(action, /DELETE\s+FROM\s+"KakaoParentIdentity"/);
  // 비울 칸은 액션에 적지 않고 상수에서 만든다 — 두 곳에 적으면 한쪽만 늘어난다.
  // 그래서 리터럴을 찾는 게 아니라 «상수를 써서 NULL 로 만든다»를 확인한다.
  assert.match(action, /CLEARED_USER_COLUMNS\.map\(\(column\) => `"\$\{column\}" = NULL`\)/);
  // 그 상수가 로그인·연락 수단을 빠뜨리지 않았는지는 목록 자체로 본다.
  for (const column of ["phone", "phoneVerifiedAt", "authUserId"]) {
    assert.ok(CLEARED_USER_COLUMNS.includes(column), `${column} 가 비우는 목록에 없다`);
  }
  // 이메일·이름은 NULL 이 안 되는 칸이라 값을 바꿔 넣는다(아래에서 따로 확인).
  assert.match(action, /SET email = \$2, name = \$3/);
});

test("탈퇴 경로가 모두 인증을 거치고, 즉시 탈퇴와 승인이 같은 함수를 쓴다", () => {
  // 남의 계정을 지울 수 있으면 끝이다.
  for (const fn of ["getAccountWithdrawalStatus", "requestAccountWithdrawal", "cancelAccountWithdrawalRequest"]) {
    const start = action.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} 가 없다`);
    const body = action.slice(start, start + 400);
    assert.match(body, /requireVerifiedParent\(\)/, `${fn} 가 학부모 인증을 거치지 않는다`);
  }
  // 두 경로가 갈리면 한쪽만 고쳐지는 사고가 난다(이 프로젝트에서 이미 겪었다).
  assert.match(action, /executeAccountWithdrawal\(parent\.appUserId\)/);
  assert.match(action, /export async function executeAccountWithdrawal/);
});

test("중복 실행과 알림 실패가 탈퇴를 막지 않는다", () => {
  // 이미 탈퇴한 계정을 다시 처리하면 withdrawnAt 이 덮여 보관 기산일이 밀린다.
  assert.match(action, /if \(row\.withdrawnAt\) return \{ ok: true, alreadyWithdrawn: true \}/);
  // 신청 시각은 한 번만 남긴다.
  assert.match(action, /COALESCE\("withdrawRequestedAt", NOW\(\)\)/);
  // 원장 알림이 실패해도 신청은 이미 접수된 상태여야 한다.
  assert.match(action, /catch[\s\S]*?원장 알림 실패/);
});
