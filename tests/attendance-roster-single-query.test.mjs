// 관리자 출결 — 정규 수업의 명단·출결을 한 번의 조회로 읽는다(2026-11-17 속도 개선) — 정적 테스트
//
// 왜: 수업 하나에 조회 네 번(수업 기록 → 명단 → 출결 → 결석 신고)을 차례로 보내면,
//     주간 보드는 수업 수만큼 반복해 운영에서 0.9초가 걸렸다. 다시 네 번으로 쪼개지지 않게 못박는다.
// 결과가 예전 네 조회와 같은지는 운영 DB 에서 128개 수업·날짜 조합으로 대조했다(차이 0, 2026-11-17).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const start = queries.indexOf("export const getAttendanceByDateAndClass");
assert.notEqual(start, -1);
const body = queries.slice(start, queries.indexOf("\nexport ", start + 1));
// 방학특강 갈래(if (sessionDateId) { … })가 끝난 뒤가 정규 수업 갈래다
const regularAt = body.indexOf("// 정규 수업: 수업 기록·명단·출결·결석 신고를 «한 번의 조회»로 읽는다");
assert.ok(regularAt > body.indexOf("if (sessionDateId) {"), "정규 수업 갈래를 찾지 못함");
const regular = body.slice(regularAt);

test("정규 수업 갈래는 DB 를 한 번만 다녀온다", () => {
  assert.equal(regular.split("$queryRawUnsafe").length - 1, 1);
  assert.doesNotMatch(regular, /Promise\.all/);
});

test("한 번의 조회에 네 가지가 다 들어 있다", () => {
  // 수업 기록: 키 있는 기록 먼저(코치 앱과 같은 정본)
  assert.match(regular, /"specialProgramSessionDateId" IS NULL\s+ORDER BY \("sessionKey" IS NULL\), "createdAt" LIMIT 1/);
  // 명단: 수강 중 + 개시일 규칙 + 병합된 학생 제외
  assert.match(regular, /e\."classId" = \$1 AND e\.status = 'ACTIVE'/);
  assert.match(regular, /\$\{notMergedStudent\("s"\)\}/);
  assert.match(regular, /ORDER BY r\.student_name ASC/);
  // 출결: 고른 수업 기록의 것만
  assert.match(regular, /FROM "Attendance" a WHERE a\."sessionId" = sess\.id/);
  // 결석 신고: 그 반·그 날짜·살아 있는 신고만
  assert.match(regular, /ra\."classId" = \$1 AND ra\.date = \$2::date AND ra\.status IN \('REPORTED','CONFIRMED'\)/);
});

test("돌려주는 모양은 예전과 같다", () => {
  for (const key of ["absenceReport:", "studentId:", "studentName:", "photoVersion:", "status:", "attendanceId:"]) {
    assert.ok(regular.includes(key), `${key} 가 빠졌다`);
  }
  // 수업 기록이 없으면 session 은 null
  assert.match(regular, /const session = row\.id \? \{ id: row\.id, classId: row\.classId \?\? row\.classid, date: row\.date, notes: row\.notes \} : null;/);
  // 사진 버전은 1/1000초 숫자로 받아 같은 함수로 만든다(json 의 시각 글자를 그대로 쓰면 시간대가 어긋난다)
  assert.match(regular, /floor\(EXTRACT\(EPOCH FROM \(\$\{profilePhotoUpdatedAtSql\("s"\)\}\)\) \* 1000\) AS "photoUpdatedAtMs"/);
  assert.match(regular, /profilePhotoVersion\(e\.photoUpdatedAtMs \?\? null\)/);
});
