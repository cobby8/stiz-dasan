import { GUEST_PAY_INVALID_MESSAGE } from "@/lib/payments/guestPayLinkRules";

/**
 * 잘못된·만료·취소 링크 공통 화면 — 어떤 이유인지 구분하지 않는다(링크가 있었는지조차 알리지 않는다).
 * 전화번호가 있으면 바로 걸 수 있게 한 줄.
 */
export default function GuestPayInvalid({ contactPhone }: { contactPhone?: string | null }) {
    const tel = String(contactPhone ?? "").replace(/[^0-9]/g, "");
    return (
        <main className="mx-auto max-w-lg px-4 py-8">
            <div className="academy-panel p-4 text-center">
                <span className="material-symbols-outlined text-3xl leading-none text-[var(--color-academy-muted)]" aria-hidden="true">link_off</span>
                <p className="mt-1 font-bold text-[var(--color-academy-ink)]">{GUEST_PAY_INVALID_MESSAGE}</p>
                {tel && (
                    <a href={`tel:${tel}`} className="academy-button-secondary mt-3 min-h-11 px-5 text-sm">
                        <span className="material-symbols-outlined text-lg leading-none" aria-hidden="true">call</span>
                        학원 전화 {contactPhone}
                    </a>
                )}
            </div>
        </main>
    );
}
