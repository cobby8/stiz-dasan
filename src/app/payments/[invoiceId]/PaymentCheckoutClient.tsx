"use client";

import { useEffect, useRef, useState } from "react";
import { taxFreeAmountFor } from "@/lib/payments/taxFree";
import { VIRTUAL_ACCOUNT_VALID_HOURS, type PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";
import PaymentMethodPicker from "@/components/parent/PaymentMethodPicker";
import { requestTossWithFallback, serverMethodFor, type PreferredPaymentMethod } from "@/lib/payments/preferredMethod";

type TossPaymentMethod = "CARD" | "TRANSFER" | "VIRTUAL_ACCOUNT";
type PaymentProvider = "TOSS" | "CAFE24_BRIDGE";

declare global {
    interface Window {
        TossPayments?: (clientKey: string) => {
            payment: (options: { customerKey: string }) => {
                requestPayment: (options: {
                    method: TossPaymentMethod;
                    amount: { currency: "KRW"; value: number };
                    taxFreeAmount?: number;
                    // 카드 결제창 방식 — DIRECT+easyPay = 그 간편결제 앱으로 바로, DEFAULT = 통합 결제창
                    card?: { flowMode: "DIRECT"; easyPay: string } | { flowMode: "DEFAULT" };
                    orderId: string;
                    orderName: string;
                    successUrl: string;
                    failUrl: string;
                    customerEmail?: string;
                    customerName?: string;
                    customerMobilePhone?: string;
                    // 무통장입금(가상계좌) 전용 옵션 — 토스 결제창 SDK v2 requestPayment 의 virtualAccount
                    virtualAccount?: {
                        validHours?: number;
                        cashReceipt?: { type: "소득공제" | "지출증빙" | "미발행" };
                        useEscrow?: boolean;
                    };
                }) => Promise<void>;
            };
        };
    }
}

type CheckoutResponse = {
    ok: boolean;
    provider?: PaymentProvider;
    providerLabel?: string;
    providerReady?: boolean;
    checkoutUrl?: string;
    clientKey?: string;
    customerKey?: string;
    orderId?: string;
    amount?: number;
    orderName?: string;
    customerName?: string;
    customerEmail?: string;
    customerMobilePhone?: string;
    successUrl?: string;
    failUrl?: string;
    error?: string;
    /** 서버가 «이미 열린 입금 계좌가 있다»고 판정하면 새 결제 대신 이 칸이 온다. */
    openVirtualAccount?: PublicVirtualAccountView;
};

// 결제 방식 — 한 줄 3칸에 들어가게 짧은 이름만 쓴다(설명 줄은 360px 에서 줄바꿈돼 뺐다).
// 묶음 결제 화면(BundleCheckoutClient)과 같은 이름이다.
const PAYMENT_METHODS: {
    value: TossPaymentMethod;
    label: string;
    icon: string;
}[] = [
        { value: "CARD", label: "카드·간편결제", icon: "credit_card" },
        { value: "TRANSFER", label: "계좌이체", icon: "account_balance" },
        { value: "VIRTUAL_ACCOUNT", label: "무통장입금", icon: "savings" },
    ];

type ReadyCheckout = CheckoutResponse & { amount: number; orderId: string; orderName: string; successUrl: string; failUrl: string };

// 결제창에 꼭 필요한 값이 다 왔는가(서버가 정한 값만 쓴다).
// 타입 판정 함수로 둔 이유: 결제창 다시 열기(바로가기 실패 → 통합창) 함수 안에서도 «값이 있다»가 유지되게.
function isReadyCheckout(data: CheckoutResponse): data is ReadyCheckout {
    return Boolean(data.providerReady && data.orderId && data.amount && data.orderName && data.successUrl && data.failUrl);
}

function loadTossScript() {
    return new Promise<void>((resolve, reject) => {
        if (window.TossPayments) {
            resolve();
            return;
        }

        const existing = document.querySelector<HTMLScriptElement>("script[data-toss-payments]");
        if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("토스페이먼츠 결제창을 불러오지 못했어요.")), { once: true });
            return;
        }

        const script = document.createElement("script");
        script.src = "https://js.tosspayments.com/v2/standard";
        script.async = true;
        script.dataset.tossPayments = "true";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("토스페이먼츠 결제창을 불러오지 못했어요."));
        document.head.appendChild(script);
    });
}

export default function PaymentCheckoutClient({
    invoiceId,
    providerReady,
    provider,
    amount,
    virtualAccount = null,
    preferredMethod = null,
    guestToken = null,
}: {
    invoiceId: string;
    providerReady: boolean;
    provider: PaymentProvider;
    /** 제공자 이름 — 화면 버튼에는 더 쓰지 않는다(좁은 화면 줄바꿈). 서버 페이지가 넘기는 모양은 그대로 둔다. */
    providerLabel: string;
    amount: number;
    /** 이 청구서의 최근 가상계좌(입금 대기 또는 만료). 서버가 소유권 확인 후 넘긴다. */
    virtualAccount?: PublicVirtualAccountView | null;
    /** 지난번(또는 설정에서 고른) 결제 방법 — 서버가 본인 계정에서 읽어 넘긴다. 없으면 null */
    preferredMethod?: PreferredPaymentMethod | null;
    /**
     * 비회원 결제 링크(/pay/<토큰>)에서 쓸 때만 — 로그인 결제 API 대신 토큰 결제 API 로 보낸다.
     * 이때 청구서 id 는 보내지 않는다(서버가 토큰의 청구서만 결제한다).
     */
    guestToken?: string | null;
}) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 서버 판정으로 받은 열린 계좌(다른 탭에서 방금 발급한 경우 등) — 화면에 바로 보여 준다.
    const [openAccount, setOpenAccount] = useState<PublicVirtualAccountView | null>(
        virtualAccount && !virtualAccount.expired ? virtualAccount : null,
    );
    const expiredAccount = virtualAccount && virtualAccount.expired ? virtualAccount : null;

    // «다른 방법으로 결제» 확인 단계를 펼쳤는가(열린 입금 계좌가 있을 때만 쓴다)
    const [switching, setSwitching] = useState(false);
    // 연타 잠금 — 결제 방법 버튼이 6~7개라 빠르게 두 번 누르면 서버 결제 준비가 두 번 나갈 수 있었다(묶음 화면과 같은 방식)
    const sending = useRef(false);

    // 토스 결제창에서 브라우저 «뒤로»로 돌아오면 페이지가 캐시(bfcache)에서 살아나 «여는 중»에 멈춘다 → 풀어 준다(묶음 화면과 같음)
    useEffect(() => {
        const onPageShow = (event: PageTransitionEvent) => {
            if (!event.persisted) return;
            sending.current = false;
            setLoading(false);
        };
        window.addEventListener("pageshow", onPageShow);
        return () => window.removeEventListener("pageshow", onPageShow);
    }, []);

    // closeAccount=true: 열린 입금 계좌를 서버가 토스에서 닫은 뒤 새 결제를 연다(확인 단계를 거친 경우만).
    // selected = 학부모가 누른 결제 방법(간편결제 3종·카드·계좌이체·무통장입금)
    async function startPayment(selected: PreferredPaymentMethod = "CARD", closeAccount = false) {
        if (!providerReady) {
            setError("지금은 온라인 결제를 쓸 수 없어요. 학원에 문의해 주세요.");
            return;
        }
        if (sending.current) return; // 이미 결제 준비 중
        sending.current = true;

        setLoading(true);
        setError(null);

        try {
            // 간편결제는 토스에서 카드 결제라 서버에는 CARD 로 보낸다(금액·주문은 서버가 정한다)
            const method = serverMethodFor(selected);
            const response = guestToken
                // 비회원 링크: 토큰만 보낸다(어느 청구서인지는 서버가 토큰으로 정한다)
                ? await fetch("/api/pay/checkout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: guestToken, method, closeOpenVirtualAccount: closeAccount }),
                })
                : await fetch("/api/payments/checkout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ invoiceId, method, closeOpenVirtualAccount: closeAccount }),
                });
            const data = (await response.json()) as CheckoutResponse;

            if (!response.ok || !data.ok) {
                throw new Error(data.error || "결제를 준비하지 못했어요.");
            }
            const responseProvider = data.provider || provider;
            // 이미 입금 대기 중인 계좌가 있다 → 새로 발급하지 않고 그 계좌를 보여 준다(이중 납부 방지).
            if (data.openVirtualAccount) {
                setOpenAccount(data.openVirtualAccount);
                setLoading(false);
                return;
            }
            if (!isReadyCheckout(data)) {
                throw new Error("결제 정보가 부족해요. 학원에 문의해 주세요.");
            }

            if (responseProvider === "CAFE24_BRIDGE") {
                if (!data.checkoutUrl) {
                    throw new Error("본사 카페24 결제 링크를 받지 못했어요. 학원에 문의해 주세요.");
                }
                window.location.assign(data.checkoutUrl);
                return;
            }

            if (!data.clientKey || !data.customerKey) {
                throw new Error("토스 결제 정보가 부족해요. 학원에 문의해 주세요.");
            }

            await loadTossScript();
            if (!window.TossPayments) {
                throw new Error("결제창을 불러오지 못했어요.");
            }

            const tossPayments = window.TossPayments(data.clientKey);
            const payment = tossPayments.payment({ customerKey: data.customerKey });
            // 간편결제 바로가기가 실패하면(미계약·미지원 등, 취소 제외) 안내 후 통합 결제창으로 한 번 다시 연다
            await requestTossWithFallback(selected, (part) => payment.requestPayment({
                ...part,
                amount: { currency: "KRW", value: data.amount },
                // 면세사업자(교육서비스)라 결제 금액 전부를 면세로 보낸다. 빠지면 토스 기본값(복합과세)으로 부가세가 잡힌다.
                taxFreeAmount: taxFreeAmountFor(data.amount),
                orderId: data.orderId,
                orderName: data.orderName,
                successUrl: data.successUrl,
                failUrl: data.failUrl,
                customerEmail: data.customerEmail,
                customerName: data.customerName,
                customerMobilePhone: data.customerMobilePhone,
                // 무통장입금: 90일(최대) 동안 입금 가능한 전용 계좌. 현금영수증은 «소득공제»로 기본 선택해 두고
                // 학부모가 결제창에서 번호를 넣거나 용도를 바꾼다. 교육비라 에스크로는 쓰지 않는다.
                ...(selected === "VIRTUAL_ACCOUNT"
                    ? {
                        virtualAccount: {
                            validHours: VIRTUAL_ACCOUNT_VALID_HOURS,
                            cashReceipt: { type: "소득공제" as const },
                            useEscrow: false,
                        },
                    }
                    : {}),
            }), (message) => setError(message));
        } catch (err) {
            setError(err instanceof Error ? err.message : "결제를 요청하지 못했어요.");
            setLoading(false);
        } finally {
            // 잠금만 푼다 — 결제창으로 넘어가는 중에는 loading 이 버튼을 계속 막는다
            sending.current = false;
        }
    }

    // 입금 대기 중 — 새 결제 버튼 대신 받은 계좌만 보여 준다(같은 청구에 계좌 두 개를 만들지 않는다).
    if (openAccount) {
        return (
            <div className="space-y-2">
                <VirtualAccountNotice account={openAccount} />
                {error && (
                    <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] p-2 text-sm font-bold text-[var(--color-academy-danger)]">
                        {error}
                    </p>
                )}
                {providerReady && provider === "TOSS" && !switching && (
                    <button
                        type="button"
                        onClick={() => setSwitching(true)}
                        className="academy-button-secondary min-h-11 w-full text-sm"
                    >
                        다른 방법으로 결제(계좌가 닫혀요)
                    </button>
                )}
                {switching && (
                    // 위험 확인: 계좌를 닫으면 되돌릴 수 없으니 무엇이 일어나는지 먼저 알리고 수단을 고르게 한다.
                    <div role="alertdialog" aria-labelledby="close-account-title" className="rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                        <p id="close-account-title" className="font-extrabold">지금 받은 입금 계좌를 닫을까요?</p>
                        <p className="mt-0.5 text-xs">이미 입금했다면 닫지 말고 잠시 기다려 주세요.</p>
                        {/* 버튼은 «닫고 + 수단 이름»만 — 2칸 버튼에서 줄바꿈되지 않게 짧게 */}
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            {PAYMENT_METHODS.filter((option) => option.value !== "VIRTUAL_ACCOUNT").map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    disabled={loading}
                                    onClick={() => void startPayment(option.value, true)}
                                    className="academy-button-danger-solid min-h-11 whitespace-nowrap px-2 text-sm"
                                >
                                    {loading ? "닫는 중..." : `닫고 ${option.label}`}
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            disabled={loading}
                            onClick={() => setSwitching(false)}
                            className="academy-button-secondary mt-2 min-h-11 w-full text-sm"
                        >
                            그대로 두기
                        </button>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {expiredAccount && (
                <VirtualAccountNotice
                    account={expiredAccount}
                    onReissue={() => void startPayment("VIRTUAL_ACCOUNT")}
                    reissuing={loading}
                />
            )}

            {!providerReady && (
                <p className="rounded-lg bg-[var(--color-academy-warning-soft)] p-2 text-sm text-[var(--color-academy-ink)]">
                    지금은 온라인 결제를 쓸 수 없어요. 학원에 문의해 주세요.
                </p>
            )}

            {/* 결제 방법 — 지난번 방법 큰 버튼 + 간편결제·카드·계좌이체·무통장입금 바로가기(묶음 결제 화면과 같은 부품) */}
            {providerReady && provider === "TOSS" && (
                <PaymentMethodPicker
                    preferred={preferredMethod}
                    amountLabel={`${amount.toLocaleString("ko-KR")}원`}
                    disabled={amount <= 0}
                    loading={loading}
                    onPay={(selected) => void startPayment(selected)}
                />
            )}

            {providerReady && provider === "CAFE24_BRIDGE" && (
                <p className="text-sm font-bold text-[var(--color-academy-ink)]">본사 카페24 결제창으로 이동합니다.</p>
            )}

            {error && (
                <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] p-2 text-sm font-bold text-[var(--color-academy-danger)]">
                    {error}
                </p>
            )}

            {/* 토스가 아닐 때(카페24·준비 중)의 주 버튼 — 금액만 보여 준다(제공자 이름을 붙이면 좁은 화면에서 두 줄이 됐다) */}
            {!(providerReady && provider === "TOSS") && (
            <button
                type="button"
                onClick={() => void startPayment()}
                disabled={loading || amount <= 0 || !providerReady}
                className="academy-button-primary min-h-12 w-full text-base font-black"
            >
                {loading
                    ? "결제창 여는 중..."
                    : providerReady
                        ? `${amount.toLocaleString("ko-KR")}원 결제하기`
                        : "온라인 결제 준비 중"}
            </button>
            )}

            {/* 부가 안내는 접어 둔다 — 첫 화면에는 «결제 안내» 한 줄만 */}
            {providerReady && provider === "TOSS" && (
                <details className="text-xs text-[var(--color-academy-muted)]">
                    <summary className="flex min-h-11 cursor-pointer items-center justify-center font-bold">결제 안내</summary>
                    <ul className="space-y-1 pb-1">
                        <li>· 카드·계좌이체는 결제하면 바로 납부 완료돼요.</li>
                        <li>· 무통장입금은 받은 계좌로 90일 안에 아무 은행에서 입금해요.</li>
                        <li>· 현금영수증은 결제창에서 번호를 넣으면 발급돼요.</li>
                        {/* 비회원 링크 화면에는 영수증 링크를 두지 않는다(링크를 받은 다른 사람에게 카드 영수증 노출 방지) */}
                        {!guestToken && <li>· 영수증은 납부 후 이 화면과 청구 탭에서 볼 수 있어요.</li>}
                    </ul>
                </details>
            )}
        </div>
    );
}
