"use client";

/**
 * 신청함 «질병·부상 결석» 상세 — 사유 글·증빙 사진(눌러 크게) → [보강권으로] [이월 승인] (2026-11-14 원장 결정 a3)
 *
 * 왜 따로 읽나: 사유 글·사진은 건강 정보라 목록에 싣지 않고, 원장이 이 칸을 열 때만 서버에서 읽는다.
 * - [이월 승인] = 기존 청구 준비 규칙으로 이월 적립(다음 달 수강료에서 1회분 차감). 조건이 아직 안 맞으면
 *   버튼을 꺼 두고 이유를 한 줄로 보인다(결석일 전·그 달 청구 발행 전 등).
 * - 승인 전 확인 창의 체크 칸 = «증빙을 확인했다» — 학부모 사진이 없는 결석(기간 결석·출석부 표시)은 원장이 직접 확인한 것.
 * - 색은 토큰만, 아이콘 없이 글자, 버튼 등급·확인 창은 기존 부품(useAdminConfirm·AdminModal).
 */

import { useEffect, useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { approveIllnessCarryAction, convertIllnessCarryAction, loadIllnessCarryDetail } from "@/app/actions/illness-carry-admin";
import type { IllnessCarryDetail } from "@/lib/regular/illness-carry-admin";

type Props = { absenceId: string; studentName: string; onChanged: () => void };

const photoUrl = (id: string) => `/api/admin/absence-evidence/${encodeURIComponent(id)}`;

export default function IllnessCarryInboxDetail({ absenceId, studentName, onChanged }: Props) {
  const [detail, setDetail] = useState<IllnessCarryDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  // 칸을 열 때 한 번 읽는다(처리 뒤에는 아래 reload 가 다시 읽는다)
  useEffect(() => {
    let alive = true;
    loadIllnessCarryDetail(absenceId)
      .then((result) => {
        if (!alive) return;
        if (result.ok) setDetail(result.detail); else setLoadError(result.message);
      })
      .catch(() => { if (alive) setLoadError("내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요."); });
    return () => { alive = false; };
  }, [absenceId]);

  const reload = async () => {
    const result = await loadIllnessCarryDetail(absenceId).catch(() => null);
    if (result?.ok) setDetail(result.detail);
  };

  if (loadError) return <p role="alert" className="mt-4 text-sm text-[var(--color-academy-danger)]">{loadError}</p>;
  if (!detail) return <p className="mt-4 text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>;

  const hasPhotos = detail.photoIds.length > 0;
  const reserved = detail.creditStatus === "RESERVED";
  const hasCredit = detail.creditStatus === "AVAILABLE" || reserved;

  async function approve() {
    if (!detail) return;
    const ok = await confirm({
      title: `${studentName} · ${detail.absenceYmd} 결석 이월 승인`,
      description: [
        "다음 달 수강료에서 1회분(그 달 수강료 ÷ 그 달 수업 횟수)을 빼 드립니다.",
        hasCredit ? (reserved ? "이 결석의 보강 예약이 취소되고 보강권이 회수됩니다." : "이미 나간 보강권은 회수됩니다.") : "",
      ].filter(Boolean).join(" "),
      confirmLabel: "이월 승인",
      tone: "primary",
      // 돈이 움직이는 처리 — 증빙을 봤다는 체크를 해야 확정 버튼이 켜진다
      acknowledgeLabel: hasPhotos ? "증빙 사진을 확인했습니다" : "증빙(진단서·처방전 등)을 직접 확인했습니다",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await approveIllnessCarryAction({ absenceId, evidenceConfirmed: true, cancelReservation: reserved })
        .catch(() => ({ ok: false as const, message: "이월을 승인하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await reload();
      if (result.ok) onChanged();
    });
  }

  async function toMakeup() {
    if (!detail) return;
    const ok = await confirm({
      title: `${studentName} · ${detail.absenceYmd} 결석을 보강권으로`,
      description: "이월하지 않고 보강권 1장으로 처리합니다. 학부모에게 앱 알림이 갑니다.",
      confirmLabel: "보강권으로",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await convertIllnessCarryAction({ absenceId })
        .catch(() => ({ ok: false as const, message: "보강권으로 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await reload();
      if (result.ok) onChanged();
    });
  }

  return (
    <section className="mt-4 space-y-3" aria-label="질병·부상 결석 증빙">
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="font-medium text-[var(--color-academy-muted)]">사유 글</dt>
        <dd className="whitespace-pre-wrap break-words text-[var(--color-academy-ink)]">
          {detail.reasonText ?? (detail.source === "KAKAO" ? "적지 않음(카카오 접수)" : detail.source === "STAFF" ? "학원에서 등록한 결석" : "적지 않음")}
        </dd>
      </dl>

      {/* 증빙 사진 — 작은 사진을 누르면 크게(관리자만 열리는 주소) */}
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
          {detail.source === "STAFF" ? "학부모가 올린 증빙 사진이 없습니다. 직접 확인한 뒤 승인해 주세요." : "아직 올라온 사진이 없습니다. 알린 날부터 7일 안에 사진이 없으면 보강권 1장으로 바뀝니다."}
        </p>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm font-medium ${message.tone === "ok"
          ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
          : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
      )}

      {detail.status === "PENDING" ? (
        <>
          {/* 아직 승인할 수 없는 이유 한 줄 — 이때는 승인 버튼을 꺼 둔다 */}
          {detail.blocker && (
            <p className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">{detail.blocker}</p>
          )}
          {/* 버튼 — 보조(보강권으로)는 왼쪽, 주 버튼(이월 승인)은 오른쪽 끝 */}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" disabled={pending} onClick={() => void toMakeup()} className="academy-button-secondary">보강권으로</button>
            <button type="button" disabled={pending || Boolean(detail.blocker)} onClick={() => void approve()} className="academy-button-primary">이월 승인</button>
          </div>
        </>
      ) : (
        <p className="text-sm text-[var(--color-academy-muted)]">
          {detail.status === "APPROVED" ? "이월 승인이 끝난 결석입니다. 다음 달 청구에 «이월»로 차감됩니다." : "보강권으로 처리한 결석입니다."}
        </p>
      )}

      {zoomId && (
        <AdminModal onClose={() => setZoomId(null)} titleId="illness-evidence-zoom-title" panelClassName="max-w-3xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <h3 id="illness-evidence-zoom-title" className="min-w-0 flex-1 text-base font-bold text-[var(--color-academy-ink)]">{studentName} 증빙 사진</h3>
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
