import { ACADEMY_GUIDE_FACTS } from "@/lib/trial-fee/guideMessages";

// 체험수업 오시는 길·준비물·확정 조건 — 신청 완료 화면과 체험비 결제 화면이 같이 쓴다.
// 원장 안내문(2026-11-10 m8)에 있던 사실만 담는다: 위치·체험비·준비물(실내용 운동화/운동복장/물)·확정 조건.
// 훅이 없는 표시 부품이라 서버·클라이언트 화면 어디서나 쓸 수 있다.
export default function TrialVisitGuide({ feeLabel, onlinePayment }: { feeLabel: string; onlinePayment: boolean }) {
    const rows: Array<[string, string]> = [
        ["위치", `${ACADEMY_GUIDE_FACTS.address} (${ACADEMY_GUIDE_FACTS.branch})`],
        ["체험비", feeLabel],
        ["준비물", ACADEMY_GUIDE_FACTS.trialSupplies],
        ["확정", onlinePayment
            ? "체험수업비 결제가 확인되면 체험수업이 확정돼요."
            : "체험수업비 입금이 확인되면 체험수업이 확정돼요."],
    ];
    return (
        <dl className="grid gap-1.5 rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-3 text-left text-sm">
            {rows.map(([label, value]) => (
                <div key={label} className="flex gap-3">
                    <dt className="w-14 shrink-0 font-bold text-[var(--color-public-muted)]">{label}</dt>
                    <dd className="min-w-0 break-keep font-semibold text-[var(--color-public-ink)]">{value}</dd>
                </div>
            ))}
            <p className="mt-1 text-xs text-[var(--color-public-muted)]">수업 시간과 반은 담당자가 한 번 더 안내드려요.</p>
        </dl>
    );
}
