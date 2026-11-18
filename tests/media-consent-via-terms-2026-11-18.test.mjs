// 2026-11-18 원장 결정 — 학생 사진 동의를 학부모에게 따로 받지 않고 이용약관 조항으로 대신한다.
//  - 약관(seed 사본)에 «수업 중 사진·동영상 촬영 → 해당 수업 피드 게시» 조항이 있다
//  - 광고(홍보물·SNS·블로그)는 «전화로» 사전 동의 — 사이트 동의 절차 없음
//  - 수업 피드 노출은 사진 동의 기록과 무관하다(동의가 없어 피드에서 빠지는 학생이 생기면 안 된다)
//  - 원생 등록 창은 사진 동의를 묻지 않는다, 공개 게시 동의 검사는 꺼져 있다
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("이용약관 사본에 수업 사진·동영상 조항이 있다 — 피드 게시·광고는 전화 사전 동의", () => {
  const seed = read("prisma/seed-data.ts");
  const terms = seed.match(/export const TERMS_OF_SERVICE: string \| null = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.ok(terms.length > 0, "약관 사본을 찾지 못함");
  assert.match(terms, /"수업 사진·동영상"/);
  assert.match(terms, /수업 중에는 강사가 수업 모습을 사진·동영상으로 촬영/);
  assert.match(terms, /해당 수업의 피드\(학부모님이 보시는 수업 소식\)에 올라갑니다/);
  assert.match(terms, /광고에 사용할 때에는[^\n]*전화로 따로 동의를 받습니다/);
  assert.match(terms, /수업 피드는 그 반 수강생의 보호자만 보실 수 있습니다/);
  assert.match(terms, /2026년 11월 18일 개정: "수업 사진·동영상" 조항을 추가하였습니다\./);
  // 조항은 «약관의 시행» 앞에 둔다(시행 조항이 맨 끝)
  assert.ok(terms.indexOf('"수업 사진·동영상"') < terms.indexOf('"약관의 시행"'));
});

test("약관 버전이 조항 추가일 이후로 올라가 있다", () => {
  const version = read("src/lib/parent-consent.ts").match(/PARENT_TERMS_VERSION = "(\d{4}-\d{2}-\d{2})"/)?.[1];
  assert.ok(version && version >= "2026-11-18", `약관 버전 ${version}`);
});

test("수업 피드 공개 기준은 사진 동의 기록을 보지 않는다", () => {
  for (const path of [
    "src/lib/feed/rules.ts", "src/lib/feed/server.ts", "src/lib/feed/reportFeedServer.ts", "src/lib/feed/reportFeedRules.ts",
    "src/lib/feed/adminFeedServer.ts", "src/lib/feed/adminFeedRules.ts", "src/lib/queries.ts",
    "src/app/api/staff/sessions/[sessionId]/photos/route.ts", "src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts",
  ]) {
    const code = read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /StudentMediaConsent|studentMediaConsent|evaluateMediaConsent/, `${path} 가 사진 동의를 본다`);
  }
});

test("사이트는 사진 동의를 따로 받지 않는다 — 공개 게시 동의 검사 꺼짐·등록 창은 묻지 않음", () => {
  assert.match(read("src/lib/studentMediaConsent.ts"), /export const PUBLIC_POST_CONSENT_GATE_ENABLED = false;/);
  assert.match(read("src/app/admin/students/StudentRegisterModal.tsx"), /mediaConsent: null,/);
});
