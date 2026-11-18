// 2026-11-17 안 쓰는 기능 정리 — 공지 «소셜 발행»이 «페이스북 광고 소재» 기록(FACEBOOK_AD_DRAFT)을 더 남기지 않는다.
// 서버 액션을 가짜 DB·가짜 인스타로 «실제로 돌려» 확인한다:
// ① 발행해도 FACEBOOK_AD_DRAFT 행을 넣지 않는다 ② 인스타 피드·스토리 기록은 예전과 같은 SQL·같은 인자로 나간다
// ③ 둘 다 고르지 않으면 아무것도 올리지 않고 기록도 없다(화면 안내 문구와 맞는다) ④ 화면이 광고 필드를 보내지 않는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

const SITE = "https://stiz.example";
const NOTICE = {
  id: "notice-1",
  title: "11월 휴무 안내",
  content: '<p>11월 20일은 휴무입니다.</p><img src="https://img.example/a.jpg"><img src="https://img.example/b.jpg">',
  attachmentsJSON: null,
};
const MEDIA = [
  { url: "https://img.example/a.jpg", type: "image" },
  { url: "https://img.example/b.jpg", type: "image" },
];
const squash = (sql) => sql.replace(/\s+/g, " ").trim();

// 예전(광고 소재 기록을 빼기 전)과 글자까지 같은 INSERT — 표·컬럼·인자 순서를 바꾸지 않았다는 기준
const INSERT_SQL = squash(`INSERT INTO "SocialCampaignPost" (
       id, "sourceType", "sourceId", channel, status, title, caption,
       "mediaJSON", "landingUrl", "providerPostId", "providerPermalink", error,
       "createdAt", "updatedAt"
     )
     VALUES (
       (gen_random_uuid())::text, 'NOTICE', $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, NOW(), NOW()
     )`);

// 서버 액션을 대역과 함께 새로 올린다(모듈 안의 «표 만들기 한 번만» 깃발이 테스트끼리 섞이지 않게 매번 새로)
function setup({ instagram } = {}) {
  const state = { executes: [], instagramCalls: [], revalidated: [], adminChecks: 0 };
  const prisma = {
    $queryRawUnsafe: async (sql, ...args) => {
      assert.match(sql, /FROM "Notice"/);
      assert.deepEqual(args, [NOTICE.id]);
      return [NOTICE];
    },
    $executeRawUnsafe: async (sql, ...args) => {
      state.executes.push({ sql: squash(sql), args });
      return 1;
    },
  };
  const actions = load("src/app/actions/social-campaigns.ts", {
    "next/cache": { revalidatePath: (path) => state.revalidated.push(path) },
    "@/lib/prisma": { prisma },
    "@/lib/auth-guard": { requireAdmin: async () => { state.adminChecks += 1; return { appUserRole: "ADMIN" }; } },
    "@/lib/instagram": {
      publishMediaItemsToInstagram: async (input) => {
        state.instagramCalls.push(input);
        return instagram
          ? instagram(input)
          : { attempted: true, ok: true, instagramMediaId: `ig-${input.placement}`, permalink: `https://insta.example/${input.placement}` };
      },
    },
    "@/lib/queries": { getAcademySettings: async () => ({ instagramBusinessAccountId: "biz-1" }) },
    "@/lib/noticeContent": load("src/lib/noticeContent.ts"),
  });
  // 기록 INSERT 만 골라 본다(표·색인 만들기 문장은 뺀다)
  state.inserts = () => state.executes.filter((call) => call.sql.startsWith("INSERT INTO"));
  return { actions, state };
}

function withSiteUrl(run) {
  return async () => {
    const before = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    try {
      await run();
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = before;
    }
  };
}

test("공지 소셜 발행: 피드·스토리 기록 2줄만 남고 FACEBOOK_AD_DRAFT 는 넣지 않는다", withSiteUrl(async () => {
  const { actions, state } = setup();
  const result = await actions.publishNoticeSocialCampaign(NOTICE.id, {
    feedCaption: "원장이 고친 피드 문구",
    storyText: "원장이 고친 스토리 문구",
    publishInstagramFeed: true,
    publishInstagramStory: true,
  });

  const inserts = state.inserts();
  assert.equal(inserts.length, 2, "기록은 피드·스토리 두 줄뿐이어야 한다");
  for (const call of state.executes) {
    assert.ok(!call.args.includes("FACEBOOK_AD_DRAFT"), "광고 소재 기록을 넣으면 안 된다");
    assert.ok(!call.args.includes("READY"), "«준비» 상태 기록을 넣으면 안 된다");
    assert.doesNotMatch(call.sql, /FACEBOOK_AD_DRAFT/);
  }

  // 예전과 같은 SQL·같은 인자(순서: 공지 id · 채널 · 상태 · 제목 · 문구 · 사진 · 공지 주소 · 인스타 id · 인스타 주소 · 오류)
  const mediaJSON = JSON.stringify(MEDIA);
  const landingUrl = `${SITE}/notices/${NOTICE.id}`;
  assert.equal(inserts[0].sql, INSERT_SQL);
  assert.deepEqual(inserts[0].args, [
    NOTICE.id, "INSTAGRAM_FEED", "PUBLISHED", NOTICE.title, "원장이 고친 피드 문구",
    mediaJSON, landingUrl, "ig-FEED", "https://insta.example/FEED", null,
  ]);
  assert.equal(inserts[1].sql, INSERT_SQL);
  assert.deepEqual(inserts[1].args, [
    NOTICE.id, "INSTAGRAM_STORY", "PUBLISHED", NOTICE.title, "원장이 고친 스토리 문구",
    mediaJSON, landingUrl, "ig-STORY", "https://insta.example/STORY", null,
  ]);

  // 인스타로 나가는 값도 그대로 — 피드는 사진 전부, 스토리는 첫 장만
  assert.deepEqual(state.instagramCalls, [
    { businessAccountId: "biz-1", caption: "원장이 고친 피드 문구", mediaItems: MEDIA, placement: "FEED" },
    { businessAccountId: "biz-1", caption: "원장이 고친 스토리 문구", mediaItems: MEDIA.slice(0, 1), placement: "STORY" },
  ]);

  // 화면으로 돌아가는 결과: 채널별 성공·실패만(광고 소재 묶음 없음)
  assert.deepEqual(result, {
    ok: true,
    results: [
      { channel: "인스타 피드", ok: true, message: "게시 완료", permalink: "https://insta.example/FEED" },
      { channel: "인스타 스토리", ok: true, message: "게시 완료", permalink: "https://insta.example/STORY" },
    ],
  });
  assert.equal(state.adminChecks, 1, "관리자 확인은 그대로 거친다");
  assert.deepEqual(state.revalidated, ["/admin/notices"]);
}));

test("공지 소셜 발행: 인스타가 실패·건너뛰면 실패 기록 1줄 + 화면에 사유, 광고 소재 기록은 여전히 없다", withSiteUrl(async () => {
  const { actions, state } = setup({
    instagram: (input) => input.placement === "FEED"
      ? { attempted: true, ok: false, error: "게시 한도를 넘었습니다." }
      : { attempted: false, skippedReason: "인스타그램 연결이 없습니다." },
  });
  const result = await actions.publishNoticeSocialCampaign(NOTICE.id, {
    feedCaption: "피드",
    publishInstagramFeed: true,
    publishInstagramStory: true,
  });

  const inserts = state.inserts();
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((call) => call.args.slice(1, 3)), [
    ["INSTAGRAM_FEED", "FAILED"],
    ["INSTAGRAM_STORY", "FAILED"],
  ]);
  // 실패 기록: 인스타 id·주소는 비우고 사유를 남긴다
  assert.deepEqual(inserts[0].args.slice(7), [null, null, "게시 한도를 넘었습니다."]);
  assert.deepEqual(inserts[1].args.slice(7), [null, null, "인스타그램 연결이 없습니다."]);
  // 스토리 문구를 비워 보내면 기록에는 기본 스토리 문구가 들어간다(예전과 같다)
  assert.equal(inserts[1].args[4], `${NOTICE.title}\n자세한 내용은 프로필/공지사항에서 확인해주세요.`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((row) => [row.channel, row.ok, row.message]), [
    ["인스타 피드", false, "게시 한도를 넘었습니다."],
    ["인스타 스토리", false, "인스타그램 연결이 없습니다."],
  ]);
}));

test("공지 소셜 발행: 하나만 고르면 그 채널 기록 1줄만", withSiteUrl(async () => {
  const { actions, state } = setup();
  const result = await actions.publishNoticeSocialCampaign(NOTICE.id, {
    feedCaption: "피드",
    storyText: "스토리",
    publishInstagramFeed: false,
    publishInstagramStory: true,
  });
  assert.deepEqual(state.inserts().map((call) => call.args[1]), ["INSTAGRAM_STORY"]);
  assert.deepEqual(result.results.map((row) => row.channel), ["인스타 스토리"]);
}));

test("공지 소셜 발행: 둘 다 고르지 않으면 인스타에 올리지 않고 DB 에도 아무것도 쓰지 않는다 — 화면 안내와 맞는다", withSiteUrl(async () => {
  const { actions, state } = setup();
  const result = await actions.publishNoticeSocialCampaign(NOTICE.id, {
    feedCaption: "피드",
    storyText: "스토리",
    publishInstagramFeed: false,
    publishInstagramStory: false,
  });
  assert.deepEqual(state.instagramCalls, []);
  assert.deepEqual(state.executes, [], "기록은 물론 표 만들기 문장도 나가지 않는다");
  assert.deepEqual(result, { ok: true, results: [] });

  // 화면은 빈 결과를 «올리지 않았다»로 보인다
  const modal = read("src/app/admin/notices/NoticeSocialModal.tsx");
  assert.match(modal, /socialResult\.results\.length === 0 \? \(\s*<p[^>]*>발행할 항목을 고르지 않아 인스타에 올리지 않았습니다\.<\/p>/);
}));

test("공지 소셜 미리보기: 인스타 문구·사진은 그대로, 광고 문구는 만들지 않는다", withSiteUrl(async () => {
  const { actions } = setup();
  const preview = await actions.prepareNoticeSocialCampaign(NOTICE.id);
  const landingUrl = `${SITE}/notices/${NOTICE.id}`;
  assert.deepEqual(preview, {
    noticeId: NOTICE.id,
    title: NOTICE.title,
    landingUrl,
    mediaItems: MEDIA,
    feedCaption: `${NOTICE.title}\n\n11월 20일은 휴무입니다.\n\n자세한 내용은 공지사항에서 확인해주세요.\n${landingUrl}\n\n#스티즈농구교실 #스티즈농구교실다산점`,
    storyText: `${NOTICE.title}\n자세한 내용은 프로필/공지사항에서 확인해주세요.`,
  });
}));

test("화면·서버 소스: 광고 필드를 보내지도 받지도 않고, 다른 소셜 길은 이 표를 쓰지 않는다", () => {
  const modal = read("src/app/admin/notices/NoticeSocialModal.tsx");
  assert.doesNotMatch(modal, /adPrimaryText|adHeadline|adDescription|landingUrl|adDraft/);
  // 발행 요청에 담는 값은 인스타 문구 2개와 고른 항목 2개뿐
  assert.match(modal, /publishNoticeSocialCampaign\(socialPreview\.noticeId, \{\s*feedCaption: socialPreview\.feedCaption,\s*storyText: socialPreview\.storyText,\s*publishInstagramFeed: socialPreview\.mediaItems\.length > 0 && publishFeed,\s*publishInstagramStory: socialPreview\.mediaItems\.length > 0 && publishStory,\s*\}\);/);

  const server = read("src/app/actions/social-campaigns.ts").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(server, /FACEBOOK_AD_DRAFT|"READY"|adDraft|adPrimaryText|adHeadline|adDescription/);
  // 표·컬럼은 그대로 둔다(쌓인 기록을 지우지 않는다)
  assert.match(server, /CREATE TABLE IF NOT EXISTS "SocialCampaignPost"/);
  assert.doesNotMatch(server, /DELETE FROM|DROP |TRUNCATE/i);
  // 갤러리·수업 사진 게시 길은 이 표와 무관하다
  assert.doesNotMatch(read("src/app/actions/social-posts.ts"), /SocialCampaignPost|FACEBOOK_AD_DRAFT/);
});
