// 앱 가족 연결 해제·병합 이전(2026-11-13) — 보호자 행을 지워도 연결이 남아 계속 자녀 정보를 보던 문제.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const LIB = "src/lib/account/family-access-admin.ts";

test("관리자 해제: 이 학생의 살아 있는 연결만 REVOKED, 그 사람의 대기 요청도 닫는다", async () => {
  const src = await readFile(LIB, "utf8");
  assert.match(src, /SET status = 'REVOKED'[\s\S]*?WHERE id = \$1 AND "studentId" = \$2 AND status = 'ACTIVE'/);
  assert.match(src, /"approverId" = ANY\(\$2::text\[\]\) OR "requesterId" = ANY\(\$2::text\[\]\)/);
  assert.match(src, /SET status = 'CANCELED'/);
  const actions = await readFile("src/app/actions/guardians.ts", "utf8");
  const fn = actions.slice(actions.indexOf("export async function revokeStudentFamilyAccess"));
  assert.match(fn, /await requireAdmin\(\)/);
  assert.match(fn, /return \{ error: "이미 해제됐거나 이 학생의 연결이 아닙니다/, "거절은 값으로");
});

test("보호자 삭제·번호 변경: 그 번호로 자동 연결된(등록 연락처) 계정만, 남은 보호자·대표 보호자와 겹치지 않을 때 해제", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = src.slice(src.indexOf("export async function revokeContactAccessForRemovedPhone"));
  assert.match(fn, /a\.source = 'REGISTERED_CONTACT'/);
  assert.match(fn, /u\.id IS DISTINCT FROM s\."parentId"/);
  assert.match(fn, /NOT EXISTS \(\s*SELECT 1 FROM "Guardian" g/);
  const actions = await readFile("src/app/actions/guardians.ts", "utf8");
  const del = actions.slice(actions.indexOf("export async function deleteStudentGuardian"), actions.indexOf("export async function setPrimaryGuardian"));
  assert.ok(del.indexOf(`DELETE FROM "Guardian"`) < del.indexOf("revokeContactAccessForRemovedPhone"), "보호자 행을 지운 뒤 확인");
  const upd = actions.slice(actions.indexOf("export async function updateStudentGuardian"), actions.indexOf("export async function deleteStudentGuardian"));
  assert.match(upd, /if \(before\.replace\(\/\[\^0-9\]\/g, ""\) !== checked\.value\.phone\.replace/, "번호가 바뀔 때만");
});

test("목록: 대표 보호자 제외·탈퇴 제외·전화는 끝 4자리만, 표가 없으면 빈 목록", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = src.slice(src.indexOf("export async function loadFamilyAccess"), src.indexOf("async function cancelPendingRequestsFor"));
  assert.match(fn, /if \(!await familyAccessTablesPresent\(db\)\) return \[\]/);
  assert.match(fn, /RIGHT\(regexp_replace\(COALESCE\(u\.phone, ''\), '\[\^0-9\]', '', 'g'\), 4\)/);
  assert.match(fn, /u\."withdrawnAt" IS NULL/);
  assert.match(fn, /u\.id IS DISTINCT FROM s\."parentId"/);
  const panel = await readFile("src/app/admin/students/[id]/GuardianPanel.tsx", "utf8");
  assert.match(panel, /familyAccess\.length > 0 && \(/, "연결이 없으면 화면에 아무것도 안 그린다");
  assert.match(panel, /window\.confirm\(/);
});

test("학생 병합: 가족 연결과 대기 요청을 대표 학생으로 옮긴다", async () => {
  const tables = await readFile("src/lib/studentMerge/tables.ts", "utf8");
  assert.match(tables, /table: "ParentStudentAccess",\s*column: "studentId",\s*conflictKeys: \["userId"\]/);
  assert.match(tables, /priority: \{ ACTIVE: 2, REVOKED: 1 \}/);
  assert.match(tables, /table: "ChildLinkRequest",\s*column: "studentId",\s*conflictKeys: \["requesterId"\]/);
  assert.match(tables, /conflictWhere: \(a\) => `\$\{a\}\.status = 'PENDING'`/);
});
