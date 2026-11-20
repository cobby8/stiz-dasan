// 방학 셔틀 확정 명단 — 서로 기다릴 필요 없는 조회를 같이 출발(2026-11-20 속도)
//
// 왜: 학부모 홈이 열릴 때마다 getConfirmedShuttleRoster 를 부르는데, 켜짐 확인 → 확정 시즌 → 확정 명단 → 확정 전 명단을
//     DB 에 4번 차례로 다녀와 운영에서 셔틀 조회가 0.6초로 홈 전체를 붙잡았다. 2번으로 줄인다(운영 DB 13경우 결과 동일, 189→93ms).
//     저장해 두기(캐시)는 금지 — 킬 스위치·명단 수정이 즉시 반영돼야 하고 기사님 화면도 같은 함수를 쓴다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync("src/lib/seasonal/shuttleRoster.ts", "utf8");
const fn = src.slice(src.indexOf("export async function getConfirmedShuttleRoster("), src.indexOf("/** 확정본 행 — 지정한 시즌들만"));

test("켜짐 확인과 확정 시즌 찾기를 같이 출발, 꺼짐이면 그대로 폴백", () => {
  assert.match(fn, /const \[modeOn, confirmedSeasons\] = await Promise\.all\(\[confirmedModeEnabled\(\), confirmedSeasonIds\(seasonId\)\]\);/);
  assert.match(fn, /if \(!modeOn\) return fallbackSeasonRoster\(seasonId\);\s*if \(confirmedSeasons\.length === 0\) return fallbackSeasonRoster\(seasonId\);/);
});

test("시즌 지정 시 확정본만, 지정 없으면 확정·확정 전 명단을 같이 읽어 합친다", () => {
  assert.match(fn, /if \(seasonId\) return confirmedSeasonRoster\(confirmedSeasons\);/);
  assert.match(fn, /\[confirmedRows, pendingRows\] = await Promise\.all\(\[\s*confirmedSeasonRoster\(confirmedSeasons\),\s*fallbackSeasonRoster\(null, confirmedSeasons\),\s*\]\)/);
  assert.match(fn, /if \(pendingRows\.length === 0\) return confirmedRows;\s*return sortRosterEntries\(\[\.\.\.confirmedRows, \.\.\.pendingRows\]\);/);
});

test("확정 명단은 저장(캐시)하지 않는다 — 킬 스위치·명단 수정 즉시 반영", () => {
  // 주석(«unstable_cache 라 킬 스위치로 못 쓴다» 설명)은 빼고 코드만 본다
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /unstable_cache|"use cache"|cacheLife|cacheTag/);
});
