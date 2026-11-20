// 학부모 셔틀 조회는 서로 기다릴 필요 없는 조회를 같이 출발시킨다(2026-11-19 전 화면 속도 8회차)
//
// 왜: 운영 학부모 홈(/mypage)의 조회 11가지 중 셔틀 조회만 0.64~0.73초로 홈 전체 시간을 정했다([mypage timing] 로그).
//     방학특강 확정 명단은 자녀와 무관한데 «자녀 찾기» 뒤에야 출발했고, 마지막 세 조회(특강 노선·특강 시각·정규 시각)는 차례로 돌았다.
//     결과는 그대로(운영 DB 학부모 20명 × 2가지 조건 비교 40/40 같음), 기다림만 겹친다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync("src/lib/shuttle/parent.ts", "utf8");
const body = src.slice(src.indexOf("export async function getParentShuttleOverview"));

test("확정 명단은 자녀 찾기보다 먼저 출발하고, 일찍 끝나도 실패가 새지 않는다", () => {
  const start = body.indexOf("const seasonalRosterP = getConfirmedShuttleRoster();");
  const accessible = body.indexOf("const accessible = await prisma.student.findMany");
  assert.ok(start > 0 && accessible > start, "명단 출발이 자녀 찾기보다 앞");
  assert.match(body, /seasonalRosterP\.catch\(\(\) => \{\}\);/);
  // 기다리는 자리는 예전 Promise.all 그대로(실패하면 함수가 실패 — 호출부가 빈 목록으로 받는다)
  assert.match(body, /await Promise\.all\(\[\s*prisma\.shuttleRoutePassenger\.findMany[\s\S]*?seasonalRosterP,/);
  assert.equal((body.match(/getConfirmedShuttleRoster\(\)/g) ?? []).length, 1);
});

test("특강 노선·특강 확정 시각·정규 확정 시각은 한꺼번에 기다린다", () => {
  assert.match(body, /const seasonalPassengersP = seasonalEntries\.length\s*\? prisma\.shuttleRoutePassenger\.findMany/);
  assert.match(body, /const etaByRequestP = seasonalEntries\.length\s*\? getConfirmedDispatchEtas/);
  assert.match(body, /const \[seasonalPassengers, etaByRequest\] = await Promise\.all\(\[\s*seasonalPassengersP,\s*etaByRequestP,\s*\.\.\.\[\.\.\.pairsByMonth\]\.map/);
  assert.doesNotMatch(body, /await getConfirmedDispatchEtas/);
});
