"use client";
/**
 * 청구 준비 «승인 대기» 세 번째 묶음 — «발행 뒤 바뀐 청구 K건»(2026-11-17).
 * 이미 발행된 청구 중 퇴원·반 이동과 어긋난 줄을 한 줄 행으로 보이고, 줄마다 «승인»(취소·금액 변경)·«무시»를 둔다.
 * - 승인할 수 없는 줄(결제 진행 중·POS 요청·이월 등)은 «확인 필요» 배지와 이유만 보인다.
 * - 결제된 청구·반 변경 차감은 목록만(환불·자동 차감 없음).
 * 청구 준비 표(BillingWorkbench)와 따로 불러온다 — 그 화면의 원본 지문·저장 흐름을 건드리지 않게.
 * 학부모 알림·문자는 보내지 않는다(서버도 보내지 않는다).
 */
import { useCallback, useEffect, useState } from "react";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { POST_ISSUE_KIND_LABEL, type PostIssueItem } from "@/lib/billing/post-issue-rules";
import styles from "./workbench.module.css";

type View = { items: PostIssueItem[]; writesEnabled: boolean; calendarMissing: boolean };
const won = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;
const errorText = (failure: unknown, fallback: string) => failure instanceof TypeError || failure instanceof SyntaxError ? fallback : adminErrorText(failure, fallback);

export default function PostIssueChanges() {
    const [view, setView] = useState<View | null>(null);
    const [loadError, setLoadError] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState<PostIssueItem | null>(null);
    const [confirmError, setConfirmError] = useState("");

    const load = useCallback(async () => {
        setLoadError("");
        try {
            const response = await fetch("/api/admin/billing-post-issue", { cache: "no-store" });
            const body = await response.json();
            if (!response.ok || !Array.isArray(body.items)) throw new Error(body.error || "발행 뒤 바뀐 청구를 불러오지 못했습니다.");
            setView(body);
        } catch (failure) { setLoadError(errorText(failure, "발행 뒤 바뀐 청구를 불러오지 못했습니다. 새로고침해 주세요.")); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    // 승인·무시 공용 — 서버가 다시 계산해 화면과 같을 때만 처리하고, 새 목록을 돌려준다
    async function send(payload: Record<string, unknown>, done: string) {
        setBusy(true); setConfirmError(""); setNotice("");
        try {
            const response = await fetch("/api/admin/billing-post-issue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const body = await response.json();
            if (!response.ok) {
                // 그 사이 바뀌었으면 목록을 새로 받아 둔다(창의 오류 글자는 그대로 보인다)
                if (body.refreshRequired) void load();
                throw new Error(body.error || "처리하지 못했습니다. 새로 조회해 주세요.");
            }
            if (body.view && Array.isArray(body.view.items)) setView(body.view);
            setConfirming(null); setNotice(done);
        } catch (failure) {
            const message = errorText(failure, "처리 결과를 확인하지 못했습니다. 새로 조회해 상태를 확인해 주세요.");
            if (payload.action === "APPROVE") setConfirmError(message); else setNotice(message);
        } finally { setBusy(false); }
    }

    const items = view?.items ?? [];
    const editable = Boolean(view?.writesEnabled) && !busy;
    return <>
        <h3 className={styles.approveSub}>발행 뒤 바뀐 청구 {items.length}건</h3>
        {loadError && <p role="alert" className={styles.error}>{loadError}</p>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {view && view.calendarMissing && <p className={styles.muted}>연간 일정을 읽지 못해 반 변경 차액은 «확인 필요»로만 보입니다.</p>}
        {view && !items.length && <p className={styles.muted}>퇴원·반 이동과 어긋난 발행 청구가 없습니다.</p>}
        {items.length > 0 && <ul className={styles.approveList}>{items.map((item) => <li key={item.key} className={styles.approveRow}>
            <span className={`${styles.badge} ${item.kind === "CHECK" ? styles.review : ""}`}>{POST_ISSUE_KIND_LABEL[item.kind]}</span>
            <span className={styles.approveName}><span className={styles.student}>{item.studentName}</span> <span className={styles.muted}>{item.className} · {item.monthLabel}</span></span>
            <span className={styles.reviewReason}>{item.text}</span>
            {item.currentAmount !== null && <span className={styles.approveAmount}>{item.approvable && item.proposedAmount !== null ? `${won(item.currentAmount)} → ${won(item.proposedAmount)}` : won(item.currentAmount)}</span>}
            <span className={styles.postIssueActions}>
                {item.approvable && <button type="button" className={styles.primary} disabled={!editable} onClick={() => { setConfirmError(""); setConfirming(item); }}>승인</button>}
                <button type="button" className={styles.button} disabled={!editable} onClick={() => void send({ action: "DISMISS", key: item.key }, `${item.studentName} 줄을 목록에서 뺐습니다. 청구는 바꾸지 않았습니다.`)}>무시</button>
            </span>
        </li>)}</ul>}
        {view && !view.writesEnabled && items.length > 0 && <p className={styles.muted}>지금은 목록만 볼 수 있습니다. 승인·무시는 청구 준비 저장이 켜진 뒤 사용할 수 있습니다.</p>}
        {confirming && <AdminConfirmDialog titleId="post-issue-approve-title"
            title={confirming.kind === "CANCEL" ? `${confirming.studentName} ${confirming.monthLabel} 청구 ${won(confirming.currentAmount ?? 0)}을 취소합니다` : `${confirming.studentName} ${confirming.monthLabel} 청구를 ${won(confirming.proposedAmount ?? 0)}으로 바꿉니다`}
            description={`${confirming.text}\n학부모에게 알림·문자는 보내지 않습니다.`}
            confirmLabel={confirming.kind === "CANCEL" ? "청구 취소" : "금액 변경"} tone={confirming.kind === "CANCEL" ? "danger" : "primary"}
            pending={busy} pendingLabel="처리 중…" error={confirmError}
            onCancel={() => setConfirming(null)}
            onConfirm={() => void send({ action: "APPROVE", key: confirming.key, kind: confirming.kind, paymentId: confirming.paymentId, currentAmount: confirming.currentAmount, proposedAmount: confirming.proposedAmount },
                confirming.kind === "CANCEL" ? `${confirming.studentName} ${confirming.monthLabel} 청구를 취소했습니다. 학부모에게는 보내지 않았습니다.` : `${confirming.studentName} ${confirming.monthLabel} 청구를 ${won(confirming.proposedAmount ?? 0)}으로 바꿨습니다. 학부모에게는 보내지 않았습니다.`)} />}
    </>;
}
