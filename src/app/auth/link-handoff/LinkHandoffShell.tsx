import type { ReactNode } from "react";

// 바깥 브라우저 확인·완료 화면 공용 틀(2026-11-15 A안).
// 아이콘·이모지 없이 글자만, 색은 academy 토큰만, 굵기는 제목 700·강조 600 만 쓴다.

export function LinkHandoffShell({
  title,
  message,
  tone = "neutral",
  children,
}: {
  title: string;
  message?: string;
  tone?: "neutral" | "success" | "danger";
  children?: ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
      : tone === "danger"
        ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
        : "";
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <p className="mb-1 text-xs text-[var(--color-academy-muted)]">스티즈 농구교실</p>
      <h1 className="academy-heading mb-3">{title}</h1>
      <div className="rounded-2xl border border-[var(--color-academy-line)] p-4">
        {message && <p role="status" className={`rounded-xl px-3 py-2 text-sm font-medium ${toneClass}`}>{message}</p>}
        {children}
      </div>
    </main>
  );
}
