import { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "@/lib/publicMetadata";

// sitemap.xml 자동 생성 - 검색엔진(구글/네이버)이 사이트 구조를 파악하는 데 사용
// Next.js가 빌드 시 이 함수를 실행하여 /sitemap.xml 경로로 제공함
export default function sitemap(): MetadataRoute.Sitemap {
    const baseUrl = PUBLIC_SITE_URL;

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
        // 갤러리
        { url: `${baseUrl}/gallery`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.7 },
        // 공지사항
        { url: `${baseUrl}/notices`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.7 },
        // 수강 신청 - 전환 페이지라 높은 우선순위
        { url: `${baseUrl}/apply`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.9 },
        { url: `${baseUrl}/apply/trial`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.9 },
        { url: `${baseUrl}/faq`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    ];
}
