"use client";

/**
 * 관리자 — 체육관 대관 신청 목록(/admin/rental).
 * 한 줄 행 목록 + 상태 칩 + 행 클릭 상세 패널. 작업 버튼(⚡·패널)은 같은 목록(buildActions)을 쓴다.
 * 누를 수 있는 버튼은 규칙 모듈의 상태 전이표(allowedRentalActions)에서 나온다 — 서버도 같은 표로 다시 검사한다.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminMessageText } from "@/components/admin/adminDisplayText";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { kstLabel } from "@/lib/datetime/kst";
import {
  RENTAL_STATUSES,
  RENTAL_STATUS_LABEL,
  RENTAL_TRANSITIONS,
  allowedRentalActions,
  formatRentalPhone,
  formatWon,
  rentalTimeLabel,
  type RentalAction,
  type RentalStatus,
} from "@/lib/rental/gym-rental-rules";
import { updateRentalStatus, type AdminRentalRow } from "@/app/actions/rental";

const ACTION_ICON: Record<RentalAction, string> = {
  approve: "check_circle",
  reject: "block",
  confirmPayment: "payments",
  complete: "task_alt",
  refund: "currency_exchange",
  cancel: "event_busy",
};

// 상태 배지 색 — 뜻이 정해진 토큰만(처리할 일 = 경고, 확정 = 성공, 끝난 일 = 흐리게)
const STATUS_TONE: Record<RentalStatus, string> = {
  REQUESTED: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
  APPROVED: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]",
  PAID: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
  COMPLETED: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
  REFUNDED: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
  REJECTED: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
  CANCELLED: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
};

// 확인 창 문구 — 무엇이 일어나는지 한두 줄
const CONFIRM_TEXT: Partial<Record<RentalAction, { description: string; tone: "danger" | "primary" }>> = {
  approve: { description: "이 시간이 다른 신청에 대해 막힙니다. 신청자에게 입금 계좌를 안내해 주세요.", tone: "primary" },
  reject: { description: "신청을 거절합니다. 신청자에게는 따로 연락해 주세요.", tone: "danger" },
  confirmPayment: { description: "입금을 확인하고 대관을 확정합니다.", tone: "primary" },
  refund: { description: "보증금 환불을 마친 것으로 기록합니다. 차감했다면 실제 돌려준 금액을 적어 주세요.", tone: "primary" },
  cancel: { description: "대관을 취소하고 이 시간을 다시 열어 둡니다. 입금을 받았다면 따로 환불해 주세요.", tone: "danger" },
};

function StatusBadge({ status }: { status: RentalStatus }) {
  return (
    <span className={`inline-flex rounded-md px-1.5 py-0.5 text-xs font-bold ${STATUS_TONE[status] ?? ""}`}>
      {RENTAL_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function RentalAdminClient({ rows }: { rows: AdminRentalRow[] }) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: RentalAction } | null>(null);
  const [memo, setMemo] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.status, (map.get(row.status) ?? 0) + 1);
    return map;
  }, [rows]);
  const chips = RENTAL_STATUSES.map((status) => ({ value: status, label: RENTAL_STATUS_LABEL[status], count: counts.get(status) ?? 0 }));
  const visible = statusFilter === "ALL" ? rows : rows.filter((row) => row.status === statusFilter);

  function run(id: string, action: RentalAction, options: { memo?: string; depositRefunded?: number | null } = {}) {
    setError("");
    startTransition(async () => {
      const result = await updateRentalStatus(id, action, options);
      if (!result.ok) {
        setError(adminMessageText(result.error, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      setConfirming(null);
      setMemo("");
      setRefundAmount("");
      router.refresh();
    });
  }

  function openConfirm(row: AdminRentalRow, action: RentalAction) {
    setError("");
    setMemo("");
    setRefundAmount(action === "refund" ? String(row.deposit) : "");
    setConfirming({ id: row.id, action });
  }

  function buildActions(row: AdminRentalRow): AdminQuickAction[] {
    const id = row.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
    // 순서: 진행 버튼 먼저, 거절·취소(위험)는 뒤로
    const actions = allowedRentalActions(row.status).sort((a, b) => Number(a === "reject" || a === "cancel") - Number(b === "reject" || b === "cancel"));
    return actions.map((action) => ({
      key: action,
      label: RENTAL_TRANSITIONS[action].label,
      icon: ACTION_ICON[action],
      tone: action === "reject" || action === "cancel" ? "danger" : action === "complete" ? "default" : "primary",
      disabled: pending,
      // 사용 완료는 되돌릴 일이 적고 돈이 오가지 않아 바로 처리, 나머지는 확인 창
      onSelect: () => (CONFIRM_TEXT[action] ? openConfirm(row, action) : run(id, action)),
    }));
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  const detail = detailId ? rows.find((row) => row.id === detailId) ?? null : null;
  const confirmRow = confirming ? rows.find((row) => row.id === confirming.id) ?? null : null;
  const confirmText = confirming ? CONFIRM_TEXT[confirming.action] : undefined;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-black text-[var(--color-academy-ink)]">
          <span className="material-symbols-outlined text-[var(--color-academy-primary)]" aria-hidden="true">sports_basketball</span>
          체육관 대관
        </h1>
        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
          홈페이지 «체육관 대관»에서 들어온 신청입니다. 승인 → 입금 확인(확정) → 사용 완료 → 보증금 환불 순서로 눌러 주세요. 승인한 시간은 다른 신청에서 막힙니다.
        </p>
      </div>

      <StatusCountChips items={chips} selected={statusFilter} onSelect={setStatusFilter} ariaLabel="대관 상태별 건수" />

      {error && !confirming && (
        <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-danger)]">{error}</p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-academy-line)] px-4 py-4 text-center text-sm text-[var(--color-academy-muted)]">
          {rows.length === 0 ? "아직 들어온 대관 신청이 없습니다." : "이 상태의 신청이 없습니다."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
              <tr>
                <th className="admin-cell-center px-2 py-2">상태</th>
                <th className="admin-cell-num px-2 py-2">이용일</th>
                <th className="admin-cell-num px-2 py-2">시간</th>
                <th className="px-2 py-2">신청자</th>
                <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">인원</th>
                <th className="admin-cell-num px-2 py-2">금액</th>
                <th className="admin-cell-num hidden px-2 py-2 md:table-cell">신청일</th>
                <th className="admin-cell-center px-2 py-2">처리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {visible.map((row) => {
                const actions = buildActions(row);
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    aria-label={`${row.applicantName} 대관 신청 상세 보기`}
                    onClick={() => setDetailId(row.id)}
                    onKeyDown={(event) => handleRowKeyDown(event, row.id)}
                    className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                  >
                    <td className="admin-cell-center px-2 py-1.5"><StatusBadge status={row.status} /></td>
                    <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{kstLabel(row.rentalDate)}</td>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{rentalTimeLabel(row.startHour, row.endHour)}</td>
                    <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{row.applicantName}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-ink)] sm:table-cell">{row.headcount}명{row.useAircon ? " · 냉난방" : ""}</td>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{formatWon(row.totalAmount)}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{kstLabel(row.createdAt)}</td>
                    <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                      {actions.length > 0
                        ? <AdminQuickActionMenu label={`${row.applicantName} 대관 빠른 작업`} actions={actions} />
                        : <span className="text-xs text-[var(--color-academy-muted)]">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && !confirming && (
        <ListDetailPanel onClose={() => setDetailId(null)} titleId="rental-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-4 flex items-center gap-2">
            <h3 id="rental-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{detail.applicantName}</h3>
            <StatusBadge status={detail.status} />
            <button
              type="button"
              onClick={() => setDetailId(null)}
              aria-label="닫기"
              className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
            >
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="font-bold text-[var(--color-academy-muted)]">이용</dt>
            <dd className="text-[var(--color-academy-ink)]">{kstLabel(detail.rentalDate)} {rentalTimeLabel(detail.startHour, detail.endHour)}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">연락처</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">
              <a href={`tel:${detail.applicantPhone}`} className="underline">{formatRentalPhone(detail.applicantPhone)}</a>
            </dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">인원</dt>
            <dd className="text-[var(--color-academy-ink)]">{detail.headcount}명{detail.useAircon ? " · 냉난방 사용" : ""}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">목적</dt>
            <dd className="whitespace-pre-wrap break-keep text-[var(--color-academy-ink)]">{detail.purpose || "—"}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">금액</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">
              이용료 {formatWon(detail.usageFee)} + 보증금 {formatWon(detail.deposit)} = <b>{formatWon(detail.totalAmount)}</b>
            </dd>
            {detail.depositRefunded !== null && (
              <>
                <dt className="font-bold text-[var(--color-academy-muted)]">환불</dt>
                <dd className="tabular-nums text-[var(--color-academy-ink)]">{formatWon(detail.depositRefunded)}{detail.depositRefunded < detail.deposit ? ` (차감 ${formatWon(detail.deposit - detail.depositRefunded)})` : ""}</dd>
              </>
            )}
            <dt className="font-bold text-[var(--color-academy-muted)]">신청일</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detail.createdAt)}</dd>
            {detail.adminMemo && (
              <>
                <dt className="font-bold text-[var(--color-academy-muted)]">메모</dt>
                <dd className="whitespace-pre-wrap break-keep text-[var(--color-academy-ink)]">{detail.adminMemo}</dd>
              </>
            )}
          </dl>
          <AdminPanelActions actions={buildActions(detail)} onBeforeSelect={() => setDetailId(null)} />
        </ListDetailPanel>
      )}

      {confirming && confirmRow && confirmText && (
        <AdminConfirmDialog
          titleId="rental-confirm-title"
          title={`${confirmRow.applicantName} · ${RENTAL_TRANSITIONS[confirming.action].label}`}
          description={
            <div className="space-y-2">
              <p>{kstLabel(confirmRow.rentalDate)} {rentalTimeLabel(confirmRow.startHour, confirmRow.endHour)} · {formatWon(confirmRow.totalAmount)}</p>
              <p>{confirmText.description}</p>
              {confirming.action === "refund" && (
                <label className="block font-bold text-[var(--color-academy-ink)]">
                  돌려준 보증금(원)
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={confirmRow.deposit}
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    className="mt-1 block min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 font-normal tabular-nums"
                  />
                </label>
              )}
              <label className="block font-bold text-[var(--color-academy-ink)]">
                메모(선택)
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  maxLength={200}
                  placeholder={confirming.action === "refund" ? "예: 정리 미흡 5,000원 차감" : "예: 전화로 안내함"}
                  className="mt-1 block min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 font-normal"
                />
              </label>
            </div>
          }
          confirmLabel={RENTAL_TRANSITIONS[confirming.action].label}
          tone={confirmText.tone}
          pending={pending}
          error={error}
          onCancel={() => setConfirming(null)}
          onConfirm={() => run(confirming.id, confirming.action, {
            memo,
            depositRefunded: confirming.action === "refund" ? (refundAmount === "" ? null : Number(refundAmount)) : null,
          })}
        />
      )}
    </div>
  );
}
