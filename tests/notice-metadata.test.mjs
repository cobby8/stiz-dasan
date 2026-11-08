// 공지 상세 SEO — 공지마다 자기 제목·요약·canonical 을 다는지 «실제로 실행해서» 확인한다.
// 계기: 상세 페이지가 홈 제목·홈 canonical 을 물려받아 검색에서 모든 공지가 중복 처리됐다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const { buildNoticeMetadata, noticeDescription, NOTICE_DESCRIPTION_MAX } = await loadTsModule("src/lib/noticeMetadata.ts");

test("공지마다 자기 제목·canonical·openGraph(article)를 단다", () => {
  const meta = buildNoticeMetadata({ id: "abc 1", title: "  11월 휴무 안내 ", content: "<p>11월 <b>휴무</b> 안내입니다.</p>" });
  assert.equal(meta.title, "11월 휴무 안내 | STIZ 농구교실 다산2호점");
  // 홈(/)이 아니라 이 공지 주소 — id 는 주소에 안전하게 인코딩
  assert.equal(meta.alternates.canonical, "https://www.stiz-dasan.kr/notices/abc%201");
  assert.equal(meta.openGraph.url, "https://www.stiz-dasan.kr/notices/abc%201");
  assert.equal(meta.openGraph.type, "article");
  assert.equal(meta.openGraph.title, meta.title);
  assert.equal(meta.description, "11월 휴무 안내입니다.");
});

test("설명은 태그·엔티티를 빼고 앞부분만 자른다", () => {
  assert.equal(noticeDescription("<p>가&amp;나</p><p>다</p>"), "가&나 다");
  // 옛 순수 텍스트 공지의 부등호는 지우지 않는다
  assert.equal(noticeDescription("3 < 5\n줄바꿈"), "3 < 5 줄바꿈");
  const long = noticeDescription(`<p>${"가".repeat(300)}</p>`);
  assert.equal(long.length, NOTICE_DESCRIPTION_MAX);
  assert.ok(long.endsWith("…"));
  // 본문이 비면 기본 설명
  assert.ok(noticeDescription("<p></p>").includes("공지사항"));
});

test("공지가 없으면 검색 제외(noindex)", () => {
  const meta = buildNoticeMetadata(null);
  assert.equal(meta.robots.index, false);
  assert.equal(meta.alternates, undefined);
});

test("script·style 안의 글자는 설명에 남지 않는다", () => {
  const d = noticeDescription("<style>.a{color:red}</style><p>안내</p><script>alert(1)</script>");
  assert.equal(d, "안내");
});

test("반 대상 공지는 검색 제외, 전체 공지는 검색 허용", () => {
  assert.equal(buildNoticeMetadata({ id: "a", title: "t", content: "c", targetType: "CLASS" }).robots.index, false);
  assert.equal(buildNoticeMetadata({ id: "a", title: "t", content: "c", targetType: "ALL" }).robots?.index === false, false);
});
