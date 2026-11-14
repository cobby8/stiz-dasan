import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const client = await readFile(
  new URL("../src/app/mypage/MyPageClient.tsx", import.meta.url),
  "utf8",
);
// 2026-11-09 셔틀 배정 상세는 홈의 접힌 칸에서 «일정» 탭(ParentShuttleDetail)으로 옮겼다.
const detail = await readFile(
  new URL("../src/app/mypage/ParentShuttleDetail.tsx", import.meta.url),
  "utf8",
);
const hub = await readFile(
  new URL("../src/app/mypage/history/ScheduleHub.tsx", import.meta.url),
  "utf8",
);

test("마이페이지 홈은 선택한 자녀의 셔틀만, 일정 탭은 자녀별 이름을 붙여 보인다", () => {
  assert.match(client, /parentShuttleOverview\.filter\(\(item\) => item\.studentId === child\.id\)/);
  assert.match(client, /filterTodayShuttle\(childShuttleOverview, todayStr\)/);
  assert.match(hub, /shuttleItems\.length > 0 &&/);
  assert.match(detail, /items\.map\(\(item\) =>/);
  assert.match(detail, /<article key=\{item\.id\}/);
  assert.match(detail, /showChild && childNames\[item\.studentId\]/);
});

test("배정 확정 또는 완료된 셔틀에만 상세 정보를 공개한다", () => {
  assert.match(detail, /item\.status === "CONFIRMED" \|\| item\.status === "COMPLETED"/);
  // 2026-11-14 원장 결정 d7: 값이 없으면 «○○ 확인 중» 대신 그 줄을 숨긴다(값이 있을 때만 그린다)
  assert.match(detail, /\{item\.routeName && \(/);
  assert.match(detail, /\{\(item\.stopName \|\| item\.stopAddress\) && \(/);
  assert.match(detail, /\{item\.plannedAt && \(/);
  assert.match(detail, /\{item\.vehicleName && \(/);
  assert.match(detail, /\{item\.serviceDate && \(/);
  assert.doesNotMatch(detail, /"(노선|정류장|차량) 확인 중"|: "(시간|운행일) 확인 중"\}/);
  // 상세 줄은 여전히 확정·완료 묶음(showDetails) 안에만 있다
  const detailsAt = detail.indexOf("{showDetails && (");
  assert.ok(detailsAt > 0 && detail.indexOf("{item.routeName && (") > detailsAt && detail.indexOf("{item.vehicleName && (") > detailsAt, "노선·차량은 확정·완료에만");
  assert.match(detail, /<time dateTime=\{item\.plannedAt\}>/);
});

test("셔틀 변경은 실제 변경 화면으로 연결하고 일반 문의 폼은 유지한다", () => {
  assert.match(client, /\/mypage\/shuttle/);
  assert.match(detail, /href="\/mypage\/shuttle"/);
  assert.doesNotMatch(client, /setReqContent\(\(prev\) => prev \|\| "셔틀 변경 요청: "\)/);
  assert.match(client, /createParentRequest\(/);
  assert.match(client, /min-h-11/);
  assert.match(client, /focus-visible:ring-2/);
});

test("운행 방향에 맞는 정류장 역할을 안내한다", () => {
  assert.match(
    detail,
    /item\.direction === "PICKUP" \? "탑승 장소" : item\.direction === "DROPOFF" \? "하차 장소" : "정류장"/,
  );
});
