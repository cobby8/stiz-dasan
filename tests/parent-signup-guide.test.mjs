// 학부모 가입 안내(재원생 미가입 학부모에게 한 번에) 검사
// - 받는 사람 고르기 순수 함수를 실제로 실행한다(중복 제거·계정 있는 학부모 제외·이미 받은 번호 제외)
// - 문구는 전문을 비교하고, 문자(EUC-KR 완성형)로 깨지는 글자가 없는지 본다
// - 서버 동작은 소스를 읽어 안전장치(관리자·재대조·잠금·기존 대량 큐·직접 발송 없음)를 확인한다
// ⚠️ 이 테스트는 문자를 절대 보내지 않는다(공급자 호출 없음).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

const templateSource = readFileSync("src/lib/customer-notice/templates.ts", "utf8");
const compiled = ts.transpileModule(templateSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const T = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const action = readFileSync("src/app/actions/customer-notice.ts", "utf8");
const sender = readFileSync("src/components/admin/ParentSignupGuideSender.tsx", "utf8");
const sms = readFileSync("src/app/admin/sms/SmsClient.tsx", "utf8");

const none = new Set();
const row = (parentUserId, studentName, phone, hasAccount = false) => ({ parentUserId, studentName, phone, hasAccount });

test("받는 사람: 가입한 학부모도 «가입함»으로 넣고, 번호는 한 번만(형제는 1통)", () => {
  // 2026-11-16 원장 지시: 이미 가입한 보호자도 안내(로그인 안내)
  const result = T.selectParentSignupGuideRecipients([
    row("p1", "김민수", "010-1111-2222"),
    row("p1", "김민지", "01011112222"), // 형제 — 같은 번호
    row("p2", "이서준", "010-3333-4444", true), // 계정 있음 → 가입함
    row("p3", "박하늘", "010 5555 6666"),
  ], { alreadySentPhones: none, resend: false });
  assert.deepEqual(result.recipients.map((r) => r.phone), ["01011112222", "01033334444", "01055556666"]);
  assert.deepEqual(result.recipients.map((r) => r.signedIn), [false, true, false]);
  assert.deepEqual(result.recipients[0].studentNames, ["김민수", "김민지"]);
  assert.equal(result.alreadySentCount, 0);
});

test("받는 사람: 같은 번호를 계정 있는 다른 학부모가 쓰면 그 번호는 «가입함» 1통", () => {
  const result = T.selectParentSignupGuideRecipients([
    row("p1", "김민수", "010-1111-2222"),
    row("p9", "김민호", "010-1111-2222", true),
  ], { alreadySentPhones: none, resend: false });
  assert.equal(result.recipients.length, 1);
  assert.equal(result.recipients[0].signedIn, true);
  assert.equal(result.recipients[0].parentUserId, "p9"); // 대표 = 가입한 계정
  assert.deepEqual(result.recipients[0].studentNames, ["김민수", "김민호"]);
});

test("받는 사람: 휴대폰 번호가 아니면 빼고 개수만 센다(가입 여부와 상관없이)", () => {
  const result = T.selectParentSignupGuideRecipients([
    row("p1", "A", null), row("p2", "B", "02-123-4567"), row("p3", "C", "010-0000-1111"),
    row("p4", "D", null, true), // 가입한 사람도 번호가 없으면 못 보낸다
  ], { alreadySentPhones: none, resend: false });
  assert.equal(result.recipients.length, 1);
  assert.equal(result.invalidPhoneCount, 3);
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
  // 2026-11-17 원장 지시 문구 — 랠리즈 종료·앱에서 전부, 앱 설치가 먼저, 문의는 원장 전화(카카오톡 채널 미오픈)
  assert.equal(T.buildParentSignupGuideMessage(), [
    "[스티즈농구교실] 학부모 앱 안내",
    "",
    "안녕하세요, 스티즈농구교실입니다.",
    "랠리즈 사용을 종료하고, 12월부터 스티즈농구교실 앱을 사용합니다.",
    "수업 소식·출결·수강료 청구와 결제를 모두 앱에서 하실 수 있어요.",
    "",
    // 앱 설치 짧은 주소 — 기기별로 Play 스토어/App Store 로 나눠 보낸다
    "▶ 앱 설치: https://www.stiz-dasan.kr/install",
    "▶ 가입하기: https://www.stiz-dasan.kr/signup/parent",
    "학원에 등록하신 휴대폰 번호로 가입하시면 자녀가 자동으로 연결돼요.",
    "앱에서는 가입하신 아이디로 로그인하시면 돼요.",
    "",
    "▶ 결석은 가입 후 앱의 ‘결석 알리기’로 알려 주세요.",
    "",
    "재원생 가족 혜택",
    "로그인 후 체육관 대관을 신청하시면 2시간 무료예요.",
    "https://www.stiz-dasan.kr/rental",
    "",
    "문의: 김수빈 원장 010-9167-8117",
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
  // 2026-11-16: 재원(ACTIVE)·휴원(PAUSED) 모두, 퇴원만 남은 학생은 빠짐
  assert.match(resolve, /e\.status IN \('ACTIVE', 'PAUSED'\)/);
  assert.doesNotMatch(resolve, /WITHDRAWN/);
  // 성인 판정 = KST 오늘 기준 만 19세(timestamptz now() 에 한 번만 건다)
  assert.match(resolve, /now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date - INTERVAL '19 years'/);
  // 가입 막힘 판정 = 가입 코드와 같은 합성 이메일 규칙 한 곳
  assert.match(action, /import \{ SYNTHETIC_PARENT_EMAIL \} from "@\/lib\/parent-synthetic-email"/);
  assert.match(resolve, /SYNTHETIC_PARENT_EMAIL\.source/);
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

// ───────────── 2026-11-16 원장 결정표 «전체 다 보내. 성인도 포함해» ─────────────
const full = (parentUserId, studentName, phone, extra = {}) => ({ parentUserId, studentName, phone, hasAccount: false, ...extra });

test("구성: 재원·휴원·성인으로 나눠 센다(번호 기준)", () => {
  const result = T.selectParentSignupGuideRecipients([
    full("p1", "김재원", "010-1000-0001", { enrollmentStatus: "ACTIVE" }),
    full("p2", "이휴원", "010-1000-0002", { enrollmentStatus: "PAUSED" }),
    full("p3", "박성인", "010-1000-0003", { enrollmentStatus: "ACTIVE", isAdult: true }),
    full("p4", "최성인", "010-1000-0004", { enrollmentStatus: "PAUSED", isAdult: true }), // 휴원 중인 성인도 «성인»
  ], { alreadySentPhones: none, resend: false });
  assert.deepEqual(result.breakdown, { active: 1, paused: 1, adult: 2, signedIn: 0 });
  assert.deepEqual(result.recipients.map((r) => r.group), ["ACTIVE", "PAUSED", "ADULT", "ADULT"]);
});

test("구성: 형제 중 한 명이라도 수강 중이면 재원, 모두 휴원이면 휴원", () => {
  const mixed = T.selectParentSignupGuideRecipients([
    full("p1", "A", "010-2000-0001", { enrollmentStatus: "PAUSED" }),
    full("p1", "B", "010-2000-0001", { enrollmentStatus: "ACTIVE" }),
  ], { alreadySentPhones: none, resend: false });
  assert.equal(mixed.recipients.length, 1);
  assert.equal(mixed.recipients[0].group, "ACTIVE");
  const paused = T.selectParentSignupGuideRecipients([
    full("p1", "A", "010-2000-0001", { enrollmentStatus: "PAUSED" }),
    full("p1", "B", "010-2000-0001", { enrollmentStatus: "PAUSED" }),
  ], { alreadySentPhones: none, resend: false });
  assert.equal(paused.recipients[0].group, "PAUSED");
});

test("구성: 같은 번호에 성인과 미성년 자녀가 섞이면 학부모용(성인용은 성인만 있을 때)", () => {
  const result = T.selectParentSignupGuideRecipients([
    full("p1", "엄마", "010-3000-0001", { isAdult: true }),
    full("p1", "아이", "010-3000-0001", { isAdult: false }),
  ], { alreadySentPhones: none, resend: false });
  assert.equal(result.recipients[0].group, "ACTIVE");
  assert.equal(T.signupGuideMessageFor(result.recipients[0]), T.buildParentSignupGuideMessage());
});

test("가입 막힘: 다른 계정이 쓰는 번호는 빼고 수만 세며, 빈 계정 여럿인 번호는 보내되 따로 센다", () => {
  const result = T.selectParentSignupGuideRecipients([
    full("p1", "A", "010-4000-0001", { phoneRegistered: true }),
    full("p1", "A2", "010-4000-0001", { phoneRegistered: true }), // 같은 번호 → 1개로 센다
    full("p2", "B", "010-4000-0002", { phoneMultipleClaimable: true }),
    full("p3", "C", "010-4000-0003"),
  ], { alreadySentPhones: none, resend: false });
  assert.deepEqual(result.recipients.map((r) => r.phone), ["01040000002", "01040000003"]);
  assert.equal(result.registeredPhoneCount, 1);
  assert.equal(result.needsAcademyHelpCount, 1);
  assert.equal(result.recipients[0].needsAcademyHelp, true);
});

test("구성: 이미 받은 번호를 빼면 구성도 남은 사람만 센다", () => {
  const result = T.selectParentSignupGuideRecipients([
    full("p1", "A", "010-5000-0001", { isAdult: true }),
    full("p2", "B", "010-5000-0002", { enrollmentStatus: "PAUSED" }),
  ], { alreadySentPhones: new Set(["01050000001"]), resend: false });
  assert.deepEqual(result.breakdown, { active: 0, paused: 1, adult: 0, signedIn: 0 });
});

test("성인 문구: 학부모용과 딱 세 줄만 다르고(학부모·자녀·가족), 문자로 깨지는 글자가 없다", () => {
  const parent = T.buildParentSignupGuideMessage().split("\n");
  const adult = T.buildAdultSignupGuideMessage().split("\n");
  assert.equal(adult.length, parent.length);
  const diff = parent.map((line, i) => [line, adult[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(diff, [
    ["[스티즈농구교실] 학부모 앱 안내", "[스티즈농구교실] 회원 앱 안내"],
    ["학원에 등록하신 휴대폰 번호로 가입하시면 자녀가 자동으로 연결돼요.", "학원에 등록하신 휴대폰 번호로 가입하시면 수강 정보가 자동으로 연결돼요."],
    ["재원생 가족 혜택", "재원생 혜택"],
  ]);
  assert.doesNotMatch(adult.join("\n"), /학부모|자녀|가족/);
  const decoder = new TextDecoder("euc-kr");
  const allowed = new Set();
  for (let a = 0xa1; a <= 0xfe; a += 1) for (let b = 0xa1; b <= 0xfe; b += 1) allowed.add(decoder.decode(new Uint8Array([a, b])));
  const broken = [...adult.join("\n")].filter((ch) => ch.charCodeAt(0) > 0x7f && !allowed.has(ch));
  assert.deepEqual(broken, []);
  assert.equal(T.signupGuideMessageFor({ group: "ADULT" }), T.buildAdultSignupGuideMessage());
  assert.equal(T.signupGuideMessageFor({ group: "PAUSED" }), T.buildParentSignupGuideMessage());
});

test("미리보기 한 줄: 성인은 «성인 수강생 본인», 휴원은 «(휴원)»", () => {
  assert.equal(T.describeSignupGuideRecipient({ phone: "01012345678", studentNames: ["김민수"], group: "ADULT" }), "김*수 성인 수강생 본인 · ***-****-5678");
  assert.equal(T.describeSignupGuideRecipient({ phone: "01012345678", studentNames: ["김민수"], group: "PAUSED" }), "김*수 학생 학부모(휴원) · ***-****-5678");
});

test("서버: 사람마다 맞는 문구로 같은 큐 한 묶음에 넣고, 문구·구분이 바뀌면 미리보기 대조가 멈춘다", () => {
  const resolve = action.slice(action.indexOf("async function resolveSignupGuide"), action.indexOf("export async function prepareParentSignupGuide"));
  // 지문 = 번호 + 구분 + 가입 여부, 문구 지문 = 네 문구 전부
  assert.match(resolve, /hashMessageRecipientPhone\(item\.phone\)\}:\$\{item\.group\}:\$\{item\.signedIn \? "IN" : "NEW"\}/);
  assert.match(resolve, /bodyHash: hashMessageBody\(`\$\{body\}\\n---\\n\$\{adultBody\}\\n---\\n\$\{signedInBody\}\\n---\\n\$\{signedInAdultBody\}`\)/);
  // 이미 받은 번호 찾기도 가입한 사람 번호까지 본다
  assert.match(resolve, /if \(phone\) phoneByHash\.set\(/);
  const send = action.slice(action.indexOf("export async function sendParentSignupGuide"));
  assert.match(send, /items: guide\.recipients\.map\(\(item\) => \(\{ recipient: item\.phone, body: signupGuideMessageFor\(item\) \}\)\)/);
  // 미리보기는 구성·성인 문구를 보여 주되 번호 원문은 내보내지 않는다
  const preview = action.slice(action.indexOf("export async function prepareParentSignupGuide"), action.indexOf("export async function sendParentSignupGuide"));
  assert.match(preview, /breakdown: guide\.breakdown/);
  assert.match(sender, /breakdownText\(preview\)/);
  assert.match(sender, /성인 수강생 본인에게 가는 문구/);
});

// ───────────── 2026-11-16 원장 지시 «이미 가입한 보호자도 넣어 — 아무도 제대로 쓰고 있지 않아서» ─────────────

test("가입함: 가입 막힘 판정은 미가입 번호에만 — 가입한 사람은 막힘 표시가 있어도 보낸다", () => {
  const result = T.selectParentSignupGuideRecipients([
    full("p1", "A", "010-6000-0001", { hasAccount: true, phoneRegistered: true }), // 가입함 → 그대로 보냄
    full("p2", "B", "010-6000-0002", { phoneRegistered: true }), // 미가입·막힘 → 뺌
    full("p3", "C", "010-6000-0003", { hasAccount: true, phoneMultipleClaimable: true }), // 가입함엔 «학원 문의» 경고 없음
  ], { alreadySentPhones: none, resend: false });
  assert.deepEqual(result.recipients.map((r) => r.phone), ["01060000001", "01060000003"]);
  assert.equal(result.registeredPhoneCount, 1);
  assert.equal(result.needsAcademyHelpCount, 0);
  assert.ok(result.recipients.every((r) => r.signedIn));
});

test("가입함: 구성은 미가입 재원·휴원·성인 / 가입함으로 겹치지 않게 센다", () => {
  const result = T.selectParentSignupGuideRecipients([
    full("p1", "A", "010-7000-0001"),
    full("p2", "B", "010-7000-0002", { enrollmentStatus: "PAUSED" }),
    full("p3", "C", "010-7000-0003", { isAdult: true }),
    full("p4", "D", "010-7000-0004", { hasAccount: true }),
    full("p5", "E", "010-7000-0005", { hasAccount: true, isAdult: true }), // 가입한 성인 본인 → 가입함에만
    full("p6", "F", "010-7000-0006", { hasAccount: true, enrollmentStatus: "PAUSED" }),
  ], { alreadySentPhones: none, resend: false });
  assert.deepEqual(result.breakdown, { active: 1, paused: 1, adult: 1, signedIn: 3 });
  const b = result.breakdown;
  assert.equal(b.active + b.paused + b.adult + b.signedIn, result.recipients.length);
});

test("가입함: 이미 받은 번호 제외·다시 보내기 규칙은 그대로", () => {
  const candidates = [full("p1", "A", "010-8000-0001", { hasAccount: true }), full("p2", "B", "010-8000-0002", { hasAccount: true })];
  const sent = new Set(["01080000001"]);
  const normal = T.selectParentSignupGuideRecipients(candidates, { alreadySentPhones: sent, resend: false });
  assert.deepEqual(normal.recipients.map((r) => r.phone), ["01080000002"]);
  assert.equal(normal.alreadySentCount, 1);
  const again = T.selectParentSignupGuideRecipients(candidates, { alreadySentPhones: sent, resend: true });
  assert.equal(again.recipients.length, 2);
});

test("가입함 문구 — 원장 지시 전문(2026-11-17: 웹 로그인 링크 빼고 앱 설치만)", () => {
  assert.equal(T.PARENT_LOGIN_URL, "https://www.stiz-dasan.kr/login");
  assert.equal(T.buildSignedInGuideMessage(), [
    "[스티즈농구교실] 학부모 앱 설치 안내",
    "",
    "안녕하세요, 스티즈농구교실입니다.",
    "랠리즈 사용을 종료하고, 12월부터 스티즈농구교실 앱을 사용합니다.",
    "수업 소식·출결·수강료 청구와 결제를 모두 앱에서 하실 수 있어요.",
    "",
    "▶ 앱 설치: https://www.stiz-dasan.kr/install",
    "이미 가입하신 아이디로 로그인하시면 바로 이용하실 수 있어요.",
    "",
    "▶ 결석은 앱의 ‘결석 알리기’로 알려 주세요.",
    "",
    "재원생 가족 혜택",
    "로그인 후 체육관 대관을 신청하시면 2시간 무료예요.",
    "https://www.stiz-dasan.kr/rental",
    "",
    "문의: 김수빈 원장 010-9167-8117",
  ].join("\n"));
  assert.doesNotMatch(T.buildSignedInGuideMessage(), /stiz-dasan\.kr\/login/);
});

test("가입 안내 네 문구 모두 카카오톡 채널 안내가 없다(2026-11-17 원장: 채널은 아직 열지 않음)", () => {
  for (const body of [
    T.buildParentSignupGuideMessage(), T.buildAdultSignupGuideMessage(),
    T.buildSignedInGuideMessage(), T.buildAdultSignedInGuideMessage(),
  ]) {
    assert.doesNotMatch(body, /카카오|kakao/i);
    assert.match(body, /랠리즈 사용을 종료하고/);
    assert.ok(body.endsWith("문의: 김수빈 원장 010-9167-8117"));
  }
});

test("가입함 문구 — 로그인 주소가 실제 로그인 화면이다", () => {
  assert.ok(existsSync("src/app/login/page.tsx"));
});

test("가입함 성인 문구 — 두 줄만 다르고(학부모·가족), 네 문구 모두 문자로 깨지는 글자가 없다", () => {
  const base = T.buildSignedInGuideMessage().split("\n");
  const adult = T.buildAdultSignedInGuideMessage().split("\n");
  const diff = base.map((line, i) => [line, adult[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(diff, [
    ["[스티즈농구교실] 학부모 앱 설치 안내", "[스티즈농구교실] 회원 앱 설치 안내"],
    ["재원생 가족 혜택", "재원생 혜택"],
  ]);
  assert.doesNotMatch(adult.join("\n"), /학부모|자녀|가족/);
  const decoder = new TextDecoder("euc-kr");
  const allowed = new Set();
  for (let a = 0xa1; a <= 0xfe; a += 1) for (let b = 0xa1; b <= 0xfe; b += 1) allowed.add(decoder.decode(new Uint8Array([a, b])));
  for (const body of [T.buildSignedInGuideMessage(), T.buildAdultSignedInGuideMessage()]) {
    const broken = [...body].filter((ch) => ch.charCodeAt(0) > 0x7f && !allowed.has(ch));
    assert.deepEqual(broken, []);
    const bytes = [...body].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);
    assert.ok(bytes > 90 && bytes <= 2000, `${bytes}바이트`);
  }
});

test("가입함: 사람마다 문구 고르기 4가지", () => {
  assert.equal(T.signupGuideMessageFor({ group: "ACTIVE", signedIn: true }), T.buildSignedInGuideMessage());
  assert.equal(T.signupGuideMessageFor({ group: "PAUSED", signedIn: true }), T.buildSignedInGuideMessage());
  assert.equal(T.signupGuideMessageFor({ group: "ADULT", signedIn: true }), T.buildAdultSignedInGuideMessage());
  assert.equal(T.signupGuideMessageFor({ group: "ACTIVE", signedIn: false }), T.buildParentSignupGuideMessage());
  assert.equal(T.signupGuideMessageFor({ group: "ADULT" }), T.buildAdultSignupGuideMessage());
});

test("가입함: 미리보기 한 줄·화면 구성 줄·문구 블록", () => {
  assert.equal(T.describeSignupGuideRecipient({ phone: "01012345678", studentNames: ["김민수"], group: "ACTIVE", signedIn: true }), "김*수 학생 학부모 · 가입함 · ***-****-5678");
  assert.match(sender, /가입함 \$\{preview\.breakdown\.signedIn\}명/);
  assert.match(sender, /이미 가입한 학부모에게 가는 문구\(앱 설치 안내\)/);
  assert.match(sender, /preview\.signedInAdultMessage/);
  const preview = action.slice(action.indexOf("export async function prepareParentSignupGuide"), action.indexOf("export async function sendParentSignupGuide"));
  assert.match(preview, /signedInMessage: guide\.recipients\.some/);
});
