"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { publishMediaItemsToInstagram } from "@/lib/instagram";
import { getAcademySettings } from "@/lib/queries";
import { isImageAttachment, stripHtmlForPreview } from "@/lib/noticeContent";

type CampaignMediaItem = {
  url: string;
  type: "image";
};

type NoticeRow = {
  id: string;
  title: string;
  content: string;
  attachmentsJSON: string | null;
};

type NoticeSocialPreview = {
  noticeId: string;
  title: string;
  landingUrl: string;
  mediaItems: CampaignMediaItem[];
  feedCaption: string;
  storyText: string;
  adPrimaryText: string;
  adHeadline: string;
  adDescription: string;
};

type PublishNoticeSocialInput = {
  feedCaption: string;
  storyText?: string;
  adPrimaryText?: string;
  adHeadline?: string;
  adDescription?: string;
  landingUrl?: string;
  publishInstagramFeed?: boolean;
  publishInstagramStory?: boolean;
};

let socialCampaignTableEnsured = false;

function publicSiteUrl() {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return base.replace(/\/$/, "");
}

function noticeUrl(noticeId: string) {
  const base = publicSiteUrl();
  return base ? `${base}/notices/${noticeId}` : `/notices/${noticeId}`;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// 2026-11-14 사진·인스타 점검: 예전에는 모든 공지에 «#방학특강»과 방학특강 문구가 박혀 나왔다
// (개학 안내·휴무 공지에도). 공지 내용과 무관한 말은 넣지 않고 학원 이름 해시태그만 둔다.
function hashtags() {
  return ["#스티즈농구교실", "#스티즈농구교실다산점"].join(" ");
}

function extractHtmlImageUrls(content: string) {
  const urls: string[] = [];
  const imageTagPattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;

  while ((match = imageTagPattern.exec(content)) !== null) {
    if (match[2]) urls.push(match[2]);
  }

  return urls;
}

function parseImageAttachments(attachmentsJSON: string | null) {
  if (!attachmentsJSON) return [];
  try {
    const parsed = JSON.parse(attachmentsJSON);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isImageAttachment)
      .map((item) => item.url)
      .filter((url): url is string => typeof url === "string" && url.length > 0);
  } catch {
    return [];
  }
}

function uniqueMediaItems(urls: string[]) {
  return Array.from(new Set(urls.filter(Boolean))).map((url) => ({
    url,
    type: "image" as const,
  }));
}

async function getNoticeForSocial(noticeId: string) {
  const rows = await prisma.$queryRawUnsafe<NoticeRow[]>(
    `SELECT id, title, content, "attachmentsJSON"
     FROM "Notice"
     WHERE id = $1
     LIMIT 1`,
    noticeId,
  );

  if (!rows[0]) {
    throw new Error("공지사항을 찾지 못했습니다.");
  }

  return rows[0];
}

async function ensureSocialCampaignPostTable() {
  if (socialCampaignTableEnsured) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SocialCampaignPost" (
      id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
      "sourceType" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      caption TEXT,
      "mediaJSON" TEXT NOT NULL DEFAULT '[]',
      "landingUrl" TEXT,
      "providerPostId" TEXT,
      "providerPermalink" TEXT,
      error TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "SocialCampaignPost_source_idx"
     ON "SocialCampaignPost" ("sourceType", "sourceId", "createdAt" DESC)`,
  );

  socialCampaignTableEnsured = true;
}

async function recordCampaignPost(data: {
  sourceId: string;
  channel: "INSTAGRAM_FEED" | "INSTAGRAM_STORY" | "FACEBOOK_AD_DRAFT";
  status: "PUBLISHED" | "FAILED" | "READY";
  title: string;
  caption: string;
  mediaJSON: string;
  landingUrl: string;
  providerPostId?: string | null;
  providerPermalink?: string | null;
  error?: string | null;
}) {
  await ensureSocialCampaignPostTable();

  await prisma.$executeRawUnsafe(
    `INSERT INTO "SocialCampaignPost" (
       id, "sourceType", "sourceId", channel, status, title, caption,
       "mediaJSON", "landingUrl", "providerPostId", "providerPermalink", error,
       "createdAt", "updatedAt"
     )
     VALUES (
       (gen_random_uuid())::text, 'NOTICE', $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, NOW(), NOW()
     )`,
    data.sourceId,
    data.channel,
    data.status,
    data.title,
    data.caption,
    data.mediaJSON,
    data.landingUrl,
    data.providerPostId || null,
    data.providerPermalink || null,
    data.error || null,
  );
}

function buildPreview(notice: NoticeRow): NoticeSocialPreview {
  const summary = cleanText(stripHtmlForPreview(notice.content));
  const trimmedSummary = summary.slice(0, 220);
  const landingUrl = noticeUrl(notice.id);
  const mediaItems = uniqueMediaItems([
    ...extractHtmlImageUrls(notice.content),
    ...parseImageAttachments(notice.attachmentsJSON),
  ]);

  return {
    noticeId: notice.id,
    title: notice.title,
    landingUrl,
    mediaItems,
    feedCaption:
      `${notice.title}\n\n${trimmedSummary}\n\n자세한 내용은 공지사항에서 확인해주세요.\n${landingUrl}\n\n${hashtags()}`,
    // 공지 제목·본문만으로 만든 중립 문구 — 어떤 공지에도 맞는다. 원장이 게시 전에 화면에서 고칠 수 있다.
    storyText: `${notice.title}\n자세한 내용은 프로필/공지사항에서 확인해주세요.`,
    adPrimaryText:
      `${notice.title}\n\n${trimmedSummary}\n\n자세한 내용은 공지사항에서 확인해주세요.`,
    adHeadline: notice.title.slice(0, 80),
    adDescription: "STIZ 농구교실 다산점 안내",
  };
}

export async function prepareNoticeSocialCampaign(noticeId: string) {
  await requireAdmin();
  const notice = await getNoticeForSocial(noticeId);
  return buildPreview(notice);
}

export async function publishNoticeSocialCampaign(noticeId: string, input: PublishNoticeSocialInput) {
  await requireAdmin();

  const notice = await getNoticeForSocial(noticeId);
  const preview = buildPreview(notice);
  const settings = (await getAcademySettings()) as any;
  const mediaJSON = JSON.stringify(preview.mediaItems);
  const landingUrl = input.landingUrl?.trim() || preview.landingUrl;
  const results: Array<{ channel: string; ok: boolean; message: string; permalink?: string | null }> = [];

  if (input.publishInstagramFeed) {
    const result = await publishMediaItemsToInstagram({
      businessAccountId: settings.instagramBusinessAccountId,
      caption: input.feedCaption,
      mediaItems: preview.mediaItems,
      placement: "FEED",
    });

    const ok = result.attempted && result.ok;
    await recordCampaignPost({
      sourceId: notice.id,
      channel: "INSTAGRAM_FEED",
      status: ok ? "PUBLISHED" : "FAILED",
      title: notice.title,
      caption: input.feedCaption,
      mediaJSON,
      landingUrl,
      providerPostId: ok ? result.instagramMediaId : null,
      providerPermalink: ok ? result.permalink : null,
      error: ok ? null : result.attempted ? result.error : result.skippedReason,
    });

    results.push({
      channel: "인스타 피드",
      ok,
      message: ok ? "게시 완료" : result.attempted ? result.error : result.skippedReason,
      permalink: ok ? result.permalink : null,
    });
  }

  if (input.publishInstagramStory) {
    const result = await publishMediaItemsToInstagram({
      businessAccountId: settings.instagramBusinessAccountId,
      caption: input.storyText,
      mediaItems: preview.mediaItems.slice(0, 1),
      placement: "STORY",
    });

    const ok = result.attempted && result.ok;
    await recordCampaignPost({
      sourceId: notice.id,
      channel: "INSTAGRAM_STORY",
      status: ok ? "PUBLISHED" : "FAILED",
      title: notice.title,
      caption: input.storyText || preview.storyText,
      mediaJSON,
      landingUrl,
      providerPostId: ok ? result.instagramMediaId : null,
      providerPermalink: ok ? result.permalink : null,
      error: ok ? null : result.attempted ? result.error : result.skippedReason,
    });

    results.push({
      channel: "인스타 스토리",
      ok,
      message: ok ? "게시 완료" : result.attempted ? result.error : result.skippedReason,
      permalink: ok ? result.permalink : null,
    });
  }

  await recordCampaignPost({
    sourceId: notice.id,
    channel: "FACEBOOK_AD_DRAFT",
    status: "READY",
    title: input.adHeadline || preview.adHeadline,
    caption: input.adPrimaryText || preview.adPrimaryText,
    mediaJSON,
    landingUrl,
  });

  revalidatePath("/admin/notices");
  return {
    ok: results.every((result) => result.ok),
    results,
    adDraft: {
      primaryText: input.adPrimaryText || preview.adPrimaryText,
      headline: input.adHeadline || preview.adHeadline,
      description: input.adDescription || preview.adDescription,
      landingUrl,
    },
  };
}
