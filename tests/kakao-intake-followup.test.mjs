import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("src/lib/kakaoIntakeFollowup.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { kakaoFollowupSummary, isKakaoFollowupOverdue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const command = { status: "PENDING", parentConfirmed: true, parentReconfirmationRequired: false, holdReason: null };

test("상담 전환과 추가 확인을 완료 또는 발송으로 표시하지 않는다", () => {
  assert.match(kakaoFollowupSummary("CONSULTATION", []), /완료가 아닙니다/);
  assert.match(kakaoFollowupSummary("NEEDS_DETAILS", []), /미발송/);
  assert.match(kakaoFollowupSummary("REJECTED", []), /미발송/);
  assert.match(kakaoFollowupSummary("PROCESSING", []), /수동 대조.*자동 재시도 금지/);
});
test("이관 후 학부모 재확인과 동기화 대기를 구분한다", () => {
  assert.match(kakaoFollowupSummary("APPROVED", []), /연결 확인 필요/);
  assert.match(kakaoFollowupSummary("APPROVED", [{ ...command, parentConfirmed: false }]), /재확인 대기/);
  assert.match(kakaoFollowupSummary("APPROVED", [{ ...command, parentReconfirmationRequired: true }]), /재확인 대기/);
  assert.match(kakaoFollowupSummary("APPROVED", [command]), /확인 완료.*동기화 대기/);
  assert.match(kakaoFollowupSummary("APPROVED", [{ ...command, status: "PARTIAL" }]), /부분 반영/);
  assert.match(kakaoFollowupSummary("APPROVED", [{ ...command, status: "SYNCED" }]), /알림 완료 여부는 별도 확인/);
});
test("24시간 경과는 후속 대상만 표시한다", () => {
  const created = "2026-09-01T00:00:00Z";
  const now = Date.parse(created) + 86400000;
  assert.equal(isKakaoFollowupOverdue("CONSULTATION", created, now), true);
  assert.equal(isKakaoFollowupOverdue("APPROVED", created, now), true);
  assert.equal(isKakaoFollowupOverdue("PROCESSING", created, now), true);
  assert.equal(isKakaoFollowupOverdue("SUBMITTED", created, now - 1), false);
  assert.equal(isKakaoFollowupOverdue("APPLIED", created, now), false);
});
test("접수 종결 필터에 이관·상담 상태가 들어가지 않는다", () => {
  const page = readFileSync("src/app/admin/kakao-requests/page.tsx", "utf8");
  const done = page.split("OR ($1='DONE'")[1].split("\n")[0];
  assert.doesNotMatch(done, /'APPROVED'|'CONSULTATION'/);
  assert.match(done, /'CONSULTATION_CLOSED'/);
  assert.match(page, /OperationsCommand/);
  assert.match(page.split("OR ($1='ACTION'")[1].split("\n")[0], /PROCESSING/);
  assert.match(page.split("OR ($1='FOLLOWUP'")[1].split("\n")[0], /PROCESSING/);
  assert.match(page, /errorCode" IS NOT NULL/);
});

test("상담 종결은 후속 지연에서 제외하고 수강·발송과 구분한다", () => {
  assert.equal(isKakaoFollowupOverdue("CONSULTATION_CLOSED", "2020-01-01T00:00:00Z", Date.now()), false);
  assert.match(kakaoFollowupSummary("CONSULTATION_CLOSED", []), /수강 반영·청구 완료가 아닙니다/);
  assert.match(kakaoFollowupSummary("CONSULTATION_CLOSED", []), /안내를 발송하지 않았습니다/);
});
