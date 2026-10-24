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
