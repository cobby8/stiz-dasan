import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as kst from "../src/lib/datetime/kst.ts";
import * as galleryMedia from "../src/lib/galleryMedia.ts";

const require = createRequire(import.meta.url);
const stamp = "2026-10-21T15:30:00Z";
const notice = { id: "fixture", title: "합성 공지", content: "공개 내용", targetType: "ALL", isPinned: false, createdAt: stamp, attachmentsJSON: null };
const passthrough = ({ children }) => React.createElement("div", null, children);

function loadPage(file, overrides = {}) {
  const code = ts.transpileModule(readFileSync(`src/${file}`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "@/lib/datetime/kst") return kst;
    if (id === "@/lib/galleryMedia") return galleryMedia;
    if (id === "next/link") return { default: ({ children, ...props }) => React.createElement("a", props, children) };
    if (id === "next/navigation") return { notFound: () => { throw new Error("not found"); } };
    if (id === "@/lib/sanitize") return { sanitizeHtml: (value) => value };
    if (id === "@/lib/publicMetadata") return { buildPublicMetadata: (value) => value };
    if (id === "@/lib/noticeContent") return { stripHtmlForPreview: (value) => value, toNoticeHtml: (value) => value, isHtmlContent: () => false, isImageAttachment: () => false };
    if (id === "@/lib/queries") return { getNotices: async () => [notice], getNoticeById: async () => notice, getAcademySettings: async () => ({ contactPhone: "" }) };
    if (id.startsWith("@/components/") || id === "./GalleryLightboxController") return { default: passthrough };
    if (id.endsWith(".css")) return {};
    return require(id);
  }, exports);
  return exports.default;
}

test("공개 게시일은 한국 자정 경계를 따라 표시하고 날짜 원문은 그대로 노출하지 않는다", () => {
  assert.equal(kst.formatKstDate(stamp, { year: "numeric", month: "long", day: "numeric" }), "2026년 10월 22일");
  assert.equal(kst.formatKstDate("2026-10-22", { year: "numeric", month: "long", day: "numeric" }), "2026년 10월 22일");
  assert.equal(kst.formatKstDate("2026-10-22T00:30:00", { day: "numeric" }), "22일");
  for (const value of [null, undefined, "", "BAD_DATE", "2026-02-30", "2026-02-30T12:00:00Z", new Date(NaN)]) {
    assert.equal(kst.formatKstDate(value), "날짜 확인 중");
  }
});

test("수강신청 월은 한국의 월·연도 경계에서 현재·다음 월을 표시한다", () => {
  assert.deepEqual(kst.kstMonthLabels(Date.parse("2026-09-30T15:00:00Z")), ["2026년 10월", "2026년 11월"]);
  assert.deepEqual(kst.kstMonthLabels(Date.parse("2026-12-31T15:00:00Z")), ["2027년 1월", "2027년 2월"]);
});

test("UTC 서버와 해외 기기도 한국 게시일과 수강신청 월이 동일하다", () => {
  const script = `import {formatKstDate,kstMonthLabels} from './src/lib/datetime/kst.ts';console.log(JSON.stringify({date:formatKstDate('${stamp}',{year:'numeric',month:'long',day:'numeric'}),months:kstMonthLabels(Date.parse('2026-12-31T15:00:00Z'))}));`;
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Seoul"]) {
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: zone }, stdio: ["ignore", "pipe", "ignore"] });
    assert.deepEqual(JSON.parse(result), { date: "2026년 10월 22일", months: ["2027년 1월", "2027년 2월"] });
  }
});

test("실제 홈 공지는 연도를 포함한 한국 게시일을 표시하고 손상된 날짜에도 열릴 수 있다", () => {
  const Home = loadPage("app/LandingPageClient.tsx");
  const html = renderToStaticMarkup(React.createElement(Home, { initialSettings: {}, notices: [notice] }));
  assert.match(html, /2026년 10월 22일/);
  assert.match(html, /dateTime="2026-10-22"/);
  const invalid = renderToStaticMarkup(React.createElement(Home, { initialSettings: {}, notices: [{ ...notice, createdAt: "BAD_DATE" }] }));
  assert.match(invalid, /날짜 확인 중/);
  assert.doesNotMatch(invalid, /BAD_DATE|Invalid Date/);
});

test("공지 목록의 월/일과 모바일 날짜·상세 게시일이 같은 한국 날짜다", async () => {
  const List = loadPage("app/notices/page.tsx");
  const Detail = loadPage("app/notices/[id]/page.tsx");
  const list = renderToStaticMarkup(await List());
  const detail = renderToStaticMarkup(await Detail({ params: Promise.resolve({ id: notice.id }) }));
  assert.match(list, />10월</);
  assert.match(list, />22</);
  assert.match(list, /class="text-\[10px\] leading-3 text-gray-400">2026년</);
  assert.match(list, /2026\. 10\. 22\./);
  assert.match(detail, /2026년 10월 22일/);
  assert.match(detail, /공지 내용은 게시 당시 기준입니다\./);
  assert.match(detail, /href="\/schedule"/);
  assert.match(detail, /href="\/seasonal"/);
  assert.match(detail, /공개 내용/);
});

test("과거 공지는 원문을 보존하고 현재 모집 링크와 구분하며 제목으로 마감을 추정하지 않는다", async () => {
  const prior = { ...notice, title: "2025 여름방학 특강 안내", createdAt: "2025-06-30T15:30:00Z", content: '<a href="https://forms.gle/fixture-only">게시 당시 접수 안내</a>' };
  const Detail = loadPage("app/notices/[id]/page.tsx", {
    "@/lib/queries": { getNoticeById: async () => prior, getAcademySettings: async () => ({}) },
  });
  const html = renderToStaticMarkup(await Detail({ params: Promise.resolve({ id: prior.id }) }));
  assert.match(html, /2025년 7월 1일/);
  assert.match(html, /https:\/\/forms\.gle\/fixture-only/);
  assert.match(html, /방학특강 모집 확인/);
  assert.doesNotMatch(html, /모집 마감|운영 종료/);
});

test("실제 수강신청 월 선택도 한국 현재·다음 월을 표시한다", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-12-31T15:00:00Z"));
  const Enroll = loadPage("app/apply/enroll/EnrollApplicationLaterSteps.tsx");
  const html = renderToStaticMarkup(React.createElement(Enroll, {
    step: 3,
    form: { preferredSlotKeys: [], enrollmentMonths: [], shuttleNeeded: false, shuttleChoice: "미탑승" },
    availableSlots: [], update() {}, toggleSlot() {},
  }));
  assert.match(html, /2027년 1월/);
  assert.match(html, /2027년 2월/);
  assert.doesNotMatch(html, /2026년 12월/);
});

test("갤러리 목록·확대창도 같은 한국 날짜를 쓰고 잘못된 게시일로 사진 전체가 멈추지 않는다", () => {
  const Gallery = loadPage("app/gallery/GalleryPublicClient.tsx");
  const Overlay = loadPage("app/gallery/GalleryLightboxOverlay.tsx");
  const post = { id: "photo", title: "합성 사진", caption: null, className: null, createdAt: stamp, mediaJSON: JSON.stringify([{ url: "/images/fixture.jpg", type: "image" }]) };
  const gallery = renderToStaticMarkup(React.createElement(Gallery, { posts: [post] }));
  assert.match(gallery, /2026\. 10\. 22\./);
  const invalid = renderToStaticMarkup(React.createElement(Gallery, { posts: [{ ...post, createdAt: "BAD_DATE" }] }));
  assert.match(invalid, /날짜 확인 중/);
  const overlay = renderToStaticMarkup(React.createElement(Overlay, { items: [{ url: "/images/fixture.jpg", type: "image", title: "합성 사진", createdAt: stamp }], activeIndex: 0, onClose() {}, onNavigate() {} }));
  assert.match(overlay, /2026년 10월 22일/);
});
