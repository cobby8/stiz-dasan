import { getNoticeById, getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import Badge from "@/components/ui/Badge";
import CTABanner from "@/components/landing/CTABanner";
import Link from "next/link";
import { notFound } from "next/navigation";
import { toNoticeHtml, isImageAttachment, isHtmlContent } from "@/lib/noticeContent";
import { sanitizeHtml } from "@/lib/sanitize";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

export const revalidate = 60;

export default async function NoticeDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    // DB에서 공지사항 상세와 학원 설정을 병렬로 가져온다
    const [notice, settings] = await Promise.all([
        getNoticeById(id),
        getAcademySettings() as Promise<any>,
    ]);

    if (!notice) notFound();

    const phone = settings.contactPhone || "010-0000-0000";

    // 첨부파일 JSON 파싱
    let attachments: { url: string; filename: string; size: number }[] = [];
    try { attachments = notice.attachmentsJSON ? JSON.parse(notice.attachmentsJSON) : []; } catch {}
    // 이미지 첨부(본문 아래 인라인 노출)와 그 외 파일(다운로드 링크)로 분리
    const imageAtts = attachments.filter(isImageAttachment);
    const fileAtts = attachments.filter(a => !isImageAttachment(a));

    // 파일 크기 포맷 함수
    function formatSize(bytes: number) {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 + 장식 도형 + 공지 제목/날짜 */}
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 text-white py-16 md:py-20">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="max-w-4xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        {/* 목록으로 돌아가기 링크 */}
                        <Link
                            href="/notices"
                            className="inline-flex items-center gap-1.5 text-blue-200/70 hover:text-white text-sm mb-6 transition-colors"
                        >
                            <FontFreeIcon name="arrow_back" size={16} /> 목록으로 돌아가기
                        </Link>

                        {/* 고정 공지 뱃지 */}
                        {notice.isPinned && (
                            <div className="mb-3">
                                <Badge variant="error" size="md">
                                    <FontFreeIcon name="push_pin" size={12} className="mr-1" />
                                    중요 공지
                                </Badge>
                            </div>
                        )}

                        {/* 공지 제목 */}
                        <h1 className="text-3xl md:text-4xl font-black leading-tight mb-3 break-keep">{notice.title}</h1>

                        {/* 날짜 */}
                        <p className="text-blue-200/60 text-sm">
                            {new Date(notice.createdAt).toLocaleDateString("ko-KR", {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                            })}
                        </p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 공지 본문 + 첨부파일 */}
            <div className="bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="max-w-4xl mx-auto px-4 py-12 md:py-16">
                    <AnimateOnScroll>
                        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 transition-colors duration-300 shadow-sm p-6 md:p-10">
                            {/* 본문 — 새 공지(리치 에디터 HTML)와 옛 공지(순수 텍스트)를 판별해 각기 안전하게 렌더 */}
                            {isHtmlContent(notice.content) ? (
                                // 리치 에디터로 작성된 HTML 공지: XSS 제거(sanitizeHtml, jsdom 미사용) 후 .notice-content 서식 적용
                                // ⚠️ 반드시 sanitizeHtml을 거친다 — 원문을 그대로 넣으면 XSS 위험. sanitize.ts는 sanitize-html(순수 JS)이라 500 안전.
                                // .notice-content 는 line-height/font-size를 자체 지정하므로 글자색만 컨테이너에서 상속시킨다(라이트/다크 대응).
                                <div
                                    className="notice-content max-w-none text-gray-700 dark:text-gray-200 [overflow-wrap:anywhere]"
                                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(notice.content, { linkifyTextUrls: true }) }}
                                />
                            ) : (
                                // 옛 순수 텍스트 공지(하위호환): 줄바꿈 유지 + URL 자동 링크(toNoticeHtml이 이미 이스케이프해 안전, sanitize 미경유 → 500 위험 없음)
                                <div
                                    className="max-w-none whitespace-pre-wrap text-gray-700 dark:text-gray-200 leading-loose text-[15px] md:text-base [overflow-wrap:anywhere]"
                                    dangerouslySetInnerHTML={{ __html: toNoticeHtml(notice.content) }}
                                />
                            )}

                            {/* 이미지 첨부 — 본문 아래에 이미지로 크게 노출 (클릭 시 원본 열기) */}
                            {imageAtts.length > 0 && (
                                <div className="mt-8 space-y-4">
                                    {imageAtts.map((a, i) => (
                                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="block group">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={a.url}
                                                alt={a.filename || `공지 이미지 ${i + 1}`}
                                                loading="lazy"
                                                className="w-full rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm group-hover:shadow-md transition-shadow"
                                            />
                                        </a>
                                    ))}
                                </div>
                            )}

                            {/* 이미지 외 첨부파일 — 다운로드 링크 */}
                            {fileAtts.length > 0 && (
                                <div className="mt-10 pt-6 border-t border-gray-100 dark:border-gray-800">
                                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-4 flex items-center gap-2">
                                        <FontFreeIcon name="attach_file" size={16} className="text-gray-400" />
                                        첨부파일 ({fileAtts.length}개)
                                    </h3>
                                    <div className="space-y-2">
                                        {fileAtts.map((a, i) => (
                                            <a
                                                key={i}
                                                href={a.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center justify-between bg-gray-50 hover:bg-brand-orange-50 dark:bg-gray-900 dark:hover:bg-gray-800 rounded-xl px-4 py-3.5 transition-colors group"
                                            >
                                                <span className="text-sm text-gray-700 dark:text-gray-200 truncate group-hover:text-brand-orange-600 dark:group-hover:text-brand-neon-lime transition-colors">
                                                    {a.filename}
                                                </span>
                                                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                                                    <span className="text-xs text-gray-400">{formatSize(a.size)}</span>
                                                    <FontFreeIcon name="download" size={16} className="text-gray-400 group-hover:text-brand-orange-500 dark:group-hover:text-brand-neon-lime transition-colors" />
                                                </div>
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </AnimateOnScroll>

                    {/* 목록으로 돌아가기 버튼 — 본문 하단 */}
                    <div className="mt-8 text-center">
                        <Link
                            href="/notices"
                            className="inline-flex items-center gap-2 text-gray-500 dark:text-gray-400 hover:text-brand-navy-900 text-sm font-medium transition-colors"
                        >
                            <FontFreeIcon name="arrow_back" size={16} /> 목록으로 돌아가기
                        </Link>
                    </div>
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
