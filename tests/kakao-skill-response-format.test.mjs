import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 카카오 스킬 응답 말풍선 규격 가드.
// 2026-10-07 운영 오픈빌더 「스킬 오류 내역」: "BasicCard의 thumbnail 필드를 채워 주시기 바랍니다 (2461)"
// → thumbnail 없는 basicCard 는 곧 미발송 처리된다. 버튼 안내는 textCard 로만 보낸다.

const contract = await loadTsModule("src/lib/kakao-chatbot-contract.ts");
const guest = await loadTsModule("src/lib/kakao-guest-entry.ts");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// 카카오 스킬 응답을 만드는 파일 전부(라이브러리 + 스킬 API)
const SKILL_SOURCES = [
  ...readdirSync("src/lib").filter((name) => /^kakao.*\.ts$/.test(name)).map((name) => path.join("src/lib", name)),
  ...walk("src/app/api/kakao").filter((file) => file.endsWith(".ts")),
];

/** 응답 JSON 을 훑어 말풍선 규격 위반을 모은다. */
function violations(response) {
  const found = [];
  const visit = (node, at) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${at}[${index}]`));
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "basicCard" && !value?.thumbnail) found.push(`${at}.basicCard 에 thumbnail 이 없다`);
      if (key === "textCard") {
        if (!value.title && !value.description) found.push(`${at}.textCard 에 title·description 이 둘 다 없다`);
        if ([...(value.description || "")].length > contract.KAKAO_TEXT_CARD_DESCRIPTION_MAX) found.push(`${at}.textCard.description 400자 초과`);
        if ((value.buttons || []).length > contract.KAKAO_MAX_CARD_BUTTONS) found.push(`${at}.textCard 버튼 3개 초과`);
        for (const button of value.buttons || []) {
          if ([...button.label].length > contract.KAKAO_BUTTON_LABEL_MAX) found.push(`버튼 라벨 14자 초과: ${button.label}`);
          if (button.action === "webLink" && !button.webLinkUrl) found.push(`webLink 버튼에 주소 없음: ${button.label}`);
          if (button.action === "message" && !button.messageText) found.push(`message 버튼에 문장 없음: ${button.label}`);
        }
      }
      visit(value, `${at}.${key}`);
    }
  };
  visit(response, "$");
  for (const reply of response.template?.quickReplies || []) {
    if ([...reply.label].length > contract.KAKAO_BUTTON_LABEL_MAX) found.push(`바로가기 라벨 14자 초과: ${reply.label}`);
  }
  return found;
}

test("스킬 응답 코드에 basicCard 를 쓰지 않는다(thumbnail 없는 basicCard 는 미발송)", () => {
  assert.ok(SKILL_SOURCES.length >= 3, "검사 대상 파일을 찾지 못했다");
  for (const file of SKILL_SOURCES) {
    // 설명 주석은 걷어내고 실제 코드만 본다
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /basicCard\s*[:"'`]|["'`]basicCard/, `${file} 에 basicCard 응답이 있다 — textCard 로 바꿔라`);
  }
});

test("버튼이 있으면 textCard, 없으면 simpleText 로 만든다", () => {
  const withButton = contract.buildKakaoSkillResponse({ text: "안내", buttons: [{ action: "webLink", label: "열기", webLinkUrl: "https://example.test" }] });
  assert.ok(withButton.template.outputs[0].textCard);
  assert.equal(withButton.template.outputs[0].basicCard, undefined);
  const plain = contract.buildKakaoSkillResponse({ text: "안내" });
  assert.deepEqual(plain.template.outputs[0], { simpleText: { text: "안내" } });
});

test("규격을 넘는 입력도 잘라서 규격 안에 맞춘다", () => {
  const response = contract.buildKakaoSkillResponse({
    text: "가".repeat(900),
    buttons: [1, 2, 3, 4].map((n) => ({ action: "webLink", label: `아주 긴 버튼 라벨 이름 ${n}번입니다`, webLinkUrl: "https://example.test" })),
    quickReplies: Array.from({ length: 12 }, (_, n) => `아주 긴 바로가기 라벨 ${n}번입니다`),
  });
  assert.deepEqual(violations(response), []);
  assert.equal(response.template.quickReplies.length, 10);
  // 바로가기를 누르면 원래 문장이 그대로 돌아와야 매칭된다 — messageText 는 자르지 않는다
  assert.equal(response.template.quickReplies[0].messageText, "아주 긴 바로가기 라벨 0번입니다");
});

test("실제 안내 응답(게스트 카드·인증 링크)이 모두 규격을 지킨다", () => {
  const samples = [
    ...["메뉴", "체험 문의", "수강 신청", "상담 안내", "오늘 결석"].map((text) => guest.kakaoGuestEntry(text, "https://example.test")),
    guest.kakaoConnectLinkReply({ url: "https://example.test/mypage/kakao-connect?token=x", reused: false, replacedPrevious: true, minutesLeft: 15 }),
    guest.kakaoConnectLinkReply({ url: "https://example.test/mypage/kakao-connect?token=x", reused: true, replacedPrevious: false, minutesLeft: 7 }),
  ];
  for (const response of samples) assert.deepEqual(violations(response), []);
});

test("기존 응답 헬퍼(kakaoText)는 공용 규격 빌더를 거친다", () => {
  const chatbot = readFileSync("src/lib/kakao-parent-chatbot.ts", "utf8");
  assert.match(chatbot, /export function kakaoText[\s\S]*?buildKakaoSkillResponse\(/);
});
