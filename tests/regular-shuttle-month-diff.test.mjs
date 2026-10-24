import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const diff = readFileSync(new URL("../src/lib/regular/regularShuttleDiff.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const importSource = readFileSync(new URL("../src/lib/shuttle/regularImport.ts", import.meta.url), "utf8");
const rosterEdit = readFileSync(new URL("../src/lib/shuttle/regularRosterEdit.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/app/admin/shuttle/regular/RegularShuttleClient.tsx", import.meta.url), "utf8");

test("정규 차량표와 저장 노선은 월별로 보존된다", () => {
  assert.match(schema, /model RegularShuttleStop[\s\S]*serviceMonth\s+String/);
  assert.match(schema, /model RegularDispatchRoute[\s\S]*@@unique\(\[serviceMonth, dayOfWeek, direction\]\)/);
  // 2026-10-02 시트 가져오기 종료 — 명단 쓰기는 셔틀 명단 편집(regularRosterEdit)만 하고, 삭제는 늘 id·월로 한정한다.
  assert.match(rosterEdit, /WHERE "id" = ANY\(\$1::text\[\]\) AND "serviceMonth"=\$2/);
  assert.doesNotMatch(rosterEdit, /DELETE FROM "RegularShuttleStop"`\)/);
  assert.doesNotMatch(rosterEdit, /DELETE FROM "RegularShuttleStop"\s+WHERE "serviceMonth"=\$1/);
  assert.doesNotMatch(importSource, /DELETE FROM "RegularShuttleStop"/);
});

test("차량 변동은 학생별 추가·제외·변경으로 구분한다", () => {
  assert.match(diff, /"ADDED" \| "REMOVED" \| "CHANGED"/);
  assert.match(diff, /beforeText === afterText/);
  assert.match(diff, /parentPhone/);
});

// 2026-10-02 월 비교·변동 문자 미리보기 UI 는 셔틀 명단 화면에서 뺐다(문자 원장 API 는 유지).
test("셔틀 명단 화면은 문자를 발송하지 않는다", () => {
  assert.doesNotMatch(client, /sendManualSms|sendSms|shuttle-notice.*POST|regular-notice/);
});
