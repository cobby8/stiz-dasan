import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const notificationSource = readFileSync(
  new URL("./operational-staff-notification.ts", import.meta.url),
  "utf8",
);
const absenceSource = readFileSync(
  new URL("./regular/parent-regular-absence.ts", import.meta.url),
  "utf8",
);
const shuttleSource = readFileSync(
  new URL("./shuttle/parent-shuttle-exception.ts", import.meta.url),
  "utf8",
);
const enrollmentSource = readFileSync(
  new URL("./enrollment/parent-change-request.ts", import.meta.url),
  "utf8",
);
const vercelSource = readFileSync(new URL("../../vercel.json", import.meta.url), "utf8");

test("운영 알림은 원장·부원장과 실제 연결된 담당 코치 및 정규 배차 기사만 찾는다", () => {
  assert.match(notificationSource, /'ADMIN','VICE_ADMIN'/);
  assert.match(notificationSource, /co\."userId"/);
  assert.match(notificationSource, /u\.role='INSTRUCTOR'/);
  assert.match(notificationSource, /u\.role='DRIVER'/);
  assert.match(notificationSource, /RegularDispatchRoute/);
  assert.match(notificationSource, /vehicle->>'driverUserId'/);
  assert.match(notificationSource, /student->>'requestId'=\$4/);
  assert.doesNotMatch(notificationSource, /FROM "User" u\s+WHERE \$3::boolean AND u\.role='DRIVER'/);
  assert.match(notificationSource, /담당 기사 확인 필요/);
});

test("결석은 담당 코치와 기사, 당일 셔틀 변경은 기사에게 알림을 연결한다", () => {
  assert.match(absenceSource, /includeCoach: true/);
  assert.match(absenceSource, /includeDriver: true/);
  assert.match(absenceSource, /driverContext: \{ studentId: input\.studentId, serviceDate: input\.date \}/);
  assert.match(shuttleSource, /includeDriver: true/);
  assert.match(shuttleSource, /direction: input\.direction as ShuttleDirection/);
  assert.match(shuttleSource, /UPDATE "ShuttleDayException" x[\s\S]*RETURNING x\."studentId"/);
  assert.match(shuttleSource, /action: "CANCELED"/);
  assert.match(shuttleSource, /셔틀 당일 변경 취소/);
  assert.match(enrollmentSource, /includeCoach: true/);
  assert.match(enrollmentSource, /관리자 승인 전에는 수업·차량표를 변경하지 마세요/);
});

test("카카오 접수 라우터가 매분 실행 목록에 등록되어 있다", () => {
  const config = JSON.parse(vercelSource) as { crons: Array<{ path: string; schedule: string }> };
  assert.ok(config.crons.some((cron) =>
    cron.path === "/api/cron/kakao-parent-intake-routing" && cron.schedule === "* * * * *"
  ));
});
