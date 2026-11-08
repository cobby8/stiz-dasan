// 학부모 공지(2026-11-09 원장 결정) — 공지 알림톡 3종 + 자유 공지 브랜드 메시지.
// 금고 틀 = 원장 승인 문구 = 심사 문서를 실제로 실행해 대조하고, 빈 변수·발송 시간·연결부를 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const reg = await loadTsModule("src/lib/messaging/parent-alimtalk-templates.ts");
const notice = await loadTsModule("src/lib/messaging/parent-notice.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const read = (p) => readFileSync(p, "utf8");
const doc = read("docs/kakao-alimtalk-parent-templates.md").replace(/\r\n/g, "\n");

// 원장이 준 문구 그대로(한 글자라도 다르면 카카오 심사본과 어긋난다)
const APPROVED = {
  NOTICE_CLOSURE: [
    "[스티즈농구교실] 학원 휴무 안내",
    "안녕하세요, #{학생명} 학부모님.",
    "#{휴무기간} 학원 전체 휴무입니다.",
    "사유: #{사유}",
    "#{보강안내}",
    "문의: #{학원전화}",
  ].join("\n"),
  NOTICE_EVENT: [
    "[스티즈농구교실] 행사 안내",
    "안녕하세요, #{학생명} 학부모님.",
    "재원생 대상 #{행사명} 일정을 안내드립니다.",
    "· 일시: #{일시}",
    "· 장소: #{장소}",
    "· 내용: #{내용}",
    "#{신청안내}",
    "문의: #{학원전화}",
  ].join("\n"),
  NOTICE_MONTHLY: [
    "[스티즈농구교실] #{월}월 수업 안내",
    "안녕하세요, #{학생명} 학부모님.",
    "#{월}월 수업 일정과 안내 사항을 알려드립니다.",
    "· 휴무일: #{휴무일}",
    "· 수강료: #{수강료안내}",
    "· 안내 사항: #{안내사항}",
    "문의: #{학원전화}",
  ].join("\n"),
};

const FIELDS = {
  NOTICE_CLOSURE: { closurePeriod: "11월 17일(월)~11월 18일(화)", reason: "체육관 바닥 공사", makeupNotice: "" },
  NOTICE_EVENT: { eventName: "겨울 농구 축제", eventDate: "12월 20일(토) 14:00", eventPlace: "다산 본관", eventDetail: "미니 게임", applyNotice: "" },
  NOTICE_MONTHLY: { month: "12", closedDays: "12월 25일(목)", tuitionNotice: "12월 1일부터 홈페이지 결제", notes: "겨울특강 신청 12월 5일까지" },
};

test("공지 3종: 금고 문구가 원장 승인 문구와 글자까지 같고, 자동 발송 9종과 섞이지 않는다", () => {
  assert.deepEqual(Object.keys(reg.NOTICE_ALIMTALK_TEMPLATES).sort(), Object.keys(APPROVED).sort());
  for (const [kind, body] of Object.entries(APPROVED)) {
    assert.equal(reg.NOTICE_ALIMTALK_TEMPLATES[kind].body, body, kind);
    assert.match(reg.NOTICE_ALIMTALK_TEMPLATES[kind].envKey, /^ALIMTALK_TPL_NOTICE_[A-Z]+$/);
    // 자동 발송 트리거 금고에는 없다(트리거 가드·9종 목록이 그대로)
    assert.equal(reg.isParentAlimtalkTrigger(kind), false, kind);
  }
});

test("심사 문서: 3종 본문이 코드 블록에 그대로 있고 환경변수·버튼·기본값·검수자 의견이 있다", () => {
  for (const [kind, spec] of Object.entries(reg.NOTICE_ALIMTALK_TEMPLATES)) {
    assert.ok(doc.includes("```\n" + spec.body + "\n```"), `문서에 ${kind} 본문이 그대로 있어야 한다`);
    assert.ok(doc.includes(spec.envKey), spec.envKey);
  }
  assert.ok(doc.includes(`웹링크 «${reg.NOTICE_BUTTON_NAME}»`));
  assert.ok(doc.includes("`https://www.stiz-dasan.kr/#{공지경로}`"));
  assert.ok(doc.includes(`«${reg.NOTICE_EMPTY_DEFAULTS.makeupNotice}»`));
  assert.ok(doc.includes(`«${reg.NOTICE_EMPTY_DEFAULTS.applyNotice}»`));
  assert.match(doc, /### 검수자 의견\(공지 3종\)/);
  // 브랜드 메시지 문서 근거(링크)와 스위치
  assert.match(doc, /https:\/\/solapi\.com\/developers\/api\/kakao-bms-free-text/);
  assert.match(doc, /https:\/\/solapi\.com\/guides\/kakao-bms-guide/);
  assert.match(doc, /ALIMTALK_BMS_FREE_NOTICE=on/);
});

test("틀 채우기: #{ 가 남지 않고, 선택 칸이 비면 기본 문장, 학생명·학원전화 자동, 버튼은 도메인 고정", () => {
  const recipients = [{ phone: "01011112222", studentNames: ["홍길동", "홍길순"] }];
  for (const kind of Object.keys(APPROVED)) {
    const fields = notice.normalizeNoticeFields(kind, FIELDS[kind]);
    const [item] = notice.buildNoticeAlimtalkItems(kind, fields, recipients, { academyPhone: "", noticePath: "notices/abc123" });
    assert.doesNotMatch(item.body, /#\{/, kind);
    assert.match(item.body, /안녕하세요, 홍길동·홍길순 학부모님\./, kind);
    assert.match(item.body, new RegExp(`문의: ${reg.DEFAULT_ACADEMY_PHONE}$`), kind);
    for (const value of Object.values(item.variables)) assert.ok(String(value).trim().length > 0, kind);
    // 등록 변수(본문) + 버튼 경로 변수만 넘긴다
    assert.deepEqual(Object.keys(item.variables).sort(), [...reg.templateVariableKeys(APPROVED[kind]), "#{공지경로}"].sort(), kind);
    assert.deepEqual(item.button, { buttonName: "공지 자세히 보기", buttonType: "WL", linkMo: "https://www.stiz-dasan.kr/notices/abc123", linkPc: "https://www.stiz-dasan.kr/notices/abc123" });
    // 문자로 보낼 때는 버튼이 없으니 링크를 본문 끝에 붙인다
    assert.equal(item.smsBody, `${item.body}\n공지 자세히 보기: https://www.stiz-dasan.kr/notices/abc123`);
    assert.ok([...item.body].length <= 1000);
  }
  const closure = notice.buildNoticeAlimtalkItems("NOTICE_CLOSURE", notice.normalizeNoticeFields("NOTICE_CLOSURE", FIELDS.NOTICE_CLOSURE), recipients, { academyPhone: "031-555-0000" })[0];
  assert.equal(closure.body, [
    "[스티즈농구교실] 학원 휴무 안내",
    "안녕하세요, 홍길동·홍길순 학부모님.",
    "11월 17일(월)~11월 18일(화) 학원 전체 휴무입니다.",
    "사유: 체육관 바닥 공사",
    "보강: 없음",
    "문의: 031-555-0000",
  ].join("\n"));
  assert.equal(closure.button.linkMo, "https://www.stiz-dasan.kr/notices"); // 공지 미선택 = 목록
  const event = notice.buildNoticeAlimtalkItems("NOTICE_EVENT", notice.normalizeNoticeFields("NOTICE_EVENT", FIELDS.NOTICE_EVENT), recipients, {})[0];
  assert.match(event.body, /\n별도 신청은 필요 없습니다\.\n문의: /);
  const withApply = notice.normalizeNoticeFields("NOTICE_EVENT", { ...FIELDS.NOTICE_EVENT, applyNotice: "12월 10일까지 카톡으로 신청" });
  assert.match(notice.buildNoticeAlimtalkItems("NOTICE_EVENT", withApply, recipients, {})[0].body, /\n12월 10일까지 카톡으로 신청\n/);
});

test("입력 검사: 필수 칸 비면 거절, 월은 1~12, 한 줄 칸의 줄바꿈은 공백, #{ 금지", () => {
  assert.throws(() => notice.normalizeNoticeFields("NOTICE_CLOSURE", { ...FIELDS.NOTICE_CLOSURE, reason: "  " }), /«사유» 칸을 채워 주세요/);
  assert.throws(() => notice.normalizeNoticeFields("NOTICE_MONTHLY", { ...FIELDS.NOTICE_MONTHLY, month: "13" }), /1~12/);
  assert.throws(() => notice.normalizeNoticeFields("NOTICE_MONTHLY", { ...FIELDS.NOTICE_MONTHLY, month: "십이" }), /1~12/);
  assert.equal(notice.normalizeNoticeFields("NOTICE_MONTHLY", { ...FIELDS.NOTICE_MONTHLY, month: "03" }).month, "3");
  assert.equal(notice.normalizeNoticeFields("NOTICE_CLOSURE", { ...FIELDS.NOTICE_CLOSURE, reason: "바닥\n공사" }).reason, "바닥 공사");
  assert.equal(notice.normalizeNoticeFields("NOTICE_EVENT", { ...FIELDS.NOTICE_EVENT, eventDetail: "1부\n2부" }).eventDetail, "1부\n2부");
  assert.throws(() => notice.normalizeNoticeFields("NOTICE_CLOSURE", { ...FIELDS.NOTICE_CLOSURE, reason: "#{x}" }), /#\{/);
  assert.throws(() => reg.buildNoticeAlimtalkMessage("NOTICE_CLOSURE", { studentName: "홍길동", reason: "공사" }), /휴무기간/);
});

test("버튼 경로: 상대 경로만 — 다른 사이트·이상한 글자는 공지 목록으로", () => {
  assert.equal(reg.normalizeNoticePath("/notices/abc-1"), "notices/abc-1");
  for (const bad of ["", null, "https://evil.example", "//evil.example", "notices/../x", "notices?x=1", "공지"]) {
    assert.equal(reg.normalizeNoticePath(bad), "notices", String(bad));
  }
});

test("받는 사람: 휴대폰만, 같은 번호는 한 통(형제 이름 모음), 번호 순 고정", () => {
  const { recipients, invalidPhoneCount } = notice.selectNoticeRecipients([
    { studentName: "홍길순", phone: "010-2222-3333" },
    { studentName: "김민수", phone: "01011112222" },
    { studentName: "홍길동", phone: "01022223333" },
    { studentName: "박집전화", phone: "031-555-0000" },
    { studentName: "이없음", phone: null },
    { studentName: "홍길동", phone: "01022223333" },
  ]);
  assert.deepEqual(recipients, [
    { phone: "01011112222", studentNames: ["김민수"] },
    { phone: "01022223333", studentNames: ["홍길동", "홍길순"] },
  ]);
  assert.equal(invalidPhoneCount, 2);
});

test("문자로 깨지는 글자 없음(EUC-KR 완성형): 공지 틀·기본 문장·자유 공지 머리말과 수신거부 줄", () => {
  const decoder = new TextDecoder("euc-kr");
  const allowed = new Set();
  for (let a = 0xa1; a <= 0xfe; a += 1) {
    for (let b = 0xa1; b <= 0xfe; b += 1) allowed.add(decoder.decode(new Uint8Array([a, b])));
  }
  const texts = [
    ...Object.values(reg.NOTICE_ALIMTALK_TEMPLATES).map((spec) => spec.body),
    ...Object.values(reg.NOTICE_EMPTY_DEFAULTS),
    notice.buildFreeNoticeBrandText("안내"),
    `${reg.NOTICE_BUTTON_NAME}: ${reg.NOTICE_LINK_BASE}notices`,
  ];
  for (const text of texts) {
    const broken = [...text.replace(/#\{[^}]+\}/g, "")].filter((ch) => ch.charCodeAt(0) > 0x7f && !allowed.has(ch));
    assert.deepEqual(broken, [], `깨지는 글자: ${broken.join(" ")} — ${text.slice(0, 20)}`);
  }
});

test("자유 공지: 브랜드 메시지 본문 = (광고) + 머리말 + 내용 + 수신거부, 문자일 때는 예전 머리말만", () => {
  assert.equal(notice.buildFreeNoticeBrandText("  12월 일정 안내입니다. "),
    "(광고) [스티즈농구교실] 12월 일정 안내입니다.\n\n수신거부: 카카오톡 채널 ‘스티즈농구교실’ 차단");
  assert.equal(notice.buildFreeNoticeSmsText("12월 일정"), "[스티즈농구교실] 12월 일정");
  assert.throws(() => notice.buildFreeNoticeBrandText("가".repeat(1300)), /1300자/);
  // 본문 줄바꿈 98개 + 수신거부 앞 2개 = 100개 > 99
  assert.throws(() => notice.buildFreeNoticeBrandText(`${"가\n".repeat(98)}가`), /줄바꿈/);
  assert.doesNotThrow(() => notice.buildFreeNoticeBrandText(`${"가\n".repeat(97)}가`));
});

test("브랜드 메시지 시간: KST 08:00 ≤ 시각 < 20:50, 접수는 마감 10분 전까지(서버 UTC 와 무관)", () => {
  const at = (hm) => kst.kstAt("2026-11-09", hm);
  assert.equal(notice.brandMessageWindow(at("07:59")).open, false);
  assert.equal(notice.brandMessageWindow(at("08:00")).open, true);
  assert.equal(notice.brandMessageWindow(at("20:49")).open, true);
  assert.equal(notice.brandMessageWindow(at("20:50")).open, false);
  assert.equal(notice.brandMessageWindow(at("23:30")).open, false);
  // 자정 넘어(UTC 로는 전날 15시대) — 서버 시간대가 UTC 여도 KST 기준으로 막힌다
  assert.equal(notice.brandMessageWindow(kst.kstAt("2026-11-10", "00:30")).open, false);
  const margin = notice.BMS_QUEUE_MARGIN_MINUTES;
  assert.equal(margin, 10);
  assert.equal(notice.brandMessageWindow(at("20:39"), margin).open, true);
  assert.equal(notice.brandMessageWindow(at("20:40"), margin).open, false);
  assert.equal(notice.brandMessageWindow(at("12:00")).endMs, at("20:50"));
  assert.equal(notice.brandMessageWindow(at("12:00")).nowHm, "12:00");
});

test("연결: 솔라피 규격(ATA·BMS_FREE)·크론 분기·서버 동작·화면", () => {
  const sms = read("src/lib/sms.ts");
  // 브랜드 메시지 자유형 텍스트형 — 채널 친구(I), 대체 문자 켬, from(발신번호)
  assert.match(sms, /type: "BMS_FREE",\s*kakaoOptions: \{\s*pfId,\s*disableSms: false,\s*bms: \{ targeting: "I", chatBubbleType: "TEXT" \},/);
  assert.match(sms, /type: "ATA",\s*kakaoOptions: \{[\s\S]*?templateId: item\.kakao\.templateId,[\s\S]*?disableSms: false,/);
  assert.match(sms, /from: SOLAPI_SENDER,\s*text: item\.body,/);
  assert.doesNotMatch(sms, /disableSms: true/);

  const cron = read("src/app/api/cron/manual-message-dispatch/route.ts");
  assert.match(cron, /if \(claimed\.some\(\(item\) => item\.perItem\)\)/);
  assert.match(cron, /BMS_SEND_WINDOW_CLOSED/);
  assert.match(cron, /BATCH_BODY_MISMATCH/); // 예전 문자 묶음 검사는 그대로
  // 카카오가 명시적으로 거절된 사람만 문자로 한 번(불확실은 재시도 금지)
  assert.match(cron, /if \(solapi && item\.kakao && delivery\?\.status === "FAILED"\) \{ retry\.push\(item\); continue; \}/);
  assert.match(cron, /body: item\.kakao\?\.kind === "ALIMTALK" \? item\.kakao\.smsBody : item\.body,/);

  const ledger = read("src/lib/message-ledger.ts");
  assert.match(ledger, /items\?: ManualQueueItem\[\]/);
  // 장부 channel 칸은 DB CHECK 안의 값만(브랜드 메시지는 SMS 로 두고 종류는 messageType)
  assert.match(ledger, /const channel = item\.kakao\?\.kind === "ALIMTALK" \? "ALIMTALK" : "SMS";/);

  const action = read("src/app/actions/parent-notice.ts");
  for (const name of ["getParentNoticeOptions", "prepareParentNotice", "sendParentNotice"]) {
    const body = action.slice(action.indexOf(`export async function ${name}`));
    assert.ok(body.indexOf("await requireAdmin()") > -1 && body.indexOf("await requireAdmin()") < body.indexOf("prisma."), name);
  }
  assert.match(action, /notMergedStudent\("s"\)/);
  assert.match(action, /e\.status = 'ACTIVE'/);
  assert.match(action, /brandMessageWindow\(Date\.now\(\), BMS_QUEUE_MARGIN_MINUTES\)/);
  assert.match(action, /isBrandFreeNoticeEnabled\(\) && kakaoChannelReady\(\)/);
  assert.match(action, /reserveManualMessageQueue\(\{/);

  const client = read("src/app/admin/sms/SmsClient.tsx");
  assert.match(client, /<ParentNoticePanel \/>/);
  // 직원(내부) 수동 발송은 그대로 — 기존 대량 접수 함수를 그대로 부른다
  assert.match(client, /enqueueManualSmsBatch\(targetRecipients, message\.trim\(\), \{ requestId \}\)/);
  const config = read("src/lib/messaging/alimtalk-config.ts");
  assert.match(config, /BMS_FREE_NOTICE_ENV_KEY = "ALIMTALK_BMS_FREE_NOTICE"/);
});
