import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const tmapSource = await readFile("src/lib/shuttle/tmap.ts", "utf8");
const serviceSource = await readFile("src/lib/shuttle/service.ts", "utf8");
const adminApiSource = await readFile("src/app/api/admin/shuttle/route.ts", "utf8");
const transpiledTmap = ts.transpileModule(tmapSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tmapModule = await import(`data:text/javascript;base64,${Buffer.from(transpiledTmap).toString("base64")}`);

const optimizationInput = {
  start: { id: "start", name: "학원", latitude: 37.1, longitude: 127.1 },
  end: { id: "end", name: "학원", latitude: 37.1, longitude: 127.1 },
  waypoints: [{ id: "stop-1", name: "정류장", latitude: 37.2, longitude: 127.2 }],
};

async function withMockedTmapFetch(fetchMock, operation) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMAP_APP_KEY;
  globalThis.fetch = fetchMock;
  process.env.TMAP_APP_KEY = "test-key";
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = originalKey;
  }
}

test("tmap optimization uses server-only app key and coordinate waypoints", () => {
  assert.match(tmapSource, /process\.env\.TMAP_APP_KEY/);
  assert.doesNotMatch(tmapSource, /NEXT_PUBLIC_TMAP/);
  assert.match(tmapSource, /routeOptimization\$\{limit\}/);
  assert.match(tmapSource, /appKey/);
  assert.match(tmapSource, /reqCoordType: "WGS84GEO"/);
  assert.match(tmapSource, /\[\`\$\{prefix\}X`\]: String\(point\.longitude\)/);
  assert.match(tmapSource, /\[\`\$\{prefix\}Y`\]: String\(point\.latitude\)/);
  assert.match(tmapSource, /viaX/);
  assert.match(tmapSource, /viaY/);
});

test("tmap optimization stops a delayed provider request after ten seconds", () => {
  assert.match(tmapSource, /TMAP_REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(tmapSource, /signal: AbortSignal\.timeout\(TMAP_REQUEST_TIMEOUT_MS\)/);
  assert.match(tmapSource, /error\.name === "TimeoutError"/);
  assert.match(tmapSource, /status = 502/);
  assert.match(tmapSource, /504,\s+"TMAP_OPTIMIZATION_TIMEOUT"/);
  assert.match(tmapSource, /잠시 후 다시 시도해 주세요/);
  assert.match(tmapSource, /body = await response\.json\(\)\.catch/);
  assert.match(tmapSource, /if \(isTimeoutError\(error\)\) throw error/);
});

test("tmap timeout is preserved as a shuttle service error for the admin API", () => {
  assert.match(serviceSource, /error instanceof TmapApiError/);
  assert.match(serviceSource, /new ShuttleServiceError\(error\.message, error\.status, error\.code\)/);
  assert.match(adminApiSource, /\{ error: error\.message, code: error\.code \}, \{ status: error\.status \}/);
});

test("tmap upstream HTTP status is not exposed through the admin API", () => {
  assert.match(tmapSource, /if \(!response\.ok\) \{\s+throw new TmapApiError\("T맵 경유지 최적화 요청이 실패했습니다\."\);\s+\}/);
  assert.doesNotMatch(tmapSource, /new TmapApiError\("T맵 경유지 최적화 요청이 실패했습니다\.", response\.status\)/);
});

test("tmap runtime preserves normal optimization results", async () => {
  // T맵은 우리가 보낸 viaPointId를 그대로 되돌려준다. 코드는 "0"을 값 없음으로 취급하는 문제를 피하려고
  // 내부 안전 id(wp0)로 바꿔 보내므로, 응답도 wp0으로 오고 → 호출부가 준 원래 id(stop-1)로 되돌아와야 한다.
  const result = await withMockedTmapFetch(
    async () => new Response(JSON.stringify({ viaPointId: "wp0", totalDistance: 1200 }), { status: 200 }),
    () => tmapModule.optimizeWaypointOrderWithTmap(optimizationInput),
  );
  assert.deepEqual(result.orderedWaypointIds, ["stop-1"]);
  assert.equal(result.rawSummary.totalDistance, 1200);
});

test("tmap runtime sends the required startTime and avoids viaPointId '0'", async () => {
  let sentBody = null;
  await withMockedTmapFetch(
    async (_url, init) => { sentBody = JSON.parse(init.body); return new Response(JSON.stringify({ viaPointId: "wp0" }), { status: 200 }); },
    () => tmapModule.optimizeWaypointOrderWithTmap(optimizationInput),
  );
  assert.match(String(sentBody.startTime), /^\d{12}$/); // yyyyMMddHHmm 필수 파라미터
  assert.equal(sentBody.viaPoints[0].viaPointId, "wp0"); // 원래 id "stop-1"이 아니라 안전 id로 전송
  assert.notEqual(sentBody.viaPoints[0].viaPointId, "0");
});

test("tmap runtime maps request and body timeouts to 504", async (t) => {
  for (const [label, fetchMock] of [
    ["request", async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["body", async () => ({ ok: true, json: async () => { throw new DOMException("aborted", "AbortError"); } })],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(
        withMockedTmapFetch(fetchMock, () => tmapModule.optimizeWaypointOrderWithTmap(optimizationInput)),
        (error) => error.status === 504 && error.code === "TMAP_OPTIMIZATION_TIMEOUT",
      );
    });
  }
});

test("tmap runtime maps network and upstream HTTP errors to 502", async (t) => {
  for (const [label, fetchMock] of [
    ["network", async () => { throw new TypeError("network unavailable"); }],
    ["upstream HTTP", async () => new Response("{}", { status: 429 })],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(
        withMockedTmapFetch(fetchMock, () => tmapModule.optimizeWaypointOrderWithTmap(optimizationInput)),
        (error) => error.status === 502 && error.code === "TMAP_API_ERROR",
      );
    });
  }
});

test("admin shuttle API exposes tmap preview without directly mutating route order", () => {
  assert.match(serviceSource, /previewOptimizedRouteStops/);
  assert.match(serviceSource, /optimizeWaypointOrderWithTmap/);
  assert.match(serviceSource, /ROUTE_ENDPOINTS_REQUIRED/);
  assert.match(adminApiSource, /optimizePreview/);
  assert.match(adminApiSource, /NextResponse\.json\(\{ preview:/);
});

// 2026-10-02 옛 노선 편성 화면(ShuttleRouteAdminClient) 삭제로 그 화면을 읽던 검사는 뺐다(서버·API 검사는 유지).
