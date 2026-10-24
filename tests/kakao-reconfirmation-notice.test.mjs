import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const action = readFileSync('src/app/actions/kakao-reconfirmation-notice.ts', 'utf8');
const bot = readFileSync('src/lib/kakao-parent-chatbot.ts', 'utf8');
const ui = readFileSync('src/app/admin/kakao-requests/KakaoRequestsClient.tsx', 'utf8');

test('관리자 인증 후 선택한 접수의 인증 보호자로만 링크 발급', () => {
  const prepare = action.slice(action.indexOf('export async function prepareKakaoReconfirmationNotice'));
  assert.ok(prepare.indexOf('await requireAdmin()') < prepare.indexOf('prisma.$queryRawUnsafe'));
  assert.match(action, /r\.id=\$1 AND r\.status='APPROVED' AND i\.status='ACTIVE'/);
  assert.match(action, /issuePendingReconfirmationLink\(rows\[0\], intakeId, admin\.appUserId\)/);
  assert.match(bot, /\(\$3::text IS NULL OR i\.id=\$3\)/);
  assert.match(bot, /ki\.status='ACTIVE' AND ki\."parentUserId"=\$2/);
});

test('SMS 명시 승인과 현재 수신자·문구·토큰을 결합하며 발송직전 재검증한다', () => {
  const send = action.slice(action.indexOf('export async function sendKakaoReconfirmationNotice'));
  assert.match(send, /await requireAdmin\(\)/);
  assert.match(send, /input.channel !== "SMS"/);
  assert.match(action, /phoneHash: hashMessageRecipientPhone/);
  assert.match(action, /bodyHash: hashMessageBody/);
  assert.match(action, /tokenHash: kakaoReconfirmationTokenHash/);
  assert.match(send, /const latest = await currentNotice/);
  assert.match(send, /finalizeReservedSmsWithoutDispatch/);
  assert.match(ui, /SMS 1건 발송/);
});

test('유효한 발송중·접수·실패 링크는 재발급으로 중복발송을 우회하지 않는다', () => {
  assert.match(bot, /d.status IN \('PENDING','SENDING','SENT','FAILED'\)/);
  assert.match(bot, /if \(protectedLinks.length\) return null/);
  const notification = readFileSync('src/lib/notification.ts', 'utf8');
  assert.match(notification, /KAKAO_RECONFIRMATION_SMS_APPROVED/);
  assert.match(notification, /MANUAL_APPROVAL_CHANGED/);
  assert.match(notification, /const policy = manualReconfirmation/);
});
test('준비는 HELD이며 자동 발송이나 완료 기록을 만들지 않는다', () => {
  assert.match(action, /status: "HELD"/);
  assert.match(action, /sent: false/);
  assert.doesNotMatch(action, /sendSms|sendTrackedSms|notifyParents|fetch\(/);
});
test('미리보기에는 만료와 재발급 무효화 안내를 표시하며 토큰을 브라우저 저장소에 쓰지 않는다', () => {
  assert.match(ui, /재확인 링크·안내 준비 \(미발송\)/);
  assert.match(ui, /이전 링크는 무효/);
  assert.match(ui, /notice\.expiresAt/);
  assert.match(ui, /readOnly value=\{notice\.message\}/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
});
