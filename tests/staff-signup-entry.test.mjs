import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminActionSource = await readFile("src/app/actions/admin.ts", "utf8");
const inviteModalSource = await readFile("src/app/admin/staff/InviteStaffModal.tsx", "utf8");
const staffClientSource = await readFile("src/app/admin/staff/StaffClient.tsx", "utf8");
// 옛 선생님 설치 화면(StaffAppInstallClient)은 2026-11-18 지웠다 — /teacher-app 은 /install 로 넘기기만 한다
const teacherAppPage = await readFile("src/app/teacher-app/page.tsx", "utf8");
const loginSource = await readFile("src/app/login/page.tsx", "utf8");
const smsSource = await readFile("src/lib/sms.ts", "utf8");

test("staff invitation returns a usable personal link even when SMS fails", () => {
  assert.match(adminActionSource, /const smsResult = baseUrl[\s\S]*?await sendFailClosedTrackedSms/);
  assert.match(adminActionSource, /return \{[\s\S]*?token,[\s\S]*?inviteUrl,[\s\S]*?smsSent: smsResult\.ok/);
  assert.match(adminActionSource, /NEXT_PUBLIC_SITE_URL[\s\S]*?NEXT_PUBLIC_BASE_URL[\s\S]*?VERCEL_URL/);
  assert.match(adminActionSource, /data\.role !== "INSTRUCTOR" && data\.role !== "DRIVER"/);
  assert.match(adminActionSource, /\/\^010\\d\{8\}\$\//);
  assert.match(adminActionSource, /parsedUrl\.protocol !== "https:" \|\| isLocalHost/);
  assert.match(adminActionSource, /:\s*\{ ok: false, reason: SMS_SITE_URL_MISSING \}/);
  assert.doesNotMatch(smsSource, /body="\$\{body\}"/);
  assert.doesNotMatch(smsSource, /to=\$\{recipientNo\}/);
  assert.match(smsSource, /maskedRecipient/);
  assert.match(smsSource, /bodyLength=\$\{body\.length\}/);
});

test("admin can invite instructors and shuttle drivers through personal links", () => {
  assert.match(inviteModalSource, /새 스태프 초대·가입/);
  assert.match(inviteModalSource, /value="INSTRUCTOR"/);
  assert.match(inviteModalSource, /value="DRIVER"/);
  assert.match(inviteModalSource, /navigator\.clipboard\.writeText\(absoluteInviteUrl\(result\.inviteUrl\)\)/);
  assert.match(inviteModalSource, /<AdminModal/);
  assert.match(inviteModalSource, /titleId="invite-staff-modal-title"/);
  assert.match(staffClientSource, /handleCopyInvitationLink\(inv\.token, inv\.name\)/);
  assert.match(staffClientSource, /스태프용 앱 설치 링크/);
  assert.match(staffClientSource, /DRIVER: \{ label: "셔틀 기사"/);
});

test("public install and login screens guide staff to personal invitation signup", () => {
  assert.match(teacherAppPage, /redirect\("\/install"\);/);
  assert.match(loginSource, /선생님 계정을 새로 만들 수 없습니다/);
});
