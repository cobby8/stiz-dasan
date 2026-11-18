import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");

function functionSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} 시작점을 찾을 수 없습니다.`);
  assert.notEqual(end, -1, `${startMarker} 끝점을 찾을 수 없습니다.`);
  return source.slice(start, end);
}

const cases = [
  ["getStudentActivity", "export async function getStudentActivity", "// ── 알림 조회"],
  ["getClassWithStudents", "export const getClassWithStudents", "/** 반의 수업 기록"],
  ["getSessionReport", "export const getSessionReport", "export async function getStudentReports"],
];

for (const [name, start, end] of cases) {
  test(`${name}는 실제 데이터 없음만 null로 반환하고 조회 오류는 다시 전달한다`, () => {
    const section = functionSection(start, end);
    assert.match(section, /if \(![^\n]+\) return null;/);
    assert.match(section, /catch \(e\)[\s\S]*?throw e;/);
  });
}
