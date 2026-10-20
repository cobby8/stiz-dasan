import { getNotices, getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import Badge from "@/components/ui/Badge";
import CTABanner from "@/components/landing/CTABanner";
import Link from "next/link";
import { isImageAttachment, stripHtmlForPreview } from "@/lib/noticeContent";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;
export const metadata = buildPublicMetadata({
    title: "공지사항 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점의 공지사항과 학원 소식을 확인하세요.",
    path: "/notices",
});

export default async function NoticesPage() {
    // DB에서 공지사항과 학원 설정을 병렬로 가져온다
    const [notices, settings] = await Promise.all([
        getNotices({ limit: 50 }),
        getAcademySettings() as Promise<{ contactPhone?: string | null }>,
    ]);

    // 공개 페이지에서는 전체 공지만 표시
    const publicNotices = notices.filter(n => n.targetType === "ALL");
    const phone = settings.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 + 장식 도형 (about/programs와 동일 패턴) */}
            <section className="public-page-intro">
        <div className="public-container">
          <h1>공지사항</h1>
          <p>학원 소식과 중요한 안내를 확인하세요.</p>
        </div>
      </section>

            {/* 공지사항 리스트 */}
            <div className="bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="public-container !max-w-4xl py-6 md:py-8">
                    {publicNotices.length === 0 ? (
                        <div className="public-card px-5 py-10 text-center text-gray-500">
                            <p className="text-lg font-medium">아직 공지사항이 없습니다</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {publicNotices.map((n, i) => {
                                // 첨부파일 JSON 파싱
                                let atts: { url: string; filename: string }[] = [];
                                try { atts = n.attachmentsJSON ? JSON.parse(n.attachmentsJSON) : []; } catch {}
                                // 목록 썸네일용 — 첫 이미지 첨부
                                const firstImage = atts.find(isImageAttachment);

                                return (
                                    <AnimateOnScroll key={n.id} delay={i * 50}>
                                        <Link
                                            href={`/notices/${n.id}`}
                                            className="block bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm hover:shadow-md hover:border-brand-orange-200 dark:hover:border-brand-orange-500 dark:border-brand-neon-lime transition-all duration-200 overflow-hidden"
                                        >
                                            <div className="flex items-start gap-3 p-4">
                                                {/* 좌측: 날짜 블록 — 월/일 강조 */}
                                                <div className="hidden sm:flex flex-col items-center justify-center w-16 h-16 rounded-xl bg-brand-navy-900/5 dark:bg-brand-neon-cobalt/10 shrink-0 transition-colors">
                                                    <span className="text-sm text-gray-400 font-medium">
                                                        {new Date(n.createdAt).toLocaleDateString("ko-KR", { month: "short" })}
                                                    </span>
                                                    <span className="text-xl font-black text-brand-navy-900 dark:text-brand-neon-lime transition-colors">
                                                        {new Date(n.createdAt).getDate()}
                                                    </span>
                                                </div>

                                                {/* 우측: 제목 + 내용 미리보기 + 뱃지 */}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                                        {/* 카테고리 뱃지 */}
                                                        {n.isPinned && (
                                                            <Badge variant="error" size="sm">
                                                                <FontFreeIcon name="push_pin" size={10} className="mr-1" />
                                                                중요
                                                            </Badge>
                                                        )}
                                                        {!n.isPinned && (
                                                            <Badge variant="info" size="sm">안내</Badge>
                                                        )}
                                                        {/* 제목 */}
                                                        <h2 className="font-bold text-gray-900 dark:text-white line-clamp-2 transition-colors">{n.title}</h2>
                                                    </div>

                                                    {/* 내용 미리보기 — 2줄 제한. HTML 공지는 태그를 제거해 순수 텍스트만 노출(raw 태그 노출 방지) */}
                                                    <p className="text-base text-gray-500 dark:text-gray-400 line-clamp-2 leading-relaxed transition-colors">{stripHtmlForPreview(n.content)}</p>

                                                    {/* 하단 메타 정보 */}
                                                    <div className="flex items-center gap-3 mt-2.5">
                                                        {/* 모바일에서만 날짜 표시 (데스크탑은 좌측 블록에 표시) */}
                                                        <span className="text-sm text-gray-400 sm:hidden">
                                                            {new Date(n.createdAt).toLocaleDateString("ko-KR")}
                                                        </span>
                                                        {/* 첨부파일 카운트 */}
                                                        {atts.length > 0 && (
                                                            <span className="text-sm text-gray-400 flex items-center gap-1">
                                                                <FontFreeIcon name="attach_file" size={12} /> {atts.length}개 첨부
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* 우측: 이미지 첨부 썸네일 (있을 때만) */}
                                                {firstImage && (
                                                    <div className="hidden sm:block shrink-0">
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img
                                                            src={firstImage.url}
                                                            alt=""
                                                            loading="lazy"
                                                            className="w-20 h-20 rounded-xl object-cover border border-gray-100 dark:border-gray-700"
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        </Link>
                                    </AnimateOnScroll>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* CTA 배너 */}
            <CTABanner
                title="궁금한 점이 있으신가요?"
                subtitle="언제든지 편하게 문의해 주세요"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
