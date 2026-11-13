"use client";

import {
    PAYMENT_METHOD_OPTIONS,
    quickPayLabel,
    type PreferredPaymentMethod,
} from "@/lib/payments/preferredMethod";

// 학부모 결제 방법 고르기(단건 청구서 결제·마이페이지 묶음 결제 공통 부품, 2026-11-13 원장 결정 방식 ①).
//
// 모양(위에서 아래로):
//  1) «지난번 결제 방법» 큰 버튼 1개(주 버튼) — 저장된 방법이 없으면 이 줄은 없다
//  2) 버튼 줄: 토스페이·카카오페이·네이버페이 / 카드·계좌이체·무통장입금 (3칸 2줄, 누르면 바로 그 방법으로 결제창)
//  3) 안내 한 줄(간편결제는 그 앱이 있어야 열린다)
// 누르는 즉시 결제를 시작한다(고르고 또 «결제하기»를 누르는 2단계를 1단계로 줄였다 — «바로가기»).
// 금액은 표시만 한다. 실제 금액·주문번호는 서버가 정한 값만 쓴다(화면 → 서버 결제 준비 API).

export default function PaymentMethodPicker({
    preferred,
    amountLabel,
    disabled = false,
    loading = false,
    showAmount = true,
    onPay,
}: {
    /** 지난번(또는 설정에서 고른) 결제 방법 — 없으면 큰 버튼 생략 */
    preferred: PreferredPaymentMethod | null;
    /** 큰 버튼에 붙일 금액 글(예: «150,000원») */
    amountLabel: string;
    /** 결제할 수 없는 상태(금액 0·선택 없음·상한 초과 등) */
    disabled?: boolean;
    /** 결제창 여는 중 */
    loading?: boolean;
    /** 금액 안내를 보일까(묶음 화면에서 청구를 하나도 안 골랐으면 «0원» 줄을 숨긴다) */
    showAmount?: boolean;
    onPay: (method: PreferredPaymentMethod) => void;
}) {
    const off = disabled || loading;
    return (
        <div className="space-y-2">
            {preferred && (
                // 이 화면의 주 버튼 하나 — 지난번 방법으로 한 번에
                <button
                    type="button"
                    onClick={() => onPay(preferred)}
                    disabled={off}
                    className="academy-button-primary min-h-12 w-full flex-col py-1.5 text-base font-black"
                >
                    {/* 360px 에서도 한 줄 — 방법 이름이 첫 줄, 금액은 둘째 줄 작은 글자 */}
                    <span className="block whitespace-nowrap">{loading ? "결제창 여는 중..." : quickPayLabel(preferred)}</span>
                    {!loading && showAmount && <span className="block whitespace-nowrap text-xs font-bold opacity-90">{amountLabel}</span>}
                </button>
            )}

            {/* 버튼 줄 제목 — 큰 버튼이 있으면 «다른 방법», 없으면 «결제 방법» */}
            {(preferred || showAmount) && (
                <p className="text-xs font-bold text-[var(--color-academy-muted)]">
                    {preferred ? "다른 방법으로 결제" : `결제 방법을 눌러 주세요 · ${amountLabel}`}
                </p>
            )}
            <div role="group" aria-label="결제 방식" className="grid grid-cols-3 gap-1.5">
                {PAYMENT_METHOD_OPTIONS.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => onPay(option.value)}
                        disabled={off}
                        className="flex min-h-12 flex-col items-center justify-center whitespace-nowrap rounded-lg border border-[var(--color-academy-line)] px-1 text-xs font-bold text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)] hover:text-[var(--color-academy-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <span className="material-symbols-outlined text-lg leading-none" aria-hidden="true">{option.icon}</span>
                        {option.label}
                    </button>
                ))}
            </div>
            <p className="text-xs text-[var(--color-academy-muted)]">간편결제는 그 앱이 있어야 열려요. 안 되면 «카드»를 눌러 주세요.</p>
        </div>
    );
}
