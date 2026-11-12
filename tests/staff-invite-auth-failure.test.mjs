// 직원 초대 가입 — 약한 비밀번호 거절이 초대를 잠그던 사고(2026-11-12 20:11 KST) 재발 방지.
// 순수 판정(inviteAuthFailure)은 실제로 실행하고, acceptInvitation 연결부는 소스 모양으로 못박는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTsModule } from "./_ts-module.mjs";

const mod = await loadTsModule("src/lib/staff/inviteAuthFailure.ts");
const {
  classifyAuthFailure,
  decideInviteFailureOutcome,
  commonPasswordWarning,
  STAFF_WEAK_PASSWORD_MESSAGE,
  staffAuthFailureMessage,
} = mod;

// 운영 사고 때 Supabase 가 돌려준 것과 같은 모양(AuthWeakPasswordError, 422)
const WEAK = { name: "AuthWeakPasswordError", status: 422, code: "weak_password", message: "Password is known to be weak and easy to guess, please choose a different one." };

test("판정: 4xx 거절은 «확실히 안 만들어짐», 네트워크·5xx·408 은 «결과 모름»", () => {
  assert.equal(classifyAuthFailure(WEAK), "weak_password");
  // 예전 서버(코드 없음)도 문구로 약한 비밀번호를 알아본다
  assert.equal(classifyAuthFailure({ status: 422, message: "Password is known to be weak and easy to guess" }), "weak_password");
  assert.equal(classifyAuthFailure({ status: 422, code: "email_exists", message: "A user with this email address has already been registered" }), "already_exists");
  assert.equal(classifyAuthFailure({ status: 400, code: "validation_failed", message: "Unable to validate email address: invalid format" }), "rejected");
  // 비밀번호와 무관한 거절 — «다른 비밀번호를 써 주세요»로 보이면 안 된다
  assert.equal(classifyAuthFailure({ status: 429, code: "over_request_rate_limit", message: "rate limit" }), "rate_limited");
  assert.equal(classifyAuthFailure({ status: 401, code: "no_authorization", message: "invalid JWT" }), "config_error");
  assert.equal(classifyAuthFailure({ status: 403, code: "not_admin", message: "User not allowed" }), "config_error");
  // 결과 모름 — 만들어졌을 수 있다
  assert.equal(classifyAuthFailure({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }), "uncertain");
  assert.equal(classifyAuthFailure({ name: "AuthRetryableFetchError", status: 503, message: "Service Unavailable" }), "uncertain");
  assert.equal(classifyAuthFailure({ name: "AuthApiError", status: 500, message: "Database error creating new user" }), "uncertain");
  assert.equal(classifyAuthFailure({ status: 408, message: "timeout" }), "uncertain");
  assert.equal(classifyAuthFailure({ name: "AuthUnknownError", message: "Unexpected token <" }), "uncertain");
  assert.equal(classifyAuthFailure(null), "uncertain");
  // 5xx 문구에 weak 가 섞여도 «결과 모름»이 우선
  assert.equal(classifyAuthFailure({ status: 502, message: "weak upstream" }), "uncertain");
});

test("약한 비밀번호 거절 → PENDING 복귀(문자 인증 유지)·같은 화면 재시도, 5xx → RECOVERY_REQUIRED 유지", () => {
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: "weak_password" }), "RETRY_KEEP_OTP");
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: "rejected" }), "RETRY_KEEP_OTP");
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: classifyAuthFailure({ status: 503 }) }), "RECOVERY_REQUIRED");
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: "uncertain" }), "RECOVERY_REQUIRED");
  // 이미 있는 계정은 기존처럼 PENDING + 인증부터 다시
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: "already_exists" }), "RESET_PENDING");
  // 계정을 만든 뒤 DB 단계에서 실패: 삭제 성공 → PENDING, 삭제 실패 → 잠금(고아 계정)
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: "u1", authDeleteFailed: false, authFailure: null }), "RESET_PENDING");
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: "u1", authDeleteFailed: true, authFailure: null }), "RECOVERY_REQUIRED");
  assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: null }), "RESET_PENDING");
});

test("안내 문구: 약한 비밀번호는 쉬운 한국어로, 공급자 영어 원문은 보이지 않는다", () => {
  assert.equal(STAFF_WEAK_PASSWORD_MESSAGE, "쉽게 추측할 수 있는 비밀번호예요. 다른 비밀번호를 써 주세요(숫자·영문 섞어 10자 이상).");
  assert.equal(staffAuthFailureMessage("weak_password"), STAFF_WEAK_PASSWORD_MESSAGE);
  for (const kind of ["weak_password", "already_exists", "rejected"]) {
    assert.doesNotMatch(staffAuthFailureMessage(kind), /[A-Za-z]{2,}/, `${kind} 문구에 영어가 섞이면 화면 필터가 일반 문구로 바꿔 버린다`);
  }
});

test("429·401·403 은 비밀번호 탓처럼 보이지 않고, 잠그지도 않는다", () => {
  assert.equal(staffAuthFailureMessage("rate_limited"), "요청이 많아요. 잠시 후 다시 시도해 주세요.");
  assert.equal(staffAuthFailureMessage("config_error"), "일시적인 문제예요. 관리자에게 알려 주세요.");
  for (const kind of ["rate_limited", "config_error"]) {
    assert.doesNotMatch(staffAuthFailureMessage(kind), /비밀번호/);
    assert.equal(decideInviteFailureOutcome({ createdAuthUserId: null, authDeleteFailed: false, authFailure: kind }), "RETRY_KEEP_OTP");
  }
});

test("실패 뒤 «인증부터 다시» 표식: 이미 가입된 계정은 붙이지 않고(문구 그대로), 그 밖의 RESET_PENDING 만", () => {
  const { failureNeedsVerification } = mod;
  assert.equal(failureNeedsVerification("RESET_PENDING", "already_exists"), false);
  assert.equal(failureNeedsVerification("RESET_PENDING", null), true, "DB 오류 등으로 인증까지 지웠다");
  assert.equal(failureNeedsVerification("RETRY_KEEP_OTP", "weak_password"), false);
  assert.equal(failureNeedsVerification("RECOVERY_REQUIRED", "uncertain"), false);
});

test("처리 시작 실패 사유: 중복 클릭·복구 필요·가입 완료는 «인증 만료»가 아니고, 진짜 만료만 인증부터 다시", () => {
  const { explainClaimFailure, STAFF_PROCESSING_MESSAGE, STAFF_NEEDS_VERIFICATION_MESSAGE } = mod;
  const ok = { role: "INSTRUCTOR", status: "PENDING", isExpired: false, otpVerified: true, otpExpired: false, otpConsumed: false, locked: false };
  // 중복 클릭 — 앞 요청이 처리 중
  assert.deepEqual(explainClaimFailure({ ...ok, status: "PROCESSING", otpConsumed: true }), { error: STAFF_PROCESSING_MESSAGE });
  assert.deepEqual(explainClaimFailure({ ...ok, status: "RECOVERING" }), { error: STAFF_PROCESSING_MESSAGE });
  assert.equal(explainClaimFailure({ ...ok, status: "RECOVERY_REQUIRED" }).needsVerification, undefined);
  assert.match(explainClaimFailure({ ...ok, status: "RECOVERY_REQUIRED" }).error, /관리자/);
  assert.match(explainClaimFailure({ ...ok, status: "ACCEPTED" }).error, /로그인/);
  assert.equal(explainClaimFailure({ ...ok, status: "ACCEPTED" }).needsVerification, undefined);
  assert.match(explainClaimFailure({ ...ok, status: "CANCELLED" }).error, /취소/);
  assert.match(explainClaimFailure({ ...ok, isExpired: true }).error, /만료된 초대/);
  assert.match(explainClaimFailure(null).error, /존재하지 않는/);
  // 진짜 «인증부터 다시»
  assert.deepEqual(explainClaimFailure({ ...ok, otpExpired: true }), { error: STAFF_NEEDS_VERIFICATION_MESSAGE, needsVerification: true });
  assert.equal(explainClaimFailure({ ...ok, otpVerified: false }).needsVerification, true);
  assert.equal(explainClaimFailure({ ...ok, locked: true }).needsVerification, true);
  // 지금은 다 맞음 = 방금 경합 → 다시 누르면 된다(인증으로 보내지 않는다)
  assert.deepEqual(explainClaimFailure(ok), { error: STAFF_PROCESSING_MESSAGE });
});

test("제출 전 사전 경고: 전화번호·생일·123456 류는 막고, 섞인 비밀번호는 통과", () => {
  for (const weak of ["01012345678", "1234567890", "19850315", "aaaaaaaaaa", "abcdefghij", "abcabcabcabc", "password12", "qwerty1234", "1212121212"]) {
    assert.ok(commonPasswordWarning(weak), `${weak} 는 경고해야 한다`);
  }
  assert.ok(commonPasswordWarning("kim01012345678x", { phone: "010-1234-5678" }), "자기 전화번호가 들어간 비밀번호");
  for (const ok of ["stizCoach2026!", "bluefox83river", "Hoop-Dasan-7"]) {
    assert.equal(commonPasswordWarning(ok), null, `${ok} 는 통과해야 한다`);
  }
  assert.equal(commonPasswordWarning(""), null);
});

test("acceptInvitation 연결부: 판정 함수를 쓰고, 확실한 거절은 시도를 닫고 문자 인증을 유지한 채 PENDING 으로", async () => {
  const src = await readFile("src/app/actions/invite.ts", "utf8");
  const accept = src.slice(src.indexOf("export async function acceptInvitation"));
  assert.match(accept, /authFailure = classifyAuthFailure\(authError\)/);
  assert.match(accept, /authFailure = classifyAuthFailure\(updateError\)/, "직원 비밀번호 재설정도 같은 판정");
  assert.doesNotMatch(accept, /authCreationUncertain/, "«already 가 아니면 전부 결과 모름» 판정은 없앴다");
  assert.match(accept, /decideInviteFailureOutcome\(/);
  // 계정을 만들지 않은 시도는 CREATING 으로 남기지 않는다(CHECK 허용값 안의 DELETED)
  assert.match(accept, /SET status = 'DELETED', error = \$2[\s\S]{0,80}WHERE id = \$1 AND status = 'CREATING'/);
  // 재시도 복귀: 문자 인증(otpVerifiedAt·otpExpiresAt)은 건드리지 않고 1회 사용 표시만 푼다
  const retry = accept.slice(accept.indexOf('outcome === "RETRY_KEEP_OTP"'), accept.indexOf("} else {", accept.indexOf('outcome === "RETRY_KEEP_OTP"')));
  assert.match(retry, /SET status = 'PENDING', "otpConsumedAt" = NULL/);
  assert.doesNotMatch(retry, /"otpVerifiedAt" = NULL|"otpExpiresAt" = NULL/);
  // RECOVERY_REQUIRED 는 판정 결과로만 간다
  assert.match(accept, /if \(outcome === "RECOVERY_REQUIRED"\) \{\s*const recoveryRecorded/);
  // 처리 시작 실패는 상태를 읽어 사유별로, 끝의 표식은 already_exists 를 뺀 RESET_PENDING 만
  assert.match(accept, /return explainClaimFailure\(states\[0\]\)/);
  assert.match(accept, /failureNeedsVerification\(outcome, authFailure\)/);
  assert.doesNotMatch(accept, /outcome === "RESET_PENDING" \? true/);
  const form = await readFile("src/app/invite/[token]/InviteAcceptForm.tsx", "utf8");
  assert.match(form, /result\.needsVerification/);
  // 1단계로 돌아갈 때 서버 문구(result.error)를 버리지 않는다
  const back = form.slice(form.indexOf("result.needsVerification"), form.indexOf("setStep(1)"));
  assert.match(back, /userErrorMessage\(result\.error/);
  assert.match(form, /commonPasswordWarning\(password\)/);
  // 실패해도 입력한 비밀번호를 지우지 않는다
  assert.doesNotMatch(form, /setPassword\(""\)/);
});
