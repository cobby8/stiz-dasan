// 학부모 알림톡 1차 9종(2026-11-09) — «금고 틀 = 심사 문서 = 문자 본문»을 실제로 실행해 대조한다.
// 대관(tests/gym-rental-member.test.mjs)과 같은 방식: 틀+변수 → 본문, 변수 목록 일치, 빈 변수 금지.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const reg = await loadTsModule("src/lib/messaging/parent-alimtalk-templates.ts");
const read = (p) => readFileSync(p, "utf8");
const TRIGGERS = Object.keys(reg.PARENT_ALIMTALK_TEMPLATES);

// 호출부가 실제로 넘기는 키 이름 그대로의 샘플 값
const SAMPLE = {
  childName: "홍길동", parentName: "김철수", scheduledDate: "2026년 11월 12일(수) 16:00", className: "초등 A반",
  academyPhone: "031-000-0000", enrollLink: "https://www.stiz-dasan.kr/e/abc123",
  학생명: "박윤우", 운행방향: "등원", 운행일: "2026년 11월 12일 (수)", 예정시간: "15:40", 정류장: "다산자이 정문",
  offeringTitle: "겨울특강 슈팅반", seasonTitle: "2027 겨울방학 특강", amount: "150000", dueDate: "2026. 12. 20.",
  paymentUrl: "https://www.stiz-dasan.kr/payments/inv1", waitlistOrder: "2",
};

test("1차 9종이 정확히 금고에 있다(원장 승인 목록)", () => {
  assert.deepEqual(TRIGGERS.sort(), [
    "SHUTTLE_NO_SHOW_PARENT", "SHUTTLE_ROUTE_CONFIRMED_PARENT",
    "SPECIAL_APPLICATION_APPROVED_PARENT", "SPECIAL_APPLICATION_CANCELLED_PARENT", "SPECIAL_APPLICATION_RECEIVED_PARENT",
    "SPECIAL_APPLICATION_WAITLISTED_PARENT", "SPECIAL_PAYMENT_REQUEST_PARENT",
    "TRIAL_ENROLL_GUIDE_PARENT", "TRIAL_SCHEDULED_PARENT",
  ]);
});

test("틀+변수 = 문자 본문: #{ 가 남지 않고, 변수 목록이 틀과 같고, 값이 비지 않는다", () => {
  for (const trigger of TRIGGERS) {
    const spec = reg.PARENT_ALIMTALK_TEMPLATES[trigger];
    const m = reg.buildParentAlimtalkMessage(trigger, SAMPLE);
    assert.equal(m.body, reg.fillAlimtalkTemplate(spec.body, m.variables), trigger);
    assert.doesNotMatch(m.body, /#\{/, trigger);
    assert.deepEqual(Object.keys(m.variables).sort(), reg.templateVariableKeys(spec.body).sort(), trigger);
    for (const value of Object.values(m.variables)) assert.ok(String(value).trim().length > 0, trigger);
    assert.equal(m.envKey, spec.envKey);
    assert.match(spec.envKey, /^ALIMTALK_TPL_[A-Z_]+$/, trigger);
    assert.ok(m.body.length <= 1000, `${trigger} 본문 1,000자 이내`);
  }
});

test("머리말은 전부 [스티즈농구교실], 수강신청서 안내에 제휴 할인·제휴 공지 링크가 없다", () => {
  for (const trigger of TRIGGERS) {
    assert.ok(reg.PARENT_ALIMTALK_TEMPLATES[trigger].body.startsWith("[스티즈농구교실] "), trigger);
  }
  const guide = reg.PARENT_ALIMTALK_TEMPLATES.TRIAL_ENROLL_GUIDE_PARENT.body;
  assert.doesNotMatch(guide, /다비치|할인|35,000|notices\//);
  assert.match(guide, /■ 수업 준비물: 실내용 운동화, 물 담은 텀블러/);
});

test("빈 변수: 기본값(반·학원전화)은 채우고, 기본값 없는 값이 비면 오류(→ 발송부가 문자로 대체)", () => {
  const trial = reg.buildParentAlimtalkMessage("TRIAL_SCHEDULED_PARENT", { ...SAMPLE, className: "", academyPhone: "" });
  assert.match(trial.body, /반: 추후 안내/);
  assert.match(trial.body, new RegExp(`문의: ${reg.DEFAULT_ACADEMY_PHONE}`));
  // 특강 문자 버그①: 학원전화 미전달 → 빈칸 «문의: » 가 생기지 않는다
  const cancelled = reg.buildParentAlimtalkMessage("SPECIAL_APPLICATION_CANCELLED_PARENT", { childName: "홍길동", offeringTitle: "슈팅반" });
  assert.doesNotMatch(cancelled.body, /문의: $/m);
  // 특강 문자 버그②: 특강명·대기순번이 비면 알림톡 틀을 만들지 않는다
  assert.throws(() => reg.buildParentAlimtalkMessage("SPECIAL_APPLICATION_CANCELLED_PARENT", { ...SAMPLE, offeringTitle: "" }));
  assert.throws(() => reg.buildParentAlimtalkMessage("SPECIAL_APPLICATION_WAITLISTED_PARENT", { ...SAMPLE, waitlistOrder: " " }));
  assert.throws(() => reg.fillAlimtalkTemplate("#{없음}", {}));
});

test("DB 문자 틀 표기({{x}})로 바꿔 같은 값을 넣으면 알림톡 본문과 같은 글자다", () => {
  for (const trigger of TRIGGERS) {
    const sms = reg.parentAlimtalkSmsTemplateBody(trigger);
    assert.doesNotMatch(sms, /#\{/);
    const rendered = sms.replace(/\{\{([\p{L}\p{N}_]+)\}\}/gu, (_, k) => SAMPLE[k] || "");
    assert.equal(rendered, reg.buildParentAlimtalkMessage(trigger, SAMPLE).body, trigger);
  }
});

test("심사 문서: 등록 문구가 코드 틀과 글자까지 같고 환경변수·검수자 의견이 있다", () => {
  const doc = read("docs/kakao-alimtalk-parent-templates.md");
  for (const trigger of TRIGGERS) {
    const spec = reg.PARENT_ALIMTALK_TEMPLATES[trigger];
    assert.ok(doc.includes("```\n" + spec.body + "\n```"), `문서에 ${trigger} 본문이 그대로 있어야 한다`);
    assert.ok(doc.includes(spec.envKey), spec.envKey);
    assert.ok(doc.includes(trigger), trigger);
  }
  assert.match(doc, /검수자 의견/);
  assert.match(doc, /대체 발송\(문자\)»: \*\*사용 안 함\*\*/);
});

test("운영 동기화 마이그레이션이 금고 문구를 그대로 담는다", () => {
  const sql = read("prisma/migrations/20261109121000_sync_parent_alimtalk_template_bodies/migration.sql");
  const e = (s) => "E'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\n/g, "\\n") + "'";
  for (const trigger of TRIGGERS) {
    assert.ok(sql.includes(`body = ${e(reg.parentAlimtalkSmsTemplateBody(trigger))}`), trigger);
    assert.ok(sql.includes(`WHERE trigger = '${trigger}'`), trigger);
  }
  assert.doesNotMatch(sql, /DELETE|DROP|TRUNCATE/);
});

test("규칙 정리 마이그레이션: 코드 없는 규칙·체험 완료 문자만 지우고 되돌림 SQL 이 있다", () => {
  const sql = read("prisma/migrations/20261109120000_remove_unused_parent_sms_rules/migration.sql");
  const live = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.match(live, /DELETE FROM "MessageAutomationRule"\s+WHERE trigger IN \('ENROLL_APPROVED_PARENT', 'INVOICE_PARENT', 'TRIAL_ATTENDED_PARENT'\);/);
  assert.match(live, /DELETE FROM "SmsTemplate"\s+WHERE trigger IN \('ENROLL_APPROVED_PARENT', 'INVOICE_PARENT', 'TRIAL_ATTENDED_PARENT'\);/);
  assert.equal((live.match(/DELETE FROM/g) ?? []).length, 2);
  assert.doesNotMatch(live, /NotificationDelivery|DROP|TRUNCATE/);
  assert.match(sql, /되돌림 SQL[\s\S]*INSERT INTO "SmsTemplate"[\s\S]*INSERT INTO "MessageAutomationRule"/);
});

// ── 가드: 학부모 문자가 금고 밖에서 몰래 생기지 않게 ─────────────────────────
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const SRC_FILES = walk("src").map((p) => ({ path: p.replace(/\\/g, "/"), code: read(p) }));

test("가드: 코드에 나오는 학부모 트리거(*_PARENT·*_APPLICANT)는 금고 또는 «문자 전용 허용목록»에만 있다", () => {
  const allowed = new Set([...TRIGGERS, ...Object.keys(reg.SMS_ONLY_PARENT_TRIGGERS)]);
  const unknown = [];
  for (const file of SRC_FILES) {
    for (const m of file.code.matchAll(/["'`]([A-Z][A-Z0-9_]*_(?:PARENT|APPLICANT))["'`]/g)) {
      if (!allowed.has(m[1])) unknown.push(`${file.path}: ${m[1]}`);
    }
  }
  assert.deepEqual(unknown, [], "새 학부모 문자는 금고(parent-alimtalk-templates.ts)에 넣거나 SMS_ONLY_PARENT_TRIGGERS 에 이유와 함께 적는다");
});

test("가드: 지운 규칙(체험 완료·수강 확정·수납 안내)이 코드에서 다시 생기지 않는다", () => {
  for (const file of SRC_FILES) {
    assert.doesNotMatch(file.code, /TRIAL_ATTENDED_PARENT"|"ENROLL_APPROVED_PARENT|"INVOICE_PARENT/, file.path);
  }
  assert.doesNotMatch(read("src/app/actions/admin.ts"), /export async function resendTrialAttendedSms/);
  const trialClient = read("src/app/admin/trial/TrialCrmClient.tsx");
  assert.doesNotMatch(trialClient, /resendTrialAttendedSms|onResendAttendedSms|^\s+완료 문자 재시도$/m);
});

test("가드: 학부모 대상 문구의 머리말은 [스티즈농구교실] (옛 [STIZ]·[STIZ 농구교실] 금지)", () => {
  const parentFiles = [
    "src/lib/customer-notice/templates.ts", "src/lib/account/social-link.ts", "src/lib/parent-account-claim.ts",
    "src/lib/parent-signup-verification.ts", "src/lib/regular/regularShuttleDiff.ts",
    "src/app/api/admin/shuttle/regular-notice/route.ts", "src/lib/seasonal/shuttleNoticeFormat.ts",
  ];
  for (const file of parentFiles) assert.doesNotMatch(read(file), /\[STIZ[\] ]/, file);
  // DB 기본 틀: 학부모(PARENT) 행에 옛 머리말이 없다
  const smsTemplate = read("src/lib/smsTemplate.ts");
  for (const m of smsTemplate.matchAll(/\[\s*"([A-Z_]+)",\s*"[^"]*",\s*"PARENT",\s*([^\n]+)/g)) {
    assert.doesNotMatch(m[2], /\[STIZ/, m[1]);
  }
  // 수동 문자 발송부 머리말
  const admin = read("src/app/actions/admin.ts");
  assert.doesNotMatch(admin, /const body = `\[STIZ\] /);
  assert.match(admin, /const body = `\$\{PARENT_MESSAGE_PREFIX\} \$\{message\.trim\(\)\}`/);
});

test("연결: 특강·셔틀·체험 경로가 금고 틀과 알림톡을 넘긴다", () => {
  const notification = read("src/lib/notification.ts");
  // 예약형 발송(특강)도 alimtalk 를 공급자 호출까지 넘긴다
  assert.match(notification, /dispatchReservedSmsDelivery\(input: \{[\s\S]*?alimtalk\?: \{ templateId: string/);
  assert.match(notification, /alimtalk: !manualReconfirmation && input\.alimtalk\?\.templateId\?\.trim\(\) \? input\.alimtalk : undefined/);
  // 학부모 문자(체험 일정·수강신청서·셔틀)는 resolveParentMessage 를 거친다
  assert.match(notification, /export async function sendParentSmsWithResult[\s\S]*?resolveParentMessage\(trigger, variables, msg\)[\s\S]*?alimtalk: resolved\.alimtalk/);
  assert.match(notification, /export async function sendParentSms\([\s\S]*?resolveParentMessage\(trigger, variables, msg\)/);
  const seasonal = read("src/lib/seasonal/notifications.ts");
  assert.match(seasonal, /academyPhone: await academyContactPhone\(\)/);
  assert.match(seasonal, /resolveParentMessage\(input\.trigger, variables, rendered\.body\)[\s\S]*?alimtalk: message\.alimtalk/);
  // 신청서 단위 알림이 특강명·대기순번을 빈칸으로 보내지 않는다
  const route = read("src/app/api/admin/seasonal/route.ts");
  assert.doesNotMatch(route, /offeringTitle: "", waitlistOrder: ""/);
  assert.match(route, /\.\.\.\(await loadApplicationSmsSummary\(application\.id\)\)/);
  assert.match(route, /\.\.\.applicationSmsSummary\(application\.items\)/);
  // 관리자 문구 화면: 금고 트리거는 본문 수정 거절
  const admin = read("src/app/actions/admin.ts");
  assert.match(admin, /isParentAlimtalkTrigger\(before\.trigger\)\) \{\s*throw new Error\(SMS_TEMPLATE_ALIMTALK_LOCKED\)/);
  const client = read("src/app/admin/sms/templates/SmsTemplateClient.tsx");
  assert.match(client, /카카오 알림톡에 등록한 문구라 여기서 고칠 수 없어요/);
});
