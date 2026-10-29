import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const adminReadPayloads = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
const studentsPage = readFileSync(new URL("../src/app/admin/students/page.tsx", import.meta.url), "utf8");
const studentsClient = readFileSync(new URL("../src/app/admin/students/StudentManagementClient.tsx", import.meta.url), "utf8");
const importSummaryRoute = readFileSync(new URL("../src/app/api/admin/students/import-summary/route.ts", import.meta.url), "utf8");

test("관리자 원생 첫 payload는 시트 이관 요약을 함께 조회하지 않는다", () => {
  const payloadStart = adminReadPayloads.indexOf("export function getCachedAdminStudentsPayload");
  const payloadEnd = adminReadPayloads.indexOf("export const getCachedAdminStudentImportSummaryPayload");
  const payloadSource = adminReadPayloads.slice(payloadStart, payloadEnd);

  assert.doesNotMatch(payloadSource, /getStudentSheetImportSummary\(\)/);
  assert.doesNotMatch(studentsPage, /sheetImportSummary=\{sheetImportSummary\}/);
});

// 2026-10-29 원장 지시: 시트 연동이 끝나 원생 화면의 «원생 자료 점검» 블록을 없앴다. 요약 API 는 남겨 둔다.
test("시트 이관 요약 API는 남기고, 원생 화면에서는 점검 블록을 부르지 않는다", () => {
  assert.match(adminReadPayloads, /getCachedAdminStudentImportSummaryPayload/);
  assert.match(importSummaryRoute, /getCachedAdminStudentImportSummaryPayload/);
  assert.doesNotMatch(studentsClient, /\/api\/admin\/students\/import-summary/);
  assert.doesNotMatch(studentsClient, /원생 자료 점검|점검 불러오기|setShowImportTools/);
});
