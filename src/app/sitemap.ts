import { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "@/lib/publicMetadata";
// 방학특강 공개 시즌 주소(2026-11-18) — /seasonal 화면과 같은 공개 조회를 쓴다
import { listPublishedSeasons } from "@/lib/seasonal/service";

// 방학특강 시즌이 새로 공개되면 1시간 안에 sitemap 에 들어가게 한다(빌드 때 한 번만 만들고 멈추지 않게)
export const revalidate = 3600;

// sitemap.xml 자동 생성 - 검색엔진(구글/네이버)이 사이트 구조를 파악하는 데 사용
// Next.js가 빌드 시 이 함수를 실행하여 /sitemap.xml 경로로 제공함
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const baseUrl = PUBLIC_SITE_URL;

    // 공개 시즌 상세 주소 — 조회가 실패해도(빌드 중 DB 없음 등) 나머지 주소는 그대로 낸다
    let seasonEntries: MetadataRoute.Sitemap = [];
    try {
        const seasons = await listPublishedSeasons();
        seasonEntries = seasons
            .filter((season) => season.slug && season.status !== "ENDED")
            .map((season) => ({ url: `${baseUrl}/seasonal/${encodeURIComponent(season.slug)}`, lastModified: new Date(), changeFrequency: "weekly" as const, priority: 0.8 }));
    } catch (error) {
        console.error("[sitemap] seasonal seasons failed:", (error as Error)?.message);
    }

    return [
        // 메인 페이지 - 가장 높은 우선순위
        { url: baseUrl, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
        // 학원 소개
        { url: `${baseUrl}/about`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
        // 프로그램 안내
        { url: `${baseUrl}/programs`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
        // 시간표 - 자주 바뀔 수 있어 weekly
        { url: `${baseUrl}/schedule`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
        // 우리 아이 수업 찾기 (시뮬레이터)
        { url: `${baseUrl}/simulator`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
        // 연간 일정
        { url: `${baseUrl}/annual`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.6 },
        { url: `${baseUrl}/rental`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.5 },
        // 갤러리
        { url: `${baseUrl}/gallery`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.7 },
        // 공지사항
        { url: `${baseUrl}/notices`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.7 },
        // 수강 신청 - 전환 페이지라 높은 우선순위
        { url: `${baseUrl}/apply`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.9 },
        { url: `${baseUrl}/apply/trial`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.9 },
        { url: `${baseUrl}/faq`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
        // 방학특강 목록 + 공개 시즌 상세(끝난 시즌은 뺀다)
        { url: `${baseUrl}/seasonal`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
        ...seasonEntries,
    ];
}
