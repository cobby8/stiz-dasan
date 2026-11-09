"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ParentTimelineView, TimelineStep } from "@/lib/requests/parent-timeline-rules";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";

// 신청 내역 타임라인(최근 3개월) — 한 줄 행, 누르면 하단 시트(PC 는 오른쪽 칸).
// 이름·상태·단계·버튼 여부는 서버가 parent-timeline-rules 로 정해서 보낸다. 여기는 그리기 + 버튼 호출만.

function Icon({ name, size = 16, className = "" }: { name: string; size?: number; className?: string }) {
  return <span className={`material-symbols-outlined leading-none ${className}`} style={{ fontSize: `${size}px` }} aria-hidden="true">{name}</span>;
}

/** 단계 한 칸 — 모양(✓·●·○·×)과 글자로 구분(색만으로 구분하지 않는다) */
function Step({ step }: { step: TimelineStep }) {
  const mark = step.state === "done" ? "check_circle" : step.state === "current" ? "radio_button_checked" : step.state === "stopped" ? "cancel" : "radio_button_unchecked";
  const tone = step.state === "current"
    ? "text-[var(--color-academy-info)] font-bold"
    : step.state === "stopped"
      ? "text-[var(--color-academy-danger)] font-bold"
      : step.state === "done"
        ? "text-[var(--color-academy-ink)]"
        : "text-[var(--color-academy-muted)]";
  return (
    <li className={`inline-flex items-center gap-1 text-sm ${tone}`}>
      <Icon name={mark} size={18} />
      <span>{step.label}</span>
      <span className="sr-only">{step.state === "done" ? "완료" : step.state === "current" ? "진행 중" : step.state === "stopped" ? "멈춤" : "남음"}</span>
    </li>
  );
}

/** 취소·취소 요청 API — 기존 학부모 API 를 그대로 부른다(서버가 소유·상태를 다시 확인한다) */
async function post(url: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) return customerMessage(data?.error ?? data?.message, "처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    return null;
  } catch {
    return "결과를 확인하지 못했어요. 새로고침해서 처리 여부를 확인해 주세요.";
  }
}

export default function RequestTimeline({ rows }: { rows: ParentTimelineView[] }) {
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const row = openKey ? rows.find((r) => r.key === openKey) ?? null : null;

  async function run(body: () => Promise<string | null>, okText: string) {
    setError("");
    setDone("");
    const message = await body();
    if (message) {
      setError(message);
      return;
    }
    setDone(okText);
    router.refresh();
  }

  const cancel = (r: ParentTimelineView) =>
    run(
      () => r.kind === "ENROLLMENT_CHANGE"
        ? post("/api/mypage/enrollment-change", { action: "cancel", id: r.id })
        : post("/api/mypage/regular-absence", { action: "cancel", id: r.id }),
      "취소했어요.",
    );
  // d8: 승인됐지만 적용 전인 휴원·퇴원 → 원장님께 «취소 요청»(원장님이 승인하면 취소된다)
  const requestCancel = (r: ParentTimelineView) =>
    run(() => post("/api/mypage/enrollment-change", { action: "cancel-request", id: r.id }), "취소 요청을 보냈어요. 원장님이 확인하면 알려 드려요.");

  return (
    <section aria-labelledby="request-timeline-heading" className="academy-panel !shadow-none overflow-hidden">
      <h2 id="request-timeline-heading" className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]">
        <span>신청 내역 <span className="font-normal text-[var(--color-academy-muted)]">최근 3개월</span></span>
        <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-[var(--color-academy-muted)]">신청 내역이 없어요</p>
      ) : (
        <ul className="divide-y divide-[var(--color-academy-line)]">
          {rows.map((r) => (
            <li key={r.key}>
              {/* 한 줄 행 — 종류·제목 / 날짜·상태. 누르면 하단 시트 */}
              <button
                type="button"
                onClick={() => { setError(""); setDone(""); setOpenKey(r.key); }}
                className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-academy-soft)]"
              >
                <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">{r.title}</span>
                {r.when && <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-[var(--color-academy-muted)]">{r.when}</span>}
                <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-bold ${TONE_BADGE_CLASS[r.tone]}`}>{r.statusLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {row && (
        <ListDetailPanel onClose={() => setOpenKey(null)} titleId="request-timeline-detail-title" panelClassName="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mb-2 flex items-center gap-2">
            <h3 id="request-timeline-detail-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">
              {row.studentName} · {row.kindName}
            </h3>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-bold ${TONE_BADGE_CLASS[row.tone]}`}>{row.statusLabel}</span>
            <button
              type="button"
              onClick={() => setOpenKey(null)}
              aria-label="닫기"
              className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
            >
              <Icon name="close" size={22} />
            </button>
          </div>
          <p className="break-keep text-sm font-bold text-[var(--color-academy-ink)]">{row.title}</p>
          <p className="text-xs tabular-nums text-[var(--color-academy-muted)]">
            {[row.when, `신청 ${row.createdOn}`, ...row.details].filter(Boolean).join(" · ")}
          </p>

          {/* 단계: 접수 → 검토 → 승인/거절 → 적용 */}
          <ol aria-label="진행 단계" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            {row.steps.map((step, i) => <Step key={`${step.label}-${i}`} step={step} />)}
          </ol>

          {/* 원장 답변·거절 사유 */}
          {row.answer && (
            <div className="mt-3 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-3 py-2">
              <p className="text-xs font-bold text-[var(--color-academy-muted)]">학원 답변</p>
              <p className="whitespace-pre-wrap break-keep text-sm text-[var(--color-academy-ink)]">{row.answer}</p>
            </div>
          )}
          {row.cancelLine && <p className="mt-2 break-keep text-sm font-bold text-[var(--color-academy-ink)]">{row.cancelLine}</p>}

          {error && <p role="alert" className="mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>}
          {done && <p role="status" className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-success)]">{done}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* 검토 중 = 바로 취소(기존 취소 API). 서버가 PENDING/REPORTED 인지 다시 본다 */}
            {row.canCancel && !done && (
              <InlineConfirm label="취소" question="이 신청을 취소할까요?" confirmLabel="취소하기" onConfirm={() => cancel(row)} className="w-full" />
            )}
            {/* 승인됐지만 적용 전 휴원·퇴원 = 원장님께 취소 요청(d8) */}
            {row.canRequestCancel && !done && (
              <InlineConfirm
                label="취소 요청"
                question={`${row.when} 예정된 ${row.kindName}을 취소해 달라고 요청할까요?`}
                confirmLabel="요청 보내기"
                onConfirm={() => requestCancel(row)}
                className="w-full"
              />
            )}
            <Link href={row.openHref} className="academy-button-text">
              신청 화면에서 보기
              <Icon name="chevron_right" size={18} />
            </Link>
          </div>
        </ListDetailPanel>
      )}
    </section>
  );
}
