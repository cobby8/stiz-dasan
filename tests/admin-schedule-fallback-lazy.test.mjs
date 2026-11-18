import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const adminReadPayloads = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
const scheduleRoute = readFileSync(new URL("../src/app/api/admin/schedule/route.ts", import.meta.url), "utf8");

test("관리자 시간표 첫 조회는 DB 시간표를 먼저 확인한다", () => {
  const payloadStart = adminReadPayloads.indexOf("export const getCachedAdminSchedulePayload");
  const payloadEnd = adminReadPayloads.indexOf("export function getCachedAdminTrialPayload");
  const payloadSource = adminReadPayloads.slice(payloadStart, payloadEnd);

  assert.match(payloadSource, /const \[dbScheduleData, coaches, programs\]/);
  assert.doesNotMatch(payloadSource, /const \[settings, dbScheduleData, coaches, programs\]/);
});

// 2026-11-18 결정표(sheet-switch «완전히 지운다»): 구글시트 사본(SheetSlotCache)으로 넘어가던 대체 경로를 지웠다.
// DB 시간표가 없으면 수업 칸은 비우고(slots: []) 칸 설정·직접 추가한 수업만 읽는다.
test("DB 시간표가 없을 때 대체 경로는 구글시트 사본을 읽지 않고 수업 칸을 비운다", () => {
  for (const source of [adminReadPayloads, scheduleRoute]) {
    assert.match(source, /if \(!scheduleData\) \{[\s\S]*getClassSlotOverrides\(\)[\s\S]*getCustomClassSlots\(\)[\s\S]*slots: \[\],[\s\S]*scheduleSource: "EMPTY"/);
    assert.doesNotMatch(source, /getSheetSlotCache|googleSheetsScheduleUrl|SHEET_CACHE|hasSheetUrl/);
  }
  assert.match(scheduleRoute, /fallback-data/);
});
