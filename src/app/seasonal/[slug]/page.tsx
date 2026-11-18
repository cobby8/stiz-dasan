import type { Metadata } from "next";
import PublicPageLayout from "@/components/PublicPageLayout";
import SeasonalDetailClient from "@/components/seasonal/SeasonalDetailClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { getPublishedSeason } from "@/lib/seasonal/service";
import { seasonDetailSeo } from "@/lib/seasonal/public-seo";

// 검색 제목·설명(아래 generateMetadata)이 시즌 자료를 읽으므로 5분 캐시한다 — 공개 /schedule 과 같은 주기.
// 화면 본문은 지금처럼 SeasonalDetailClient 가 따로 불러오므로 신청 가능 여부 표시는 이 캐시와 무관하다.
export const revalidate = 300;

/**
 * 시즌 상세 검색용 제목·설명(2026-11-18) — «남양주 다산 농구 방학특강» 지역어 + 수업 기간·대상.
 * 시즌을 못 찾으면(주소 오타·비공개) 기본 문구로 둔다(화면은 SeasonalDetailClient 가 안내).
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const season = await getPublishedSeason(slug).catch(() => null);
  const seo = seasonDetailSeo(season);
  const metadata = buildPublicMetadata({ ...seo, path: `/seasonal/${encodeURIComponent(slug)}` });
  // 없는 주소·비공개 시즌은 검색에 올리지 않는다
  return season ? metadata : { ...metadata, robots: { index: false, follow: true } };
}

export default async function SeasonalDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicPageLayout><SeasonalDetailClient slug={slug} /></PublicPageLayout>;
}
