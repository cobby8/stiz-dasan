// 학부모 가입 안내(재원생 미가입 학부모에게 한 번에) 검사
// - 받는 사람 고르기 순수 함수를 실제로 실행한다(중복 제거·계정 있는 학부모 제외·이미 받은 번호 제외)
// - 문구는 전문을 비교하고, 문자(EUC-KR 완성형)로 깨지는 글자가 없는지 본다
// - 서버 동작은 소스를 읽어 안전장치(관리자·재대조·잠금·기존 대량 큐·직접 발송 없음)를 확인한다
// ⚠️ 이 테스트는 문자를 절대 보내지 않는다(공급자 호출 없음).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const templateSource = readFileSync("src/lib/customer-notice/templates.ts", "utf8");
const compiled = ts.transpileModule(templateSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const T = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const action = readFileSync("src/app/actions/customer-notice.ts", "utf8");
const sender = readFileSync("src/components/admin/ParentSignupGuideSender.tsx", "utf8");
const sms = readFileSync("src/app/admin/sms/SmsClient.tsx", "utf8");

const none = new Set();
const row = (parentUserId, studentName, phone, hasAccount = false) => ({ parentUserId, studentName, phone, hasAccount });

test("받는 사람: 계정 없는 학부모만, 번호는 한 번만(형제는 1통)", () => {
  const result = T.selectParentSignupGuideRecipients([
    row("p1", "김민수", "010-1111-2222"),
    row("p1", "김민지", "01011112222"), // 형제 — 같은 번호
    row("p2", "이서준", "010-3333-4444", true), // 계정 있음 → 제외
    row("p3", "박하늘", "010 5555 6666"),
  ], { alreadySentPhones: none, resend: false });
  assert.deepEqual(result.recipients.map((r) => r.phone), ["01011112222", "01055556666"]);
  assert.deepEqual(result.recipients[0].studentNames, ["김민수", "김민지"]);
  assert.equal(result.alreadySentCount, 0);
});

test("받는 사람: 같은 번호를 계정 있는 다른 학부모가 쓰면 뺀다", () => {
  const result = T.selectParentSignupGuideRecipients([
    row("p1", "김민수", "010-1111-2222"),
    row("p9", "김민호", "010-1111-2222", true),
  ], { alreadySentPhones: none, resend: false });
  assert.equal(result.recipients.length, 0);
});

test("받는 사람: 휴대폰 번호가 아니면 빼고 개수만 센다", () => {
  const result = T.selectParentSignupGuideRecipients([
    row("p1", "A", null), row("p2", "B", "02-123-4567"), row("p3", "C", "010-0000-1111"),
    row("p4", "D", null, true), // 계정 있는 사람은 «번호 없음»으로 세지 않는다
  ], { alreadySentPhones: none, resend: false });
  assert.equal(result.recipients.length, 1);
  assert.equal(result.invalidPhoneCount, 2);
});

test("받는 사람: 이미 받은 번호는 기본 제외, «다시 보내기»일 때만 포함", () => {
  const candidates = [row("p1", "A", "010-1111-2222"), row("p2", "B", "010-3333-4444")];
  const sent = new Set(["01011112222"]);
  const normal = T.selectParentSignupGuideRecipients(candidates, { alreadySentPhones: sent, resend: false });
  assert.deepEqual(normal.recipients.map((r) => r.phone), ["01033334444"]);
  assert.equal(normal.alreadySentCount, 1);
  const again = T.selectParentSignupGuideRecipients(candidates, { alreadySentPhones: sent, resend: true });
  assert.deepEqual(again.recipients.map((r) => r.phone), ["01011112222", "01033334444"]);
});

test("받는 사람: 입력 순서가 달라도 결과 순서는 같다(미리보기·보내기 대조용)", () => {
  const a = [row("p1", "A", "010-9999-0000"), row("p2", "B", "010-1111-0000")];
  const r1 = T.selectParentSignupGuideRecipients(a, { alreadySentPhones: none, resend: false }).recipients.map((r) => r.phone);
  const r2 = T.selectParentSignupGuideRecipients([...a].reverse(), { alreadySentPhones: none, resend: false }).recipients.map((r) => r.phone);
  assert.deepEqual(r1, r2);
});

test("미리보기 한 줄: 이름은 가리고 번호는 끝 4자리만", () => {
  assert.equal(T.maskPersonName("김민수"), "김*수");
  assert.equal(T.maskPersonName("이준"), "이*");
  assert.equal(T.maskPersonName("남궁민수"), "남**수");
  assert.equal(T.maskPersonName(""), "*");
  const line = T.describeSignupGuideRecipient({ phone: "01012345678", parentUserId: "p", studentNames: ["김민수", "김민지"] });
  assert.equal(line, "김*수·김*지 학생 학부모 · ***-****-5678");
  assert.doesNotMatch(line, /민수|1234/);
});

test("가입 안내 문구 — 원장 승인본 전문(이모지·꺾쇠 따옴표만 문자용으로 바꿈)", () => {
  assert.equal(T.buildParentSignupGuideMessage(), [
    "[스티즈농구교실] 학부모 가입 안내",
    "",
    "안녕하세요, 스티즈농구교실입니다.",
    "12월부터 출결·수업 소식·수강료 청구와 결제를 홈페이지에서 확인하실 수 있어요.",
    "",
    "▶ 가입하기: https://www.stiz-dasan.kr/signup/parent",
    "학원에 등록하신 휴대폰 번호로 가입하시면 자녀가 자동으로 연결돼요.",
    "",
    "▶ 결석은 가입 후 ‘결석 신고’로 알려 주세요.",
    "",
    "재원생 가족 혜택",
    "로그인 후 체육관 대관을 신청하시면 2시간 무료예요.",
    "https://www.stiz-dasan.kr/rental",
    "",
    "문의: 카카오톡 채널 ‘스티즈농구교실’",
  ].join("\n"));
});

test("가입 안내 문구 — 문자(EUC-KR 완성형)로 깨지는 글자가 없고 LMS 한도 안이다", () => {
  // EUC-KR 2바이트 글자표 전체를 만들어 «문자로 갈 수 있는 글자»를 모은다
  const decoder = new TextDecoder("euc-kr");
  const allowed = new Set();
  for (let a = 0xa1; a <= 0xfe; a += 1) {
    for (let b = 0xa1; b <= 0xfe; b += 1) allowed.add(decoder.decode(new Uint8Array([a, b])));
  }
  const body = T.buildParentSignupGuideMessage();
  const broken = [...body].filter((ch) => ch.charCodeAt(0) > 0x7f && !allowed.has(ch));
  assert.deepEqual(broken, [], `문자에서 깨지는 글자: ${broken.join(" ")}`);
  assert.equal(allowed.has("🏀"), false); // 이모지는 문자로 못 간다(그래서 뺐다)
  assert.equal(allowed.has("«"), false); // 꺾쇠 따옴표도 못 간다
  // EUC-KR 바이트(한글 2·영문 1) — 솔라피 LMS 한도 2,000바이트
  const bytes = [...body].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);
  assert.ok(bytes > 90 && bytes <= 2000, `${bytes}바이트`);
});

test("서버: 두 동작 모두 관리자 확인이 먼저다", () => {
  for (const name of ["prepareParentSignupGuide", "sendParentSignupGuide"]) {
    const body = action.slice(action.indexOf(`export async function ${name}`));
    assert.ok(body.indexOf("await requireAdmin()") > -1, name);
    assert.ok(body.indexOf("await requireAdmin()") < body.indexOf("prisma."), name);
  }
});

test("서버: 받는 사람은 서버가 재원생·대표 학부모·탈퇴 제외로 계산한다(화면이 번호를 보내지 않음)", () => {
  const resolve = action.slice(action.indexOf("async function resolveSignupGuide"), action.indexOf("export async function prepareParentSignupGuide"));
  assert.match(resolve, /e\.status = 'ACTIVE'/);
  assert.match(resolve, /s\."mergedIntoStudentId" IS NULL/);
  assert.match(resolve, /u\.id = s\."parentId" AND u\."withdrawnAt" IS NULL/);
  assert.match(resolve, /u\."authUserId" IS NOT NULL\) AS "hasAccount"/);
  assert.match(resolve, /selectParentSignupGuideRecipients\(/);
  // 이미 받은 번호 = 발송 장부(번호 지문), 실패 건은 다시 보낼 수 있게 제외하지 않는다
  assert.match(resolve, /"NotificationDelivery"/);
  assert.match(resolve, /status NOT IN \('FAILED', 'SKIPPED'\)/);
  // 화면 입력 타입에 번호 목록이 없다
  assert.match(action, /sendParentSignupGuide\(input: \{\s*approvalId: string;\s*resend: boolean;\s*approved: boolean;\s*\}\)/);
  assert.match(action, /prepareParentSignupGuide\(input: \{ resend\?: boolean \}\)/);
  // 미리보기는 처음 몇 명만, 가린 형태로
  const preview = action.slice(action.indexOf("export async function prepareParentSignupGuide"), action.indexOf("export async function sendParentSignupGuide"));
  assert.match(preview, /slice\(0, PARENT_SIGNUP_PREVIEW_SAMPLE\)\.map\(describeSignupGuideRecipient\)/);
  assert.doesNotMatch(preview, /phone: item\.phone|recipients: guide\.recipients/);
});

test("서버: 미리보기에선 안 보내고, 보내기는 승인·재대조·잠금 뒤 기존 대량 큐로만", () => {
  const preview = action.slice(action.indexOf("export async function prepareParentSignupGuide"), action.indexOf("export async function sendParentSignupGuide"));
  assert.doesNotMatch(preview, /sendSms|reserveManualMessageQueue|reserveMessageDelivery/);
  const send = action.slice(action.indexOf("export async function sendParentSignupGuide"));
  const order = ["approved !== true", "CUSTOMER_NOTICE_PREVIEW", "'PARENT_SIGNUP_GUIDE'", "resolveSignupGuide(", "pg_advisory_xact_lock", "CUSTOMER_NOTICE_CLAIMED", "reserveManualMessageQueue("];
  let last = -1;
  for (const marker of order) {
    const at = send.indexOf(marker);
    assert.ok(at > last, `${marker} 순서`);
    last = at;
  }
  // 직접 발송·새 발송 엔진 없음(기존 크론이 큐를 보낸다)
  assert.doesNotMatch(send, /sendSmsDetailed|sendSmsBulk/);
  assert.match(send, /"actorUserId" = \$2/); // 남이 만든 미리보기로는 못 보낸다
});

test("화면: 확인 창 뒤에만 보내고, 문자 화면 «수동 발송» 탭에 붙어 있다", () => {
  assert.match(sender, /useAdminConfirm/);
  const send = sender.slice(sender.indexOf("async function send()"));
  assert.ok(send.indexOf("await confirm(") < send.indexOf("sendParentSignupGuide("));
  assert.match(sender, /resend: target\.resend/); // 미리보기 때 값 그대로
  assert.doesNotMatch(sender, /window\.confirm|useEffect/); // 자동 발송·자동 열기 없음
  assert.match(sms, /activeTab === "manual"[\s\S]{0,200}<ParentSignupGuidePanel \/>/);
  assert.match(sms, /<ParentSignupGuideSender \/>/);
});
