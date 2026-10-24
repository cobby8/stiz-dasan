"use client";

import { useState } from "react";
import Link from "next/link";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

type TierOption = { key: string; label: string; amount: number };

/**
 * 프로그램 카드의 [결제하기] — 토스페이먼츠 가맹 심사용 테스트 결제.
 * 서버가 테스트 키를 가지고 있을 때만 화면에 나온다(부모 컴포넌트가 판단).
 * 결제창을 바로 열지 않고 **주문서**(/programs/order)로 보낸다 — 심사 결제경로
 * "상품 선택 → 주문서(주문자 정보·결제수단·구매조건 동의) → 결제창"을 맞추기 위해서다.
 */
export default function ProgramPayButton({ programId, tiers }: { programId: string; tiers: TierOption[] }) {
    const [tier, setTier] = useState(tiers[0]?.key ?? "");

    if (tiers.length === 0) return null;

    // 고른 수업 빈도를 주문서에 그대로 넘긴다(금액은 주문서·서버가 DB 로 다시 정한다)
    const orderHref = `/programs/order?program=${encodeURIComponent(programId)}&tier=${encodeURIComponent(tier)}`;

    return (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {tiers.length > 1 && (
                <select
                    value={tier}
                    onChange={(event) => setTier(event.target.value)}
                    aria-label="결제할 수업 빈도"
                    className="min-h-10 max-w-full rounded-xl border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                    {tiers.map((option) => (
                        <option key={option.key} value={option.key}>
                            {option.label} · {option.amount.toLocaleString("ko-KR")}원
                        </option>
                    ))}
                </select>
            )}
            <Link
                href={orderHref}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand-orange-500 px-4 text-sm font-black text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                <FontFreeIcon name="payments" size={18} />
                결제하기
            </Link>
        </div>
    );
}
