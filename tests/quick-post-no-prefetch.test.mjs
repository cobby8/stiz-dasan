// 공개 화면의 «사진 올리기»(/staff/quick-post) 링크는 미리 불러오지 않는다(2026-11-19 전 화면 속도 7회차)
//
// 왜: 로그인 안 한 방문자의 휴대폰 메뉴에도 이 링크가 있어, 홈이 뜬 뒤 Next 가 이 주소를 미리 불러왔다.
//     직원 화면이라 로그인 화면으로 돌려보내져 헛요청이 4번 났다(Lighthouse 홈 측정). 관리자 갤러리의 같은 링크는 이미 prefetch={false}.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("공개 머리줄·계정 버튼의 사진 올리기 링크는 모두 prefetch={false}", () => {
  for (const file of ["src/components/PublicHeader.tsx", "src/components/PublicAccountControls.tsx", "src/app/admin/gallery/GalleryAdminClient.tsx"]) {
    const src = readFileSync(file, "utf8");
    // <Link ... > 한 덩어리(여러 줄이어도)를 보고 판정한다 — 줄바꿈 정리로 prefetch 가 다른 줄로 가도 통과
    const all = (src.match(/<Link\b[^>]*>/g) ?? []).filter((tag) => tag.includes('href="/staff/quick-post"'));
    assert.ok(all.length > 0, file);
    for (const link of all) assert.match(link, /prefetch=\{false\}/, `${file}: ${link.slice(0, 60)}`);
  }
});
