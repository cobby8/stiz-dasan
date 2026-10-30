import { getNotices, getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import CTABanner from "@/components/landing/CTABanner";
import Link from "next/link";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { formatKstDate, toKstYmd } from "@/lib/datetime/kst";

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
        getAcademySettings() as Promise<any>,
    ]);

    // 공개 페이지에서는 전체 공지만 표시
    const publicNotices = notices.filter(n => n.targetType === "ALL");
    const phone = settings.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 + 장식 도형 (about/programs와 동일 패턴) */}
            <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">공지사항</h1>
                        <p className="text-blue-200 text-lg max-w-xl">학원 소식과 안내사항을 확인하세요</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 공지사항 리스트 — 게슈탈트 P-09: 홈 공지와 같은 한 줄 행(약 52px: [중요] 제목 … 날짜).
                본문 미리보기·썸네일은 빼고 상세 화면에서 본다. 날짜는 KST 공용 모듈로만 만든다. */}
            <div className="bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="public-content-section max-w-4xl mx-auto px-4 py-16 md:py-24">
                    {publicNotices.length === 0 ? (
                        /* 게슈탈트 P-12 빈 상태: 한 줄 문구 + 전화 링크 */
                        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                            <span className="font-bold">아직 공지사항이 없습니다.</span>{" "}
                            <a href={`tel:${phone.replace(/-/g, "")}`} className="inline-flex min-h-11 items-center font-bold text-[var(--color-public-accent)] underline underline-offset-2">문의 {phone}</a>
                        </p>
                    ) : (
                        <ul className="public-notice-list divide-y divide-[var(--color-public-line)] overflow-hidden rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)]">
                            {publicNotices.map((n) => {
                                // 첨부파일 개수만 작게 표시(내용은 상세에서)
                                let atts: { url: string; filename: string }[] = [];
                                try { atts = n.attachmentsJSON ? JSON.parse(n.attachmentsJSON) : []; } catch {}

                                return (
                                    <li key={n.id}>
                                        <Link
                                            href={`/notices/${n.id}`}
                                            className="flex min-h-[52px] items-center gap-2 px-4 py-2 text-sm text-[var(--color-public-ink)] transition-colors hover:bg-[var(--color-public-tint)]"
                                        >
                                            {/* 고정 공지만 «중요» 표시(일반 공지는 표시 없음 — 표시가 많으면 오히려 안 보인다) */}
                                            {n.isPinned && <span className="shrink-0 text-xs font-bold text-[var(--color-public-accent)]">중요</span>}
                                            <h2 className="min-w-0 flex-1 font-bold [overflow-wrap:anywhere]">{n.title}</h2>
                                            {atts.length > 0 && (
                                                <span className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--color-public-muted)]" aria-label={`첨부 ${atts.length}개`}>
                                                    <FontFreeIcon name="attach_file" size={12} />{atts.length}
                                                </span>
                                            )}
                                            <time dateTime={toKstYmd(n.createdAt) || undefined} className="shrink-0 whitespace-nowrap text-xs text-[var(--color-public-muted)]">
                                                {formatKstDate(n.createdAt, { year: "numeric", month: "short", day: "numeric" })}
                                            </time>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>

            {/* CTA 배너 */}
            <CTABanner variant="outline"
                title="궁금한 점이 있으신가요?"
                subtitle="언제든지 편하게 문의해 주세요"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
