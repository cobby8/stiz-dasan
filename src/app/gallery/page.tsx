import { getGalleryPosts, getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
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
        getAcademySettings() as Promise<any>,
    ]);

    const phone = settings.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — about/programs/apply와 동일한 그라데이션 + 장식 도형 패턴 */}
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                {/* 배경 장식 도형들 */}
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">GALLERY</p>
                        <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">포토갤러리</h1>
                        <p className="text-blue-200 text-lg max-w-xl">수업 현장의 생생한 모습을 확인하세요</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 갤러리 그리드 — Client Component에서 호버 오버레이 + 라이트박스 처리 */}
            <div className="bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-4 py-16 md:py-24">
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
