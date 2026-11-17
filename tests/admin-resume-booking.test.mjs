// 관리자 복귀 예약(2026-11-17 원장 신고 «휴원 인원을 복귀로 돌렸는데 복귀 시작일을 지정할 수 없다»)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const action = read("src/app/actions/admin.ts");
const cron = read("src/lib/enrollment/admin-change-request.ts");
const client = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
const queries = read("src/lib/queries.ts");

test("앞날 효력일은 휴원 → 수강 중(복귀)만 받고, 상태는 바꾸지 않고 승인된 복귀 예약을 남긴다", () => {
  const at = action.indexOf("if (effectiveFrom > todayKst()) {");
  assert.ok(at > 0);
  const branch = action.slice(at, action.indexOf("let changedStudentId", at));
  assert.match(branch, /if \(status !== "ACTIVE"\) throw new Error\("미래 효력일은 예약 변경으로 신청해 주세요\."\);/);
  assert.match(branch, /scheduleEnrollmentResume\(enrollmentId, effectiveFrom, change\?\.reason, admin\.appUserId\)/);

  const fn = action.slice(action.indexOf("async function scheduleEnrollmentResume("), action.indexOf("export async function deleteEnrollment("));
  // 날짜 규칙은 학부모 복귀 신청과 같은 함수(오늘~3개월)
  assert.match(fn, /resolveResumeDate\(\{ requested: effectiveFrom, today: todayKst\(\) \}\)/);
  // 잠금 순서: 전역 → 처리 중 신청 → 수강
  assert.ok(fn.indexOf("lockCompensation(tx)") < fn.indexOf("readOpenChangeRequestsForUpdate(tx, enrollmentId)"));
  assert.ok(fn.indexOf("readOpenChangeRequestsForUpdate(tx, enrollmentId)") < fn.indexOf("FOR UPDATE OF e"));
  // 휴원 중인 반만, 처리 중 신청이 있으면 예약하지 않는다
  assert.match(fn, /if \(before\.status !== "PAUSED"\) \{\s*return \{ ok: false/);
  // 관리자가 예약해 둔 복귀뿐이면 닫고 다시 넣는다(날짜 변경). 다른 신청이 섞이면 막는다
  assert.match(fn, /const booked = await adminBookedResumes\(tx, openRequests\);\s*if \(booked\.length !== openRequests\.length\) \{\s*return \{ ok: false/);
  assert.ok(fn.indexOf("supersedeChangeRequests(tx, booked") < fn.indexOf('INSERT INTO "EnrollmentChangeRequest"'));
  // 수강 상태는 건드리지 않는다 — 신청 행만 넣는다
  assert.doesNotMatch(fn, /UPDATE "Enrollment"/);
  assert.match(fn, /'RESUME', \$4::date, \$5, 'APPROVED', \$6, \$6, NOW\(\), NOW\(\), NOW\(\)\)/);
  assert.doesNotMatch(fn, /"appliedAt"/);
});

test("적용일 처리: 관리자가 직접 예약한 복귀는 보호자 확인 없이 적용한다 — 조건은 좁게", () => {
  const at = cron.indexOf("관리자가 학생 상세에서 직접 예약한 복귀");
  assert.ok(at > 0);
  const block = cron.slice(at, cron.indexOf("let classChangeProblem", at));
  assert.match(block, /!parentConfirmed && row\.kind === "RESUME" && row\.requestedByUserId && row\.requestedByUserId === row\.decidedByUserId/);
  assert.match(block, /role::text IN \('ADMIN','VICE_ADMIN'\)/);
  // 판정 함수보다 앞에서 정해져야 한다
  assert.ok(at < cron.indexOf("const plan = planDueEnrollmentChange({"));
});

test("화면: 휴원 → 수강 중일 때만 앞날을 고를 수 있고, 예약된 복귀일을 수강 줄에 보여 준다", () => {
  assert.match(client, /const resumeBooking = statusChange\.currentStatus === "PAUSED" && nextStatus === "ACTIVE";\s*if \(effectiveFrom > todayKst\(\) && !resumeBooking\) \{/);
  assert.match(client, /max=\{statusChange\.currentStatus === "PAUSED" && statusChange\.nextStatus === "ACTIVE" \? undefined : todayKst\(\)\}/);
  assert.match(client, /"복귀 시작일" : "효력일"/);
  assert.match(client, /enrollment\.status === "PAUSED" && enrollment\.resumeFrom && ` · \$\{enrollment\.resumeFrom\} 복귀 예정`/);
  const fn = queries.slice(queries.indexOf("export async function getStudentActivity"));
  assert.match(fn.slice(0, 3000), /p\.name AS program_name, \$\{resumeFromSql\("e"\)\} AS "resumeFrom"/);
});

test("예약한 복귀는 날짜를 바꾸거나 취소할 수 있다 — 관리자가 직접 예약한 것만", () => {
  const pick = action.slice(action.indexOf("async function adminBookedResumes("), action.indexOf("export async function cancelScheduledResume("));
  assert.match(pick, /r\.kind === "RESUME" && r\.status === "APPROVED" && !r\.invoiced && !r\.settled && !r\.linkedCommand/);
  assert.match(pick, /"requestedByUserId" = "decidedByUserId"/);
  const cancel = action.slice(action.indexOf("export async function cancelScheduledResume("), action.indexOf("export async function deleteEnrollment("));
  assert.match(cancel, /const admin = await requireAdmin\(\);/);
  assert.ok(cancel.indexOf("lockCompensation(tx)") < cancel.indexOf("readOpenChangeRequestsForUpdate(tx, enrollmentId)"));
  assert.match(cancel, /if \(!booked\.length\) return \{ ok: false/);
  assert.doesNotMatch(cancel, /UPDATE "Enrollment"/);
  // 화면: 예약이 있을 때만 메뉴에 보이고, 걸린 신청이 없는 거절은 문구만 보여 준다
  assert.match(client, /enrollment\.status === "PAUSED" && enrollment\.resumeFrom\s*\? \[\{ key: "cancel-resume", label: "복귀 예약 취소"/);
  assert.match(client, /if \(!result\.ok && result\.requests\.length === 0\) \{[^}]*setStatusFormError\(result\.message\);/);
});
