import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 이 주소는 인터넷에 열려 있다. 검증이 뚫리면 아무나 "결제됐다"는 가짜 알림을 보내
// 우리 기록을 오염시킬 수 있고, 다음 단계에서 그 기록으로 청구서를 납부 처리하게 되면
// 돈 문제로 번진다. 그래서 소스 문자열 검사가 아니라 **실제로 실행해서** 확인한다.
// 규격: docs.tossplace.com/reference/open-api/webhook.html (2026-09-29 확인)
//   서명 대상 = `${x-toss-timestamp}.${본문 원문}` → HMAC-SHA256 → hex → 앞에 `v1=`

const { verifyWebhookSignature, expectedSignature, buildSignedPayload, WEBHOOK_MAX_SKEW_MS } =
  await loadTsModule("src/lib/pos/webhookSignature.ts");

const SECRET = "whsec_test_0123456789";
const BODY = JSON.stringify({ id: "evt_1", type: "order.order.completed.v1", merchantId: 324744 });
const NOW = 1790000000000;
const TS = String(NOW);
const sign = (secret, ts, body) => `v1=${createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex")}`;
const call = (over = {}) =>
  verifyWebhookSignature({
    secret: SECRET, signatureHeader: sign(SECRET, TS, BODY), timestampHeader: TS,
    rawBody: BODY, nowMs: NOW, ...over,
  });

test("서명 대상 문자열은 '시각.본문원문' 이다", () => {
  assert.equal(buildSignedPayload("123", '{"a":1}'), '123.{"a":1}');
  assert.equal(expectedSignature(SECRET, TS, BODY), sign(SECRET, TS, BODY));
});

test("올바른 서명은 통과한다", () => {
  assert.deepEqual(call(), { ok: true });
});

test("본문이 한 글자만 달라도 막는다", () => {
  // 실무 함정: 받은 본문을 JSON.parse 후 다시 stringify 하면 공백·키 순서가 바뀌어
  // 서명이 절대 맞지 않는다. 그래서 라우트가 req.text() 로 원문을 먼저 읽는다.
  const r = call({ rawBody: BODY.replace("324744", "324745") });
  assert.deepEqual(r, { ok: false, reason: "BAD_SIGNATURE" });
  const reordered = JSON.stringify({ merchantId: 324744, type: "order.order.completed.v1", id: "evt_1" });
  assert.equal(call({ rawBody: reordered }).ok, false, "키 순서가 바뀌면 서명은 맞지 않는다");
});

test("다른 secret 으로 만든 서명은 막는다", () => {
  assert.deepEqual(call({ signatureHeader: sign("wrong_secret", TS, BODY) }), { ok: false, reason: "BAD_SIGNATURE" });
});

test("secret 이 설정되지 않으면 통과가 아니라 거부다", () => {
  // 설정을 빠뜨린 채 열어두면 검증 없는 공개 주소가 된다.
  assert.deepEqual(call({ secret: undefined }), { ok: false, reason: "NO_SECRET" });
  assert.deepEqual(call({ secret: "" }), { ok: false, reason: "NO_SECRET" });
});

test("헤더가 없으면 거부한다", () => {
  assert.deepEqual(call({ signatureHeader: null }), { ok: false, reason: "NO_SIGNATURE" });
  assert.deepEqual(call({ timestampHeader: null }), { ok: false, reason: "NO_TIMESTAMP" });
  assert.deepEqual(call({ timestampHeader: "어제" }), { ok: false, reason: "NO_TIMESTAMP" });
});

test("오래된 요청은 재전송으로 보고 막는다", () => {
  const old = String(NOW - WEBHOOK_MAX_SKEW_MS - 1000);
  assert.deepEqual(
    call({ timestampHeader: old, signatureHeader: sign(SECRET, old, BODY) }),
    { ok: false, reason: "STALE_TIMESTAMP" },
  );
  // 허용 폭 안이면 통과(시계가 약간 어긋난 정상 요청까지 막으면 안 된다)
  const recent = String(NOW - WEBHOOK_MAX_SKEW_MS + 1000);
  assert.equal(call({ timestampHeader: recent, signatureHeader: sign(SECRET, recent, BODY) }).ok, true);
  // 미래 쪽으로 어긋난 것도 같은 폭으로 본다
  const future = String(NOW + WEBHOOK_MAX_SKEW_MS + 1000);
  assert.equal(call({ timestampHeader: future, signatureHeader: sign(SECRET, future, BODY) }).ok, false);
});

test("v1= 형식이 아닌 값은 후보로 치지 않는다", () => {
  const raw = createHmac("sha256", SECRET).update(`${TS}.${BODY}`, "utf8").digest("hex");
  assert.deepEqual(call({ signatureHeader: raw }), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(call({ signatureHeader: "v2=" + raw }), { ok: false, reason: "BAD_SIGNATURE" });
});

test("서명이 여러 개 나열돼 오면 하나만 맞아도 통과한다", () => {
  // 서명 키를 교체하는 동안 두 개를 함께 보낼 수 있다.
  assert.equal(call({ signatureHeader: `${sign("old_secret", TS, BODY)} ${sign(SECRET, TS, BODY)}` }).ok, true);
  assert.equal(call({ signatureHeader: `${sign("old_secret", TS, BODY)} ${sign("other", TS, BODY)}` }).ok, false);
});

// ── 받는 곳(라우트)이 지켜야 할 계약 ─────────────────────────────────────
const route = await readFile("src/app/api/webhooks/tossplace/route.ts", "utf8");

test("본문을 원문으로 읽은 뒤 검증한다", () => {
  const rawAt = route.indexOf("await req.text()");
  // import 줄에도 이름이 나오므로 '호출' 지점을 본다.
  const verifyAt = route.indexOf("verifyWebhookSignature({");
  assert.ok(rawAt > 0, "req.text() 로 원문을 읽어야 합니다");
  assert.ok(verifyAt > rawAt, "원문을 먼저 읽고 그 다음에 검증해야 합니다");
  assert.doesNotMatch(route, /await req\.json\(\)/, "json() 으로 읽으면 서명이 맞지 않습니다");
});

test("서명 실패는 401 로 막고 저장하지 않는다", () => {
  assert.match(route, /status: 401/);
  const rejectAt = route.indexOf("status: 401");
  const insertAt = route.indexOf('INSERT INTO "PosWebhookEvent"');
  assert.ok(insertAt > rejectAt, "검증 실패 시 저장 코드에 도달하면 안 됩니다");
});

test("중복은 DB 가 막는다", () => {
  // 코드로 '있나 확인 후 INSERT' 하면 동시에 두 건이 오면 뚫린다.
  assert.match(route, /ON CONFLICT \("webhookId"\) DO NOTHING/);
  assert.doesNotMatch(route, /SELECT[^;]*FROM "PosWebhookEvent"/, "확인 후 INSERT 방식은 쓰지 않는다");
});

test("청구서·결제를 건드리지 않는다", () => {
  for (const table of ["Payment", "PaymentInvoice", "Enrollment", "Student"]) {
    assert.doesNotMatch(route, new RegExp(`UPDATE "${table}"`));
    assert.doesNotMatch(route, new RegExp(`DELETE FROM "${table}"`));
  }
  assert.doesNotMatch(route, /markPaymentPaid/);
});

test("우리 쪽 오류로 재시도 폭풍을 만들지 않는다", () => {
  // 5xx 를 주면 토스가 계속 재시도하고 엔드포인트가 정지될 수 있다.
  assert.match(route, /catch \(error\)[\s\S]{0,400}NextResponse\.json\(\{ ok: true/);
  assert.doesNotMatch(route, /status: 5\d\d/);
});
