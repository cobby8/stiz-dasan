"use client";

import { useEffect, useState, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";

/**
 * 학부모 화면 공용 «그 자리 확인» 버튼 (게슈탈트 C-M1).
 *
 * 왜: 취소·거절·퇴원처럼 되돌리기 어려운 버튼이 한 번 누르면 바로 실행돼, 휴대폰에서
 * 스크롤하다 잘못 눌러도 막을 길이 없었다. 팝업 대신 버튼 자리에서
 * «정말 ~할까요? [~하기] [유지]» 를 펼쳐 손가락이 멀리 가지 않게 한다.
 *
 * - 평소 버튼 = academy-button-danger(테두리 위험색) — 꽉 찬 위험색은 최종 확정 버튼만.
 * - 확정을 누르면 onConfirm 을 «그대로» 부른다(인자·흐름은 부르는 쪽이 정한 그대로).
 * - 처리 중(pending 또는 onConfirm 이 돌려준 Promise 진행 중)엔 두 버튼 모두 잠근다.
 * - stopPropagation: 행 전체가 눌리는 목록(셔틀 예정 변경)에서 행 열기로 번지지 않게 막는다.
 */
export default function InlineConfirm({
  label,
  question,
  confirmLabel,
  keepLabel = "유지",
  onConfirm,
  disabled = false,
  pending = false,
  pendingLabel = "처리 중…",
  stopPropagation = false,
  triggerClassName = "",
  className = "",
  openClassName = "",
  ariaLabel,
}: {
  /** 평소 보이는 버튼 글(예: «취소») */
  label: ReactNode;
  /** 펼쳤을 때 묻는 말(예: «이 예약을 취소할까요?») */
  question: ReactNode;
  /** 최종 확정 버튼 글(예: «취소하기») */
  confirmLabel: ReactNode;
  /** 되돌아가는 버튼 글 */
  keepLabel?: ReactNode;
  onConfirm: () => unknown;
  disabled?: boolean;
  /** 부르는 쪽의 처리 중 상태(useTransition 등) */
  pending?: boolean;
  pendingLabel?: ReactNode;
  stopPropagation?: boolean;
  triggerClassName?: string;
  className?: string;
  /** 펼쳤을 때만 붙는 칸 클래스(행 안에서 한 줄을 다 쓰게 할 때 basis-full 등) */
  openClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // 확정을 눌러 처리를 기다리는 중인지(이 동안 닫히지 않고 잠긴다)
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = busy || pending;

  // 처리가 끝나면(pending·busy 가 모두 풀리면) 확인 칸을 닫는다.
  useEffect(() => {
    if (requested && !busy && !pending) {
      setRequested(false);
      setOpen(false);
    }
  }, [requested, busy, pending]);

  // 행 클릭·키보드로 번지지 않게 막는다(행 안 버튼일 때만)
  const stop = (event: MouseEvent | KeyboardEvent) => {
    if (stopPropagation) event.stopPropagation();
  };

  async function handleConfirm() {
    setRequested(true);
    const result = onConfirm();
    // onConfirm 이 Promise 를 돌려주면 끝날 때까지 잠근다
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setBusy(true);
      try {
        await result;
      } finally {
        setBusy(false);
      }
    }
  }

  if (!open) {
    return (
      <span className={className} onClick={stop} onKeyDown={stop}>
        <button
          type="button"
          disabled={disabled || locked}
          aria-label={ariaLabel}
          onClick={() => setOpen(true)}
          className={`academy-button-danger shrink-0 ${triggerClassName}`}
        >
          {label}
        </button>
      </span>
    );
  }

  return (
    <span
      role="group"
      aria-label={typeof question === "string" ? question : undefined}
      onClick={stop}
      onKeyDown={stop}
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-2 ${className} ${openClassName}`}
    >
      <span className="min-w-0 basis-full text-sm font-bold text-[var(--color-academy-ink)]">{question}</span>
      <button type="button" disabled={locked} onClick={() => void handleConfirm()} className="academy-button-danger-solid">
        {locked ? pendingLabel : confirmLabel}
      </button>
      <button type="button" disabled={locked} onClick={() => setOpen(false)} className="academy-button-text">
        {keepLabel}
      </button>
    </span>
  );
}
