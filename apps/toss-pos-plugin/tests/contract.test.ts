// 서버 응답 해석·API 호출(토큰 헤더·오류 분류) 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_PATHS,
  SERVER_ORIGIN,
  parseChargeRequestList,
  parseClaimResponse,
  parseReportStatus,
  parseUnpaidList,
} from "../src/core/contract.ts";
import { classifyStatus, createServerApi } from "../src/core/api.ts";
import type { HttpLike } from "../src/core/pos-types.ts";

test("목록: camelCase·snake_case·data 감싸개 모두 읽는다", () => {
  const camel = { requests: [{ id: "a", shortCode: "S-1234", studentName: "김○○", itemTitle: "수강료(11월)", amount: 100000, taxFreeAmount: 100000, expiresAt: "2026-11-07T01:30:00Z", status: "PENDING" }] };
  const snake = { success: true, data: { requests: [{ id: "a", short_code: "S-1234", student_name: "김○○", item_title: "수강료(11월)", amount: "100000", tax_free_amount: 100000, expires_at: "2026-11-07T01:30:00Z", status: "PENDING" }] } };
  for (const body of [camel, snake]) {
    const [r] = parseChargeRequestList(body);
    assert.deepEqual(r, { id: "a", shortCode: "S-1234", studentName: "김○○", title: "수강료(11월)", amount: 100000, taxFreeAmount: 100000, expiresAt: "2026-11-07T01:30:00Z", status: "PENDING" });
  }
});

test("목록: 필수 칸 없는 항목은 버리고, 면세 칸이 없으면 NaN(검증에서 막힘)", () => {
  const list = parseChargeRequestList([{ id: "a" }, { shortCode: "S-1234", amount: 1 }, { id: "b", shortCode: "S-5678", amount: 1000 }, null, "x"]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "b");
  assert.ok(Number.isNaN(list[0].taxFreeAmount));
  assert.equal(list[0].studentName, "(이름 없음)");
  assert.deepEqual(parseChargeRequestList("엉뚱한 값"), []);
});

test("선점 응답: {request} 또는 요청 그 자체", () => {
  const raw = { id: "a", shortCode: "S-1234", amount: 1000, taxFreeAmount: 1000 };
  assert.equal(parseClaimResponse({ request: raw })?.id, "a");
  assert.equal(parseClaimResponse({ data: { request: raw } })?.id, "a");
  assert.equal(parseClaimResponse(raw)?.id, "a");
  assert.equal(parseClaimResponse({}), null);
});

test("미납 목록·보고 상태 해석", () => {
  const u = parseUnpaidList({ items: [{ payment_id: "p1", student_name: "이○○", class_name: "토요 초등", title: "수강료(11월)", amount: 120000 }, { amount: 1 }] });
  assert.deepEqual(u, [{ paymentId: "p1", studentName: "이○○", className: "토요 초등", title: "수강료(11월)", amount: 120000 }]);
  assert.equal(parseReportStatus({ request: { status: "PAID" } }), "PAID");
  assert.equal(parseReportStatus({ data: { status: "SENT" } }), "SENT");
  assert.equal(parseReportStatus(null), "");
});

test("HTTP 상태 → 실패 종류", () => {
  assert.equal(classifyStatus(200), null);
  assert.equal(classifyStatus(401), "auth");
  assert.equal(classifyStatus(403), "auth");
  assert.equal(classifyStatus(409), "conflict");
  assert.equal(classifyStatus(410), "conflict");
  assert.equal(classifyStatus(404), "not_found");
  assert.equal(classifyStatus(429), "rate");
  assert.equal(classifyStatus(503), "server");
  assert.equal(classifyStatus(400), "bad_response");
});

/** 가짜 http — 부른 주소·헤더·본문을 기록 */
function fakeHttp(respond: (method: string, url: string) => { code: number; body: string } | Error) {
  const calls: { method: string; url: string; headers?: [string, string][]; payload?: unknown }[] = [];
  const http: HttpLike = {
    async get(url, headers) {
      calls.push({ method: "GET", url, headers });
      const r = respond("GET", url);
      if (r instanceof Error) throw r;
      return r;
    },
    async post(url, payload, headers) {
      calls.push({ method: "POST", url, headers, payload });
      const r = respond("POST", url);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { http, calls };
}

test("API: 토큰을 Bearer 로 붙여 계약 주소를 부른다", async () => {
  const { http, calls } = fakeHttp(() => ({ code: 200, body: JSON.stringify({ requests: [] }) }));
  const api = createServerApi({ http, getToken: async () => "t".repeat(32) });
  const r = await api.listRequests();
  assert.deepEqual(r, { ok: true, data: [] });
  assert.equal(calls[0].url, SERVER_ORIGIN + "/api/pos-plugin/charge-requests");
  assert.deepEqual(calls[0].headers?.[0], ["Authorization", `Bearer ${"t".repeat(32)}`]);

  await api.claim("id/1");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, SERVER_ORIGIN + "/api/pos-plugin/charge-requests/id%2F1/claim");
  await api.report("r1", { event: "paid", tossPaymentId: "tp" });
  assert.equal(calls[2].url, SERVER_ORIGIN + API_PATHS.report("r1"));
  assert.deepEqual(calls[2].payload, { event: "paid", tossPaymentId: "tp" });
  await api.searchUnpaid("김 철");
  assert.equal(calls[3].url, SERVER_ORIGIN + "/api/pos-plugin/unpaid?q=%EA%B9%80%20%EC%B2%A0");
  await api.chargeUnpaid("p1");
  assert.equal(calls[4].url, SERVER_ORIGIN + "/api/pos-plugin/unpaid/p1/charge");
});

test("API: 토큰 없으면 서버를 부르지 않는다", async () => {
  const { http, calls } = fakeHttp(() => ({ code: 200, body: "{}" }));
  const r = await createServerApi({ http, getToken: async () => undefined }).listRequests();
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, "no_token");
  assert.equal(calls.length, 0);
});

test("API: 네트워크 오류·요청 제한·깨진 JSON·409 분류", async () => {
  class RateErr extends Error {}
  const cases: [() => { code: number; body: string } | Error, string][] = [
    [() => new Error("offline"), "network"],
    [() => new RateErr("rl"), "rate"],
    [() => ({ code: 200, body: "<html>" }), "bad_response"],
    [() => ({ code: 409, body: "{}" }), "conflict"],
    [() => ({ code: 401, body: "" }), "auth"],
  ];
  for (const [respond, kind] of cases) {
    const { http } = fakeHttp(respond);
    const api = createServerApi({ http, getToken: async () => "x".repeat(24), isRateLimitError: (e) => e instanceof RateErr });
    const r = await api.claim("a");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.kind, kind);
  }
});
