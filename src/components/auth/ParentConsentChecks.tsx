"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStoreApp } from "@/hooks/useStoreApp";

// 학부모 필수 동의 3개(이용약관·개인정보·만 14세) + 약관 «보기» 창 — 신규 가입과 기존 계정 활성화가 같이 쓴다(2026-11-13 a3·a5).
//
// 왜 «같은 화면 안의 창»인가: 예전에는 약관 링크가 새 탭(/terms)으로 열렸다. 앱(스토어 앱·설치 앱)에서는
// 새 탭이 앱 밖 브라우저로 나가 가입 화면으로 돌아오기 어려웠다. 창으로 보여 주면 입력한 값도 그대로 남는다.
// 본문은 서버 페이지가 /terms·/privacy 와 같은 원천(학원 설정, getParentPolicyTexts)에서 읽어 넘겨 준다.
// 체크칸은 이름(terms·privacy·age)으로 폼에 실려 간다 — 화면이 아니라 서버가 최종 판정한다.

export type ParentPolicyTextsProp = { terms: string | null; privacy: string };

type Tone = "public" | "academy";

const TONE = {
  public: {
    box: "bg-[var(--color-public-tint)] text-[var(--color-public-ink)] dark:bg-[var(--color-public-paper)] dark:text-white",
    link: "text-[var(--color-public-accent)] dark:text-brand-neon-lime",
    sheet: "bg-white text-[var(--color-public-ink)] dark:bg-[var(--color-public-paper)] dark:text-white",
    line: "border-[var(--color-public-line)]",
    muted: "text-[var(--color-public-muted)]",
    button: "bg-[var(--color-public-accent)] text-white",
  },
  academy: {
    box: "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]",
    link: "text-[var(--color-academy-ink)]",
    sheet: "bg-white text-[var(--color-academy-ink)]",
    line: "border-[var(--color-academy-line)]",
    muted: "text-[var(--color-academy-muted)]",
    button: "bg-[var(--color-academy-primary)] text-white",
  },
} as const;

export default function ParentConsentChecks({ policies, tone = "public" }: { policies: ParentPolicyTextsProp; tone?: Tone }) {
  const [open, setOpen] = useState<"terms" | "privacy" | null>(null);
  // 닫기 함수를 고정해 둔다 — 창이 열린 동안 바깥 화면이 다시 그려져도 포커스·스크롤 잠금이 다시 걸리지 않게
  const close = useCallback(() => setOpen(null), []);
  const t = TONE[tone];

  const rows: Array<{ name: "terms" | "privacy" | "age"; label: string; policy?: "terms" | "privacy" }> = [
    { name: "terms", label: "이용약관", policy: "terms" },
    { name: "privacy", label: "개인정보 수집·이용", policy: "privacy" },
    { name: "age", label: "만 14세 이상입니다" },
  ];

  return (
    <>
      <div className={`space-y-1 rounded-xl p-3 text-sm ${t.box}`}>
        {rows.map((row) => (
          // 줄 전체가 44px 이상 — 체크칸이 작아도 글자까지 눌러 체크된다
          <div key={row.name} className="flex min-h-11 items-center gap-2">
            <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3">
              <input name={row.name} type="checkbox" required className="h-5 w-5 shrink-0 cursor-pointer" />
              <span>
                {row.policy ? `${row.label} 동의` : row.label} <span className="font-semibold">(필수)</span>
              </span>
            </label>
            {row.policy && (
              <button
                type="button"
                onClick={() => setOpen(row.policy!)}
                className={`min-h-11 shrink-0 px-2 text-sm font-semibold underline underline-offset-2 ${t.link}`}
              >
                보기
              </button>
            )}
          </div>
        ))}
      </div>
      {open && (
        <PolicySheet
          title={open === "terms" ? "이용약관" : "개인정보 처리방침"}
          text={open === "terms" ? policies.terms : policies.privacy}
          fullHref={open === "terms" ? "/terms" : "/privacy"}
          tone={tone}
          onClose={close}
        />
      )}
    </>
  );
}

/** 약관 본문 창 — 휴대폰은 아래에서 올라오는 시트, 넓은 화면은 가운데 창 */
function PolicySheet({
  title,
  text,
  fullHref,
  tone,
  onClose,
}: {
  title: string;
  text: string | null;
  fullHref: string;
  tone: Tone;
  onClose: () => void;
}) {
  const t = TONE[tone];
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 스토어 앱에서는 «전체 페이지로 보기»(새 탭)를 숨긴다 — 앱 밖 브라우저로 나가 돌아오기 어렵다
  const storeApp = useStoreApp();

  useEffect(() => {
    // 창을 연 «보기» 버튼 — 닫을 때 그 자리로 포커스를 돌려준다(키보드·화면읽기 사용자가 길을 잃지 않게)
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      // Tab 을 창 안에서만 돈다(뒤 화면으로 빠지지 않게)
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    // 뒤 화면 스크롤 잠금(창 안만 스크롤)
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-policy-title"
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-2xl shadow-xl sm:rounded-2xl ${t.sheet}`}
      >
        <div className={`flex items-center justify-between border-b px-4 py-2 ${t.line}`}>
          <h2 id="parent-policy-title" className="text-base font-bold">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="닫기" className="flex h-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-medium">
            닫기
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3 text-sm leading-6 whitespace-pre-line">
          {text || <p className={t.muted}>등록된 내용이 아직 없어요. 학원에 문의해 주세요.</p>}
        </div>
        {/* 아래 버튼 줄은 휴대폰 홈 표시줄(안전 영역)만큼 띄운다 */}
        <div className={`flex items-center justify-end gap-2 border-t px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] ${t.line}`}>
          {/* 전체 페이지는 보조 — 브라우저에서만(스토어 앱·판정 전에는 숨김) */}
          {storeApp === false && (
            <a href={fullHref} target="_blank" rel="noopener noreferrer" className={`min-h-11 flex-1 content-center text-xs underline ${t.muted}`}>
              전체 페이지로 보기
            </a>
          )}
          <button type="button" onClick={onClose} className={`min-h-11 rounded-xl px-5 text-sm font-bold ${t.button}`}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}
