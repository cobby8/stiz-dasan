// 방학특강 회차 기록을 관리자 수업일지로 고칠 때 정규반 명단 출석이 그 기록에 들어가지 않게 못박는다.
// 왜: 특강 출석은 좌석(SpecialProgramEnrollmentDate) 기준이고, 출석이 생긴 회차는 특강 날짜를 지우거나 옮길 수 없게 막힌다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const admin = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const modal = readFileSync(new URL("../src/app/admin/classes/[id]/SessionLogModal.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/admin/session-detail/route.ts", import.meta.url), "utf8");

function saveSessionLogBody() {
  const start = admin.indexOf("export async function saveSessionLog(");
  assert.ok(start >= 0, "saveSessionLog 를 찾지 못함");
  const end = admin.indexOf("\nexport ", start + 10);
  return admin.slice(start, end);
}

test("서버: 특강 회차 기록이면 출석 UPSERT 를 건너뛴다", () => {
  const body = saveSessionLogBody();
  assert.match(body, /"specialProgramSessionDateId" IS NOT NULL/);
  const guard = body.indexOf("if (!isSeasonal && data.attendances");
  const upsert = body.indexOf('INSERT INTO "Attendance"');
  assert.ok(guard >= 0, "isSeasonal 조건이 출석 저장 앞에 있어야 한다");
  assert.ok(upsert > guard, "출석 INSERT 는 isSeasonal 조건 안에 있어야 한다");
});

test("상세 API 가 특강 회차 여부를 내려준다", () => {
  assert.match(route, /"specialProgramSessionDateId" IS NOT NULL\) AS "isSeasonal"/);
  assert.match(route, /isSeasonal: Boolean\(/);
});

test("화면: 특강 회차 수정이면 출석 칸을 숨기고 출석을 보내지 않는다", () => {
  assert.match(modal, /const seasonalEdit = !!initialData\?\.isSeasonal && initialData\.date === date;/);
  assert.match(modal, /\{seasonalEdit \? \(/);
  assert.match(modal, /attendances: !\(initialData\?\.isSeasonal && initialData\.date === date\) && visibleAttendances\.length > 0/);
});
