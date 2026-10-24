import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveTrialScheduleFromRow, resolveTrialScheduleStartTime, toSeoulScheduledDateTime } from "../src/lib/trial-schedule-time.ts";
import { formatTrialScheduleLabel, formatTrialSmsDateTime, hasExplicitTrialTime, isLegacyTrialDatePlaceholder } from "../src/lib/trial-sms-time.ts";

const publicAction = readFileSync("src/app/actions/public.ts", "utf8");
const adminAction = readFileSync("src/app/actions/admin.ts", "utf8");
const serverResolver = readFileSync("src/lib/trial-schedule-server.ts", "utf8");

test("신규 신청의 날짜 전용 희망일은 scheduledDate 자정으로 저장하지 않는다", () => {
  assert.match(publicAction, /null,\s+\/\/ scheduledDate: 관리자 확정 전에는 비워 둔다/);
  assert.match(publicAction, /CASE WHEN status='SCHEDULED' THEN "scheduledDate" ELSE \$9::timestamptz END/);
  assert.match(publicAction, /null, \/\/ 희망일은 날짜뿐이므로 실제 확정시각 칼럼에 자정으로 저장하지 않는다/);
});

test("시간 우선순위와 서울시각 결합은 실제 값으로 동작한다", () => {
  const startTime = resolveTrialScheduleStartTime({
    startTime: "12:00", customStartTime: "11:30", scheduleStartTime: "10:50",
    scheduleActiveFrom: "2026-08-01T00:00:00+09:00", scheduleActiveTo: "2026-08-31T23:59:59+09:00",
  }, "2026-08-29");
  assert.equal(startTime, "10:50");
  const canonical = toSeoulScheduledDateTime("2026-08-29", startTime);
  assert.equal(canonical, "2026-08-29T10:50:00+09:00");
  assert.equal(formatTrialSmsDateTime(canonical), "2026년 8월 29일 (토) 10:50");
});

test("서버 resolver는 override→활성 schedule→custom→Class 순서와 불일치를 차단한다", () => {
  const base = {
    overrideStart: null, overrideHidden: false,
    scheduleStart: "10:50", scheduleDay: "Sat", scheduleHidden: false,
    scheduleActiveFrom: "2026-08-01T00:00:00+09:00", scheduleActiveTo: "2026-08-31T23:59:59+09:00",
    customStart: "11:20", customDay: "Sat", customHidden: false,
    classStart: "12:00", classDay: "Sat", classSlotKey: "Sat-2", className: "토2",
  };
  const input = { selectedDate: "2026-08-29", slotKey: "Sat-2", scheduledClassId: "class-1" };
  assert.equal(resolveTrialScheduleFromRow(base, input).startTime, "10:50");
  assert.equal(resolveTrialScheduleFromRow({ ...base, overrideStart: "10:40" }, input).startTime, "10:40");
  assert.equal(resolveTrialScheduleFromRow({ ...base, scheduleActiveFrom: "2026-08-29T00:00:00+09:00" }, input).startTime, "10:50");
  assert.equal(resolveTrialScheduleFromRow({ ...base, scheduleActiveFrom: "2026-08-30T00:00:00+09:00" }, input).startTime, "11:20");
  assert.equal(resolveTrialScheduleFromRow({ ...base, scheduleActiveTo: "2026-08-28T23:59:59+09:00" }, input).startTime, "11:20");
  assert.equal(resolveTrialScheduleFromRow({ ...base, scheduleStart: null, customStart: null }, input).startTime, "12:00");
  assert.throws(() => resolveTrialScheduleFromRow({ ...base, scheduleStart: null, customStart: null, classStart: null }, input), /시작시간/);
  assert.throws(() => resolveTrialScheduleFromRow({ ...base, scheduleHidden: true }, input), /숨김/);
  assert.throws(() => resolveTrialScheduleFromRow({ ...base, classSlotKey: "Sat-3" }, input), /일치하지 않습니다/);
  assert.throws(() => resolveTrialScheduleFromRow({ ...base, scheduleDay: "Fri" }, input), /요일/);
  assert.match(serverResolver, /resolveTrialScheduleFromRow\(rows\[0\], input\)/);
});

test("명시한 유효 확정 시각은 canonical 검증 뒤 덮어쓰지 않는다", () => {
  const update = adminAction.slice(adminAction.indexOf("export async function updateTrialLead"), adminAction.indexOf("export async function deleteTrialLead"));
  assert.match(update, /const hasExplicitScheduledTime/);
  assert.match(update, /const nextScheduledDate = hasExplicitScheduledTime \? explicitScheduledDate : canonical\.scheduledDate/);
});

test("저장 확정시각 11:10은 canonical 10:50과 달라도 학부모·담당자 문자에 동일하게 유지된다", () => {
  const stored = "2026-08-29T11:10:00+09:00";
  assert.equal(hasExplicitTrialTime(stored), true);
  assert.equal(hasExplicitTrialTime("2026-08-29"), false);
  assert.equal(formatTrialSmsDateTime(stored), "2026년 8월 29일 (토) 11:10");
  assert.equal(formatTrialScheduleLabel("Sat 10:50", stored), "Sat 11:10");

  const notice = adminAction.slice(adminAction.indexOf("export async function sendTrialCoachNotice"));
  assert.match(notice, /lead\.scheduledDate \?\? lead\.scheduleddate \?\? lead\.trialDate/);
  assert.match(notice, /resolveCanonicalTrialSchedule/);
  assert.match(notice, /hasStoredConfirmedTime[\s\S]*formatTrialSmsDateTime\(confirmedScheduleDate\)[\s\S]*canonicalSchedule\.formattedDate/);
  assert.match(notice, /formatTrialScheduleLabel\(canonicalSchedule\.scheduleLabel, confirmedScheduleDate\)/);
  assert.doesNotMatch(notice, /new Date\(trialDate\)\.toLocaleString/);
  // 학부모 확정 문자도 같은 DB scheduledDate를 직접 포맷한다.
  assert.match(adminAction, /const dateStr = formatTrialSmsDateTime\(scheduledDate\)/);
});

test("DB Date 왕복 자정은 원본 희망일과 같고 확정 근거가 없을 때만 placeholder다", () => {
  const legacyRoundTrip = new Date("2026-08-29T00:00:00.000Z");
  assert.equal(isLegacyTrialDatePlaceholder({
    scheduledDate: legacyRoundTrip,
    trialDate: new Date("2026-08-29T00:00:00.000Z"),
    status: "NEW",
    scheduledClassId: null,
  }), true);

  // 실제 09:00 확정도 UTC로는 자정이므로, 확정 상태와 반이 있으면 절대 placeholder로 보지 않는다.
  assert.equal(isLegacyTrialDatePlaceholder({
    scheduledDate: legacyRoundTrip,
    trialDate: new Date("2026-08-29T00:00:00.000Z"),
    status: "SCHEDULED",
    scheduledClassId: null,
  }), false);
  // preferredSlotKey만 남은 과거 행이어도 SCHEDULED 수동 09:00은 확정값이다.
  const scheduledWithoutClass = {
    scheduledDate: new Date("2026-08-29T00:00:00.000Z"),
    trialDate: new Date("2026-08-29T00:00:00.000Z"),
    status: "SCHEDULED",
    scheduledClassId: null,
    preferredSlotKey: "Sat-2",
  };
  assert.equal(isLegacyTrialDatePlaceholder(scheduledWithoutClass), false);
  assert.equal(formatTrialSmsDateTime(scheduledWithoutClass.scheduledDate), "2026년 8월 29일 (토) 09:00");
  assert.equal(isLegacyTrialDatePlaceholder({
    scheduledDate: new Date("2026-08-29T02:10:00.000Z"),
    trialDate: new Date("2026-08-29T02:10:00.000Z"),
    status: "NEW",
    scheduledClassId: null,
  }), false);

  const notice = adminAction.slice(adminAction.indexOf("export async function sendTrialCoachNotice"));
  assert.match(notice, /isLegacyTrialDatePlaceholder/);
  assert.match(notice, /hasExplicitTrialTime\(storedScheduledDate\) && !legacyDatePlaceholder/);
});
