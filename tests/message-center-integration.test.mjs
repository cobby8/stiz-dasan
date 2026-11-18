import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("관리자 자동 발송 API는 내부·외부·보안 규칙과 채널 준비 상태를 반환한다", () => {
    const route = read("src/app/api/admin/sms/automations/route.ts");
    assert.match(route, /MessageAutomationRule/);
    assert.match(route, /audienceScope/);
    assert.match(route, /승인 템플릿의 변수 계약 연결은 다음 단계/);
    assert.match(route, /configured: channelConfigured/);
});

test("인증·보안 자동 발송 규칙은 API와 DB 양쪽에서 변경을 막는다", () => {
    const patchRoute = read("src/app/api/admin/sms/automations/[id]/route.ts");
    const migration = read("prisma/migrations/20260723190000_message_automation_center/migration.sql");
    assert.match(patchRoute, /audienceScope === "SECURITY"/);
    assert.match(patchRoute, /Security messages cannot be changed/);
    assert.match(migration, /SECURITY_PHONE_OTP/);
    assert.match(migration, /'SECURITY'/);
    const dispatcher = read("src/lib/message-dispatch.ts");
    const signup = read("src/lib/parent-signup-verification.ts");
    const claim = read("src/lib/parent-account-claim.ts");
    // 직원 전화 인증 API(/api/admin/verify-phone)는 2026-11-18 옛 코드 정리 B 로 지웠다.
    assert.match(dispatcher, /sendAuthenticationSms/);
    assert.match(dispatcher, /audience: "AUTH"/);
    assert.match(dispatcher, /requestedChannel: "SMS"/);
    assert.match(signup, /sendAuthenticationSms/);
    assert.match(claim, /sendAuthenticationSms/);
});

test("자동 문자는 규칙의 채널을 읽고 통합 발송기로 보내며 실제 결과를 장부에 확정한다", () => {
    const notification = read("src/lib/notification.ts");
    assert.match(notification, /getAutomationPolicy/);
    assert.match(notification, /sendMessageDetailed/);
    assert.match(notification, /providerMessageId/);
    assert.match(notification, /fallbackUsed/);
    assert.match(notification, /unitCost/);
});

test("발송 이력 API는 전화번호를 마스킹하고 최대 조회량을 제한한다", () => {
    const route = read("src/app/api/admin/sms/history/route.ts");
    assert.match(route, /-\*\*\*\*-/);
    assert.match(route, /Math\.min\([^,]+,\s*100\)/);
    assert.match(route, /NotificationDelivery/);
});

test("기존 DB 컬럼만 있는 배포 구간에도 문자 장부를 계속 사용할 수 있다", () => {
    const notification = read("src/lib/notification.ts");
    assert.match(notification, /legacyRows/);
    assert.match(notification, /legacyError/);
});

test("실패 대체 채널과 공급자 접수 상태를 실제 장부에 기록한다", () => {
    const notification = read("src/lib/notification.ts");
    const dispatcher = read("src/lib/message-dispatch.ts");
    assert.match(dispatcher, /fallbackChannel/);
    assert.match(notification, /"fallbackChannel" = \$11/);
    assert.match(notification, /"providerStatus" = \$12/);
    assert.match(notification, /"ACCEPTED"/);
});

test("신규 DB에서 기본 템플릿 생성 뒤 자동 발송 규칙도 함께 채운다", () => {
    const templates = read("src/lib/smsTemplate.ts");
    assert.match(templates, /INSERT INTO "MessageAutomationRule"/);
    assert.match(templates, /FROM "SmsTemplate" t/);
    assert.match(templates, /ON CONFLICT \(trigger\) DO UPDATE/);
});

test("템플릿과 자동화 ON OFF는 같은 거래에서 갱신한다", () => {
    const admin = read("src/app/actions/admin.ts");
    assert.match(admin, /to_regclass\('public\."MessageAutomationRule"'\)/);
    assert.match(admin, /prisma\.\$transaction\(async \(tx\) => updateTemplate/);
    assert.match(admin, /prisma\.\$transaction\(async \(tx\) => resetTemplate/);
});
