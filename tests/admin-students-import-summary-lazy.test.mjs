import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const adminReadPayloads = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
const studentsPage = readFileSync(new URL("../src/app/admin/students/page.tsx", import.meta.url), "utf8");
const studentsClient = readFileSync(new URL("../src/app/admin/students/StudentManagementClient.tsx", import.meta.url), "utf8");

test("관리자 원생 첫 payload는 시트 이관 요약을 함께 조회하지 않는다", () => {
  assert.doesNotMatch(adminReadPayloads, /getStudentSheetImportSummary\(\)/);
  assert.doesNotMatch(studentsPage, /sheetImportSummary=\{sheetImportSummary\}/);
});

// 2026-10-29 원장 지시: 시트 연동이 끝나 원생 화면의 «원생 자료 점검» 블록을 없앴다.
// 2026-11-18 옛 코드 정리 B: 아무도 부르지 않던 요약 API 와 그 조회 함수도 지웠다.
test("시트 이관 요약 API·조회 함수는 지워져 있고, 원생 화면에서도 점검 블록을 부르지 않는다", () => {
  assert.equal(existsSync(new URL("../src/app/api/admin/students/import-summary/route.ts", import.meta.url)), false);
  assert.doesNotMatch(adminReadPayloads, /getCachedAdminStudentImportSummaryPayload/);
  assert.doesNotMatch(studentsClient, /\/api\/admin\/students\/import-summary/);
  assert.doesNotMatch(studentsClient, /원생 자료 점검|점검 불러오기|setShowImportTools/);
});
