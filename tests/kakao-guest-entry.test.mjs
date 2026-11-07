import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const { kakaoGuestEntry, kakaoConnectLinkReply, isKakaoParentAuthIntent } = await loadTsModule("src/lib/kakao-guest-entry.ts");

const card = (result) => result.template.outputs[0].textCard;

test("공개 메뉴는 인증 링크 없이 실제 신청 페이지를 안내한다", () => {
  const result = kakaoGuestEntry("메뉴", "https://example.test");
  const links = card(result).buttons.filter((button) => button.action === "webLink");
  assert.equal(links.length, 2);
  for (const button of links) {
    const path = new URL(button.webLinkUrl).pathname;
    assert.ok(existsSync(`src/app${path}/page.tsx`));
  }
  assert.match(card(result).description, /상담이 접수되지는 않습니다/);
  // 상담 안내는 버튼 3개 제한 때문에 바로가기로 옮겼다 — 길이 사라지지 않았는지
  assert.ok(result.template.quickReplies.some((reply) => reply.messageText === "상담 안내"));
  assert.ok(kakaoGuestEntry("상담 안내", "https://example.test"));
});

test("연결 안 된 안내 카드는 맨 위에 '기존 수강생 인증' 버튼을 둔다", () => {
  for (const text of ["메뉴", "체험 문의", "수강 신청", "상담 안내"]) {
    const result = kakaoGuestEntry(text, "https://example.test");
    const first = card(result).buttons[0];
    assert.equal(first.action, "message", text);
    assert.equal(first.messageText, "기존 수강생 인증", text);
    assert.equal(result.template.quickReplies[0].messageText, "기존 수강생 인증", text);
    assert.match(card(result).title, /이미 다니는 학부모님/);
  }
});

test("신규·체험·상담은 공개 링크, 기존 학생 요청은 인증 선택 안내", () => {
  for (const text of ["체험 문의", "수강 신청", "상담 안내", "오늘 결석", "메뉴"]) assert.ok(kakaoGuestEntry(text, "https://example.test"));
  assert.equal(kakaoGuestEntry("기존 수강생 인증", "https://example.test"), null);
});

test("인증 의도 매칭 경계 — 기존 학부모 문장은 인증으로, 신규 문의는 공개 안내로", () => {
  // 인증 흐름으로 가야 하는 말
  for (const text of [
    "기존 수강생 인증", "인증", "학부모 인증하기", "계정 연결",
    "인증 어떻게 해요", "기존 학부모예요", "수강생 학부모입니다", "아이가 다니고 있어요",
    "지금 다니는 학생 엄마예요", "재원생 학부모", "인증번호가 안 와요",
  ]) assert.equal(isKakaoParentAuthIntent(text), true, text);
  // 공개 안내에 남아야 하는 말(오탐 방지)
  for (const text of [
    "메뉴", "체험 문의", "수강 신청", "상담 안내", "오늘 결석", "가격 궁금해요",
    "신규 수강생 등록 문의", "처음 방문이에요", "체험 수업 신청하고 싶은 학부모예요",
    "수강생 모집하나요", "입학 상담",
    // 검수에서 찾은 오탐 2건
    "아이가 농구 다니고 싶어해요", "학부모입니다 상담 받고 싶어요",
  ]) assert.equal(isKakaoParentAuthIntent(text), false, text);
});

test("미인증 메뉴는 identity 생성 전 반환하고 기존 인증 흐름은 유지한다", () => {
  const route = readFileSync("src/app/api/kakao/chatbot/skill/route.ts", "utf8");
  assert.ok(route.indexOf("if (guestResponse)") < route.indexOf("await issueLink"));
  assert.match(route, /identity.status !== "ACTIVE"/);
  // 정책 답변 연결점(policyHook)이 붙었지만 기존 인자 순서는 그대로다
  assert.match(route, /handleLinkedMessage\(identity, utterance, requestId(?:, policyHook)?\)/);
  assert.match(route, /kakaoConnectLinkReply\(link\)/);
});

test("인증 링크 안내 — 15분·활성화 안내, 재사용/교체 문구", () => {
  const fresh = kakaoConnectLinkReply({ url: "https://example.test/mypage/kakao-connect?token=x", reused: false, replacedPrevious: false, minutesLeft: 15 });
  const text = card(fresh).description;
  assert.match(text, /15분 안에 열어 주세요/);
  assert.match(text, /로그인이 안 되면 연결 화면에서 ‘기존 학부모 계정 활성화’를 누르세요/);
  assert.doesNotMatch(text, /이전에 받은 인증 링크/);
  assert.equal(card(fresh).buttons[0].webLinkUrl, "https://example.test/mypage/kakao-connect?token=x");

  const replaced = kakaoConnectLinkReply({ url: "https://example.test/a", reused: false, replacedPrevious: true, minutesLeft: 15 });
  assert.match(card(replaced).description, /이전에 받은 인증 링크는 더 이상 쓸 수 없어요/);

  const reused = kakaoConnectLinkReply({ url: "https://example.test/a", reused: true, replacedPrevious: false, minutesLeft: 9 });
  assert.match(card(reused).description, /다시 보여드려요\. 9분 안에 열어 주세요/);
  assert.match(card(reused).description, /기존 학부모 계정 활성화/);
});

// ── 체육관 대관(2026-11-07) ─────────────────────────────────────────────
test("대관 문의는 상담·인증·셔틀보다 먼저 대관 카드 — 요금·실내화·주차 안내 + 신청 버튼, 계좌는 없다", async () => {
  const { kakaoRentalReply } = await loadTsModule("src/lib/kakao-guest-entry.ts");
  for (const text of ["대관 문의", "대관 차량 되나요?", "체육관 빌릴 수 있나요", "코트 대여 가능한가요", "대관비 얼마예요", "기존 회원인데 대관 되나요"]) {
    const result = kakaoGuestEntry(text, "https://example.test/");
    assert.ok(result, text);
    assert.equal(card(result).title, "체육관 대관 안내", text);
    const button = card(result).buttons[0];
    assert.equal(button.label, "대관 신청하기", text);
    assert.equal(button.webLinkUrl, "https://example.test/rental", text);
  }
  const description = card(kakaoRentalReply("https://example.test")).description;
  for (const word of [/40,000원/, /30,000원/, /시간당 5,000원/, /1인당 시간당 3,000원/, /보증금 20,000원\(사용 후 환불\)/, /실내 운동화 필수/, /주민센터 주차장/]) {
    assert.match(description, word);
  }
  assert.doesNotMatch(description, /계좌|은행|입금/);
  assert.ok([...description].length <= 400, "textCard 400자 안");
  // 대관과 무관한 말은 기존 안내 그대로
  assert.equal(card(kakaoGuestEntry("상담 안내", "https://example.test")).buttons[1].webLinkUrl, "https://example.test/apply");
  assert.notEqual(card(kakaoGuestEntry("농구공 대여되나요", "https://example.test")).title, "체육관 대관 안내");
});

test("스킬 경로: 미연결 사용자의 대관은 정책 답변(Gemini)보다 먼저 카드", () => {
  const route = readFileSync("src/app/api/kakao/chatbot/skill/route.ts", "utf8");
  const rental = route.indexOf("if (isKakaoRentalIntent(utterance))");
  assert.ok(rental > 0);
  assert.ok(rental < route.indexOf("isGuestPolicyCandidate(utterance"), "대관 카드가 정책 답변보다 앞");
  assert.ok(rental < route.indexOf("await issueLink"));
});

test("대관 요금은 RENTAL_FEE 한 곳 — 카카오 카드와 고객 안내 문자 문구가 같은 값을 쓴다", async () => {
  const rules = await loadTsModule("src/lib/rental/gym-rental-rules.ts");
  const { KAKAO_RENTAL_TEXT } = await loadTsModule("src/lib/kakao-rental-reply.ts");
  const templates = await loadTsModule("src/lib/customer-notice/templates.ts");
  const guide = templates.buildRentalGuideMessage();
  const fee = rules.RENTAL_FEE;
  for (const amount of [fee.firstHour, fee.extraHour, fee.airconPerHour, fee.extraPersonPerHour, fee.deposit]) {
    assert.ok(KAKAO_RENTAL_TEXT.includes(rules.formatWon(amount)), `카드에 ${amount}`);
    // 안내 문자 문구(templates.ts)는 import 없는 순수 모듈 규칙 때문에 숫자를 직접 적는다 — 요금이 바뀌면 여기서 깨진다
    assert.ok(guide.includes(rules.formatWon(amount)), `안내 문자에 ${amount}`);
  }
  assert.ok(KAKAO_RENTAL_TEXT.includes(`${fee.baseHeadcount}명 초과`));
  // 카드 모듈은 계좌 값을 가진 서버 전용 모듈을 부르지 않는다
  const source = readFileSync("src/lib/kakao-rental-reply.ts", "utf8");
  assert.doesNotMatch(source, /gym-rental-notify|server-only|계좌:|bankAccount/);
});
