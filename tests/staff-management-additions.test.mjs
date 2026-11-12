// 스태프 관리 추가 기능(2026-11-12 원장 승인 «추천대로 해») — s1 초대로 전환 · s2 추가 역할 줄 · s3 퇴사 처리 ·
// s4 역할 변경 확인창 · s5 마지막 문자 발송 · s6 담당 반. 순수 함수는 실행해 보고, 서버·화면은 약속을 소스로 못박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildStaffRoster, classesForStaff, classAssignmentLabel, inviteSendStatusLabel } from "../src/lib/staff/staffRoster.ts";
import { shouldBlockLoginOnRetire, staffAuthId, staffLoginKind, isConvertibleStaffRole } from "../src/lib/staff/staffAccountLink.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const admin = await read("src/app/actions/admin.ts");
const invite = await read("src/app/actions/invite.ts");
const client = await read("src/app/admin/staff/StaffClient.tsx");
const page = await read("src/app/admin/staff/page.tsx");
const guard = await read("src/lib/auth-guard.ts");
const panelData = await read("src/lib/staff/staffPanelData.ts");

function fnBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, name);
  const next = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

const NOW = Date.parse("2026-11-12T03:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// ── 순수 판정 ───────────────────────────────────────────────

test("로그인 종류: 직접 추가(@staff.local·로그인 없음) / 직원 전용 로그인 / 일반 로그인", () => {
  assert.equal(staffLoginKind({ id: "u", email: "01011112222@staff.local", authUserId: null }), "none");
  assert.equal(staffLoginKind({ id: "u", email: "01011112222@staff.stiz.kr", authUserId: null }), "staffLogin");
  assert.equal(staffLoginKind({ id: "u", email: "01011112222@STAFF.STIZ.KR", authUserId: "a" }), "staffLogin");
  assert.equal(staffLoginKind({ id: "u", email: "mom@gmail.com", authUserId: "a" }), "other");
  // 직접 추가 기록에 로그인이 붙었으면 더는 «없음»이 아니다
  assert.notEqual(staffLoginKind({ id: "u", email: "01011112222@staff.local", authUserId: "a" }), "none");
  // 로그인 id: authUserId 우선, 옛 방식은 User.id, 로그인 없으면 null
  assert.equal(staffAuthId({ id: "u", email: "x@staff.stiz.kr", authUserId: "a" }), "a");
  assert.equal(staffAuthId({ id: "u", email: "x@staff.stiz.kr", authUserId: null }), "u");
  assert.equal(staffAuthId({ id: "u", email: "x@staff.local", authUserId: null }), null);
});

test("퇴사 시 로그인 차단은 직원 전용 로그인 + 자기 자녀 없음일 때만", () => {
  assert.equal(shouldBlockLoginOnRetire({ kind: "staffLogin", hasOwnChildren: false }), true);
  assert.equal(shouldBlockLoginOnRetire({ kind: "staffLogin", hasOwnChildren: true }), false);
  assert.equal(shouldBlockLoginOnRetire({ kind: "other", hasOwnChildren: false }), false);
  assert.equal(shouldBlockLoginOnRetire({ kind: "none", hasOwnChildren: false }), false);
  assert.deepEqual(["INSTRUCTOR", "DRIVER", "ADMIN", "VICE_ADMIN"].map(isConvertibleStaffRole), [true, true, false, false]);
});

test("s1 전환 초대는 그 직원 줄에 붙고(따로 줄 없음) 코치와 새로 짝짓지 않는다", () => {
  const { rows } = buildStaffRoster({
    staffUsers: [{ id: "u1", name: "이병하", phone: "01011112222", role: "INSTRUCTOR", coachId: null }],
    coaches: [{ id: "c1", name: "이병하", role: "코치", phone: "01011112222", userId: null }],
    invitations: [{ id: "i1", name: "이병하", phone: "01011112222", role: "INSTRUCTOR", status: "PENDING", expiresAt: iso(NOW + 7 * DAY), targetUserId: "u1" }],
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((r) => r.kind), ["user", "coach"]);
  assert.equal(rows[0].conversion?.id, "i1");
  // 퇴사 후 재초대처럼 대상이 스태프 목록에 없으면 초대 줄로 남되, 코치와 짝짓지 않는다
  const retired = buildStaffRoster({
    staffUsers: [],
    coaches: [{ id: "c1", name: "이병하", role: "코치", phone: "01011112222", userId: null }],
    invitations: [{ id: "i2", name: "이병하", phone: "01011112222", role: "INSTRUCTOR", status: "PENDING", expiresAt: iso(NOW + DAY), targetUserId: "old" }],
    nowMs: NOW,
  });
  assert.equal(retired.rows[0].kind, "invite");
  assert.equal(retired.rows[0].coach, null);
});

test("s2 추가 역할 직원은 «grant» 줄(스태프 다음), 그 사람에 연결된 코치 프로필은 따로 줄을 만들지 않는다", () => {
  const { rows } = buildStaffRoster({
    staffUsers: [{ id: "u1", name: "김원장", phone: null, role: "ADMIN", coachId: null }],
    coaches: [{ id: "c9", name: "박선생", role: "코치", phone: null, userId: "p1" }, { id: "c2", name: "빈코치", role: "코치", phone: null, userId: null }],
    invitations: [],
    grantUsers: [{ id: "p1", name: "박선생", phone: "01033334444", roles: ["INSTRUCTOR"], coachId: "c9" }],
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((r) => r.kind), ["user", "grant", "coach"]);
  assert.equal(rows[2].coach.id, "c2");
});

test("s6 담당 반: 코치 배정 + 슬롯 없는 반 담당자, 같은 반은 한 번, 요일·시각 순", () => {
  const list = classesForStaff({ id: "u1", coachId: "c1" }, [
    { classId: "k3", name: "토요반", dayOfWeek: "Sat", startTime: "10:00", coachId: "c1", instructorUserId: null },
    { classId: "k1", name: "저학년", dayOfWeek: "Mon", startTime: "16:00", coachId: "c1", instructorUserId: null },
    { classId: "k1", name: "저학년", dayOfWeek: "Mon", startTime: "16:00", coachId: "c1", instructorUserId: null },
    { classId: "k2", name: "특강", dayOfWeek: "Wed", startTime: "17:00", coachId: null, instructorUserId: "u1" },
    { classId: "k4", name: "남의반", dayOfWeek: "Tue", startTime: "15:00", coachId: "c2", instructorUserId: null },
  ]);
  assert.deepEqual(list.map((r) => r.classId), ["k1", "k2", "k3"]);
  assert.equal(classAssignmentLabel(list[0]), "월 16:00 저학년");
});

test("s5 발송 상태 한 단어", () => {
  assert.deepEqual(inviteSendStatusLabel("SENT"), { label: "발송 성공", ok: true });
  assert.equal(inviteSendStatusLabel("FAILED").ok, false);
  assert.equal(inviteSendStatusLabel("SKIPPED").label, "보내지 않음");
  assert.equal(inviteSendStatusLabel("SENDING").ok, null);
});

// ── 서버: 권한·거래·멱등 ─────────────────────────────────────

test("s1 초대로 전환: 원장만 · 직접 추가 기록만 · 문자 자동 발송 없음 · 같은 사람 대기 초대는 재사용", () => {
  const body = fnBody(admin, "convertDirectStaffToInvite");
  assert.match(body, /await requireOwner\(\)/);
  assert.match(body, /staffLoginKind\(target\) !== "none"/);
  assert.match(body, /isConvertibleStaffRole\(target\.role\)/);
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /'SIGNUP', \$4, \$5/);
  assert.match(body, /reused: true/);
  assert.doesNotMatch(body, /sendFailClosedTrackedSms|sendSms/);
  assert.doesNotMatch(body, /\.user\.|\.staffInvitation\./); // ORM 기본 메서드 금지
});

test("s1 가입: 전환 초대는 새 직원 기록 대신 기존 기록에 로그인을 붙이고 코치 연결은 승계", () => {
  assert.match(invite, /if \(invitation\.targetUserId\)/);
  assert.match(invite, /SET "authUserId" = \$1, email = \$2/);
  assert.match(invite, /AND "authUserId" IS NULL AND "withdrawnAt" IS NULL AND lower\(email\) LIKE '%@staff\.local'/);
  assert.match(invite, /if \(attached !== 1\) throw/);
  assert.match(invite, /async function linkCoachProfileIfNone[\s\S]*?SELECT id FROM "Coach" WHERE "userId" = \$1/);
  // 퇴사 뒤 재초대: 로그인 차단 해제 + 역할 복구
  assert.match(invite, /updateUserById\(authId, \{ password, ban_duration: "none" \}\)/);
  // 일반 가입 경로(INSERT)는 그대로
  assert.match(invite, /INSERT INTO "User" \(id, email, name, phone, role, "createdAt", "updatedAt"\)/);
});

test("s3 퇴사 처리: 원장만 · 자기 자신 금지 · 한 거래(역할·코치·추가 역할·대기 초대·감사) · 로그인 차단 · 캐시 비움", () => {
  const body = fnBody(admin, "retireStaffMember");
  assert.match(body, /const owner = await requireOwner\(\)/);
  assert.match(body, /targetId === owner\.appUserId/);
  assert.match(body, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(body, /FOR UPDATE/);
  assert.match(body, /SET role = 'PARENT'::"Role"[^`]*WHERE id = \$1 AND role = \$2::"Role"/);
  assert.match(body, /UPDATE "Coach" SET "userId" = NULL/);
  assert.match(body, /UPDATE "UserRoleGrant"[\s\S]*?'REVOKED'[\s\S]*?status IN \('PENDING', 'ACTIVE'\)/);
  assert.match(body, /UPDATE "StaffInvitation" SET status = 'CANCELLED'[\s\S]*?"targetUserId" = \$1 AND status = 'PENDING'/);
  assert.match(body, /INSERT INTO "OperationsAuditLog"[\s\S]*?'STAFF_RETIRED'/);
  assert.match(body, /ban_duration: RETIRED_LOGIN_BAN_DURATION/);
  assert.match(body, /forgetAppUserRoleCache\(targetId\)/);
  assert.match(body, /alreadyDone: !outcome\.changed/);
  assert.doesNotMatch(body, /\.user\.update|\.coach\.update/);
});

test("s3 역할 캐시: 캐시가 있어도 역할을 다시 읽는다(다른 서버의 5분 캐시가 퇴사자를 통과시키지 않게)", () => {
  assert.match(guard, /SELECT id, name, role FROM "User" WHERE id = \$1 AND "withdrawnAt" IS NULL LIMIT 1/);
  assert.match(guard, /const fresh = \{ \.\.\.active\[0\], expiresAt: cached\.expiresAt \}/);
  assert.match(guard, /export function forgetAppUserRoleCache\(appUserId: string\)/);
});

test("부원장은 보기 전용 — 패널 작업은 canManage 일 때만, 자기 자신에게는 퇴사 버튼 없음", () => {
  assert.match(client, /function buildUserPanelActions[\s\S]*?if \(!canManage\) return \[\];/);
  assert.match(client, /if \(user\.id !== currentUserId\)/);
  assert.match(page, /currentUserId=\{admin\.appUserId\}/);
  assert.match(page, /canManage=\{admin\.appUserRole === "ADMIN"\}/);
});

// ── 화면 ──────────────────────────────────────────────────

test("s4 역할 변경은 공용 확인 창 + 학부모 안내, 브라우저 confirm 을 쓰지 않는다", () => {
  const fn = client.slice(client.indexOf("async function handleRoleChange"), client.indexOf("// ── 코치 연결 핸들러"));
  assert.match(fn, /await askConfirm\(/);
  assert.match(fn, /학부모로 바꾸면 목록에서 빠지고 코치 연결이 풀려요\./);
  assert.doesNotMatch(fn, /\bconfirm\(`/);
  assert.match(client, /\{confirmDialog\}/);
});

test("s3 확인 창은 할 일을 나열하고 체크해야 확정", () => {
  const fn = client.slice(client.indexOf("async function handleRetire"), client.indexOf("// 초대 문자 마지막 발송"));
  for (const word of ["학부모", "코치 프로필", "추가 역할", "로그인"]) assert.ok(fn.includes(word), word);
  assert.match(fn, /acknowledgeLabel:/);
  assert.match(fn, /tone: "danger"/);
});

test("s1·s2·s5 화면: 전환 버튼·링크 복사·문자 보내기, 추가 역할 줄은 신청함 링크, 초대 패널에 마지막 문자", () => {
  assert.match(client, /label: "초대로 전환"/);
  assert.match(client, /label: "링크 복사"/);
  assert.match(client, /label: "문자 보내기"/);
  assert.match(client, /href="\/admin\/role-requests"/);
  assert.match(client, /\{lastSendLine\(detailInvite\.id\)\}/);
  assert.match(client, /classesForStaff\(detailUser, classAssignments\)/);
  // 하드코딩 색 금지
  assert.doesNotMatch(client, /\b(bg|text|border)-(red|green|amber|gray|blue)-\d/);
});

test("덧붙임 조회는 기존 표만 읽는다(새 표 없음) · 담당 반은 선생님 앱 기준과 같은 세 배정 표", () => {
  assert.match(panelData, /FROM "UserRoleGrant" g[\s\S]*?g\.status = 'ACTIVE' AND u\.role = 'PARENT'/);
  assert.match(panelData, /"eventType" = 'STAFF_INVITATION'/);
  for (const table of ["ScheduleSlot", "ClassSlotOverride", "CustomClassSlot"]) assert.ok(panelData.includes(`FROM "${table}"`), table);
  assert.doesNotMatch(panelData, /CREATE TABLE|ALTER TABLE/);
});
