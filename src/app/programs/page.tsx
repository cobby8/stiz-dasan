import { getPrograms, getAcademySettings } from "@/lib/queries";
import Image from "next/image";
import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import CTABanner from "@/components/landing/CTABanner";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { hasSellablePrice, listReviewTierOptions, readTossReviewConfig } from "@/lib/payments/tossReview";
import ProgramPayButton from "./ProgramPayButton";

export const revalidate = 60;
export const metadata = buildPublicMetadata({
    title: "프로그램 안내 | STIZ 농구교실 다산2호점",
    description: "유아, 초등, 중등 수준별 맞춤 농구 클래스와 수강료, 셔틀버스 정보를 확인하세요.",
    path: "/programs",
});

// 요일 한글 매핑
const DAY_OPTIONS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};
const WEEKEND = new Set(["Sat", "Sun"]);
const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// 수강 빈도별 가격 키와 셔틀비 매핑
const FREQ_TIERS = [
    { key: "priceWeek1" as const, label: "주 1회", autoShuttle: 10000 },
    { key: "priceWeek2" as const, label: "주 2회", autoShuttle: 15000 },
    { key: "priceWeek3" as const, label: "주 3회", autoShuttle: 20000 },
    { key: "priceDaily" as const, label: "매일반", autoShuttle: 20000 },
];

type Program = {
    id: string;
    name: string;
    targetAge: string | null;
    weeklyFrequency: string | null;
    frequency: string | null;
    description: string | null;
    price: number;
    days: string | null;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
    shuttleFeeOverride: number | null;
    imageUrl: string | null;
};

// 주말 전용 프로그램인지 판별
function isWeekendOnly(days: string[]): boolean {
    return days.length > 0 && days.every((d) => WEEKEND.has(d));
}

// 셔틀비 표시 문자열 생성
function getShuttleFeeDisplay(
    shuttleFeeOverride: number | null | undefined,
    freqKey: typeof FREQ_TIERS[number]["key"],
    weekend: boolean,
): string | null {
    if (weekend) return null;
    if (shuttleFeeOverride === 0) return null;
    if (shuttleFeeOverride != null && shuttleFeeOverride > 0)
        return shuttleFeeOverride.toLocaleString() + "원";
    const tier = FREQ_TIERS.find((t) => t.key === freqKey);
    return tier ? tier.autoShuttle.toLocaleString() + "원" : null;
}

// 대상 연령에 따른 색상 매핑 — 한눈에 구분되게
function getAgeColor(targetAge: string | null): { bg: string; text: string; border: string } {
    if (!targetAge) return { bg: "bg-gray-50 dark:bg-gray-900", text: "text-gray-600 dark:text-gray-300", border: "border-gray-200 dark:border-gray-700" };
    const age = targetAge.toLowerCase();
    if (age.includes("유아") || age.includes("미취학")) return { bg: "bg-emerald-50 dark:bg-emerald-900/30", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-700" };
    if (age.includes("초등") && (age.includes("저") || age.includes("1") || age.includes("2") || age.includes("3")))
        return { bg: "bg-blue-50 dark:bg-blue-900/30", text: "text-blue-700 dark:text-blue-400", border: "border-blue-200 dark:border-blue-700" };
    if (age.includes("초등")) return { bg: "bg-sky-50 dark:bg-sky-900/30", text: "text-sky-700 dark:text-sky-400", border: "border-sky-200 dark:border-sky-700" };
    if (age.includes("중등") || age.includes("중학")) return { bg: "bg-purple-50 dark:bg-purple-900/30", text: "text-purple-700 dark:text-purple-400", border: "border-purple-200 dark:border-purple-700" };
    return { bg: "bg-gray-50 dark:bg-gray-900", text: "text-gray-600 dark:text-gray-300", border: "border-gray-200 dark:border-gray-700" };
}

export default async function ProgramsPage() {
    const [allPrograms, settings] = await Promise.all([
        getPrograms() as Promise<Program[]>,
        getAcademySettings() as Promise<any>,
    ]);
    // 0원 프로그램 숨김 — 가격 칸이 모두 0/빈 값이면 공개 화면에서 뺀다(토스 심사 기준: 0원 상품 노출 불가).
    // getPrograms 자체는 관리자 화면 등도 쓰므로 여기서만 거른다.
    const programs = allPrograms.filter((program) => hasSellablePrice(program));
    const phone = settings.contactPhone || "010-0000-0000";
    // 토스페이먼츠 가맹 심사용 결제 버튼 — 테스트 키가 있을 때만 보인다(라이브 키·미설정이면 숨김).
    const reviewPayEnabled = readTossReviewConfig(process.env) !== null;
    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 배경 + 장식 요소 */}
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">PROGRAMS</p>
                        <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">프로그램 안내</h1>
                        <p className="text-blue-200 text-lg max-w-xl">수준과 연령에 맞는 최적의 프로그램을 찾아보세요.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 프로그램 목록 — 세로 카드(이미지 상단 + 정보 하단) 구조 */}
            <SectionLayout label="CLASSES" title="수업 안내" description="연령과 수준에 맞춘 체계적인 프로그램" bgColor="white">
                {programs.length === 0 ? (
                    <div className="text-center py-20 text-gray-400">
                        <div className="text-5xl mb-4">🏀</div>
                        <p className="text-lg font-medium">준비 중입니다.</p>
                        <p className="text-sm mt-2">문의: {phone}</p>
                    </div>
                ) : (
                    <>
                    {/* 판매정책 표시 — 결제사 심사 필수(서비스 제공기간이 상품 화면에 명확히 보여야 함) */}
                    <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm leading-6 text-gray-700 break-keep dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                        <p>
                            <strong className="text-gray-900 dark:text-white">수강 기간</strong> 월 수강료는 <strong>4주(1개월) 단위</strong>로 결제하며,
                            서비스 제공기간은 결제한 달의 수업 4주입니다. 셔틀비는 별도입니다.
                        </p>
                        <p className="mt-1">
                            <strong className="text-gray-900 dark:text-white">환불</strong> 「학원법 시행령」 교습비 반환기준에 따릅니다 —{" "}
                            <a href="/terms" className="font-bold text-brand-orange-500 underline underline-offset-2 dark:text-brand-neon-lime">환불 규정 보기</a>
                        </p>
                    </div>
                    <div data-tour-target="program-cards" className="grid md:grid-cols-2 gap-6">
                        {programs.map((program, i) => {
                            const days = program.days
                                ? DAY_ORDER.filter((d) => program.days!.split(",").includes(d))
                                : [];
                            const weekend = isWeekendOnly(days);
                            const tiers = FREQ_TIERS.filter((t) => program[t.key] != null);
                            const freq = program.weeklyFrequency || program.frequency;
                            const ageColor = getAgeColor(program.targetAge);

                            return (
                                <AnimateOnScroll key={program.id} delay={(i % 2) * 150}>
                                    <Card variant="default" className={`overflow-hidden !p-0 border-t-4 ${ageColor.border}`}>
                                        {/* 프로그램 이미지 */}
                                        {program.imageUrl && (
                                            <div className="relative aspect-[3/1] bg-gray-100 dark:bg-gray-800 overflow-hidden">
                                                <Image
                                                    src={program.imageUrl}
                                                    alt={program.name}
                                                    fill
                                                    className="object-cover"
                                                    sizes="(max-width: 768px) 100vw, 50vw"
                                                />
                                            </div>
                                        )}

                                        {/* 프로그램 헤더 — 이름 + 뱃지들 */}
                                        <div className="px-5 pt-5 pb-3">
                                            <div className="flex flex-wrap items-center gap-2 mb-2">
                                                <h3 className="text-xl font-bold text-gray-900 dark:text-white">{program.name}</h3>
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                {/* 대상 연령 뱃지 */}
                                                {program.targetAge && (
                                                    <span className={`${ageColor.bg} ${ageColor.text} text-xs font-bold px-3 py-1 rounded-full`}>
                                                        {program.targetAge}
                                                    </span>
                                                )}
                                                {/* 수강 빈도 뱃지 */}
                                                {tiers.length === 0 && freq && (
                                                    <Badge variant="info" size="sm">{freq}</Badge>
                                                )}
                                                {tiers.map((t) => (
                                                    <Badge key={t.key} variant="info" size="sm">{t.label}</Badge>
                                                ))}
                                                {/* 수업 요일 뱃지 */}
                                                {days.map((d) => (
                                                    <span key={d} className={`text-xs font-bold px-2.5 py-1 rounded-full ${WEEKEND.has(d) ? "bg-orange-100 text-orange-700" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"}`}>
                                                        {DAY_OPTIONS[d]}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>

                                        {/* 프로그램 설명 */}
                                        {program.description && (
                                            <div className="px-5 pb-3">
                                                <p className="text-gray-600 dark:text-gray-300 text-base leading-relaxed whitespace-pre-line">{program.description}</p>
                                            </div>
                                        )}

                                        {/* 수강료 — 다단 가격표 또는 단일 가격 */}
                                        <div className="px-5 pb-5">
                                            {tiers.length > 0 ? (
                                                <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-900">
                                                    <table className="w-full text-sm">
                                                        <thead className="bg-brand-navy-900 text-white">
                                                            <tr>
                                                                <th className="px-4 py-2.5 text-left font-bold">수업 빈도</th>
                                                                <th className="px-4 py-2.5 text-right font-bold">월 수강료</th>
                                                                <th className="px-4 py-2.5 text-right font-bold">셔틀비</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                                            {tiers.map((t) => {
                                                                const fee = getShuttleFeeDisplay(program.shuttleFeeOverride, t.key, weekend);
                                                                return (
                                                                    <tr key={t.key} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                                                                        <td className="px-4 py-3 font-semibold text-gray-800 dark:text-gray-100">{t.label}</td>
                                                                        <td className="px-4 py-3 text-right font-bold text-brand-navy-900 dark:text-white">
                                                                            {Number(program[t.key]).toLocaleString()}원
                                                                        </td>
                                                                        <td className="px-4 py-3 text-right text-blue-600 dark:text-blue-400 font-medium">
                                                                            {fee ? fee : <span className="text-gray-400 font-normal">운행 없음</span>}
                                                                        </td>
                                                                    </tr>
                                                                );
                                                            })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            ) : (
                                                <div className="flex flex-wrap items-center gap-6">
                                                    <div>
                                                        <p className="text-sm text-gray-400 mb-0.5">월 수강료</p>
                                                        <p className="text-3xl font-black text-brand-navy-900 dark:text-white">
                                                            {program.price.toLocaleString()}
                                                            <span className="text-base font-normal text-gray-500 dark:text-gray-400">원</span>
                                                        </p>
                                                    </div>
                                                    {weekend ? (
                                                        <p className="text-sm text-orange-600 dark:text-orange-400 font-medium">셔틀 운행 없음</p>
                                                    ) : program.shuttleFeeOverride === 0 ? (
                                                        <p className="text-sm text-gray-400">셔틀 없음</p>
                                                    ) : program.shuttleFeeOverride != null && program.shuttleFeeOverride > 0 ? (
                                                        <p className="text-sm text-blue-600 font-medium">
                                                            셔틀비 {program.shuttleFeeOverride.toLocaleString()}원
                                                        </p>
                                                    ) : null}
                                                </div>
                                            )}

                                            {/* 시간표 보기 링크 */}
                                            <div className="flex justify-end mt-4">
                                                <a href={`/schedule?program=${program.id}`}
                                                    className="text-sm font-bold text-brand-orange-500 dark:text-brand-neon-lime hover:text-orange-600 border border-brand-orange-500 dark:border-brand-neon-lime/50 hover:border-brand-orange-500 dark:border-brand-neon-lime px-4 py-2 rounded-xl transition-all duration-200 hover:scale-[1.02]">
                                                    시간표 보기 →
                                                </a>
                                            </div>

                                            {reviewPayEnabled && (
                                                <ProgramPayButton
                                                    programId={program.id}
                                                    // 주문서와 같은 규칙으로 빈도 목록을 만든다(공용 함수 — 사본 금지)
                                                    tiers={listReviewTierOptions(program)}
                                                />
                                            )}
                                        </div>
                                    </Card>
                                </AnimateOnScroll>
                            );
                        })}
                    </div>
                    </>
                )}
            </SectionLayout>

            {/* CTA 배너 — 공통 CTABanner 재사용 */}
            <CTABanner
                title="수강 신청 및 문의"
                subtitle="궁금한 점은 전화로 문의해 주세요. 친절하게 안내해 드립니다."
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
