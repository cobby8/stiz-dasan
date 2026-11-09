export default function StaffLoading() {
  return (
    <main aria-busy="true" aria-label="교사용 앱을 불러오는 중" className="mx-auto max-w-lg animate-pulse space-y-4 px-4 py-5">
      <div className="h-4 w-24 rounded bg-[var(--color-academy-line)]" />
      <div className="h-8 w-48 rounded bg-[var(--color-academy-line)]" />
      <div className="h-24 rounded-2xl bg-[var(--color-academy-line)]" />
      <div className="h-40 rounded-2xl bg-[var(--color-academy-line)]" />
      <p className="sr-only">잠시만 기다려 주세요.</p>
    </main>
  );
}
