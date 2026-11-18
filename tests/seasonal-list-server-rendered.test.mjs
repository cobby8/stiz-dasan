// 방학특강 공개 목록은 서버가 미리 그린다(2026-11-19 전 화면 속도 2회차)
//
// 왜: 목록 부품이 브라우저 스크립트 실행 뒤 /api/seasonal 을 따로 불러, 휴대폰 첫 화면 카드가 약 5초 늦게 떴다
//     (Lighthouse 모바일 LCP 5.2초, 92%가 그리기 지연). 서버가 같은 함수로 읽어 넘기면 HTML 에 카드가 들어 있다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("공개 /seasonal — 서버가 API 와 같은 함수로 열 때마다 읽어 넘긴다(저장 화면 없음: 관리자 공개가 바로 보이게)", () => {
  const page = readFileSync("src/app/seasonal/page.tsx", "utf8");
  const api = readFileSync("src/app/api/seasonal/route.ts", "utf8");
  assert.match(page, /export const dynamic = "force-dynamic";/);
  assert.doesNotMatch(page, /export const revalidate/);
  assert.match(page, /await listPublishedSeasons\(\)/);
  assert.match(api, /await listPublishedSeasons\(\)/);
  // 읽기 실패는 화면을 깨지 않고, 예전처럼 브라우저가 다시 묻게 넘기지 않는다
  assert.match(page, /\.catch\(\(\) => undefined\)/);
  assert.match(page, /<SeasonalListClient initialData=\{initialData\} \/>/);
});

test("목록 부품 — 미리 받은 목록이 있으면 «확인 중» 없이 바로 그리고 다시 묻지 않는다", () => {
  const src = readFileSync("src/components/seasonal/SeasonalListClient.tsx", "utf8");
  assert.match(src, /useState<"loading" \| "ready" \| "error">\(initialData \? "ready" : "loading"\)/);
  assert.match(src, /useEffect\(\(\) => \{\s*if \(initialData\) return;/);
  // 학부모 앱 안 목록(initialData 없이 basePath 만)은 예전처럼 브라우저가 부른다
  assert.match(src, /fetch\("\/api\/seasonal"/);
});
