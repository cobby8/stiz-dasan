// 공개 시간표는 서버가 그린 화면에 표가 들어 있다(2026-11-19 전 화면 속도 5회차)
//
// 왜: 주소의 ?program= 을 읽는 useSearchParams 를 Suspense 로 감싸면서 기다림 화면이 «시간표 불러오는 중...» 글자였다.
//     저장 화면(ISR)에는 그 글자만 들어가, 휴대폰이 스크립트를 다 받은 뒤에야 표가 그려졌다.
//     기다림 화면을 «필터 없는 전체 시간표»로 두면 서버 화면에 표가 들어가고, 필터가 있으면 브라우저가 거른다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("시간표 — Suspense 기다림 화면이 필터 없는 전체 표다(불러오는 중 글자 아님)", () => {
  const src = readFileSync("src/app/schedule/ScheduleClient.tsx", "utf8");
  assert.match(src, /<Suspense fallback=\{\s*<div className="schedule-ssr-fallback">[\s\S]*?<ScheduleFilter \{\.\.\.props\} filterProgramId=\{undefined\} \/>\s*<\/div>\s*\}>/);
  // 필터 주소로 들어오면 미리 그린 전체 표를 감춘다(«필터가 안 먹었다» 방지)
  assert.match(src, /\[\?&\]program=/);
  assert.match(readFileSync("src/app/globals.css", "utf8"), /html\[data-schedule-filtered\] \.schedule-ssr-fallback \{ visibility: hidden; \}/);
  assert.doesNotMatch(src, /시간표 불러오는 중/);
  // 주소 값은 Suspense 안쪽 부품에서만 읽는다(정적 화면 빌드 규칙)
  const readers = src.match(/useSearchParams\(\)/g) ?? [];
  assert.equal(readers.length, 1);
  assert.match(src, /function ScheduleFilterFromUrl[\s\S]*?useSearchParams\(\);[\s\S]*?searchParams\.get\("program"\)[\s\S]*?function ScheduleFilter\(/);
});
