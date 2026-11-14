"use client";

/**
 * 신청함 «부상 결석(기간)» 상세 — 기간·사유 글·증빙 사진(기간 한 묶음) → 증빙 확인 체크 → [부상 결석 승인] (2026-11-15 원장 승인)
 *
 * 왜 하루짜리 상세와 따로인가: 하루짜리는 승인하는 순간 금액(이월)을 적립한다. 기간 결석은 «인정»만 먼저 하고
 * 금액은 복귀한 뒤 한 번에 정산한다 — 그래서 이 화면에는 금액이 없고, 결석일·청구 발행을 기다리지 않는다.
 * - 사유 글·사진은 건강 정보라 목록에 싣지 않고, 원장이 이 칸을 열 때만 서버에서 읽는다.
 * - 증빙은 기간 전체에 한 번만 확인한다(체크해야 승인 버튼이 켜진다).
 * - 승인 뒤에는 상태 글자와 «승인 취소»(위험 작업 — 기존 확인 창 부품).
 * - 색은 토큰만, 아이콘 없이 글자, 버튼 등급·확인 창은 기존 부품(useAdminConfirm·AdminModal).
 */

import { useEffect, useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { kstAt, kstLabel } from "@/lib/datetime/kst";
import {
  approveIllnessPeriodAction, cancelIllnessPeriodApprovalAction, convertIllnessPeriodToMakeupAction, holdIllnessPeriodBillsAction,
  loadIllnessPeriodDetail, loadIllnessPeriodHold, type IllnessPeriodHoldView,
} from "@/app/actions/illness-period-admin";
import type { IllnessPeriodDetail } from "@/lib/regular/illness-period-admin";
import { BILLING_HOLD_LABEL, PERIOD_APPROVED_ADMIN_NOTE } from "@/lib/regular/illnessPeriodRules";

type Props = { periodId: string; studentName: string; onChanged: () => void };

const photoUrl = (id: string) => `/api/admin/absence-evidence/${encodeURIComponent(id)}`;

export default function IllnessPeriodInboxDetail({ periodId, studentName, onChanged }: Props) {
  const [detail, setDetail] = useState<IllnessPeriodDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [zoomId, setZoomId] = useState<string | null>(null);
  // 증빙 확인 체크 — 기간 전체에 한 번. 체크해야 승인 버튼이 켜진다
  const [evidenceChecked, setEvidenceChecked] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();
  // 청구 발행 보류 칸(승인 뒤에만) — 이미 발행된 미납 청구 목록과 보류로 돌린 건수. 못 읽으면 칸만 숨긴다
  const [hold, setHold] = useState<IllnessPeriodHoldView | null>(null);

  // 칸을 열 때 한 번 읽는다(처리 뒤에는 아래 reload 가 다시 읽는다).
  // 보류 칸은 승인된 기간일 때만, 상세를 읽은 «뒤에» 읽는다(DB 연결을 동시에 늘리지 않는다)
  useEffect(() => {
    let alive = true;
    loadIllnessPeriodDetail(periodId)
      .then(async (result) => {
        if (!alive) return;
        if (!result.ok) { setLoadError(result.message); return; }
        setDetail(result.detail);
        if (result.detail.carryState !== "APPROVED") return;
        const holdResult = await loadIllnessPeriodHold(periodId).catch(() => null);
        if (alive) setHold(holdResult?.ok ? holdResult.hold : null);
      })
      .catch(() => { if (alive) setLoadError("내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요."); });
    return () => { alive = false; };
  }, [periodId]);

  const reload = async () => {
    const result = await loadIllnessPeriodDetail(periodId).catch(() => null);
    if (!result?.ok) return;
    setDetail(result.detail);
    const holdResult = result.detail.carryState === "APPROVED" ? await loadIllnessPeriodHold(periodId).catch(() => null) : null;
    setHold(holdResult?.ok ? holdResult.hold : null);
  };

  if (loadError) return <p role="alert" className="mt-4 text-sm text-[var(--color-academy-danger)]">{loadError}</p>;
  if (!detail) return <p className="mt-4 text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>;

  const hasPhotos = detail.photoIds.length > 0;
  const classes = detail.classes.map((item) => `${item.className} ${item.count}회`).join(" · ");
  const approved = detail.carryState === "APPROVED";

  function approve() {
    if (!detail || !evidenceChecked) return;
    startTransition(async () => {
      const result = await approveIllnessPeriodAction({ periodId, evidenceConfirmed: true })
        .catch(() => ({ ok: false as const, message: "승인하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      setEvidenceChecked(false);
      await reload();
      if (result.ok) onChanged();
    });
  }

  async function cancelApproval() {
    if (!detail) return;
    const ok = await confirm({
      title: `${studentName} · 부상 결석 승인 취소`,
      // 실제로 일어나는 일 그대로: 상태 되돌림 · 거둔 보강권 돌려줌 · 학부모가 알린 결석은 다시 검토 중
      description: [
        "기간이 다시 «승인 대기»로 돌아갑니다.",
        detail.heldCreditCount > 0 ? `승인하며 거둔 보강권 ${detail.heldCreditCount}장은 돌려줍니다(만료일이 지난 것은 만료).` : "",
        "학부모가 알린 결석은 «검토 중»으로 돌아가 사진 기한(7일)이 새로 시작합니다.",
        // 보류로 돌린 청구는 되살리지 않는다 — 청구 준비에 «확인 필요»로 다시 나온다
        "발행 보류가 풀려 청구 준비에서 다시 발행할 수 있습니다.",
        hold && hold.heldCount > 0 ? `보류로 돌린 청구 ${hold.heldCount}건은 청구 준비에서 다시 발행해야 합니다.` : "",
      ].filter(Boolean).join(" "),
      confirmLabel: "승인 취소",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await cancelIllnessPeriodApprovalAction({ periodId })
        .catch(() => ({ ok: false as const, message: "승인을 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await reload();
      if (result.ok) onChanged();
    });
  }

  // 이미 발행된 미납 청구를 보류로 돌린다 — 원장만. 대상과 금액을 확인 창에서 한 번 더 보여 준 뒤 실행한다.
  // 서버에는 «지금 화면에서 본 돌릴 청구» id 를 함께 보낸다(그 사이 목록이 바뀌었으면 서버가 실행하지 않는다)
  const holdTargets = (hold?.bills ?? []).filter((bill) => !bill.skipText);
  const holdTotal = holdTargets.reduce((sum, bill) => sum + (bill.amount ?? 0), 0);
  async function holdBills() {
    if (!hold?.canHold || holdTargets.length === 0) return;
    const ok = await confirm({
      title: `${studentName} · 미납 청구 ${holdTargets.length}건 발행 보류`,
      description: [
        `${holdTargets.map((bill) => `${bill.label} ${(bill.amount ?? 0).toLocaleString("ko-KR")}원`).join(", ")} — 합계 ${holdTotal.toLocaleString("ko-KR")}원.`,
        "이 청구를 취소 상태로 돌려 학부모 결제 화면과 미납 안내에서 뺍니다. 금액 메모는 청구 준비에 남고, 복귀 뒤 다시 발행합니다(새 청구 번호).",
        "학부모에게 앱 알림이 한 번 갑니다.",
      ].join(" "),
      confirmLabel: "발행 보류로 돌리기",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await holdIllnessPeriodBillsAction({ periodId, expectedPaymentIds: holdTargets.map((bill) => bill.paymentId) })
        .catch(() => ({ ok: false as const, message: "발행 보류로 돌리지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await reload();
      if (result.ok) onChanged();
    });
  }

  // 부상 결석으로 인정하지 않는 기간 — 결정 전인 날마다 보강권 1장(하루짜리 [보강권으로]와 같은 처리)
  async function toMakeup() {
    if (!detail) return;
    const ok = await confirm({
      title: `${studentName} · 결석 ${detail.pendingCount}회를 보강권으로`,
      description: "부상 결석으로 인정하지 않고, 아직 결정 전인 날마다 보강권 1장으로 처리합니다. 그날 출석으로 기록된 날은 보강권 없이 닫습니다. 학부모에게 앱 알림이 갑니다.",
      confirmLabel: "보강권으로 전환",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await convertIllnessPeriodToMakeupAction({ periodId })
        .catch(() => ({ ok: false as const, message: "보강권으로 돌리지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      setEvidenceChecked(false);
      await reload();
      if (result.ok) onChanged();
    });
  }

  return (
    <section className="mt-4 space-y-3" aria-label="부상 결석 기간 증빙">
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {/* 기간·횟수·접수·증빙 장수는 바로 위 공통 줄(신청함 목록이 준 값)에 있다 — 여기는 상세를 열어야 읽는 것만 */}
        {classes && (
          <>
            <dt className="font-medium text-[var(--color-academy-muted)]">반별</dt>
            <dd className="break-words text-[var(--color-academy-ink)]">{classes}</dd>
          </>
        )}
        <dt className="font-medium text-[var(--color-academy-muted)]">사유 글</dt>
        <dd className="whitespace-pre-wrap break-words text-[var(--color-academy-ink)]">
          {detail.reasonText ?? (detail.parentReported ? "적지 않음" : detail.note ?? "학원에서 등록한 기간 결석")}
        </dd>
      </dl>

      {/* 증빙 사진 — 기간 한 묶음. 작은 사진을 누르면 크게(관리자만 열리는 주소) */}
      {hasPhotos ? (
        <ul className="flex flex-wrap gap-2" aria-label="증빙 사진">
          {detail.photoIds.map((id, index) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => setZoomId(id)}
                aria-label={`증빙 사진 ${index + 1} 크게 보기`}
                className="block h-24 w-24 overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- 권한 확인 API 가 내려 주는 비공개 사진(이미지 최적화 서버를 거치지 않게) */}
                <img src={photoUrl(id)} alt={`증빙 사진 ${index + 1}`} className="h-full w-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-muted)]">
          {detail.parentReported ? "아직 올라온 증빙 사진이 없습니다." : "학부모가 올린 증빙 사진이 없습니다. 직접 확인한 뒤 승인해 주세요."}
        </p>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm font-medium ${message.tone === "ok"
          ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
          : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
      )}

      {detail.carryState === "NONE" ? (
        detail.blocker ? (
          <p className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">{detail.blocker}</p>
        ) : (
          <>
            {detail.pendingCount < detail.absenceCount && (
              <p className="text-xs text-[var(--color-academy-muted)]">
                {detail.absenceCount - detail.pendingCount}회는 이미 날짜별로 처리돼 그대로 둡니다.
              </p>
            )}
            {/* 증빙 확인 — 기간 전체에 한 번. 줄 전체가 눌리는 칸(높이 44px) */}
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-academy-line)] px-3 text-sm text-[var(--color-academy-ink)]">
              <input
                type="checkbox"
                checked={evidenceChecked}
                disabled={pending}
                onChange={(event) => setEvidenceChecked(event.target.checked)}
                className="h-5 w-5 accent-[var(--color-academy-primary)]"
              />
              <span>{hasPhotos ? "증빙 사진을 확인했습니다" : "증빙(진단서·처방전 등)을 직접 확인했습니다"}</span>
            </label>
            <p className="text-xs text-[var(--color-academy-muted)]">승인하면 부상 결석으로 인정만 됩니다. {PERIOD_APPROVED_ADMIN_NOTE}.</p>
            {/* 버튼 — 보조(인정하지 않음 → 보강권으로)는 왼쪽, 주 버튼(승인) 하나는 오른쪽 끝 */}
            <div className="flex flex-wrap justify-end gap-2">
              {detail.pendingCount > 0 && (
                <button type="button" disabled={pending} onClick={() => void toMakeup()} className="academy-button-secondary">보강권으로 전환</button>
              )}
              <button type="button" disabled={pending || !evidenceChecked} onClick={approve} className="academy-button-primary">
                {pending ? "처리 중…" : "부상 결석 승인"}
              </button>
            </div>
          </>
        )
      ) : approved ? (
        <>
          <p className="rounded-lg bg-[var(--color-academy-info-soft)] px-3 py-2 text-sm text-[var(--color-academy-info)]">
            부상 결석 인정{detail.approvedYmd ? ` · ${kstLabel(kstAt(detail.approvedYmd))} 승인` : ""} · {PERIOD_APPROVED_ADMIN_NOTE}
          </p>
          {/* 청구 발행 보류 — 상태 한 줄 + 이미 발행된 미납 청구(한 줄 행) + 원장만 누르는 «발행 보류로 돌리기» */}
          {hold?.holdActive && (
            <div className="space-y-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm">
              <p className="font-semibold text-[var(--color-academy-ink)]">{BILLING_HOLD_LABEL}</p>
              <p className="text-xs text-[var(--color-academy-muted)]">금액이 정해질 때까지 이 아이의 새 수강료 청구는 발행되지 않습니다.</p>
              {hold.heldCount > 0 && (
                <p className="text-[var(--color-academy-ink)]">보류로 돌린 청구 {hold.heldCount}건 · 복귀 뒤 청구 준비에서 다시 발행합니다.</p>
              )}
              {hold.bills.length > 0 && (
                <>
                  <p className="font-medium text-[var(--color-academy-ink)]">
                    이미 발행된 미납 청구 {hold.bills.length}건{hold.canHold ? ` · ${hold.bills.reduce((sum, bill) => sum + (bill.amount ?? 0), 0).toLocaleString("ko-KR")}원` : ""}
                  </p>
                  <ul aria-label="이미 발행된 미납 청구">
                    {hold.bills.map((bill) => (
                      <li key={bill.paymentId} className="flex min-h-11 flex-wrap items-center gap-x-2 border-t border-[var(--color-academy-line)] py-1">
                        <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">{bill.label}</span>
                        {bill.amount !== null && <span className="whitespace-nowrap tabular-nums text-[var(--color-academy-ink)]">{bill.amount.toLocaleString("ko-KR")}원</span>}
                        {bill.skipText && <span className="w-full text-xs text-[var(--color-academy-warning)]">{bill.skipText}</span>}
                      </li>
                    ))}
                  </ul>
                  {hold.canHold ? (
                    holdTargets.length > 0 && (
                      <div className="flex justify-end">
                        <button type="button" disabled={pending} onClick={() => void holdBills()} className="academy-button-secondary">발행 보류로 돌리기</button>
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-[var(--color-academy-muted)]">발행 보류로 돌리기는 원장만 할 수 있습니다.</p>
                  )}
                </>
              )}
            </div>
          )}
          {/* 위험 작업(되돌리기)은 위험 등급 버튼 + 확인 창 */}
          <div className="flex justify-end">
            <button type="button" disabled={pending} onClick={() => void cancelApproval()} className="academy-button-danger">승인 취소</button>
          </div>
        </>
      ) : (
        <p className="text-sm text-[var(--color-academy-muted)]">정산이 끝난 기간 결석입니다.</p>
      )}

      {zoomId && (
        <AdminModal onClose={() => setZoomId(null)} titleId="illness-period-evidence-zoom-title" panelClassName="max-w-3xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <h3 id="illness-period-evidence-zoom-title" className="min-w-0 flex-1 text-base font-bold text-[var(--color-academy-ink)]">{studentName} 증빙 사진</h3>
            <button type="button" onClick={() => setZoomId(null)} className="academy-button-text">닫기</button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- 비공개 사진 */}
          <img src={photoUrl(zoomId)} alt="증빙 사진 크게 보기" className="max-h-[75vh] w-full rounded-lg object-contain" />
        </AdminModal>
      )}
      {confirmDialog}
    </section>
  );
}
