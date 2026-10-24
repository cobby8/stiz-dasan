import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const trialModals = readFileSync(
  new URL("../src/app/admin/trial/TrialCrmModals.tsx", import.meta.url),
  "utf8",
);
const scheduleTimeHelper = readFileSync(
  new URL("../src/lib/trial-schedule-time.ts", import.meta.url),
  "utf8",
);

function seoulDateInputValue(value) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function resolveTrialScheduleStartTime(candidate, selectedDate) {
  if (candidate.startTimeOverride) return candidate.startTimeOverride;
  const dateKey = (value) => value ? seoulDateInputValue(value) : null;
  const active =
    (!dateKey(candidate.scheduleActiveFrom) || selectedDate >= dateKey(candidate.scheduleActiveFrom)) &&
    (!dateKey(candidate.scheduleActiveTo) || selectedDate <= dateKey(candidate.scheduleActiveTo));
  if (candidate.scheduleStartTime && active) return candidate.scheduleStartTime;
  return candidate.customStartTime || candidate.startTime || "";
}

test("체험 일정 날짜와 시간은 관리자 PC가 아니라 Asia/Seoul 기준을 사용한다", () => {
  assert.match(
    scheduleTimeHelper,
    /timeZone:\s*SEOUL_TIME_ZONE/,
  );
  assert.match(trialModals, /return seoulDateInputValue\(dateStr\)/);
  assert.match(trialModals, /return seoulTimeInputValue\(dateStr\)/);
});

test("오전 9시 이전 일정도 한국 날짜가 전날로 밀리지 않는다", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    assert.equal(seoulDateInputValue("2026-07-22T15:30:00.000Z"), "2026-07-23");
    assert.equal(seoulDateInputValue("2026-07-22T23:59:00.000Z"), "2026-07-23");
  } finally {
    process.env.TZ = originalTimezone;
  }
});

test("자정 경계 직전과 직후의 한국 날짜를 구분한다", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "UTC";

  try {
    assert.equal(seoulDateInputValue("2026-07-22T14:59:59.000Z"), "2026-07-22");
    assert.equal(seoulDateInputValue("2026-07-22T15:00:00.000Z"), "2026-07-23");
  } finally {
    process.env.TZ = originalTimezone;
  }
});

test("시간 우선순위는 보정값, 활성 정규 시간표, 커스텀 시간, 기본 반 시간 순서다", () => {
  const candidate = {
    startTime: "18:00",
    customStartTime: "17:00",
    scheduleStartTime: "16:00",
    scheduleActiveFrom: "2026-07-01T00:00:00+09:00",
    scheduleActiveTo: "2026-07-31T23:59:59+09:00",
  };

  assert.equal(resolveTrialScheduleStartTime(candidate, "2026-07-15"), "16:00");
  assert.equal(resolveTrialScheduleStartTime(candidate, "2026-08-01"), "17:00");
  assert.equal(resolveTrialScheduleStartTime({ ...candidate, startTimeOverride: "15:00" }, "2026-08-01"), "15:00");
  assert.equal(resolveTrialScheduleStartTime({ startTime: "18:00" }, "2026-07-15"), "18:00");
});

test("날짜·반 변경은 적용 시간을 다시 계산하고 저장값에는 한국 오프셋을 명시한다", () => {
  assert.match(trialModals, /handleDateChange[\s\S]*setScheduledClassId\(""\);[\s\S]*setScheduledTime\(""\)/);
  assert.match(trialModals, /handleClassChange[\s\S]*options\.find\(\(option\) => option\.classId === classId\)\?\.startTime/);
  assert.match(scheduleTimeHelper, /`\$\{selectedDate\}T\$\{normalizedTime\}\+09:00`/);
});

test("이미 확정한 수동 시간은 모달을 다시 열어도 반 기본 시간으로 덮지 않는다", () => {
  assert.match(
    trialModals,
    /lead\.scheduledDate && !isDateOnlySchedulePlaceholder\(lead\.scheduledDate\)[\s\S]*timeInputValue\(lead\.scheduledDate\)/,
  );
});

test("날짜 전용 placeholder는 브라우저 시간대로 변환하지 않고 확정시간에서 제외한다", () => {
  assert.match(trialModals, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  assert.doesNotMatch(trialModals, /getHours\(\) === 9/);
});
