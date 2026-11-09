// 승인된 휴원·퇴원 «취소 요청»(2026-11-10 원장 결정 d8) — 학부모 요청 → 관리자 승인 → 적용 전에만 CANCELED.
//  ① 데이터: 새 행(kind)이 아니라 대상 신청의 칸(마이그레이션 = 칸 5개 + CHECK, 기존 행 불변)
//  ② 학부모 요청 = 한 문장 UPDATE 의 WHERE 로 소유·상태·종류·적용일(KST)·중복 전부 확인
//  ③ 관리자 승인 = 적용 전·적용일 > KST 오늘·적용 명령 없음일 때만 CANCELED, 거절 = 요청만 닫음, 감사 로그
//  ④ 알림 = 1단계 경로(앱 알림), 받는 사람 = 취소를 요청한 보호자, 문구 실제 실행
//  ⑤ 마이그레이션 전에도 화면은 열린다(목록은 빈 목록, 타임라인은 칸 없이 다시 읽음)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (p) => readFileSync(p, "utf8");
const migration = read("prisma/migrations/20261110130000_enrollment_change_cancel_request/migration.sql");
const parentLib = read("src/lib/enrollment/parent-change-request.ts");
const adminLib = read("src/lib/enrollment/admin-change-request.ts");
const notify = read("src/lib/enrollment/change-decision-notify.ts");
const status = await loadTsModule("src/lib/enrollment/parentChangeStatus.ts");

test("① 마이그레이션: 칸 5개 + CHECK + 부분 인덱스, 전부 IF NOT EXISTS, 기존 행을 바꾸는 문장 없음", () => {
  for (const col of ["cancelRequestStatus", "cancelRequestedAt", "cancelRequestedByUserId", "cancelRequestReason", "cancelDecisionNote"]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${col}"`), col);
    assert.match(read("prisma/schema.prisma"), new RegExp(`\\b${col}\\s`), `schema.prisma 사본에도 ${col}`);
  }
  assert.match(migration, /CHECK \("cancelRequestStatus" IS NULL OR "cancelRequestStatus" IN \('PENDING', 'APPROVED', 'REJECTED'\)\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "EnrollmentChangeRequest_cancel_pending_idx"/);
  const body = migration.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(body, /\bUPDATE\b|\bDELETE\b|\bDROP\b|NOT NULL/i, "기존 데이터·칸을 건드리지 않는다");
  assert.match(migration, /되돌림 SQL/);
});

test("② 학부모 취소 요청: 한 문장 UPDATE 에 소유·병합·APPROVED·미적용·휴원/퇴원·적용일 > KST 오늘·중복 금지", () => {
  const fn = parentLib.slice(parentLib.indexOf("export async function requestScheduledChangeCancel"), parentLib.indexOf("async function notifyAdminsOfChangeRequest"));
  assert.match(fn, /UPDATE "EnrollmentChangeRequest" r/);
  assert.match(fn, /childAccessSql\("s", "\$1"\)/);
  assert.match(fn, /notMergedStudent\("s"\)/);
  assert.match(fn, /r\.status = 'APPROVED' AND r\."appliedAt" IS NULL/);
  assert.match(fn, /r\.kind IN \('PAUSE','WITHDRAW'\)/);
  assert.match(fn, /r\."effectiveFrom" > \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/, "timestamptz now() 는 AT TIME ZONE 한 번");
  assert.match(fn, /r\."cancelRequestStatus" IS NULL/, "거절된 요청은 다시 못 낸다");
  assert.match(fn, /"cancelRequestedByUserId" = \$1/);
  assert.doesNotMatch(fn, /SET status/, "학부모는 상태를 직접 바꾸지 않는다(관리자 승인으로만)");
  assert.match(read("src/app/api/mypage/enrollment-change/route.ts"), /body\?\.action === "cancel-request"[\s\S]{0,120}requestScheduledChangeCancel\(parent\.appUserId/);
});

test("③ 관리자 승인·거절: 적용 전에만 CANCELED · 거절은 요청만 · 감사 로그 · 원장만", () => {
  const fn = adminLib.slice(adminLib.indexOf("export async function decideEnrollmentCancelRequest"));
  const [approveSql, rejectSql] = fn.split("// 거절 = 취소 요청만 닫는다");
  assert.match(approveSql, /SET status = 'CANCELED', "cancelRequestStatus" = 'APPROVED'/);
  assert.match(approveSql, /r\."cancelRequestStatus" = 'PENDING'/);
  assert.match(approveSql, /r\.status = 'APPROVED' AND r\."appliedAt" IS NULL/);
  assert.match(approveSql, /r\."effectiveFrom" > \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.match(approveSql, /NOT EXISTS \(SELECT 1 FROM "OperationsCommand" c WHERE c\."idempotencyKey" = 'enrollment-change:' \|\| r\.id\)/, "적용 크론이 이미 잡은 건은 못 취소");
  assert.doesNotMatch(rejectSql, /SET status/, "거절은 원래 승인을 건드리지 않는다");
  assert.match(rejectSql, /"cancelRequestStatus" = 'REJECTED'/);
  assert.match(fn, /action: "ENROLLMENT_CHANGE_CANCEL_DECIDED"/);
  assert.match(fn, /notifyParentOfEnrollmentChange\(input\.requestId, input\.approve \? "CANCEL_APPROVED" : "CANCEL_REJECTED"\)/);
  const action = read("src/app/actions/enrollment-changes.ts");
  assert.match(action, /export async function decideEnrollmentChangeCancelRequest[\s\S]{0,200}await requireAdmin\(\)/);
  // 적용 크론은 APPROVED 행만 잠가 반영한다 — 먼저 CANCELED 가 되면 건너뛴다(크론은 바꾸지 않았다)
  assert.match(adminLib, /WHERE id = \$1 AND status = 'APPROVED'\s+AND "appliedAt" IS NULL FOR UPDATE/);
  // 관리자 화면: 탭과 무관하게 맨 위 · 늦은 건은 승인 잠금
  const ui = read("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx");
  assert.match(ui, /학부모 취소 요청 \{cancelRequests\.length\}건/);
  assert.match(ui, /disabled=\{pending \|\| row\.tooLate\} onClick=\{\(\) => decideCancel\(row, true\)\}/);
});

test("④ 알림: 받는 사람 = 취소를 요청한 보호자(보호자 재확인), 문구는 실제 실행", () => {
  assert.match(notify, /if \(cancelEvent\) \{[\s\S]*?recipientUserId = extra\[0\]\.cancelRequestedByUserId;/);
  assert.match(notify, /row\.studentId, recipientUserId,/, "지금도 그 학생 보호자인지 같은 가드로");
  assert.match(notify, /stableEventKey: `enrollment-change:\$\{requestId\}:\$\{event\}`/, "중복 키 = 이벤트별 한 번");
  const ok = status.buildChangeDecisionNotice({ event: "CANCEL_APPROVED", studentName: "김합성", className: "월요반", kind: "PAUSE", effectiveFrom: "2026-12-01" });
  assert.equal(ok.message, "김합성 월요반 휴원 예정(12/1부터)이 취소됐어요. 지금처럼 수업을 이어 가요");
  const no = status.buildChangeDecisionNotice({ event: "CANCEL_REJECTED", studentName: "김합성", className: "월요반", kind: "WITHDRAW", effectiveFrom: "2026-12-01", decisionNote: "  이미 대기자에게\n자리를 안내했어요 " });
  assert.equal(no.message, "김합성 월요반 퇴원 취소 요청이 받아들여지지 않았어요: 이미 대기자에게 자리를 안내했어요");
});

test("⑤ 마이그레이션 전에도 화면은 열린다", () => {
  assert.match(read("src/app/admin/enrollment-changes/page.tsx"), /getEnrollmentCancelRequests\(\)\.catch\(/);
  assert.match(read("src/lib/requests/parent-timeline.ts"), /withCancelRequest: true \}\)\s*\.catch\(\(\) => getEnrollmentChangeHistory\(parentUserId, \{ includeOpen: true \}\)\)/);
  // 예전 «지난 결과»(수강 변경 화면)는 새 칸을 읽지 않는다
  assert.match(parentLib, /const history = await getEnrollmentChangeHistory\(parentUserId\);/);
});
