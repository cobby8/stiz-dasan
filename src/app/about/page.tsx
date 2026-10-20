import Image from "next/image";
import { getAcademySettings, getCoaches } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import CTABanner from "@/components/landing/CTABanner";
import CoachBioToggle from "./CoachBioToggle";
import { sanitizeHtml } from "@/lib/sanitize";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;
export const metadata = buildPublicMetadata({
    title: "학원/멤버소개 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점의 원장 인사말, 전문 코치진, 시설을 소개합니다.",
    path: "/about",
});

// HTML 텍스트를 안전하게 렌더링하기 위한 유틸 함수 — sanitizeHtml로 XSS 방지
function renderHtml(text: string | null | undefined, fallback: string) {
    if (!text) return sanitizeHtml(fallback);
    if (text.includes("<")) return sanitizeHtml(text);
    return sanitizeHtml(text.replace(/\n/g, "<br>"));
}

// 교육 이념 아이콘 카드 데이터 — 학원의 핵심 가치 4가지
const PHILOSOPHY_CARDS = [
    {
        icon: "🎯",
        title: "전문성",
        description: "체계적인 커리큘럼과 전문 코치진이 아이의 실력을 단계별로 끌어올립니다",
        color: "bg-blue-50 text-blue-600",
    },
    {
        icon: "🛡️",
        title: "안전",
        description: "안전한 시설과 체계적인 관리로 아이들이 마음껏 뛰어놀 수 있는 환경을 제공합니다",
        color: "bg-emerald-50 text-emerald-600",
    },
    {
        icon: "😊",
        title: "즐거움",
        description: "농구를 통해 성취감과 즐거움을 경험하며 운동에 대한 긍정적 태도를 형성합니다",
        color: "bg-amber-50 text-amber-600",
    },
    {
        icon: "🌱",
        title: "성장",
        description: "체력뿐 아니라 협동심, 리더십, 인성까지 함께 성장하는 교육을 추구합니다",
        color: "bg-purple-50 text-purple-600",
    },
];

// 핵심 약속 3가지 — 학원 소개 섹션 하단에 표시
const PROMISES = [
    { icon: "🏆", title: "최고의 코치진", text: "자격증 보유 전문 코치" },
    { icon: "📋", title: "체계적 커리큘럼", text: "수준별 맞춤 교육" },
    { icon: "💬", title: "소통하는 교육", text: "학부모 피드백 시스템" },
];

export default async function AboutPage() {
    // DB에서 학원 설정과 코치 정보를 병렬로 가져온다
    const [settings, coaches] = await Promise.all([
        getAcademySettings() as Promise<any>,
        getCoaches(),
    ]);

    // 시설 이미지 JSON 파싱 — 실패 시 빈 배열 반환
    const facilityImages: string[] = (() => {
        try {
            if (settings.facilitiesImagesJSON) return JSON.parse(settings.facilitiesImagesJSON);
        } catch {}
        return [];
    })();

    const phone = settings.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 배경 + 장식 요소 (Phase 0 패턴 적용) */}
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                {/* 배경 장식 도형들 */}
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">ABOUT US</p>
                        <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">학원/멤버소개</h1>
                        <p className="text-blue-200 text-lg max-w-xl">스티즈 농구교실 다산2호점의 교육 철학과 전문 코치진을 소개합니다.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 학원 소개 — 좌 인사말 + 우 대표원장 사진 */}
            <SectionLayout label="INTRODUCTION" title="원장 인사말" bgColor="white">
                {(() => {
                    const headCoach = (coaches as any[]).find((c: any) => c.role === '대표원장');
                    return (
                        <div className="max-w-3xl mx-auto">
                            <div className="grid md:grid-cols-[1fr_auto] gap-8 items-start">
                                {/* 좌: 인사말 텍스트 */}
                                <AnimateOnScroll>
                                    <div
                                        className="rich-content prose prose-gray dark:prose-invert dark:[&_*]:!text-gray-100 prose-p:text-base prose-p:leading-relaxed max-w-none transition-colors"
                                        dangerouslySetInnerHTML={{
                                            __html: renderHtml(
                                                settings.introductionText,
                                                "<p>안녕하세요, 스티즈 농구교실 다산2호점입니다.</p><p>저희 학원은 아이들이 농구를 통해 협동심, 책임감, 그리고 건강한 체력을 기를 수 있도록 최선을 다해 지도하고 있습니다.</p><p>전문 코치진과 체계적인 커리큘럼으로 아이들의 가능성을 이끌어 드리겠습니다.</p>"
                                            ),
                                        }}
                                    />
                                </AnimateOnScroll>

                                {/* 우: 대표원장 사진 + 이름 */}
                                {headCoach?.imageUrl && (
                                    <AnimateOnScroll delay={200}>
                                        <div className="flex flex-col items-center mx-auto md:mx-0">
                                            <div className="w-40 h-40 md:w-48 md:h-48 rounded-2xl overflow-hidden bg-gray-100 dark:bg-gray-800 shadow-md">
                                                <Image
                                                    src={headCoach.imageUrl}
                                                    alt={headCoach.name}
                                                    width={192}
                                                    height={192}
                                                    className="w-full h-full object-cover"
                                                />
                                            </div>
                                            <p className="mt-3 font-bold text-gray-900 dark:text-gray-100 transition-colors">{headCoach.name}</p>
                                            <Badge variant="default" size="sm">대표원장</Badge>
                                        </div>
                                    </AnimateOnScroll>
                                )}
                            </div>

                        </div>
                    );
                })()}
            </SectionLayout>

            {/* 교육 이념 — 가로 4칸 컴팩트 카드 */}
            {settings.philosophyText ? (
                <SectionLayout label="PHILOSOPHY" title="교육 이념" bgColor="section">
                    <AnimateOnScroll>
                        <div
                            className="rich-content prose prose-gray max-w-none text-center mb-8"
                            dangerouslySetInnerHTML={{
                                __html: renderHtml(settings.philosophyText, ""),
                            }}
                        />
                    </AnimateOnScroll>
                    <AnimateOnScroll delay={200}>
                        <Card variant="default" className="!p-0">
                            <div className="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-gray-100 dark:divide-gray-700">
                                {PHILOSOPHY_CARDS.map((card, i) => (
                                    <div key={i} className="flex flex-col items-center text-center gap-1.5 py-5 px-3 md:py-6 md:px-4">
                                        <h4 className="text-lg md:text-xl font-black text-brand-navy-900 dark:text-white tracking-tight">{card.title}</h4>
                                        <p className="text-sm md:text-base text-gray-500 dark:text-gray-400 leading-relaxed">{card.description}</p>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </AnimateOnScroll>
                </SectionLayout>
            ) : (
                <SectionLayout label="PHILOSOPHY" title="교육 이념" description="STIZ 농구교실이 추구하는 가치" bgColor="section">
                    <AnimateOnScroll>
                        <Card variant="default" className="!p-0">
                            <div className="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-gray-100 dark:divide-gray-700">
                                {PHILOSOPHY_CARDS.map((card, i) => (
                                    <div key={i} className="flex flex-col items-center text-center gap-1.5 py-5 px-3 md:py-6 md:px-4">
                                        <h4 className="text-lg md:text-xl font-black text-brand-navy-900 dark:text-white tracking-tight">{card.title}</h4>
                                        <p className="text-sm md:text-base text-gray-500 dark:text-gray-400 leading-relaxed">{card.description}</p>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </AnimateOnScroll>
                </SectionLayout>
            )}

            {/* 코치진 소개 — 확대된 카드형 레이아웃 (가로형 사진 + 정보) */}
            {coaches.length > 0 && (
                <SectionLayout label="COACHES" title="코치진 소개" description="자격증을 보유한 전문 코치진이 지도합니다" bgColor="white">
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {coaches.map((coach, i) => (
                            <AnimateOnScroll key={coach.id} delay={i * 100}>
                                <Card variant="default" className="overflow-hidden !p-0">
                                    {/* 코치 사진 영역 — 정방형 (1:1) */}
                                    <div className="relative aspect-square bg-gray-100 dark:bg-gray-800 overflow-hidden">
                                        {coach.imageUrl ? (
                                            <Image
                                                src={coach.imageUrl}
                                                alt={coach.name}
                                                fill
                                                className="object-cover object-top"
                                                sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-6xl opacity-30">
                                                🏀
                                            </div>
                                        )}
                                    </div>

                                    {/* 코치 정보 영역 */}
                                    <div className="p-5">
                                        <div className="flex items-center gap-3 mb-2">
                                            <h3 className="text-lg font-bold text-gray-900 dark:text-white">{coach.name}</h3>
                                            <Badge variant="default" size="sm">{coach.role}</Badge>
                                        </div>

                                        {/* 이력 — 1줄만 보이고 더보기로 펼치기 */}
                                        <CoachBioToggle text={coach.description || ''} />
                                    </div>
                                </Card>
                            </AnimateOnScroll>
                        ))}
                    </div>
                </SectionLayout>
            )}

            {/* 시설 소개 — 이미지 갤러리 + 시설 특장점 리스트 */}
            {(settings.facilitiesText || facilityImages.length > 0) && (
                <SectionLayout label="FACILITIES" title="시설 소개" description="쾌적하고 안전한 환경에서 수업합니다" bgColor="section">
                    {/* 시설 설명 텍스트 */}
                    {settings.facilitiesText && (
                        <AnimateOnScroll>
                            <div
                                className="rich-content prose prose-gray dark:prose-invert max-w-none mb-10 transition-colors"
                                dangerouslySetInnerHTML={{
                                    __html: renderHtml(settings.facilitiesText, ""),
                                }}
                            />
                        </AnimateOnScroll>
                    )}

                    {/* 시설 이미지 갤러리 — 반응형 그리드 */}
                    {facilityImages.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {facilityImages.map((url, i) => (
                                <AnimateOnScroll key={i} delay={i * 100}>
                                    <div className="aspect-[4/3] relative rounded-2xl overflow-hidden bg-gray-200 group">
                                        <Image
                                            src={url}
                                            alt={`시설 사진 ${i + 1}`}
                                            fill
                                            className="object-cover transition-transform duration-300 group-hover:scale-105"
                                            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                                        />
                                        {/* 호버 시 어두운 오버레이 — 인터랙션 피드백 */}
                                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300 rounded-2xl" />
                                    </div>
                                </AnimateOnScroll>
                            ))}
                        </div>
                    )}
                </SectionLayout>
            )}

            {/* 오시는 길 — 카카오맵 embed + 주소 표시 */}
            {settings.address && (
                <SectionLayout label="LOCATION" title="오시는 길" bgColor="white">
                    <AnimateOnScroll>
                        <div className="max-w-4xl mx-auto">
                            {/* 카카오맵 iframe — 주소 검색 기반 embed */}
                            <div className="relative w-full aspect-[16/9] md:aspect-[2/1] rounded-2xl overflow-hidden shadow-md mb-6">
                                <iframe
                                    src={`https://map.kakao.com/link/search/${encodeURIComponent(settings.address)}`}
                                    className="absolute inset-0 w-full h-full border-0"
                                    title="오시는 길 지도"
                                    loading="lazy"
                                    allowFullScreen
                                />
                            </div>
                            {/* 주소 텍스트 — 아이콘 + 클립보드 복사 없이 심플하게 */}
                            <div className="flex items-start gap-3 text-gray-700 dark:text-gray-200">
                                <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime text-2xl mt-0.5 shrink-0">location_on</span>
                                <div>
                                    <p className="font-bold text-lg text-gray-900 dark:text-white">{settings.address}</p>
                                    {phone && (
                                        <p className="mt-1 text-gray-500 dark:text-gray-400">
                                            상담문의: <a href={`tel:${phone.replace(/-/g, "")}`} className="text-brand-navy-900 dark:text-brand-neon-lime font-semibold hover:underline">{phone}</a>
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </AnimateOnScroll>
                </SectionLayout>
            )}

            {/* CTA 배너 — Phase 2에서 만든 공통 CTABanner 재사용 */}
            <CTABanner
                title="우리 아이, 농구로 성장시켜 보세요"
                subtitle="전문 코치진과 체계적인 커리큘럼이 기다리고 있습니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
