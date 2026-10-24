import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import PublicPageLayout from "@/components/PublicPageLayout";
import {
    listReviewTierOptions,
    readTossReviewConfig,
    type ReviewProgramPrices,
} from "@/lib/payments/tossReview";
import OrderForm from "./OrderForm";

// 주소의 program·tier 로 매번 다른 화면이 나오므로 캐시하지 않는다.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
    title: "주문서 | STIZ 농구교실",
    // 심사용 주문서 — 검색 결과에는 내보내지 않는다.
    robots: { index: false, follow: false },
};

type OrderProgram = ReviewProgramPrices & {
    id: string;
    targetAge: string | null;
    description: string | null;
    imageUrl: string | null;
};

/** 주문서를 못 열 때 보여주는 안내 상자 — 프로그램 화면으로 돌아가는 길을 함께 준다. */
function Notice({ title, message, href = "/programs", linkLabel = "프로그램 안내로 돌아가기" }: {
    title: string;
    message: string;
    href?: string;
    linkLabel?: string;
}) {
    return (
        <PublicPageLayout>
            <section className="public-content-section bg-gray-50 px-4 py-16 dark:bg-gray-950">
                <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
                    <h1 className="text-xl font-black text-gray-900 dark:text-white">{title}</h1>
                    <p className="mt-4 break-keep text-sm leading-6 text-gray-600 dark:text-gray-300">{message}</p>
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                        <Link
                            href={href}
                            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-orange-500 px-5 text-sm font-black text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                        >
                            {linkLabel}
                        </Link>
                        {href !== "/programs" && (
                            <Link
                                href="/programs"
                                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-gray-300 px-5 text-sm font-bold text-gray-700 dark:border-gray-700 dark:text-gray-200"
                            >
                                프로그램 안내
                            </Link>
                        )}
                    </div>
                </div>
            </section>
        </PublicPageLayout>
    );
}

/**
 * 주문서 — 토스페이먼츠 가맹 심사 결제경로("상품 선택 → 주문서 → 결제하기 → 카드 결제창")의 가운데 단계.
 * - 비로그인으로 연다(proxy 는 admin/staff/mypage 만 막는다).
 * - DB 는 읽기만 한다. 주문자 정보는 저장하지 않고 토스 결제창에만 넘긴다.
 * - 테스트 키(TOSS_REVIEW_*)가 없으면 주문서 대신 "준비 중" 안내를 보여준다.
 */
export default async function ProgramOrderPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    if (!readTossReviewConfig(process.env)) {
        return (
            <Notice
                title="온라인 결제 준비 중입니다"
                message="지금은 온라인 결제를 받지 않습니다. 수강 신청은 체험·수강 신청서로 접수해 주세요."
                href="/apply"
                linkLabel="체험/수강신청"
            />
        );
    }

    const params = await searchParams;
    const programId = typeof params.program === "string" ? params.program : "";
    const requestedTier = typeof params.tier === "string" ? params.tier : "";

    // 삭제된 프로그램은 제외하고 1건만 읽는다(쓰기 없음)
    const rows = programId
        ? await prisma.$queryRawUnsafe<OrderProgram[]>(
            `SELECT id, name, "targetAge", description, "imageUrl",
                    price, "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily"
               FROM "Program" WHERE id = $1 AND "deletedAt" IS NULL LIMIT 1`,
            programId,
        )
        : [];
    const program = rows[0];
    if (!program) {
        return <Notice title="수업을 찾을 수 없습니다" message="없거나 운영이 끝난 수업입니다. 프로그램 안내에서 다시 골라 주세요." />;
    }

    // 금액이 있는 가격 칸만 고를 수 있다 — 0원·빈 칸은 목록에 없다.
    const options = listReviewTierOptions(program);
    if (options.length === 0) {
        return <Notice title="결제할 수 없는 수업입니다" message="이 수업은 온라인 결제 금액이 정해져 있지 않습니다. 학원으로 문의해 주세요." />;
    }
    // tier 가 없으면 첫 칸으로, 있는데 고를 수 없는 칸이면 안내
    const initial = requestedTier ? options.find((option) => option.key === requestedTier) : options[0];
    if (!initial) {
        return <Notice title="선택한 수업 빈도를 결제할 수 없습니다" message="프로그램 안내에서 수업 빈도를 다시 골라 주세요." />;
    }

    return (
        <PublicPageLayout>
            <section className="public-content-section bg-gray-50 px-4 py-10 dark:bg-gray-950 md:py-14">
                <div className="mx-auto w-full max-w-2xl">
                    <Link href="/programs" className="text-sm font-bold text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white">
                        ← 프로그램 안내
                    </Link>
                    <h1 className="mt-3 text-2xl font-black text-gray-900 dark:text-white">주문서</h1>

                    {/* 상품 정보 */}
                    <div className="mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
                        <div className="relative aspect-[3/1] w-full overflow-hidden">
                            {program.imageUrl ? (
                                <Image src={program.imageUrl} alt={program.name} fill className="object-cover" sizes="(max-width: 768px) 100vw, 672px" />
                            ) : (
                                // 이미지가 없으면 이름 첫 글자를 브랜드 그라데이션 위에 보여준다
                                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-orange-500 dark:from-black dark:via-gray-900 dark:to-brand-neon-cobalt">
                                    <span className="text-5xl font-black text-white">{program.name.trim().charAt(0)}</span>
                                </div>
                            )}
                        </div>
                        <div className="p-5">
                            <h2 className="break-keep text-xl font-black text-gray-900 dark:text-white">{program.name}</h2>
                            {program.targetAge && (
                                <p className="mt-1 text-sm font-semibold text-gray-600 dark:text-gray-300">대상: {program.targetAge}</p>
                            )}
                            {program.description && (
                                <p className="mt-3 whitespace-pre-line break-keep text-sm leading-6 text-gray-600 dark:text-gray-300">{program.description}</p>
                            )}
                            <div className="mt-4 rounded-xl bg-gray-50 p-4 text-sm leading-6 text-gray-700 break-keep dark:bg-gray-800 dark:text-gray-300">
                                <p>
                                    <strong className="text-gray-900 dark:text-white">서비스 제공기간</strong> 결제한 달의 수업 4주(1개월) · 셔틀비 별도
                                </p>
                                <p className="mt-1">
                                    <strong className="text-gray-900 dark:text-white">환불</strong> 「학원법 시행령」 교습비 반환기준에 따릅니다 —{" "}
                                    <a href="/terms" className="font-bold text-brand-orange-500 underline underline-offset-2 dark:text-brand-neon-lime">환불 규정 보기</a>
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* 수업 빈도·금액·주문자 정보·결제수단·동의·결제하기 */}
                    <OrderForm programId={program.id} options={options} initialTier={initial.key} />
                </div>
            </section>
        </PublicPageLayout>
    );
}
