// 수강료 청구 알림톡 2종(2026-11-12) — 청구서 발행 안내(원장 승인 원문)·미납 안내(초안).
// «금고 틀 = 심사 문서 = 문자 대체 본문»을 실제로 실행해 대조하고, 발송부는 «가짜 발송자»(fetch·문자 함수 대체)로
// 돌려 알림톡 text·버튼·문자 대체 본문이 맞게 나가는지 본다. 실제 발송은 하지 않는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const reg = await loadTsModule("src/lib/messaging/parent-alimtalk-templates.ts");
const read = (p) => readFileSync(p, "utf8");
const KINDS = Object.keys(reg.BILLING_ALIMTALK_TEMPLATES);

const SAMPLE = {
  childName: "홍길동", billingMonth: "12월", amount: "130,000", dueDate: "2026년 12월 10일",
  academyPhone: "031-000-0000", unpaidCount: "2", totalAmount: "260,000",
};

// 원장 승인 원문(2026-11-12) — 한 글자라도 바뀌면 이 테스트가 깨진다(재승인·재심사 필요)
const APPROVED_INVOICE_BODY = `[스티즈농구교실] #{학생명} 학생 #{청구월} 수강료 안내

안녕하세요, 스티즈농구교실입니다.
#{학생명} 학생의 #{청구월} 수강료 청구서가 발행되었습니다.

■ 청구 금액: #{금액}원
■ 납부 기한: #{납부기한}

아래 버튼에서 청구 내용 확인과 결제(카드·계좌이체)를 하실 수 있어요.
문의: #{학원전화}`;

test("청구 2종: 청구서 안내는 원장 승인 원문 그대로, 미납은 초안 표시", () => {
  assert.deepEqual(KINDS.sort(), ["BILLING_INVOICE_PARENT", "UNPAID_PARENT"]);
  const invoice = reg.BILLING_ALIMTALK_TEMPLATES.BILLING_INVOICE_PARENT;
  assert.equal(invoice.body, APPROVED_INVOICE_BODY);
  assert.equal(invoice.status, "APPROVED");
  assert.equal(invoice.envKey, "ALIMTALK_TPL_BILLING_INVOICE");
  const unpaid = reg.BILLING_ALIMTALK_TEMPLATES.UNPAID_PARENT;
  assert.equal(unpaid.status, "DRAFT");
  assert.equal(unpaid.envKey, "ALIMTALK_TPL_BILLING_UNPAID");
  // 기한 전 미납도 섞여 있어 «기한이 지난» 이라고 단정하지 않는다
  assert.doesNotMatch(unpaid.body, /기한이 지난/);
  assert.match(unpaid.body, /■ 청구 금액: #\{금액\}원/);
});

test("틀+변수 = 본문: #{ 가 남지 않고, 변수 목록 = 틀 변수 + 버튼 경로, 문자 본문 = 본문 + 링크 줄", () => {
  for (const kind of KINDS) {
    const spec = reg.BILLING_ALIMTALK_TEMPLATES[kind];
    const m = reg.buildBillingAlimtalkMessage(kind, SAMPLE, "payments/inv1");
    assert.doesNotMatch(m.body, /#\{/, kind);
    assert.ok(m.body.startsWith("[스티즈농구교실] 홍길동 학생 "), kind);
    assert.deepEqual(
      Object.keys(m.variables).sort(),
      [...reg.templateVariableKeys(spec.body), "#{청구서경로}"].sort(),
      kind,
    );
    for (const value of Object.values(m.variables)) assert.ok(String(value).trim().length > 0, kind);
    assert.equal(m.variables["#{청구서경로}"], "payments/inv1");
    assert.deepEqual(m.button, {
      buttonName: "청구서 확인하기", buttonType: "WL",
      linkMo: "https://www.stiz-dasan.kr/payments/inv1", linkPc: "https://www.stiz-dasan.kr/payments/inv1",
    });
    assert.equal(m.smsBody, `${m.body}\n청구서 확인하기: https://www.stiz-dasan.kr/payments/inv1`);
    assert.equal(m.envKey, spec.envKey);
    assert.ok([...m.body].length <= 1000, `${kind} 본문 1,000자 이내`);
  }
  const invoice = reg.buildBillingAlimtalkMessage("BILLING_INVOICE_PARENT", SAMPLE, "payments/inv1");
  assert.match(invoice.body, /^\[스티즈농구교실\] 홍길동 학생 12월 수강료 안내\n/);
  assert.match(invoice.body, /■ 청구 금액: 130,000원\n■ 납부 기한: 2026년 12월 10일/);
  assert.match(invoice.body, /문의: 031-000-0000$/);
});

test("문자 대체 글자: EUC-KR 에서 깨지는 겹꺾쇠·이모지가 없다(한글·ASCII·■·· 만)", () => {
  for (const kind of KINDS) {
    const m = reg.buildBillingAlimtalkMessage(kind, SAMPLE, "payments/inv1");
    for (const text of [reg.BILLING_ALIMTALK_TEMPLATES[kind].body, m.body, m.smsBody]) {
      assert.doesNotMatch(text, /[«»]|\p{Extended_Pictographic}/u, kind);
      for (const ch of text) assert.match(ch, /[가-힣\x20-\x7E\n■·]/u, `${kind}: 허용 밖 글자 ${ch}`);
    }
  }
});

test("빈 값: 학원전화는 대표번호로 채우고, 학생명·금액·납부기한이 비면 오류(빈칸 문장 금지)", () => {
  const m = reg.buildBillingAlimtalkMessage("BILLING_INVOICE_PARENT", { ...SAMPLE, academyPhone: "" }, "payments/x");
  assert.match(m.body, new RegExp(`문의: ${reg.DEFAULT_ACADEMY_PHONE}$`));
  for (const key of ["childName", "amount", "dueDate", "billingMonth"]) {
    assert.throws(() => reg.buildBillingAlimtalkMessage("BILLING_INVOICE_PARENT", { ...SAMPLE, [key]: " " }, "payments/x"), key);
  }
  assert.throws(() => reg.buildBillingAlimtalkMessage("UNPAID_PARENT", { ...SAMPLE, totalAmount: "" }, null));
});

test("버튼 경로: 도메인 고정·상대 경로만, 이상한 값·여러 장은 마이페이지 결제 화면", () => {
  assert.equal(reg.normalizeBillingPath("/payments/abc-1"), "payments/abc-1");
  for (const bad of ["", null, "https://evil.example/x", "//evil.example", "payments/../../x?y", "payments//a", "결제"]) {
    assert.equal(reg.normalizeBillingPath(bad), "mypage/payments", String(bad));
  }
  assert.equal(reg.billingPathForInvoices(["inv1"]), "payments/inv1");
  assert.equal(reg.billingPathForInvoices(["inv1", "inv1"]), "payments/inv1");
  assert.equal(reg.billingPathForInvoices(["inv1", "inv2"]), "mypage/payments");
  assert.equal(reg.billingPathForInvoices(["inv1", undefined]), "mypage/payments", "청구서 없는 결제가 섞이면");
  assert.equal(reg.billingPathForInvoices([]), "mypage/payments");
});

test("납부기한 표기: YYYY-MM-DD 달력 숫자만 읽는다(시간대 개입 없음)", () => {
  assert.equal(reg.formatBillingDueDate("2026-12-10"), "2026년 12월 10일");
  assert.equal(reg.formatBillingDueDate("2027-01-01"), "2027년 1월 1일");
  assert.equal(reg.formatBillingDueDate("2028-02-29"), "2028년 2월 29일");
  assert.equal(reg.formatBillingDueDate(null), "");
  assert.equal(reg.formatBillingDueDate("2026-12-10T00:00:00Z"), "");
});

test("심사 문서: 두 틀 본문이 코드와 글자까지 같고 환경변수·트리거·버튼·초안 표시가 있다", () => {
  const doc = read("docs/kakao-alimtalk-parent-templates.md");
  for (const kind of KINDS) {
    const spec = reg.BILLING_ALIMTALK_TEMPLATES[kind];
    assert.ok(doc.includes("```\n" + spec.body + "\n```"), `문서에 ${kind} 본문이 그대로 있어야 한다`);
    assert.ok(doc.includes(spec.envKey), spec.envKey);
    assert.ok(doc.includes(kind), kind);
  }
  assert.ok(doc.includes(reg.BILLING_BUTTON_LINK_TEMPLATE));
  assert.equal(reg.BILLING_BUTTON_LINK_TEMPLATE, "https://www.stiz-dasan.kr/#{청구서경로}");
  assert.match(doc, /웹링크 «청구서 확인하기»/);
  assert.match(doc, /B2\. 수강료 미납 안내 \(초안 — 원장 확인 필요\)/);
  assert.match(doc, /### 검수자 의견\(청구 2종\)/);
  assert.match(doc, /BILLING_PARENT_SEND_ENABLED=1/);
});

test("DB 표시용 문구({{x}})에 같은 값을 넣으면 문자 대체 본문과 같은 글자다", () => {
  const link = "https://www.stiz-dasan.kr/payments/inv1";
  for (const kind of KINDS) {
    const sms = reg.billingAlimtalkSmsTemplateBody(kind);
    assert.doesNotMatch(sms, /#\{/);
    const rendered = sms.replace(/\{\{([\p{L}\p{N}_]+)\}\}/gu, (_, k) => (k === "invoiceLink" ? link : SAMPLE[k] || ""));
    assert.equal(rendered, reg.buildBillingAlimtalkMessage(kind, SAMPLE, "payments/inv1").smsBody, kind);
  }
});

// ── 가짜 발송자: message-dispatch.ts 를 그대로 실행하고 fetch·문자 함수만 바꿔 끼운다 ──────────
function loadDispatch({ fetchOk }) {
  const calls = { fetch: [], sms: [] };
  // 가짜 솔라피 설정(실제 키 아님) — fetch 를 바꿔 끼우므로 어디에도 나가지 않는다
  const fakeProcess = { env: { SOLAPI_API_KEY: "k", SOLAPI_API_SECRET: "s", SOLAPI_SENDER: "0310000000", SOLAPI_KAKAO_PF_ID: "PF" } };
  const policySrc = ts.transpileModule(read("src/lib/message-channel-policy.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const policy = { exports: {} };
  new Function("module", "exports", "require", "process", "Buffer", policySrc)(policy, policy.exports, () => ({}), fakeProcess, Buffer);
  const stubs = {
    crypto: { randomBytes: () => Buffer.from("00".repeat(16), "hex"), createHmac: () => ({ update: () => ({ digest: () => "sig" }) }) },
    "@/lib/sms": {
      getSmsMessageType: (body) => (Buffer.byteLength(body, "utf8") <= 90 ? "SMS" : "LMS"),
      getSmsProviderName: () => "SOLAPI",
      sendSmsDetailed: async (to, body) => { calls.sms.push({ to, body }); return { ok: true, to, provider: "SOLAPI", messageType: "LMS" }; },
    },
    "@/lib/message-channel-policy": policy.exports,
    "@/lib/message-ledger": {},
  };
  const src = ts.transpileModule(read("src/lib/message-dispatch.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const fakeFetch = async (url, init) => {
    calls.fetch.push({ url, body: JSON.parse(init.body) });
    return fetchOk
      ? { ok: true, status: 200, json: async () => ({ groupId: "G1" }) }
      : { ok: false, status: 400, json: async () => ({ errorMessage: "템플릿 불일치" }) };
  };
  new Function("module", "exports", "require", "fetch", "process", src)(
    mod, mod.exports, (id) => { if (!(id in stubs)) throw new Error(`stub 없음: ${id}`); return stubs[id]; }, fakeFetch,
    fakeProcess,
  );
  return { send: mod.exports.sendMessageDetailed, calls };
}

function dispatchInput() {
  const m = reg.buildBillingAlimtalkMessage("BILLING_INVOICE_PARENT", SAMPLE, "payments/inv1");
  return {
    m,
    input: {
      to: "01012345678", body: m.smsBody, audience: "PARENT", requestedChannel: "ALIMTALK",
      fallbackEnabled: true, fallbackChannel: "LMS",
      alimtalk: { templateId: "KA01TP_FAKE", variables: m.variables, text: m.body, buttons: [m.button] },
    },
  };
}

test("가짜 발송자: 알림톡은 등록 문구(text)·버튼·변수로 보내고 문자 대체는 켠 채", async () => {
  const { send, calls } = loadDispatch({ fetchOk: true });
  const { m, input } = dispatchInput();
  const result = await send(input);
  assert.equal(result.ok, true);
  assert.equal(result.actualChannel, "ALIMTALK");
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.sms.length, 0);
  const sent = calls.fetch[0].body.message;
  assert.equal(sent.text, m.body, "알림톡 text = 등록 문구에 값을 넣은 것(링크 줄 없음)");
  assert.deepEqual(sent.kakaoOptions.buttons, [m.button]);
  assert.equal(sent.kakaoOptions.templateId, "KA01TP_FAKE");
  assert.equal(sent.kakaoOptions.variables["#{청구서경로}"], "payments/inv1");
  assert.equal(sent.kakaoOptions.disableSms, false);
});

test("가짜 발송자: 알림톡이 거절되면 같은 본문 + «청구서 확인하기: 링크» 를 문자로", async () => {
  const { send, calls } = loadDispatch({ fetchOk: false });
  const { m, input } = dispatchInput();
  const result = await send(input);
  assert.equal(result.ok, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(calls.sms.length, 1);
  assert.equal(calls.sms[0].body, m.smsBody);
  assert.match(calls.sms[0].body, /\n청구서 확인하기: https:\/\/www\.stiz-dasan\.kr\/payments\/inv1$/);
});

test("가짜 발송자: text·buttons 를 안 넘긴 기존 호출은 예전 그대로(body 를 알림톡 text 로, 버튼 없음)", async () => {
  const { send, calls } = loadDispatch({ fetchOk: true });
  await send({
    to: "01012345678", body: "[스티즈농구교실] 본문", audience: "PARENT", requestedChannel: "ALIMTALK",
    alimtalk: { templateId: "KA01TP_FAKE", variables: {} },
  });
  const sent = calls.fetch[0].body.message;
  assert.equal(sent.text, "[스티즈농구교실] 본문");
  assert.equal("buttons" in sent.kakaoOptions, false);
});

// ── 연결: 발송 잠금 그대로, id 가 비면 지금 동작 그대로 ───────────────────────────────
const admin = read("src/app/actions/admin.ts");
const sliceFn = (name, next) => admin.slice(admin.indexOf(name), admin.indexOf(next, admin.indexOf(name) + 1));

test("연결: 청구서 링크 발송 — 잠금 뒤에서만, id 가 없으면 DB 조회·발송 없이 바로 돌아온다", () => {
  const helper = sliceFn("async function sendBillingInvoiceAlimtalks", "function prepareUnpaidAlimtalk");
  const early = helper.indexOf("if (!templateId || invoiceIds.length === 0) return result;");
  assert.ok(early > 0);
  assert.doesNotMatch(helper.slice(0, early), /prisma\.|sendParentSms/);
  assert.match(helper, /alimtalkTemplateIdForEnv\(BILLING_ALIMTALK_TEMPLATES\.BILLING_INVOICE_PARENT\.envKey\)/);
  assert.match(helper, /alimtalk: \{ templateId, variables: message\.variables, text: message\.body, buttons: \[message\.button\] \}/);
  assert.match(helper, /body: message\.smsBody/);
  assert.match(helper, /TO_CHAR\(i\."dueDate" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\)/);
  const sendLinks = sliceFn("export async function sendInvoiceLinksForMonth", "export async function sendUnpaidReminders");
  const guard = sendLinks.indexOf("if (!isBillingParentSendEnabled())");
  const call = sendLinks.indexOf("await sendBillingInvoiceAlimtalks(ids, month, Boolean(forceResend))");
  assert.ok(guard > 0 && call > guard, "알림톡 발송은 잠금 검사 뒤");
  // 청구서 «발송됨» 기록 뒤에 보낸다(알림톡 실패가 기존 기록을 막지 않게)
  assert.ok(sendLinks.indexOf(`UPDATE "PaymentInvoice"`) < call);
});

test("연결: 미납 알림 — id 가 없으면 옛 DB 문자(prepared 없음), 있으면 미납 틀", () => {
  const prepare = sliceFn("function prepareUnpaidAlimtalk", "export async function sendInvoiceLinksForMonth");
  assert.match(prepare, /if \(!templateId\) return undefined;/);
  assert.match(prepare, /catch \(error\) \{[\s\S]*?return undefined;/);
  const reminders = sliceFn("export async function sendUnpaidReminders", "export async function bulkUpdatePaymentStatus");
  const guard = reminders.indexOf("if (!isBillingParentSendEnabled())");
  const tpl = reminders.indexOf("alimtalkTemplateIdForEnv(BILLING_ALIMTALK_TEMPLATES.UNPAID_PARENT.envKey)");
  assert.ok(guard > 0 && tpl > guard);
  assert.match(reminders, /if \(unpaidTemplateId\) \{[\s\S]*?FROM "PaymentInvoice"/);
  assert.match(reminders, /"UNPAID_PARENT",[\s\S]*?prepareUnpaidAlimtalk\(unpaidTemplateId, \{/);
  // 발송 결과형 함수: prepared 가 없으면 예전처럼 금고/DB 문구
  const notification = read("src/lib/notification.ts");
  assert.match(notification, /const resolved = prepared \?\? resolveParentMessage\(trigger, variables, msg\);/);
});

test("규칙 행: 청구서 안내는 자동 발송 규칙을 갖도록 기본 문자 틀에 있다(표시용 문구)", () => {
  const sms = read("src/lib/smsTemplate.ts");
  assert.match(sms, /"BILLING_INVOICE_PARENT",\s*"수강료 청구서 발행 안내 \(학부모\)",\s*"PARENT",\s*billingAlimtalkSmsTemplateBody\("BILLING_INVOICE_PARENT"\)/);
});
