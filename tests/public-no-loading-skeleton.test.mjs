// 공개 화면에는 로딩 화면(loading.tsx)을 두지 않는다(2026-11-19 전 화면 속도 4회차)
//
// 왜: loading.tsx 가 있으면 완성된 화면을 저장해 보내는 경우에도 본문이 <div hidden> 에 숨어서 오고,
//     브라우저 스크립트가 로딩 화면과 바꿔 끼운다. 휴대폰이 다른 스크립트로 바쁘면 그 교체가 늦어
//     운영 Lighthouse 모바일에서 소개·연간일정·수강 신청의 글이 2.7~4.1초 늦게 그려졌다(로딩 화면이 없는 FAQ 는 늘 2.0초).
//     공개 화면은 대부분 저장 화면(ISR)이고 링크 미리 불러오기가 있어, 사이트 안 이동도 거의 바로 끝난다.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PUBLIC_ROUTES = ["about", "annual", "apply", "gallery", "notices", "programs", "schedule", "simulator", "faq", "seasonal", "rental"];

test("공개 화면 폴더에 loading.tsx 가 없다(앱 최상위 포함)", () => {
  const present = ["src/app/loading.tsx", ...PUBLIC_ROUTES.map((route) => `src/app/${route}/loading.tsx`)].filter((file) => existsSync(file));
  assert.deepEqual(present, []);
});

test("프로그램 첫 카드 사진은 바로 받는다(나머지는 나중에)", () => {
  const src = readFileSync("src/app/programs/page.tsx", "utf8");
  assert.match(src, /priority=\{i === 0\}/);
});
