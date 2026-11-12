// 스태프 관리 화면 점검(2026-11-12) — «한 사람 = 한 줄» 목록 조립과 함께 고친 고장들을 못박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildStaffRoster, invitationDaysLeft, isLivePendingInvitation } from "../src/lib/staff/staffRoster.ts";

const NOW = Date.parse("2026-11-12T03:00:00Z"); // KST 12:00
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const invite = (over) => ({ id: "i1", name: "이병하", phone: "010-1111-2222", role: "INSTRUCTOR", status: "PENDING", expiresAt: iso(NOW + 7 * DAY), ...over });
const coach = (over) => ({ id: "c1", name: "이병하", role: "코치", phone: "01011112222", userId: null, ...over });
const user = (over) => ({ id: "u1", name: "김원장", phone: "01099990000", role: "ADMIN", coachId: null, ...over });

test("초대 대기 중인 코치는 코치 프로필 줄과 합쳐 한 줄로 — 전화번호(숫자만)가 같으면 짝", () => {
  const { rows } = buildStaffRoster({ staffUsers: [], coaches: [coach()], invitations: [invite()], nowMs: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "invite");
  assert.equal(rows[0].coach?.id, "c1");
  assert.equal(rows[0].daysLeft, 7);
});

test("전화번호가 다르면 이름으로 짝(가입 시 자동 연결 규칙과 같은 순서) · 전화가 같은 코치가 먼저", () => {
  const byName = buildStaffRoster({ staffUsers: [], coaches: [coach({ phone: null })], invitations: [invite()], nowMs: NOW });
  assert.equal(byName.rows.length, 1);
  const both = buildStaffRoster({
    staffUsers: [],
    coaches: [coach({ id: "same-name", phone: null }), coach({ id: "same-phone", name: "다른이름" })],
    invitations: [invite()],
    nowMs: NOW,
  });
  assert.equal(both.rows[0].coach?.id, "same-phone");
  assert.deepEqual(both.rows.slice(1).map((r) => r.coach.id), ["same-name"]);
});

test("기사 초대는 코치 프로필과 짝짓지 않는다(가입해도 코치 연결은 코치/강사만)", () => {
  const { rows } = buildStaffRoster({ staffUsers: [], coaches: [coach()], invitations: [invite({ role: "DRIVER" })], nowMs: NOW });
  assert.deepEqual(rows.map((r) => r.kind), ["invite", "coach"]);
  assert.equal(rows[0].coach, null);
});

test("이미 계정에 연결된 코치는 짝짓지 않고, 그 계정이 스태프 목록에 있으면 따로 줄을 만들지 않는다", () => {
  const { rows } = buildStaffRoster({
    staffUsers: [user({ id: "u2", role: "INSTRUCTOR", coachId: "c1" })],
    coaches: [coach({ userId: "u2" })],
    invitations: [invite()],
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((r) => r.kind), ["invite", "user"]);
  assert.equal(rows[0].coach, null);
});

test("스태프 목록에 없는 계정(학부모 + 승인된 선생님 역할)에 연결된 코치는 사라지지 않고 «앱 연결됨» 줄로 남는다", () => {
  const { rows } = buildStaffRoster({ staffUsers: [], coaches: [coach({ userId: "parent-with-grant" })], invitations: [], nowMs: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "coach");
  assert.equal(rows[0].linkedElsewhere, true);
});

test("한 코치는 한 초대에만 붙는다", () => {
  const { rows } = buildStaffRoster({
    staffUsers: [],
    coaches: [coach()],
    invitations: [invite({ id: "a" }), invite({ id: "b", phone: "010-3333-4444" })],
    nowMs: NOW,
  });
  assert.equal(rows.filter((r) => r.kind === "invite" && r.coach).length, 1);
});

test("만료·취소·가입 중 초대는 대기 줄이 아니라 이력으로, 가입 멈춤 상태는 복구 개수로 센다", () => {
  const invitations = [
    invite({ id: "live" }),
    invite({ id: "expired", expiresAt: iso(NOW - 1000) }),
    invite({ id: "cancel", status: "CANCELLED" }),
    invite({ id: "stuck", status: "RECOVERY_REQUIRED" }),
    invite({ id: "proc", status: "PROCESSING" }),
  ];
  const result = buildStaffRoster({ staffUsers: [], coaches: [], invitations, nowMs: NOW });
  assert.deepEqual(result.pendingInvitations.map((i) => i.id), ["live"]);
  assert.deepEqual(result.pastInvitations.map((i) => i.id), ["expired", "cancel", "stuck", "proc"]);
  assert.equal(result.recoveryCount, 2);
});

test("순서 = 초대 대기 → 스태프(서버 순서 그대로) → 계정 없는 코치", () => {
  const { rows } = buildStaffRoster({
    staffUsers: [user({ id: "a" }), user({ id: "b", role: "DRIVER" })],
    coaches: [coach({ id: "free", name: "남은코치", phone: "01055556666" })],
    invitations: [invite({ role: "DRIVER" })],
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((r) => r.key), ["invite:i1", "user:a", "user:b", "coach:free"]);
});

test("남은 기간은 예전 화면과 같은 올림 계산, 만료 경계는 시각 비교", () => {
  assert.equal(invitationDaysLeft(iso(NOW + 6 * DAY + 1), NOW), 7);
  assert.equal(invitationDaysLeft(iso(NOW - DAY), NOW), 0);
  assert.equal(isLivePendingInvitation({ status: "PENDING", expiresAt: iso(NOW) }, NOW), false);
  assert.equal(isLivePendingInvitation({ status: "PENDING", expiresAt: iso(NOW + 1) }, NOW), true);
});

// ── 서버 작업 고장 수정(실DB 없이 원문으로 못박기 — 이 저장소의 서버 작업 검사 방식) ──
const admin = await readFile(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const fnBody = (name) => {
  const start = admin.indexOf(`export async function ${name}(`);
  const end = admin.indexOf("\nexport async function ", start + 10);
  return admin.slice(start, end);
};

test("역할을 기사·학부모로 바꾸면 같은 거래에서 코치 연결을 푼다(승인된 선생님 역할이 있으면 유지)", () => {
  const body = fnBody("updateUserRole");
  assert.match(body, /await requireOwner\(\)/);
  assert.match(body, /prisma\.\$transaction\(async \(tx\) =>[\s\S]*UPDATE "User" SET role[\s\S]*!COACH_LINKABLE_ROLES\.includes\(newRole\)[\s\S]*UPDATE "Coach" SET "userId" = NULL[\s\S]*role = 'INSTRUCTOR' AND status = 'ACTIVE'/);
  assert.match(admin, /const COACH_LINKABLE_ROLES: readonly StaffRoleValue\[\] = \["ADMIN", "VICE_ADMIN", "INSTRUCTOR"\]/);
  // 자기 자신은 앱 사용자 ID 로도 막고, 없는 대상은 조용히 성공하지 않는다
  assert.match(body, /userId === user\.appUserId/);
  assert.match(body, /대상 직원을 찾을 수 없습니다/);
  assert.match(body, /STAFF_ROLE_VALUES\.includes\(newRole\)/);
});

test("코치 연결은 한 거래 + 정확히 1건 바뀌었는지 확인(기존 연결만 풀리고 끝나지 않게)", () => {
  const body = fnBody("linkCoachToUser");
  assert.match(body, /await requireOwner\(\)/);
  assert.match(body, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(body, /WHERE id = \$2 AND \("userId" IS NULL OR "userId" = \$1\)/);
  assert.match(body, /if \(linked !== 1\)/);
  assert.match(body, /코치 프로필은 원장·부원장·코치\/강사 계정에만 연결할 수 있습니다/);
  // ORM 기본 메서드 금지(PgBouncer) — 원문 SQL 만
  assert.doesNotMatch(body, /\.coach\.|\.user\.update/);
});

test("중단된 초대 복구 뒤 스태프 화면 캐시 태그도 비운다", async () => {
  const src = await readFile(new URL("../src/app/actions/staff-invite-recovery.ts", import.meta.url), "utf8");
  assert.match(src, /revalidateTag\("admin-staff", \{ expire: 0 \}\)/);
});

test("스태프 화면: 원장만 바꾸기 — 페이지가 역할을 확인해 넘기고, 부원장에겐 선택칸·초대 버튼이 없다", async () => {
  const page = await readFile(new URL("../src/app/admin/staff/page.tsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/app/admin/staff/StaffClient.tsx", import.meta.url), "utf8");
  assert.match(page, /const canManage = admin\.appUserRole === "ADMIN";/);
  assert.match(page, /canManage=\{canManage\}/);
  assert.match(client, /\{canManage \? roleChangeButton\(user\) : roleChip\(user\.role\)\}/);
  assert.match(client, /\{canManage && roleTargetUser && \(/); // 역할 변경 창도 원장만
  assert.match(client, /\{canManage && \(\s*<button[\s\S]*?새 스태프 초대/);
  assert.match(client, /return canManage \? actions : actions\.filter\(\(action\) => action\.key === "copy"\)/);
  // 머리줄 보조 버튼은 ⋯ 더보기 하나로(설치 링크·중단된 초대 복구). «직접 추가»는 2026-11-12 원장 결정으로 없앴다.
  assert.match(client, /<AdminQuickActionMenu label="스태프 관리 더보기" icon="more_horiz"/);
  for (const label of ["스태프용 앱 설치 링크 복사", "중단된 초대 복구"]) assert.ok(client.includes(label), label);
  assert.doesNotMatch(client, /label: "직접 추가"/);
  assert.doesNotMatch(client, /<AddStaffModal/);
  assert.doesNotMatch(page, /<Link href="\/admin\/staff\/recovery"/);
});

test("비밀번호 재설정 초대는 코치와 짝짓지 않고, 이름으로만 맞은 짝은 matchedBy=name 으로 구분한다", () => {
  const reset = buildStaffRoster({ staffUsers: [], coaches: [coach()], invitations: [invite({ purpose: "PASSWORD_RESET" })], nowMs: NOW });
  assert.equal(reset.rows[0].coach, null);
  assert.equal(reset.rows[0].matchedBy, null);
  const byPhone = buildStaffRoster({ staffUsers: [], coaches: [coach()], invitations: [invite()], nowMs: NOW });
  assert.equal(byPhone.rows[0].matchedBy, "phone");
  const byName = buildStaffRoster({ staffUsers: [], coaches: [coach({ phone: "01077778888" })], invitations: [invite()], nowMs: NOW });
  assert.equal(byName.rows[0].matchedBy, "name");
});

test("화면: 연결 예정 코치는 이름(전화 끝 4자리)·«이름 일치» 구분, 휴대폰 카드도 같은 부품, «가입 멈춤»은 휴대폰에서 숫자만", async () => {
  const client = await readFile(new URL("../src/app/admin/staff/StaffClient.tsx", import.meta.url), "utf8");
  assert.match(client, /코치 프로필 \{row\.coach\.name\}\{last4 \? `\(\$\{last4\}\)` : ""\} 연결 예정/);
  assert.match(client, /row\.matchedBy === "name"[\s\S]{0,160}이름 일치/);
  assert.equal(client.match(/\{inviteCoachNote\(row\)\}/g)?.length, 2);
  assert.match(client, /<span className="hidden sm:inline">가입 멈춤<\/span>/);
  assert.doesNotMatch(client, /\bbg-white\b/);
  // main(455fb2c2)의 비밀번호 재설정 표시 보존 — 표·카드·이력
  assert.match(client, /inv\.purpose === "PASSWORD_RESET"/);
  assert.match(client, /\{resetChip\(row\.invite\)\}/);
  assert.match(client, /\{resetChip\(inv\)\}/);
});
