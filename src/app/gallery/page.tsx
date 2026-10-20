import { getGalleryPosts, getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import CTABanner from "@/components/landing/CTABanner";
import GalleryPublicClient from "./GalleryPublicClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;
export const metadata = buildPublicMetadata({
    title: "포토갤러리 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점의 수업 사진과 활동 영상을 확인하세요.",
    path: "/gallery",
});

export default async function GalleryPage() {
    // DB에서 갤러리 게시물과 학원 설정을 병렬로 가져온다
    const [posts, settings] = await Promise.all([
        getGalleryPosts({ limit: 36, publicOnly: true }),
        getAcademySettings() as Promise<{ contactPhone?: string | null }>,
    ]);

    const phone = settings.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — about/programs/apply와 동일한 그라데이션 + 장식 도형 패턴 */}
            <section className="public-page-intro">
        <div className="public-container">
          <h1>수업 갤러리</h1>
          <p>아이들이 함께 뛰고 성장하는 수업 현장입니다.</p>
        </div>
      </section>

            {/* 갤러리 그리드 — Client Component에서 호버 오버레이 + 라이트박스 처리 */}
            <div className="bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="public-container py-6 md:py-8">
                    <GalleryPublicClient posts={posts} />
                </div>
            </div>

            {/* CTA 배너 — 공통 컴포넌트 재사용 */}
            <CTABanner
                title="우리 아이의 성장을 사진으로 확인하세요"
                subtitle="체험 수업에 참여하시면 활동 사진을 보내드립니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
