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
                <p className="font-bold text-[var(--color-academy-ink)]">{GUEST_PAY_INVALID_MESSAGE}</p>
                {tel && (
                    <a href={`tel:${tel}`} className="academy-button-secondary mt-3">
                        학원 전화 {contactPhone}
                    </a>
                )}
            </div>
        </main>
    );
}
