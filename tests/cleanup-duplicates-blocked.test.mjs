import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// 2026-10-02 Phase 0 정합성 점검에서 막은 기능.
// 예전 POST 는 "이름이 같은 학생 중 학교·학년이 빈 쪽"을 골라 청구·출석·수강 기록까지
// 영구 삭제했다. 이름만으로 판단해 동명이인이 지워지고, 돈 기록은 되돌릴 수 없다.
// 중복은 지우지 않고 합치는 병합 도구(src/lib/studentMerge/engine.ts)로 처리한다.
// 2026-11-18 옛 코드 정리 B: 410 으로 막혀 있던 라우트를 통째로 지웠다. 되살아나지 않게 확인한다.

test("중복 정리 라우트(/api/admin/cleanup-duplicates)는 지워져 있다", () => {
  assert.equal(existsSync("src/app/api/admin/cleanup-duplicates/route.ts"), false);
});
