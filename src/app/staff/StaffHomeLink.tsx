"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { prepareStaffNavigation } from "./staffNavigation";

export default function StaffHomeLink({ isDriver = false }: { isDriver?: boolean }) {
  const pathname = usePathname();
  const inSession = pathname.startsWith("/staff/sessions/");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (saving) return;
        setOpen(false);
        setError("");
        window.requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const buttons = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, saving]);

  const close = () => {
    if (saving) return;
    setOpen(false);
    setError("");
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const goHome = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    const result = await prepareStaffNavigation();
    if (!result.ok) {
      setSaving(false);
      setError(result.message || "수업 기록을 저장하지 못해 이동을 중단했습니다.");
      return;
    }
    window.location.assign("/staff");
  };

  return (
    <>
      <Link ref={triggerRef} href="/staff" onClick={(event) => { if (!inSession) return; event.preventDefault(); setOpen(true); }} className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl text-brand-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)] dark:text-white" aria-label="교사용 홈으로 이동">
        {/* 실제 공식 로고를 유지해 역할이 바뀌어도 같은 학원 앱임을 알립니다. */}
        <Image src="/stiz-logo.png" alt="스티즈 농구교실" width={92} height={40} className="h-10 w-20 shrink-0 object-contain sm:w-[92px]" />
        <span className="shrink-0 whitespace-nowrap text-xs font-bold text-[var(--color-academy-muted)]">{isDriver ? "기사님 앱" : "선생님 앱"}</span>
      </Link>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-3 sm:items-center" onMouseDown={(event) => !saving && event.target === event.currentTarget && close()}>
          <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-sm overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl dark:bg-gray-900">
            <span className="material-symbols-outlined mb-3 text-3xl text-[var(--brand-accent)]" aria-hidden="true">home</span>
            <h2 id={titleId} className="text-lg font-black text-gray-900 dark:text-white">수업 화면을 나갈까요?</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">작성한 수업 내용을 먼저 저장한 뒤 선생님 홈으로 이동합니다.</p>
            {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" disabled={saving} onClick={close} className="min-h-12 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200">계속 수업하기</button>
              <button type="button" disabled={saving} aria-busy={saving} onClick={() => void goHome()} className="min-h-12 rounded-2xl bg-[var(--brand-accent)] text-sm font-black text-[var(--brand-accent-contrast)] disabled:opacity-60">{saving ? "저장 확인 중…" : "저장 후 홈 이동"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
