"use client";

/**
 * 신청함 «변경» 탭 상세 칸 — 휴원 승인 전 수강료 처리(이월·환불·없음) 미리보기·고르기 (통합 2026-11-10, 원장 결정 m6)
 *
 * 규칙·문구는 관리자 수강 변경 화면(EnrollmentChangesClient)과 똑같다:
 *  - 처리할 금액(낸 돈 또는 미납 청구)이 있고 계산 문제(problems)가 없으면 → 방식을 골라야 승인된다
 *  - problems 가 있으면 빨간 안내만 보이고 승인은 예전처럼(수강료 처리 없이) 된다
 *  - 표 준비 전(tablesReady=false)·실행 불가(ready=false)면 승인 버튼이 잠긴다
 * 그 화면은 목록 행에 미리보기를 받지만, 신청함은 칸을 열 때 getPauseTuitionPreview 로 받는다.
 * (그 화면을 공용 부품으로 쪼개면 문구를 못박은 기존 테스트가 깨져서, 같은 규칙을 여기 한 벌 더 둔다 —
 *  tests/inbox-consult-pause-wiring.test.mjs 가 두 화면 문구가 같은지 비교한다)
 */
import type { AdminSettlementPreview } from "@/lib/enrollment/admin-change-request";
import {
  SETTLEMENT_MODES,
  SETTLEMENT_MODE_LABEL,
  SETTLEMENT_PROBLEM_APPROVE_NOTE,
  settlementChoiceRequired,
  type SettlementMode,
} from "@/lib/enrollment/pause-settlement-plan";

/** 이 휴원에 처리할 금액이 있는가 — 있으면 승인 전에 방식을 골라야 한다(수강 변경 화면 needsSettlementChoice 와 같은 규칙) */
export function pauseNeedsSettlementChoice(preview: AdminSettlementPreview | null): boolean {
  // 서버 강제(decideEnrollmentChangeRequest)와 같은 순수 판정 — problems 없고 낸 돈·미납 청구가 있으면 필수
  return Boolean(preview && settlementChoiceRequired(preview));
}

/** 돈이 움직이는 처리라 확인창에 금액·길을 그대로 적는다(수강 변경 화면 settlementConfirmText 와 같은 문구) */
export function pauseSettlementConfirmText(head: string, preview: AdminSettlementPreview, mode: SettlementMode): string {
  const won = (n: number) => `${n.toLocaleString()}원`;
  const lines = [head, `수강료 처리: ${SETTLEMENT_MODE_LABEL[mode]}`];
  if (mode === "REFUND" && preview.paidTotal > 0) {
    lines.push(`환불 ${won(preview.paidTotal)}`);
    if (preview.channels.includes("TOSS")) lines.push("· 토스 온라인 결제분은 확인을 누르면 바로 부분 취소됩니다(되돌릴 수 없음).");
    if (preview.channels.some((c) => c !== "TOSS")) lines.push("· 현금·랠리즈·POS 등은 «환불 할 일»로 남습니다.");
  }
  if (mode === "CARRY" && preview.paidTotal > 0) lines.push(`이월 ${won(preview.paidTotal)} — 다음 청구에서 차감`);
  if (mode !== "NONE" && preview.unpaidTotal > 0) lines.push(`미납 청구 ${won(preview.unpaidTotal)} 감액`);
  if (mode === "NONE") lines.push("돈은 움직이지 않고 기록만 남깁니다.");
  return lines.join("\n");
}

/** 미리보기 상태 — 칸을 열면 loading → ready(미리보기) 또는 error */
export type PausePreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: AdminSettlementPreview | null };

export default function PauseSettlementBox({ state, mode, onMode, disabled }: {
  state: PausePreviewState;
  mode: SettlementMode | null;
  onMode: (mode: SettlementMode) => void;
  disabled: boolean;
}) {
  if (state.status === "loading") {
    return <p className="mt-3 rounded-xl bg-[var(--color-academy-soft)] p-3 text-xs text-[var(--color-academy-muted)]">휴원 수강료 처리 금액을 계산하는 중…</p>;
  }
  if (state.status === "error") {
    return <p role="alert" className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-xs font-bold text-[var(--color-academy-danger)]">{state.message}</p>;
  }
  const preview = state.preview;
  if (!preview) return null; // 휴원이 아니거나 반 정보가 없어 미리보기 대상이 아님 — 예전처럼 승인만
  const choose = pauseNeedsSettlementChoice(preview);
  return (
    <div className="mt-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
      <p className="text-xs font-black text-[var(--color-academy-ink)]">이번 휴원 수강료 처리</p>
      {preview.lines.length === 0 && preview.problems.length === 0 && (
        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">휴원 기간에 걸친 수강료 청구가 없어 처리할 금액이 없습니다.</p>
      )}
      {preview.lines.map((line) => (
        <p key={line} className="mt-1 text-xs tabular-nums text-[var(--color-academy-ink)]">{line}</p>
      ))}
      {(preview.paidTotal > 0 || preview.unpaidTotal > 0) && (
        <p className="mt-2 text-sm font-black tabular-nums text-[var(--color-academy-ink)]">
          {preview.paidTotal > 0 ? `낸 수강료에서 ${preview.paidTotal.toLocaleString()}원` : ""}
          {preview.paidTotal > 0 && preview.unpaidTotal > 0 ? " · " : ""}
          {preview.unpaidTotal > 0 ? `미납 청구 ${preview.unpaidTotal.toLocaleString()}원 감액` : ""}
        </p>
      )}
      {/* 계산 문제 — 수강료 처리 없이 승인만 된다(처리는 나중에 수강 변경 화면에서) */}
      {preview.problems.map((problem) => (
        <p key={problem} className="mt-1 text-xs font-bold text-[var(--color-academy-danger)]">{problem}</p>
      ))}
      {/* 계산 문제가 있으면 방식을 고를 수 없다 — 승인 결과를 미리 알린다(수강 변경 화면과 같은 문구) */}
      {preview.problems.length > 0 && (
        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{SETTLEMENT_PROBLEM_APPROVE_NOTE}</p>
      )}
      {!preview.tablesReady && (
        <p className="mt-1 text-xs font-bold text-[var(--color-academy-warning)]">수강료 처리 기록 준비 전이라 지금은 금액 미리보기만 됩니다.</p>
      )}
      {choose && (
        <>
          <div role="radiogroup" aria-label="휴원 수강료 처리 방식" className="mt-2 grid grid-cols-3 gap-2">
            {SETTLEMENT_MODES.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={mode === item}
                disabled={disabled}
                onClick={() => onMode(item)}
                className={`min-h-11 rounded-xl border text-sm font-bold ${mode === item
                  ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]"
                  : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]"}`}
              >
                {SETTLEMENT_MODE_LABEL[item]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
            이월 = 다음 청구에서 차감 · 환불 = 토스 온라인 결제는 바로 부분 취소, 그 밖은 환불 할 일로 남김 · 없음 = 기록만(미납 청구도 그대로)
          </p>
        </>
      )}
    </div>
  );
}
