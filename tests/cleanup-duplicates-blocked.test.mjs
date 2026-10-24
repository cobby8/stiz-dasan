import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 2026-10-02 Phase 0 정합성 점검에서 막은 기능.
// 예전 POST 는 "이름이 같은 학생 중 학교·학년이 빈 쪽"을 골라 청구·출석·수강 기록까지
// 영구 삭제했다. 이름만으로 판단해 동명이인이 지워지고, 돈 기록은 되돌릴 수 없다.
// 중복은 지우지 않고 합치는 병합 도구(src/lib/studentMerge/engine.ts)로 처리한다.

const route = await readFile("src/app/api/admin/cleanup-duplicates/route.ts", "utf8");

test("중복 정리 라우트에 영구 삭제 구문이 없다", () => {
  assert.doesNotMatch(route, /DELETE\s+FROM/i, "학생·청구 기록을 지우는 구문이 되살아났습니다");
});

test("삭제 요청(POST)은 410 으로 막히고 병합 도구를 안내한다", () => {
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /status: 410/);
  assert.match(post, /병합 도구/);
  // 막더라도 관리자 확인은 남긴다 — 비로그인 요청에 안내문조차 주지 않는다.
  assert.match(post, /requireAdmin\(\)/);
});

test("미리보기(GET)는 읽기 전용으로 남아 있다", () => {
  assert.match(route, /export async function GET\(\)/);
});
