import { prisma } from "@/lib/prisma";

// 인스타그램 → 갤러리 자동 가져오기 함수와 그 cron(/api/cron/instagram-gallery)은
// 들어오는 길이 없어 2026-11-18 지웠다. 남은 것은 게시 기능(socialPostPublishing.ts)이 쓰는 컬럼 보장 함수뿐이다.

let galleryInstagramColumnsEnsured = false;

export async function ensureGalleryPostInstagramColumns() {
  if (galleryInstagramColumnsEnsured) return;

  const columns: [string, string][] = [
    ["source", "TEXT DEFAULT 'WEBSITE'"],
    ["externalId", "TEXT"],
    ["externalUrl", "TEXT"],
    ["instagramMediaId", "TEXT"],
    ["instagramPermalink", "TEXT"],
    ["instagramPublishedAt", "TIMESTAMPTZ"],
    ["instagramPublishError", "TEXT"],
  ];

  for (const [col, type] of columns) {
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "GalleryPost" ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
      );
    } catch (error) {
      console.warn(`[instagram/gallery-sync] ensure column "${col}" failed:`, (error as Error).message);
    }
  }

  galleryInstagramColumnsEnsured = true;
}
