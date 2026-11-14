"use client";

/**
 * 관리자 직접 수강 변경(상태 변경·반 이동) 뒤 화면 안내 두 가지 (2026-11-14 김루빈 사례 재발 방지)
 *
 * 1) OpenRequestsBox — «처리 중 신청 N건» 확인 상자. [함께 정리하고 저장] 또는 «수강 변경 신청»에서 먼저 처리.
 * 2) EnrollmentCleanupNotice — 저장 뒤 결과(신청 정리·결석 취소·보강권 회수·정리 못 한 결석) + 끝난 반의 미납 청구 목록.
 *    청구는 돈과 연결돼 자동으로 지우지 않는다 — 원장이 «청구/수납»에서 직접 확인하게 길만 안내한다.
 *
 * 금액: 미납 청구 1건의 금액은 부원장도 볼 수 있는 값(moneyAccess 규칙)이라 그대로 보여 주고, 합계는 만들지 않는다.
 */
import Link from "next/link";
import { cleanupResultMessage, type EnrollmentEndCleanupSummary, type OpenRequestView } from "@/lib/enrollment/enrollment-end-cleanup";

export function OpenRequestsBox({
    code,
    message,
    requests,
    busy,
    onConfirm,
}: {
    code: "OPEN_REQUESTS" | "BLOCKED_REQUESTS";
    message: string;
    requests: OpenRequestView[];
    busy: boolean;
    /** «함께 정리하고 저장» — 막힌(BLOCKED) 경우엔 버튼을 보이지 않는다 */
    onConfirm: () => void;
}) {
    const blocked = code === "BLOCKED_REQUESTS";
    return (
        <div role="alert" className="space-y-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
            <p className="font-medium">{message}</p>
            <ul className="space-y-0.5 text-xs text-[var(--color-academy-muted)]">
                {requests.map((r) => <li key={r.id}>· {r.label}</li>)}
            </ul>
            <p className="text-xs text-[var(--color-academy-muted)]">
                {blocked
                    ? "청구서·휴원 정산·반영 처리가 걸려 있어 여기서는 닫을 수 없어요."
                    : "함께 정리하면 이 신청들은 «학원에서 처리함»으로 닫히고 더 적용되지 않아요."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <Link href="/admin/enrollment-changes" className="academy-button-secondary academy-button-sm">수강 변경 신청에서 처리</Link>
                {!blocked && (
                    <button type="button" onClick={onConfirm} disabled={busy} className="academy-button-primary academy-button-sm">
                        {busy ? "저장 중…" : "함께 정리하고 저장"}
                    </button>
                )}
            </div>
        </div>
    );
}

/** 저장 뒤 결과 안내 — 할 일이 없었으면 아무것도 그리지 않는다 */
export function hasCleanupNotice(cleanup: EnrollmentEndCleanupSummary | null | undefined): boolean {
    if (!cleanup) return false;
    return Boolean(cleanupResultMessage(cleanup)) || cleanup.unpaidPayments.length > 0;
}

export function EnrollmentCleanupNotice({
    cleanup,
    canManageFinance,
    onOpenBilling,
    onClose,
}: {
    cleanup: EnrollmentEndCleanupSummary;
    /** 원장만 «청구/수납» 탭이 있다 */
    canManageFinance: boolean;
    onOpenBilling: () => void;
    onClose: () => void;
}) {
    const summary = cleanupResultMessage(cleanup);
    const unpaid = cleanup.unpaidPayments;
    return (
        <div className="mb-3 space-y-2 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
            <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 font-medium">{summary || "함께 정리할 기록은 없었어요."}</p>
                <button type="button" onClick={onClose} className="academy-button-text academy-button-sm shrink-0">닫기</button>
            </div>
            {unpaid.length > 0 && (
                <div className="space-y-1">
                    <p className="text-xs font-medium text-[var(--color-academy-warning)]">
                        끝난 반에 남은 미납 청구 {unpaid.length}건 — 자동으로 지우지 않았어요. 확인 후 수정·삭제해 주세요.
                    </p>
                    <ul className="space-y-0.5 text-xs text-[var(--color-academy-muted)]">
                        {unpaid.map((p) => (
                            <li key={p.id}>
                                · {p.className} · {p.monthLabel}
                                {p.amount != null ? ` · ${p.amount.toLocaleString("ko-KR")}원` : ""}
                                {p.partial ? " · 효력일이 낀 달(일부 다님)" : ""}
                            </li>
                        ))}
                    </ul>
                    {canManageFinance ? (
                        <button type="button" onClick={onOpenBilling} className="academy-button-tonal academy-button-sm">청구/수납에서 확인</button>
                    ) : (
                        <p className="text-xs text-[var(--color-academy-muted)]">원장님께 «청구/수납»에서 확인을 부탁해 주세요.</p>
                    )}
                </div>
            )}
        </div>
    );
}
