"use client";

import { useState } from "react";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { normalizeMobilePhone, type ReviewTierOption } from "@/lib/payments/tossReview";
import { openReviewCardPayment } from "@/lib/payments/tossReviewClient";

const inputClass =
    "mt-1 block min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-base text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-white";
const cardClass = "mt-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900";

/**
 * 주문서의 입력 부분 — 수업 빈도 선택, 주문자 정보, 결제수단, 구매조건 동의, [결제하기].
 * 주문자 정보는 어디에도 저장하지 않고 토스 결제창(customerName·customerMobilePhone)에만 넘긴다.
 */
export default function OrderForm({ programId, options, initialTier }: {
    programId: string;
    options: ReviewTierOption[];
    initialTier: string;
}) {
    const [tier, setTier] = useState(initialTier);
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [agreed, setAgreed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 화면에 보여줄 금액 — 실제 결제 금액은 서버가 DB 가격으로 다시 정한다
    const selected = options.find((option) => option.key === tier) ?? options[0];

    async function pay() {
        setError(null);
        const trimmedName = name.trim();
        const mobile = normalizeMobilePhone(phone);
        if (!trimmedName) return setError("주문자 이름을 입력해 주세요.");
        if (!mobile) return setError("휴대폰 번호를 정확히 입력해 주세요. (예: 010-1234-5678)");
        if (!agreed) return setError("구매조건에 동의해 주세요.");

        setLoading(true);
        try {
            await openReviewCardPayment({
                programId,
                tier: selected.key,
                customerName: trimmedName.slice(0, 100),
                customerMobilePhone: mobile,
            });
        } catch (err) {
            // 결제창을 닫은 경우도 여기로 온다 — 다시 누를 수 있게 돌려놓는다.
            setError(err instanceof Error ? err.message : "결제 요청 중 오류가 발생했습니다.");
            setLoading(false);
        }
    }

    return (
        <>
            {/* 수업 빈도 + 금액 */}
            <div className={cardClass}>
                <h2 className="text-base font-black text-gray-900 dark:text-white">수업 선택</h2>
                {options.length > 1 ? (
                    <label className="mt-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                        수업 빈도
                        <select value={selected.key} onChange={(event) => setTier(event.target.value)} className={inputClass}>
                            {options.map((option) => (
                                <option key={option.key} value={option.key}>
                                    {option.label} · {option.amount.toLocaleString("ko-KR")}원
                                </option>
                            ))}
                        </select>
                    </label>
                ) : (
                    <p className="mt-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{selected.label}</p>
                )}
                <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-4 dark:border-gray-800">
                    <span className="text-sm font-bold text-gray-600 dark:text-gray-300">결제 금액</span>
                    <span className="text-2xl font-black text-brand-orange-500 dark:text-brand-neon-lime">
                        {selected.amount.toLocaleString("ko-KR")}원
                    </span>
                </div>
            </div>

            {/* 주문자 정보 — 저장하지 않음 */}
            <div className={cardClass}>
                <h2 className="text-base font-black text-gray-900 dark:text-white">주문자 정보</h2>
                <label className="mt-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                    이름
                    <input type="text" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={50} placeholder="홍길동" className={inputClass} />
                </label>
                <label className="mt-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                    휴대폰 번호
                    <input type="tel" inputMode="numeric" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" maxLength={13} placeholder="010-1234-5678" className={inputClass} />
                </label>
                {phone && !normalizeMobilePhone(phone) && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">휴대폰 번호 형식을 확인해 주세요.</p>
                )}
            </div>

            {/* 결제수단 — 카드 1개(선택된 상태) */}
            <div className={cardClass}>
                <h2 className="text-base font-black text-gray-900 dark:text-white">결제수단</h2>
                <label className="mt-3 flex min-h-11 items-center gap-2 rounded-xl border border-brand-orange-500 px-3 text-sm font-bold text-gray-900 dark:border-brand-neon-lime dark:text-white">
                    <input type="radio" name="payMethod" value="CARD" checked readOnly className="h-4 w-4 accent-brand-orange-500" />
                    신용·체크카드
                </label>
            </div>

            {/* 구매조건 동의 + 결제하기 */}
            <div className={cardClass}>
                <label className="flex items-start gap-2 text-sm font-semibold text-gray-800 break-keep dark:text-gray-200">
                    <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-orange-500" />
                    <span>
                        구매조건 확인 및 결제 진행에 동의합니다(
                        <a href="/terms" target="_blank" rel="noreferrer" className="text-brand-orange-500 underline underline-offset-2 dark:text-brand-neon-lime">환불 규정</a>
                        {" "}포함)
                    </span>
                </label>
                <button
                    type="button"
                    onClick={pay}
                    disabled={!agreed || loading}
                    className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-orange-500 px-4 text-base font-black text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                    <FontFreeIcon name="payments" size={20} />
                    {loading ? "결제창 여는 중" : `${selected.amount.toLocaleString("ko-KR")}원 결제하기`}
                </button>
                {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            </div>
        </>
    );
}
