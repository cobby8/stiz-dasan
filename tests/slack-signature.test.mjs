import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// /api/slack/interactions 는 인터넷에 열린 주소이고, 그 뒤에 "사이트 청구서 납부 반영" 버튼이 있다.
// 서명 검증이 뚫리면 누구나 가짜 클릭으로 돈 기록을 바꿀 수 있다 → 소스 문자열이 아니라 **실행해서** 확인한다.
// 규격: https://api.slack.com/authentication/verifying-requests-from-slack
//   서명 대상 = `v0:${x-slack-request-timestamp}:${본문 원문}` → HMAC-SHA256 → hex → 앞에 `v0=`

const { verifySlackSignature, expectedSlackSignature, buildSlackBaseString, SLACK_MAX_SKEW_SEC } =
  await loadTsModule("src/lib/slack/signature.ts");

const SECRET = "slack_signing_test_0123456789";
const BODY = "payload=%7B%22type%22%3A%22block_actions%22%7D";
const NOW = 1790000000; // 초
const TS = String(NOW);
const sign = (secret, ts, body) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`, "utf8").digest("hex")}`;
const call = (over = {}) =>
  verifySlackSignature({
    secret: SECRET, signatureHeader: sign(SECRET, TS, BODY), timestampHeader: TS, rawBody: BODY, nowSec: NOW, ...over,
  });

test("서명 대상은 'v0:시각:본문원문' 이다", () => {
  assert.equal(buildSlackBaseString("123", "a=1"), "v0:123:a=1");
  assert.equal(expectedSlackSignature(SECRET, TS, BODY), sign(SECRET, TS, BODY));
});

test("올바른 서명은 통과한다", () => {
  assert.deepEqual(call(), { ok: true });
});

test("본문이 한 글자만 달라도 막는다", () => {
  assert.deepEqual(call({ rawBody: BODY.replace("block", "blocc") }), { ok: false, reason: "BAD_SIGNATURE" });
});

test("다른 secret 으로 만든 서명은 막는다", () => {
  assert.deepEqual(call({ signatureHeader: sign("wrong_secret", TS, BODY) }), { ok: false, reason: "BAD_SIGNATURE" });
});

test("5분(300초) 넘게 어긋난 시각은 재전송으로 보고 막는다", () => {
  assert.equal(SLACK_MAX_SKEW_SEC, 300);
  const old = String(NOW - 301);
  assert.deepEqual(call({ timestampHeader: old, signatureHeader: sign(SECRET, old, BODY) }), { ok: false, reason: "STALE_TIMESTAMP" });
  const future = String(NOW + 301);
  assert.deepEqual(call({ timestampHeader: future, signatureHeader: sign(SECRET, future, BODY) }), { ok: false, reason: "STALE_TIMESTAMP" });
  // 허용 폭 안쪽은 통과(시계가 조금 어긋난 정상 요청까지 막으면 안 된다)
  const recent = String(NOW - 299);
  assert.equal(call({ timestampHeader: recent, signatureHeader: sign(SECRET, recent, BODY) }).ok, true);
});

test("secret 이 없으면 통과가 아니라 거부다", () => {
  assert.deepEqual(call({ secret: undefined }), { ok: false, reason: "NO_SECRET" });
  assert.deepEqual(call({ secret: "" }), { ok: false, reason: "NO_SECRET" });
});

test("v0= 로 시작하지 않는 서명 헤더는 막는다", () => {
  const raw = createHmac("sha256", SECRET).update(`v0:${TS}:${BODY}`, "utf8").digest("hex");
  assert.deepEqual(call({ signatureHeader: raw }), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(call({ signatureHeader: `v1=${raw}` }), { ok: false, reason: "BAD_SIGNATURE" });
});

test("헤더가 없거나 시각이 숫자가 아니면 거부한다", () => {
  assert.deepEqual(call({ signatureHeader: null }), { ok: false, reason: "NO_SIGNATURE" });
  assert.deepEqual(call({ timestampHeader: null }), { ok: false, reason: "NO_TIMESTAMP" });
  assert.deepEqual(call({ timestampHeader: "어제" }), { ok: false, reason: "NO_TIMESTAMP" });
});
