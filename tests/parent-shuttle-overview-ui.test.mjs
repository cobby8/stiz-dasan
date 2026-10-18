import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const client = await readFile(
  new URL("../src/app/mypage/MyPageClient.tsx", import.meta.url),
  "utf8",
);

test("마이페이지는 선택한 자녀의 셔틀 현황만 표시한다", () => {
  assert.match(client, /parentShuttleOverview\.filter\(\(item\) => item\.studentId === child\.id\)/);
  assert.match(client, /childShuttleOverview\.length > 0/);
  assert.match(client, /childShuttleOverview\.map\(\(item\) =>/);
  assert.match(client, /<article key=\{item\.id\}/);
});

test("배정 확정 또는 완료된 셔틀에만 상세 정보를 공개한다", () => {
  assert.match(client, /item\.status === "CONFIRMED" \|\| item\.status === "COMPLETED"/);
  assert.match(client, /item\.routeName \|\| "노선 확인 중"/);
  assert.match(client, /item\.stopName \|\| "정류장 확인 중"/);
  assert.match(client, /item\.vehicleName \|\| "차량 확인 중"/);
  assert.match(client, /<time dateTime=\{item\.plannedAt\}>/);
});

test("셔틀 변경은 실제 변경 화면으로 연결하고 일반 문의 폼은 유지한다", () => {
  assert.match(client, /\/mypage\/shuttle/);
  assert.doesNotMatch(client, /setReqContent\(\(prev\) => prev \|\| "셔틀 변경 요청: "\)/);
  assert.match(client, /createParentRequest\(/);
  assert.match(client, /min-h-11/);
  assert.match(client, /focus-visible:ring-2/);
});

test("운행 방향에 맞는 정류장 역할을 안내한다", () => {
  assert.match(
    client,
    /item\.direction === "PICKUP" \? "탑승 장소" : item\.direction === "DROPOFF" \? "하차 장소" : "정류장"/,
  );
});
