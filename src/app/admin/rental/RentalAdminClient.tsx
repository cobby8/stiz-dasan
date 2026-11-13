"use client";

/**
 * 관리자 — 체육관 대관 신청 목록(/admin/rental).
 * 한 줄 행 목록 + 상태 칩 + 행 클릭 상세 패널. 작업 버튼(⚡·패널)은 같은 목록(buildActions)을 쓴다.
 * 누를 수 있는 버튼은 규칙 모듈의 상태 전이표(allowedRentalActions)에서 나온다 — 서버도 같은 표로 다시 검사한다.
 * 2026-11-08: 재원생 무료 배지 · 거절 사유(필수) · 확인창 문자 미리보기 · 환불 계좌(사용 완료 단계) · «문자 실패» 표시.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminMessageText } from "@/components/admin/adminDisplayText";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { kstLabel } from "@/lib/datetime/kst";
import { statusBadgeClass } from "@/lib/ui/statusTones";
import {
  RENTAL_CLOSE_HOUR,
  RENTAL_DURATION_STEP_MINUTES,
  RENTAL_MAX_HEADCOUNT,
  RENTAL_MAX_MINUTES,
  RENTAL_MIN_MINUTES,
  RENTAL_OPEN_HOUR,
  RENTAL_REJECT_REASONS,
  RENTAL_STATUSES,
  RENTAL_STATUS_LABEL,
  RENTAL_TRANSITIONS,
  allowedRentalActions,
  buildRentalApplicantMessage,
  calculateRentalFee,
  formatRentalPhone,
  isRentalEditable,
  formatWon,
  rentalTimeText,
  rentalTransitionTarget,
  type RentalAction,
  type RentalApplicantKind,
  type RentalStatus,
} from "@/lib/rental/gym-rental-rules";
import { editRentalRequest, updateRentalStatus, type AdminRentalRow } from "@/app/actions/rental";
// 신청함 «대관» 탭에 끼울 때 «처리할 것 / 완료»를 나누는 기준 — 신청함과 같은 칸 판정(catalog 한 곳)
import { bucketFor, deriveRentalStatus } from "@/lib/requests/catalog";

const ACTION_ICON: Record<RentalAction, string> = {
  approve: "check_circle",
  reject: "block",
  confirmPayment: "payments",
  complete: "task_alt",
  refund: "currency_exchange",
  cancel: "event_busy",
};

// 상태 배지 색 — 뜻이 정해진 토큰만(처리할 일 = 경고, 확정 = 성공, 끝난 일 = 흐리게)
// 대관 상태 → 공용 상태색(statusTones). 승인 대기 주의 · 입금 대기 정보(진행 중) · 확정 정상 · 거절 위험 ·
// 사용 완료·환불·취소 중립(끝난 일). 예전엔 «사용 완료»가 «승인 대기»와 같은 노랑이라 처리할 일처럼 보였다.
const STATUS_TONE: Record<RentalStatus, string> = {
  REQUESTED: statusBadgeClass("warning"),
  APPROVED: statusBadgeClass("info"),
  PAID: statusBadgeClass("success"),
  COMPLETED: statusBadgeClass("neutral"),
  REFUNDED: statusBadgeClass("neutral"),
  REJECTED: statusBadgeClass("danger"),
  CANCELLED: statusBadgeClass("neutral"),
};

// 확인 창 문구 — 무엇이 일어나는지 한두 줄
const CONFIRM_TEXT: Partial<Record<RentalAction, { description: string; tone: "danger" | "primary" }>> = {
  approve: { description: "이 시간이 다른 신청에 대해 막힙니다. 신청자에게 입금 계좌를 안내합니다.", tone: "primary" },
  reject: { description: "신청을 거절합니다. 사유가 신청자 문자에 그대로 나갑니다.", tone: "danger" },
  confirmPayment: { description: "입금을 확인하고 대관을 확정합니다.", tone: "primary" },
  refund: { description: "보증금 환불을 마친 것으로 기록합니다. 차감했다면 실제 돌려준 금액을 적어 주세요.", tone: "primary" },
  cancel: { description: "대관을 취소하고 이 시간을 다시 열어 둡니다. 입금을 받았다면 실제로 돌려준 금액을 적어 주세요.", tone: "danger" },
};

// 버튼 → 신청자 문자 종류(미리보기용 · 서버 updateRentalStatus 와 같은 짝)
const SMS_KIND: Partial<Record<RentalAction, RentalApplicantKind>> = { approve: "approved", reject: "rejected", confirmPayment: "confirmed" };
const CUSTOM_REASON = "__custom__";

// 시작 시각 후보(10분 간격) · 이용 시간 후보(30분 간격). 실제로 비어 있는지는 서버가 수업·대관과 다시 맞춰 본다.
const START_OPTIONS = Array.from({ length: (RENTAL_CLOSE_HOUR - 1 - RENTAL_OPEN_HOUR) * 6 + 1 }, (_, i) => RENTAL_OPEN_HOUR * 60 + i * 10);
const DURATION_OPTIONS = Array.from(
  { length: (RENTAL_MAX_MINUTES - RENTAL_MIN_MINUTES) / RENTAL_DURATION_STEP_MINUTES + 1 },
  (_, i) => RENTAL_MIN_MINUTES + i * RENTAL_DURATION_STEP_MINUTES,
);
const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const durationText = (minute: number) => `${Math.floor(minute / 60)}시간${minute % 60 ? " 30분" : ""}`;
type EditForm = { id: string; rentalDate: string; startMinute: number; durationMinutes: number; headcount: string; useAircon: boolean; notify: boolean };

type SmsOn = Record<RentalApplicantKind, boolean>;

function StatusBadge({ status }: { status: RentalStatus }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs ${STATUS_TONE[status] ?? ""}`}>
      {RENTAL_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** «재원생 무료(학생명)» 배지 */
function MemberBadge({ row }: { row: AdminRentalRow }) {
  if (!row.memberFree) return null;
  return (
    <span className="inline-flex rounded bg-[var(--color-academy-success-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-success)]">
      재원생 무료{row.memberStudentName ? `(${row.memberStudentName})` : ""}
    </span>
  );
}

/** 마지막 신청자 문자가 실패했으면 «문자 실패» */
function smsFailed(row: AdminRentalRow): boolean {
  return String(row.applicantSmsStatus ?? "").startsWith("FAILED");
}

/**
 * embedded = 신청함 «대관» 탭 안에 끼운 모양(2026-11-10 원장 결정 k1·k2).
 * 제목·상태 칩을 숨기고 «처리할 것(승인 대기 → 진행 중)» 먼저, 끝난 건은 맨 아래 «완료 보기»로 접는다.
 * 처리 버튼·확인 창·문자 미리보기는 옛 대관 화면과 같은 코드 그대로다.
 */
export default function RentalAdminClient({ rows, bankAccount, smsOn, embedded = false }: { rows: AdminRentalRow[]; bankAccount: string; smsOn: SmsOn; embedded?: boolean }) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: RentalAction } | null>(null);
  const [memo, setMemo] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [reasonChoice, setReasonChoice] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [pending, startTransition] = useTransition();
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<EditForm | null>(null);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.status, (map.get(row.status) ?? 0) + 1);
    return map;
  }, [rows]);
  const chips = RENTAL_STATUSES.map((status) => ({ value: status, label: RENTAL_STATUS_LABEL[status], count: counts.get(status) ?? 0 }));
  // 끼운 모양: 처리 필요(승인 대기) → 진행 중(입금 대기·확정·환불 대기) 순, 같은 칸 안은 원래 순서 유지. 완료는 펼쳤을 때만 맨 아래
  // 보증금 0원(재원생 무료) 대관의 «사용 완료»는 끝난 일(deriveRentalStatus)
  const rank = (row: AdminRentalRow) => ({ ACTION: 0, ONGOING: 1, DONE: 2 })[bucketFor("RENTAL", deriveRentalStatus(row.status, row.deposit))];
  const openRows = embedded ? rows.filter((row) => rank(row) < 2).sort((a, b) => rank(a) - rank(b)) : [];
  const doneRows = embedded ? rows.filter((row) => rank(row) === 2) : [];
  const visible = embedded
    ? [...openRows, ...(showDone ? doneRows : [])]
    : statusFilter === "ALL" ? rows : rows.filter((row) => row.status === statusFilter);

  const rejectReason = reasonChoice === CUSTOM_REASON ? customReason.trim() : reasonChoice;

  function run(
    id: string,
    action: RentalAction,
    options: { memo?: string; depositRefunded?: number | null; cancelRefund?: number | null; rejectReason?: string } = {},
  ) {
    setError("");
    setNotice("");
    startTransition(async () => {
      const result = await updateRentalStatus(id, action, options);
      if (!result.ok) {
        setError(adminMessageText(result.error, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      // 상태는 바뀌었다. 문자만 실패했으면 따로 알린다(전화로 안내할 수 있게)
      if (result.sms === "FAILED") setNotice("처리는 끝났지만 신청자 문자를 보내지 못했어요. 전화로 안내해 주세요.");
      setConfirming(null);
      setMemo("");
      setRefundAmount("");
      setReasonChoice("");
      setCustomReason("");
      router.refresh();
    });
  }

  function openConfirm(row: AdminRentalRow, action: RentalAction) {
    setError("");
    setMemo("");
    setReasonChoice("");
    setCustomReason("");
    setRefundAmount(action === "refund" ? String(row.deposit) : "");
    setConfirming({ id: row.id, action });
  }

  function openEdit(row: AdminRentalRow) {
    setError("");
    setNotice("");
    setEditing({
      id: row.id,
      rentalDate: row.rentalDate,
      startMinute: row.startMinute,
      durationMinutes: row.endMinute - row.startMinute,
      headcount: String(row.headcount),
      useAircon: row.useAircon,
      notify: true,
    });
  }

  function saveEdit(form: EditForm) {
    setError("");
    startTransition(async () => {
      const result = await editRentalRequest(
        form.id,
        { rentalDate: form.rentalDate, startMinute: form.startMinute, durationMinutes: form.durationMinutes, headcount: Number(form.headcount), useAircon: form.useAircon },
        { notify: form.notify },
      );
      if (!result.ok) {
        setError(adminMessageText(result.error, "고치지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      setEditing(null);
      if (!result.changed) setNotice("바뀐 내용이 없어 그대로 두었습니다.");
      else if (result.sms === "FAILED") setNotice("내용은 고쳤지만 신청자 문자를 보내지 못했어요. 전화로 안내해 주세요.");
      else if (result.sms === "SENT") setNotice("내용을 고치고 바뀐 안내 문자를 보냈습니다.");
      else setNotice("내용을 고쳤습니다. 바꾼 기록은 메모에 남았어요.");
      router.refresh();
    });
  }

  function actionLabel(row: AdminRentalRow, action: RentalAction): string {
    // 입금할 금액이 0원(재원생 2시간 이내)이면 승인 = 바로 확정
    if (action === "approve" && rentalTransitionTarget(action, row) === "PAID") return "승인(바로 확정)";
    return RENTAL_TRANSITIONS[action].label;
  }

  function buildActions(row: AdminRentalRow): AdminQuickAction[] {
    const id = row.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
    // 순서: 진행 버튼 먼저, 거절·취소(위험)는 뒤로. 보증금 0원 건은 «보증금 환불» 단계가 없다(row 를 넘김).
    const actions = allowedRentalActions(row.status, row).sort((a, b) => Number(a === "reject" || a === "cancel") - Number(b === "reject" || b === "cancel"));
    // «내용 수정»은 진행 버튼 뒤에 둔다(위험 버튼은 메뉴가 알아서 맨 아래로 모은다)
    // 수정 가능 기준은 서버와 같은 함수(돈 받기 전 + 무료 확정)
    const edit: AdminQuickAction[] = isRentalEditable(row)
      ? [{ key: "edit", label: "내용 수정", icon: "edit_calendar", tone: "default", disabled: pending, onSelect: () => openEdit(row) }]
      : [];
    return [...actions.map((action): AdminQuickAction => ({
      key: action,
      label: actionLabel(row, action),
      icon: ACTION_ICON[action],
      tone: action === "reject" || action === "cancel" ? "danger" : action === "complete" ? "default" : "primary",
      disabled: pending,
      // 사용 완료는 되돌릴 일이 적고 돈이 오가지 않아 바로 처리, 나머지는 확인 창
      onSelect: () => (CONFIRM_TEXT[action] ? openConfirm(row, action) : run(id, action)),
    })), ...edit];
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  async function copyRefund(row: AdminRentalRow) {
    try {
      await navigator.clipboard.writeText(`${row.refundBank ?? ""} ${row.refundAccount ?? ""}`.trim());
      setCopiedId(row.id);
    } catch {
      setCopiedId("");
    }
  }

  const detail = detailId ? rows.find((row) => row.id === detailId) ?? null : null;
  const confirmRow = confirming ? rows.find((row) => row.id === confirming.id) ?? null : null;
  const confirmText = confirming ? CONFIRM_TEXT[confirming.action] : undefined;
  // 입금 확인(확정)된 대관의 취소 = 돌려준 금액 입력이 필요한 경우
  const paidCancel = confirming?.action === "cancel" && confirmRow?.status === "PAID";
  const smsKind = confirming ? SMS_KIND[confirming.action] : undefined;
  // 보낼 문자 미리보기 — 서버가 보낼 본문과 같은 함수(틀 + 변수)
  let smsPreview = "";
  if (confirmRow && smsKind) {
    try {
      smsPreview = buildRentalApplicantMessage(smsKind, { ...confirmRow, rejectReason: rejectReason || "(사유를 골라 주세요)" }, bankAccount).body;
    } catch {
      smsPreview = "";
    }
  }
  const approveFree = confirming?.action === "approve" && confirmRow ? rentalTransitionTarget("approve", confirmRow) === "PAID" : false;
  // 수정 창 — 바뀐 금액 미리보기(서버가 같은 함수로 다시 계산해 저장한다)
  const editRow = editing ? rows.find((row) => row.id === editing.id) ?? null : null;
  let editFee: ReturnType<typeof calculateRentalFee> | null = null;
  let editFeeError = "";
  if (editing && editRow) {
    try {
      editFee = calculateRentalFee({ durationMinutes: editing.durationMinutes, headcount: Number(editing.headcount), useAircon: editing.useAircon, memberFree: editRow.memberFree });
    } catch (e) {
      editFeeError = (e as Error).message;
    }
  }
  const editInput = "academy-input mt-1 block font-normal tabular-nums";
  const amountDiff = editFee && editRow ? editFee.total - editRow.totalAmount : 0;

  return (
    <div className="space-y-3">
      {!embedded && (
      <AdminPageHeader
        title="체육관 대관"
        description={<>
          홈페이지 «체육관 대관»에서 들어온 신청입니다. 승인 → 입금 확인(확정) → 사용 완료 → 보증금 환불 순서로 눌러 주세요.
          재원생 무료(입금 0원)는 승인하면 바로 확정되고, 보증금이 없어 사용 완료가 마지막입니다.
        </>}
      />
      )}

      {!embedded && <StatusCountChips items={chips} selected={statusFilter} onSelect={setStatusFilter} ariaLabel="대관 상태별 건수" />}

      {error && !confirming && (
        <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{error}</p>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">{notice}</p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-academy-line)] px-4 py-4 text-center text-sm text-[var(--color-academy-muted)]">
          {rows.length === 0 ? "아직 들어온 대관 신청이 없습니다." : embedded ? "처리할 대관이 없습니다." : "이 상태의 신청이 없습니다."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-semibold text-[var(--color-academy-muted)]">
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
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{kstLabel(row.rentalDate)}</td>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{rentalTimeText(row)}</td>
                    <td className="px-2 py-1.5 font-medium text-[var(--color-academy-ink)]">
                      {/* 이름 옆에 배지를 붙여 한 줄 유지(컴팩트) */}
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {row.applicantName}
                        <MemberBadge row={row} />
                        {smsFailed(row) && (
                          <span className="inline-flex rounded-md bg-[var(--color-academy-danger-soft)] px-1.5 py-0.5 text-xs font-normal text-[var(--color-academy-danger)]">문자 실패</span>
                        )}
                      </span>
                    </td>
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

      {/* 끼운 모양: 끝난 대관은 맨 아래 «완료 보기»로 접어 둔다 */}
      {embedded && doneRows.length > 0 && (
        <button type="button" onClick={() => setShowDone((value) => !value)} aria-expanded={showDone} className="academy-button-text">
          {showDone ? "완료 접기" : `완료 보기 ${doneRows.length}`}
          <span aria-hidden="true">{showDone ? "▴" : "▾"}</span>
        </button>
      )}

      {detail && !confirming && !editing && (
        <ListDetailPanel onClose={() => setDetailId(null)} titleId="rental-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-4 flex items-center gap-2">
            <h3 id="rental-detail-panel-title" className="min-w-0 break-keep text-lg font-bold text-[var(--color-academy-ink)]">{detail.applicantName}</h3>
            <StatusBadge status={detail.status} />
            <MemberBadge row={detail} />
            <button
              type="button"
              onClick={() => setDetailId(null)}
              aria-label="닫기"
              className="ml-auto academy-button-text academy-button-sm shrink-0"
            >
              닫기
            </button>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="font-medium text-[var(--color-academy-muted)]">이용</dt>
            <dd className="text-[var(--color-academy-ink)]">{kstLabel(detail.rentalDate)} {rentalTimeText(detail)}</dd>
            <dt className="font-medium text-[var(--color-academy-muted)]">연락처</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">
              <a href={`tel:${detail.applicantPhone}`} className="underline">{formatRentalPhone(detail.applicantPhone)}</a>
            </dd>
            <dt className="font-medium text-[var(--color-academy-muted)]">인원</dt>
            <dd className="text-[var(--color-academy-ink)]">{detail.headcount}명{detail.useAircon ? " · 냉난방 사용" : ""}</dd>
            <dt className="font-medium text-[var(--color-academy-muted)]">목적</dt>
            <dd className="whitespace-pre-wrap break-keep text-[var(--color-academy-ink)]">{detail.purpose || "—"}</dd>
            <dt className="font-medium text-[var(--color-academy-muted)]">금액</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">
              {detail.memberFree ? "재원생 2시간 무료 · " : ""}이용료 {formatWon(detail.usageFee)} + 보증금 {formatWon(detail.deposit)} = <b className="font-semibold">{formatWon(detail.totalAmount)}</b>
            </dd>
            {detail.rejectReason && (
              <>
                <dt className="font-medium text-[var(--color-academy-muted)]">거절 사유</dt>
                <dd className="break-keep text-[var(--color-academy-ink)]">{detail.rejectReason}</dd>
              </>
            )}
            {/* 환불 계좌는 «사용 완료·환불 완료» 단계에서만 서버가 보내 준다 */}
            {detail.refundAccount && (
              <>
                <dt className="font-medium text-[var(--color-academy-muted)]">환불 계좌</dt>
                <dd className="flex flex-wrap items-center gap-2 tabular-nums text-[var(--color-academy-ink)]">
                  <span>{detail.refundBank} {detail.refundAccount} · {detail.refundHolder}</span>
                  <button
                    type="button"
                    onClick={() => copyRefund(detail)}
                    className="academy-button-tonal academy-button-sm"
                  >
                    {copiedId === detail.id ? "복사함" : "복사"}
                  </button>
                </dd>
              </>
            )}
            {detail.depositRefunded !== null && (
              <>
                <dt className="font-medium text-[var(--color-academy-muted)]">환불</dt>
                <dd className="tabular-nums text-[var(--color-academy-ink)]">{formatWon(detail.depositRefunded)}{detail.depositRefunded < detail.deposit ? ` (차감 ${formatWon(detail.deposit - detail.depositRefunded)})` : ""}</dd>
              </>
            )}
            {detail.cancelRefundAmount !== null && (
              <>
                <dt className="font-medium text-[var(--color-academy-muted)]">취소 환불</dt>
                <dd className="tabular-nums text-[var(--color-academy-ink)]">{formatWon(detail.cancelRefundAmount)}</dd>
              </>
            )}
            {smsFailed(detail) && (
              <>
                <dt className="font-medium text-[var(--color-academy-muted)]">문자</dt>
                <dd className="font-medium text-[var(--color-academy-danger)]">마지막 안내 문자 실패 — 전화로 안내해 주세요</dd>
              </>
            )}
            <dt className="font-medium text-[var(--color-academy-muted)]">신청일</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detail.createdAt)}</dd>
            {detail.adminMemo && (
              <>
                <dt className="font-medium text-[var(--color-academy-muted)]">메모</dt>
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
          title={`${confirmRow.applicantName} · ${actionLabel(confirmRow, confirming.action)}`}
          description={
            <div className="space-y-2">
              <p>{kstLabel(confirmRow.rentalDate)} {rentalTimeText(confirmRow)} · {formatWon(confirmRow.totalAmount)}{confirmRow.memberFree ? " · 재원생 무료" : ""}</p>
              <p>{approveFree ? "입금할 금액이 0원이라 승인하면 바로 확정됩니다. 이 시간은 다른 신청에서 막힙니다." : confirmText.description}</p>
              {/* 재원생 무료는 로그인한 학부모 계정의 연결 학생일 때만 들어온다 — 어느 계정이 신청했는지 한 줄로 보인다 */}
              {confirming.action === "approve" && confirmRow.memberFree && (
                <p className="font-medium text-[var(--color-academy-warning)]">
                  재원생 무료 · 로그인 계정: {confirmRow.applicantUserName || "확인 필요"}로 신청(학생: {confirmRow.memberStudentName || "확인 필요"})
                </p>
              )}
              {confirming.action === "reject" && (
                <div className="space-y-1.5">
                  <p className="font-medium text-[var(--color-academy-ink)]">거절 사유(필수)</p>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="거절 사유 빠른 선택">
                    {[...RENTAL_REJECT_REASONS, CUSTOM_REASON].map((reason) => (
                      <button
                        key={reason}
                        type="button"
                        aria-pressed={reasonChoice === reason}
                        onClick={() => setReasonChoice(reason)}
                        className="academy-choice"
                      >
                        {reason === CUSTOM_REASON ? "직접 입력" : reason}
                      </button>
                    ))}
                  </div>
                  {reasonChoice === CUSTOM_REASON && (
                    <input
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      maxLength={100}
                      placeholder="신청자 문자에 그대로 나가요"
                      aria-label="거절 사유 직접 입력"
                      className="academy-input block font-normal"
                    />
                  )}
                </div>
              )}
              {(confirming.action === "refund" || paidCancel) && (
                <label className="block font-medium text-[var(--color-academy-ink)]">
                  {/* 확정(입금 확인) 뒤 취소는 이미 돈을 받았으므로 돌려준 금액을 꼭 적는다(0원도 직접 입력) */}
                  {paidCancel ? `돌려준 금액(원, 필수 · 0 ~ ${confirmRow.totalAmount.toLocaleString("ko-KR")})` : "돌려준 보증금(원)"}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={paidCancel ? confirmRow.totalAmount : confirmRow.deposit}
                    required={paidCancel}
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    className="academy-input mt-1 block font-normal tabular-nums"
                  />
                </label>
              )}
              {/* 보낼 문자 미리보기 — 꺼져 있으면 «문자 꺼짐»(상태만 바뀌고 문자는 안 나간다) */}
              {smsKind && (
                <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-2">
                  <p className="text-xs font-medium text-[var(--color-academy-muted)]">
                    신청자 문자 {smsOn[smsKind] ? "· 보냄" : "· 문자 꺼짐(보내지 않음)"}
                  </p>
                  {smsPreview && <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-keep font-sans text-xs text-[var(--color-academy-ink)]">{smsPreview}</pre>}
                </div>
              )}
              <label className="block font-medium text-[var(--color-academy-ink)]">
                메모(선택)
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  maxLength={200}
                  placeholder={confirming.action === "refund" ? "예: 정리 미흡 5,000원 차감" : "예: 전화로 안내함"}
                  className="academy-input mt-1 block font-normal"
                />
              </label>
            </div>
          }
          confirmLabel={actionLabel(confirmRow, confirming.action)}
          tone={confirmText.tone}
          pending={pending}
          error={error}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            // 거절은 사유가 없으면 보내지 않는다(서버도 다시 막는다)
            if (confirming.action === "reject" && !rejectReason) {
              setError("거절 사유를 골라 주세요. 신청자 문자에 그대로 나갑니다.");
              return;
            }
            run(confirming.id, confirming.action, {
              memo,
              depositRefunded: confirming.action === "refund" ? (refundAmount === "" ? null : Number(refundAmount)) : null,
              // 비워 두면 서버가 «금액을 입력해 주세요»로 거절한다
              cancelRefund: paidCancel ? (refundAmount === "" ? null : Number(refundAmount)) : null,
              rejectReason: confirming.action === "reject" ? rejectReason : undefined,
            });
          }}
        />
      )}

      {editing && editRow && (
        <AdminConfirmDialog
          titleId="rental-edit-title"
          title={`${editRow.applicantName} · 내용 수정`}
          description={
            <div className="space-y-2">
              <p className="text-[var(--color-academy-muted)]">
                지금: {kstLabel(editRow.rentalDate)} {rentalTimeText(editRow)} · {editRow.headcount}명{editRow.useAircon ? " · 냉난방" : ""} · {formatWon(editRow.totalAmount)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 block font-medium text-[var(--color-academy-ink)]">
                  이용일
                  <input type="date" value={editing.rentalDate} onChange={(e) => setEditing({ ...editing, rentalDate: e.target.value })} className={editInput} />
                </label>
                <label className="block font-medium text-[var(--color-academy-ink)]">
                  시작
                  <select value={editing.startMinute} onChange={(e) => setEditing({ ...editing, startMinute: Number(e.target.value) })} className={editInput}>
                    {START_OPTIONS.map((minute) => <option key={minute} value={minute}>{hhmm(minute)}</option>)}
                  </select>
                </label>
                <label className="block font-medium text-[var(--color-academy-ink)]">
                  이용 시간
                  <select value={editing.durationMinutes} onChange={(e) => setEditing({ ...editing, durationMinutes: Number(e.target.value) })} className={editInput}>
                    {DURATION_OPTIONS.map((minute) => (
                      <option key={minute} value={minute}>{durationText(minute)} (~{hhmm(editing.startMinute + minute)})</option>
                    ))}
                  </select>
                </label>
                <label className="block font-medium text-[var(--color-academy-ink)]">
                  인원
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={RENTAL_MAX_HEADCOUNT}
                    value={editing.headcount}
                    onChange={(e) => setEditing({ ...editing, headcount: e.target.value })}
                    className={editInput}
                  />
                </label>
                <label className="flex min-h-11 items-center gap-2 self-end font-medium text-[var(--color-academy-ink)]">
                  <input type="checkbox" checked={editing.useAircon} onChange={(e) => setEditing({ ...editing, useAircon: e.target.checked })} className="h-5 w-5" />
                  냉난방
                </label>
              </div>
              {/* 바뀐 금액 — 서버가 같은 계산으로 다시 저장한다 */}
              <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 font-medium tabular-nums text-[var(--color-academy-ink)]">
                {editFee
                  ? `바뀐 금액: 이용료 ${formatWon(editFee.usageFee)} + 보증금 ${formatWon(editFee.deposit)} = ${formatWon(editFee.total)}${amountDiff ? ` (${amountDiff > 0 ? "+" : "-"}${formatWon(Math.abs(amountDiff))})` : ""}`
                  : editFeeError}
              </p>
              {/* 안내 문자가 이미 나간 단계만 다시 안내한다: 입금 대기 → 승인 안내, 무료 확정 → 확정 안내 */}
              {(editRow.status === "APPROVED" || editRow.status === "PAID") && (
                <label className="flex min-h-11 items-center gap-2 font-medium text-[var(--color-academy-ink)]">
                  <input type="checkbox" checked={editing.notify} onChange={(e) => setEditing({ ...editing, notify: e.target.checked })} className="h-5 w-5" />
                  {editRow.status === "PAID" ? "바뀐 시간으로 확정 안내 문자 다시 보내기" : "바뀐 시간·금액으로 승인 안내 문자 다시 보내기"}
                  {smsOn[editRow.status === "PAID" ? "confirmed" : "approved"] ? "" : " (문자 꺼짐 · 보내지 않음)"}
                </label>
              )}
              {editRow.status === "PAID" && editFee && editFee.total > 0 && (
                <p role="alert" className="font-medium text-[var(--color-academy-danger)]">무료 확정 건은 0원 안에서만 고칠 수 있어요(재원생 2시간까지 무료). 늘리려면 취소 후 다시 신청받아 주세요.</p>
              )}
              <p className="text-xs text-[var(--color-academy-muted)]">수업·특강·다른 승인 대관과 겹치면 저장되지 않습니다. 바꾼 내용은 메모에 자동으로 남습니다.</p>
            </div>
          }
          confirmLabel="저장"
          tone="primary"
          pending={pending}
          error={error}
          onCancel={() => {
            setEditing(null);
            setError("");
          }}
          onConfirm={() => {
            if (!editFee) {
              setError(editFeeError || "입력값을 확인해 주세요.");
              return;
            }
            saveEdit(editing);
          }}
        />
      )}
    </div>
  );
}
