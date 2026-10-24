import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { coordinateLinkSet, coordinatePoint } from "../src/lib/maps/coordinate-links.ts";

const coordinateLinksSource = await readFile("src/lib/maps/coordinate-links.ts", "utf8");

test("map links are generated from coordinates instead of address text", () => {
  assert.match(coordinateLinksSource, /coordinatePoint/);
  assert.match(coordinateLinksSource, /latitude/);
  assert.match(coordinateLinksSource, /longitude/);
  assert.match(coordinateLinksSource, /goalx=\$\{point\.longitude\}/);
  assert.match(coordinateLinksSource, /goaly=\$\{point\.latitude\}/);
  assert.match(coordinateLinksSource, /map\.kakao\.com\/link\/map/);
  assert.match(coordinateLinksSource, /map\.kakao\.com\/link\/to/);
});

// 2026-10-02 옛 노선 편성 화면(ShuttleRouteAdminClient) 삭제로 화면 쪽 검사는 뺐다(링크 생성 모듈 검사는 유지).

test("coordinate links reject non-finite and out-of-range positions", () => {
  for (const input of [
    { latitude: 91, longitude: 127, name: "invalid latitude" },
    { latitude: 37, longitude: 181, name: "invalid longitude" },
    { latitude: Number.NaN, longitude: 127, name: "not a number" },
  ]) {
    assert.equal(coordinatePoint(input), null);
    assert.deepEqual(coordinateLinkSet(input), {
      point: null,
      kakaoMap: null,
      kakaoNavigation: null,
      naverNavigation: null,
      tmapNavigation: null,
    });
  }
});

test("coordinate links accept geographic boundary values", () => {
  assert.deepEqual(coordinatePoint({ latitude: "-90", longitude: "180", name: " boundary " }), {
    latitude: -90,
    longitude: 180,
    name: "boundary",
  });
});
