"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";
import PaymentMethodPicker from "@/components/parent/PaymentMethodPicker";
import { requestTossWithFallback, serverMethodFor, type PreferredPaymentMethod } from "@/lib/payments/preferredMethod";
import { todayKst } from "@/lib/datetime/kst";
import { VIRTUAL_ACCOUNT_VALID_HOURS, type PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import type { BundleCheckoutCandidate } from "@/lib/payment-ledger";

// 학부모 «한 번에 결제» 화면.
// 흐름: 미납 청구 체크(결제 가능한 건 기본 전부 체크) → 결제 방식 고르기 → 토스 결제창 1번 → /mypage/payments/done.
// 막힌 청구(대표 보호자 아님·랠리즈 청구 등)는 체크할 수 없고 이유를 그 줄에 적는다.
// 계좌로 직접 입금했다면 고른 청구를 한 번에 «입금했어요»로 알린다(서버가 건마다 확인 요청을 만든다).

// 결제 방법 버튼(간편결제 3종·카드·계좌이체·무통장입금)은 단건 화면과 같은 부품(PaymentMethodPicker)을 쓴다.

/** POST /api/mypage/payments/checkout 응답(서버 계약 9463c9ce) */
type CheckoutResponse = {
    ok?: boolean;
    error?: string;
    clientKey?: string;
    customerKey?: string;
    orderId?: string;
    amount?: number;
    taxFreeAmount?: number;
    orderName?: string;
    customerName?: string;
    customerEmail?: string | null;
    customerMobilePhone?: string;
    successUrl?: string;
    failUrl?: string;
    /** 같은 청구 묶음의 입금 대기 계좌가 이미 있으면 새 결제 대신 그 계좌가 온다 */
    openVirtualAccount?: PublicVirtualAccountView;
    /** 고른 청구가 다른 입금 대기 계좌에 들어 있다(409) — 확인 후 closeOpenVirtualAccount:true 로 다시 */
    openVirtualAccountConflict?: boolean;
    openVirtualAccounts?: (PublicVirtualAccountView & { paymentIds: string[] })[];
    blocked?: string;
};

// 토스 결제창 SDK — 단건 결제 화면(PaymentCheckoutClient)과 같은 v2 standard 스크립트·같은 태그 표시를 쓴다
// (이미 불러온 스크립트가 있으면 다시 넣지 않는다).
type TossFactory = (clientKey: string) => {
    payment: (options: { customerKey: string }) => {
        requestPayment: (options: Record<string, unknown>) => Promise<void>;
    };
};

function loadTossScript(): Promise<TossFactory> {
    const read = () => (window as unknown as { TossPayments?: TossFactory }).TossPayments;
    return new Promise((resolve, reject) => {
        const ready = () => {
            const factory = read();
            if (factory) resolve(factory);
            else reject(new Error("결제창을 불러오지 못했어요."));
        };
        if (read()) return ready();
        const existing = document.querySelector<HTMLScriptElement>("script[data-toss-payments]");
        if (existing) {
            existing.addEventListener("load", ready, { once: true });
            existing.addEventListener("error", () => reject(new Error("토스페이먼츠 결제창을 불러오지 못했어요.")), { once: true });
            return;
        }
        const script = document.createElement("script");
        script.src = "https://js.tosspayments.com/v2/standard";
        script.async = true;
        script.dataset.tossPayments = "true";
        script.onload = ready;
        script.onerror = () => reject(new Error("토스페이먼츠 결제창을 불러오지 못했어요."));
        document.head.appendChild(script);
    });
}

const AMOUNT_CHANGED_MESSAGE = "금액이 바뀌었어요. 다시 확인해 주세요.";

const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;

export default function BundleCheckoutClient({
    items,
    loadFailed = false,
    maxItems,
    maxTotal,
    onlineReady,
    bankAccount = null,
    failed = false,
    failMessage = "",
    preferredMethod = null,
}: {
    items: BundleCheckoutCandidate[];
    loadFailed?: boolean;
    maxItems: number;
    maxTotal: number;
    /** 토스 온라인 결제 설정이 끝났는가(서버 판정) */
    onlineReady: boolean;
    /** 학원 입금 계좌(서버 전용 값, 로그인한 학부모에게만) */
    bankAccount?: string | null;
    /** 토스 결제창에서 실패·취소하고 돌아왔는가(?result=fail) */
    failed?: boolean;
    failMessage?: string;
    /** 지난번(또는 설정에서 고른) 결제 방법 — 서버가 본인 계정에서 읽어 넘긴다 */
    preferredMethod?: PreferredPaymentMethod | null;
}) {
    const router = useRouter();
    // D3: 결제 가능한 청구는 기본 전부 체크
    const [selected, setSelected] = useState<Set<string>>(() => new Set(items.filter((item) => item.selectable).map((item) => item.paymentId)));
    const [method, setMethod] = useState<PreferredPaymentMethod>(preferredMethod ?? "CARD");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState<CheckoutResponse["openVirtualAccounts"] | null>(null);
    // 충돌 안내 문장(서버 문구). 잠금 사이 다른 탭이 계좌를 받은 경우(OPEN_DEPOSIT_EXISTS)는 계좌 목록이 비어 올 수 있다
    const [conflictMessage, setConflictMessage] = useState("");
    const [account, setAccount] = useState<PublicVirtualAccountView | null>(null);
    // «이미 계좌로 입금했어요» 묶음 알림
    const [claimOpen, setClaimOpen] = useState(false);
    const [paidOn, setPaidOn] = useState(() => todayKst());
    const [depositorName, setDepositorName] = useState("");
    const [claimDone, setClaimDone] = useState("");
    const [copied, setCopied] = useState<"" | "ok" | "fail">("");
    const sending = useRef(false);

    // 토스 결제창에서 브라우저 «뒤로»로 돌아오면 페이지가 캐시(bfcache)에서 그대로 살아나 «결제창 여는 중»에 멈춘다 → 풀어 준다
    useEffect(() => {
        const onPageShow = (event: PageTransitionEvent) => {
            if (!event.persisted) return;
            sending.current = false;
            setLoading(false);
        };
        window.addEventListener("pageshow", onPageShow);
        return () => window.removeEventListener("pageshow", onPageShow);
    }, []);

    const selectableCount = items.filter((item) => item.selectable).length;
    const picked = useMemo(() => items.filter((item) => item.selectable && selected.has(item.paymentId)), [items, selected]);
    const total = picked.reduce((sum, item) => sum + item.amount, 0);
    // D5: 한 번에 10건·100만 원까지 — 넘으면 결제 버튼을 막고 나눠 내라고 안내
    const overCount = picked.length > maxItems;
    const overTotal = total > maxTotal;
    const overLimit = overCount || overTotal;

    function toggle(paymentId: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(paymentId)) next.delete(paymentId);
            else next.add(paymentId);
            return next;
        });
        // 고른 묶음이 바뀌면 이전 결과(계좌·충돌 확인)는 맞지 않는다
        setConflict(null);
        setAccount(null);
        setError("");
    }

    // chosen = 이번에 누른 결제 방법(계좌 닫기 확인 뒤 다시 부를 때는 마지막으로 누른 방법)
    async function startPayment(closeOpenVirtualAccount = false, chosen: PreferredPaymentMethod = method) {
        if (sending.current || picked.length === 0 || overLimit || !onlineReady) return;
        sending.current = true;
        setLoading(true);
        setError("");
        try {
            const response = await fetch("/api/mypage/payments/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // 간편결제는 토스에서 카드 결제라 서버에는 CARD 로 보낸다(금액·주문은 서버가 정한다)
                body: JSON.stringify({ paymentIds: picked.map((item) => item.paymentId), method: serverMethodFor(chosen), closeOpenVirtualAccount }),
            });
            const data = (await response.json().catch(() => ({}))) as CheckoutResponse;

            // 다른 입금 대기 계좌와 겹친다 → 닫을지 먼저 묻는다(이중 납부 방지)
            if (data.openVirtualAccountConflict) {
                setConflict(Array.isArray(data.openVirtualAccounts) ? data.openVirtualAccounts : []);
                setConflictMessage(data.error ?? "");
                return;
            }
            if (!response.ok || !data.ok) throw new Error(data.error || "결제를 준비하지 못했어요.");
            // 같은 묶음의 입금 대기 계좌가 이미 있다 → 새로 만들지 않고 그 계좌를 보여 준다
            if (data.openVirtualAccount) {
                setConflict(null);
                setAccount(data.openVirtualAccount);
                return;
            }
            if (!data.clientKey || !data.customerKey || !data.orderId || !data.amount || !data.orderName || !data.successUrl || !data.failUrl) {
                throw new Error("결제 정보가 부족해요. 학원으로 문의해 주세요.");
            }
            // 서버가 다시 계산한 금액이 화면 합계와 다르면(그 사이 청구가 바뀜) 결제창을 열지 않고 목록을 새로 받는다
            if (data.amount !== total) {
                setError(AMOUNT_CHANGED_MESSAGE);
                router.refresh();
                return;
            }
            // 면세 금액은 서버가 항목별로 더한 값을 그대로 넘긴다(빠지면 복합과세로 부가세가 잡힌다 — 그러면 결제하지 않는다)
            if (typeof data.taxFreeAmount !== "number" || !Number.isFinite(data.taxFreeAmount)) {
                throw new Error("결제 금액을 확인하지 못했어요. 학원으로 문의해 주세요.");
            }
            // 이제 결제창을 연다 — 계좌 닫기 확인 창은 할 일을 마쳤으니 닫는다
            setConflict(null);

            const TossPayments = await loadTossScript();
            const payment = TossPayments(data.clientKey).payment({ customerKey: data.customerKey });
            // 간편결제 바로가기가 실패하면(미계약·미지원 등, 취소 제외) 안내 후 통합 결제창으로 한 번 다시 연다
            await requestTossWithFallback(chosen, (part) => payment.requestPayment({
                ...part,
                amount: { currency: "KRW", value: data.amount },
                taxFreeAmount: data.taxFreeAmount,
                orderId: data.orderId,
                orderName: data.orderName,
                successUrl: data.successUrl,
                failUrl: data.failUrl,
                customerEmail: data.customerEmail ?? undefined,
                customerName: data.customerName,
                customerMobilePhone: data.customerMobilePhone,
                // 무통장입금: 단건 화면과 같은 옵션(최대 기한·현금영수증 소득공제 기본·에스크로 없음)
                ...(chosen === "VIRTUAL_ACCOUNT"
                    ? { virtualAccount: { validHours: VIRTUAL_ACCOUNT_VALID_HOURS, cashReceipt: { type: "소득공제" }, useEscrow: false } }
                    : {}),
            }), (message) => setError(message));
        } catch (err) {
            setError(err instanceof Error ? err.message : "결제를 요청하지 못했어요.");
        } finally {
            sending.current = false;
            setLoading(false);
        }
    }

    async function submitClaim() {
        if (sending.current || picked.length === 0 || !paidOn || overLimit) return;
        sending.current = true;
        setLoading(true);
        setError("");
        setClaimDone("");
        try {
            const response = await fetch("/api/mypage/payment-request", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "submit-bundle",
                    paymentIds: picked.map((item) => item.paymentId),
                    paidOn,
                    method: "TRANSFER",
                    depositorName,
                }),
            });
            // 서버가 처리한 뒤 응답만 잃었을 수 있다 — 곧바로 다시 보내지 말고 청구 탭에서 확인하게 한다
            if (response.status >= 500) throw new Error("응답을 확인하지 못했어요. 다시 보내기 전에 청구 탭에서 «확인 중» 표시를 확인해 주세요.");
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data?.ok !== true) throw new Error(typeof data?.error === "string" ? data.error : "요청을 처리하지 못했어요.");
            const skipped = Array.isArray(data.alreadyPending) ? data.alreadyPending.length : 0;
            setClaimDone(`입금 확인 요청을 보냈어요(${Array.isArray(data.submitted) ? data.submitted.length : picked.length}건). 학원에서 확인 후 알려드려요.${skipped > 0 ? ` 이미 확인 중인 ${skipped}건은 빼고 보냈어요.` : ""}`);
            setClaimOpen(false);
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : "요청을 보내지 못했어요.");
        } finally {
            sending.current = false;
            setLoading(false);
        }
    }

    function copyBankAccount() {
        // 계좌번호(숫자)만 복사 — 은행 앱 붙여넣기용. 복사가 막힌 기기는 글자를 길게 눌러 복사
        const digits = (bankAccount ?? "").replace(/[^0-9]/g, "");
        const mark = (value: "ok" | "fail") => {
            setCopied(value);
            window.setTimeout(() => setCopied(""), 2500);
        };
        if (!navigator.clipboard) return mark("fail");
        navigator.clipboard.writeText(digits).then(() => mark("ok")).catch(() => mark("fail"));
    }

    return (
        <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
            <div className="flex items-center justify-between gap-2">
                <h1 className="academy-heading">한 번에 결제</h1>
                <Link href="/mypage/payments" className="academy-button-text shrink-0">청구 목록</Link>
            </div>

            {failed && (
                <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">
                    {failMessage || "결제가 완료되지 않았어요. 다시 시도해 주세요."} 돈은 빠져나가지 않았어요.
                </p>
            )}
            {claimDone && <p role="status" className="rounded-xl bg-[var(--color-academy-success-soft)] p-3 text-sm font-medium text-[var(--color-academy-success)]">{claimDone}</p>}
            {error && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}

            {loadFailed ? (
                <p className="academy-panel p-4 text-sm text-[var(--color-academy-muted)]">청구 목록을 불러오지 못했어요. 잠시 후 다시 열어 주세요.</p>
            ) : items.length === 0 ? (
                <p className="academy-panel p-4 text-center text-sm text-[var(--color-academy-muted)]">납부할 청구가 없어요.</p>
            ) : (
                <>
                    {/* 미납 청구 목록 — 한 줄 행(체크·자녀·항목·금액). 줄 전체를 눌러 체크한다(터치 44px) */}
                    <section aria-labelledby="bundle-list-heading" className="academy-panel overflow-hidden">
                        <h2 id="bundle-list-heading" className="academy-section-title flex items-center justify-between border-b border-[var(--color-academy-line)] px-3 py-2">
                            <span>미납 청구 <span className="text-sm font-normal tabular-nums text-[var(--color-academy-muted)]">{items.length}</span></span>
                            {selectableCount > 1 && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        const all = picked.length === selectableCount;
                                        setSelected(all ? new Set() : new Set(items.filter((item) => item.selectable).map((item) => item.paymentId)));
                                        setConflict(null);
                                        setAccount(null);
                                    }}
                                    className="academy-button-text"
                                >
                                    {picked.length === selectableCount ? "모두 해제" : "모두 선택"}
                                </button>
                            )}
                        </h2>
                        <ul className="divide-y divide-[var(--color-academy-line)]">
                            {items.map((item) => {
                                const checked = item.selectable && selected.has(item.paymentId);
                                return (
                                    <li key={item.paymentId}>
                                        <label className={`flex min-h-12 items-center gap-3 px-3 py-2 ${item.selectable ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}>
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                disabled={!item.selectable || loading}
                                                onChange={() => toggle(item.paymentId)}
                                                className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]"
                                                aria-describedby={item.blockReason ? `block-${item.paymentId}` : undefined}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block break-keep text-sm text-[var(--color-academy-ink)]">
                                                    <span className="mr-1 font-semibold text-[var(--color-academy-ink)]">{item.studentName}</span>
                                                    {item.title}
                                                </span>
                                                {item.blockReason && (
                                                    <span id={`block-${item.paymentId}`} className="block text-xs text-[var(--color-academy-muted)]">{item.blockReason}</span>
                                                )}
                                                {item.pendingDeposit && (
                                                    <span className="block text-xs text-[var(--color-academy-warning)]">입금 대기 계좌가 있어요</span>
                                                )}
                                            </span>
                                            <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{won(item.amount)}</span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>

                    {selectableCount === 0 ? (
                        // 고를 수 있는 청구가 없다(대표 보호자 아님·랠리즈 청구 등) — 이유는 각 줄에 있다
                        <p className="academy-panel p-3 text-sm text-[var(--color-academy-muted)]">
                            결제할 수 있는 청구가 없어요.
                        </p>
                    ) : account ? (
                        // 같은 묶음으로 이미 받은 입금 계좌 — 그 계좌로 입금하면 자동으로 납부 완료된다
                        <section className="space-y-2">
                            <VirtualAccountNotice account={account} />
                            {/* 합계 금액은 위 계좌 안내에 이미 있다 — 묶음이라는 사실만 한 줄로 */}
                            <p className="text-xs text-[var(--color-academy-muted)]">청구 {picked.length}건을 묶은 계좌예요. 합계를 한 번에 입금해 주세요.</p>
                            {!account.expired && (
                                // 카드 등으로 바꾸려면 이 계좌를 닫아야 한다 — 바로 닫지 않고 확인 창으로 넘긴다
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (method === "VIRTUAL_ACCOUNT") setMethod("CARD");
                                        setConflict([{ ...account, paymentIds: picked.map((item) => item.paymentId) }]);
                                        setAccount(null);
                                    }}
                                    className="academy-button-secondary w-full"
                                >
                                    다른 방법으로 결제(계좌가 닫혀요)
                                </button>
                            )}
                        </section>
                    ) : (
                        <section aria-label="결제" className="academy-panel space-y-3 p-3">
                            {/* 합계 한 줄 — 이 화면의 주인공 숫자 */}
                            <p className="flex items-baseline justify-between gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                                <span>선택 <span className="tabular-nums">{picked.length}</span>건</span>
                                <span className="text-lg font-bold tabular-nums">{won(total)}</span>
                            </p>
                            {overLimit && (
                                <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] p-2 text-xs font-medium text-[var(--color-academy-ink)]">
                                    한 번에 {maxItems}건·{won(maxTotal)}까지 결제할 수 있어요. 나눠서 결제해 주세요.
                                </p>
                            )}

                            {onlineReady ? (
                                <>
                                    {conflict ? (
                                        // 위험 확인: 계좌를 닫으면 그 계좌로는 입금할 수 없다 — 무엇이 일어나는지 먼저 알린다
                                        <div role="alertdialog" aria-labelledby="bundle-conflict-title" className="rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                                            <p id="bundle-conflict-title" className="font-semibold">입금 대기 중인 계좌가 있는 청구가 들어 있어요</p>
                                            {conflict.length === 0 && conflictMessage && <p className="mt-1 text-xs">{conflictMessage}</p>}
                                            {conflict.map((va) => (
                                                <p key={va.accountNumber} className="mt-1 break-all text-xs tabular-nums">
                                                    {va.bankName} {va.accountNumber} · {won(va.amount)} · {va.dueLabel}까지
                                                </p>
                                            ))}
                                            <p className="mt-1 text-xs">계좌를 닫고 새로 결제할까요? <b>이미 입금했다면 닫지 말고</b> 잠시 기다려 주세요.</p>
                                            <div className="mt-2 grid grid-cols-2 gap-2">
                                                <button type="button" disabled={loading} onClick={() => setConflict(null)} className="academy-button-secondary">
                                                    그대로 두기
                                                </button>
                                                <button type="button" disabled={loading} onClick={() => void startPayment(true)} className="academy-button-danger-solid">
                                                    {loading ? "계좌 닫는 중..." : "계좌 닫고 결제"}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            {picked.length === 0 && <p className="text-xs text-[var(--color-academy-muted)]">결제할 청구를 선택해 주세요</p>}
                                            {/* 결제 방법 — 지난번 방법 큰 버튼 + 바로가기 버튼 줄(누르면 바로 결제창) */}
                                            <PaymentMethodPicker
                                                preferred={preferredMethod}
                                                amountLabel={won(total)}
                                                disabled={picked.length === 0 || overLimit}
                                                showAmount={picked.length > 0}
                                                loading={loading}
                                                onPay={(chosen) => {
                                                    setMethod(chosen);
                                                    void startPayment(false, chosen);
                                                }}
                                            />
                                        </>
                                    )}
                                    {/* «입금 대기 계좌가 있어요»는 그 청구 줄에 이미 적혀 있어 여기서는 다시 말하지 않는다 */}
                                </>
                            ) : (
                                <p className="text-xs text-[var(--color-academy-muted)]">지금은 온라인 결제를 쓸 수 없어요. 아래 계좌로 입금한 뒤 알려 주세요.</p>
                            )}

                            {/* 계좌로 직접 입금한 경우 — 고른 청구 전부를 한 번에 알린다(보조 버튼) */}
                            <div className="border-t border-[var(--color-academy-line)] pt-3">
                                {bankAccount && (
                                    // 계좌 글과 복사 버튼을 한 줄에 — 버튼은 «복사»로 짧게, 계좌 글은 남은 폭에서 단어 단위로 접힌다
                                    <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                                        <span className="min-w-0 flex-1 break-keep font-semibold tabular-nums text-[var(--color-academy-ink)]">{bankAccount}</span>
                                        <button type="button" onClick={copyBankAccount} aria-label="계좌번호 복사" className="academy-button-secondary shrink-0 whitespace-nowrap">
                                            {copied === "ok" ? "복사됨" : "복사"}
                                        </button>
                                        {copied === "fail" && <span role="status" className="w-full text-xs text-[var(--color-academy-muted)]">복사가 안 됐어요. 계좌번호를 길게 눌러 복사해 주세요.</span>}
                                    </div>
                                )}
                                {!claimOpen ? (
                                    <button
                                        type="button"
                                        disabled={picked.length === 0 || overLimit}
                                        onClick={() => setClaimOpen(true)}
                                        className={`${onlineReady ? "academy-button-secondary" : "academy-button-primary"} w-full`}
                                    >
                                        이미 계좌로 입금했어요 ({picked.length}건)
                                    </button>
                                ) : (
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-2 gap-2">
                                            <label className="text-xs font-medium text-[var(--color-academy-muted)]">
                                                입금한 날짜
                                                <input type="date" value={paidOn} max={todayKst()} onChange={(event) => setPaidOn(event.target.value)} className="academy-input mt-1" />
                                            </label>
                                            <label className="text-xs font-medium text-[var(--color-academy-muted)]">
                                                입금자명 (선택)
                                                <input value={depositorName} maxLength={60} onChange={(event) => setDepositorName(event.target.value)} placeholder="자녀 이름과 다르면" className="academy-input mt-1" />
                                            </label>
                                        </div>
                                        <p className="text-xs text-[var(--color-academy-muted)]">{picked.length}건 · {won(total)} 입금을 학원에 알려요.</p>
                                        <div className="grid grid-cols-2 gap-2">
                                            <button type="button" disabled={loading} onClick={() => setClaimOpen(false)} className="academy-button-secondary">닫기</button>
                                            <button type="button" disabled={loading || !paidOn || picked.length === 0 || overLimit} onClick={() => void submitClaim()} className="academy-button-primary">
                                                {loading ? "보내는 중..." : "확인 요청 보내기"}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </section>
                    )}
                </>
            )}
        </main>
    );
}
