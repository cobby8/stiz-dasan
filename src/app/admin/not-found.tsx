import Link from "next/link";

export default function AdminNotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <section className="w-full max-w-lg rounded-3xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
        <h1 className="academy-page-title">정보를 찾을 수 없습니다</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--color-academy-muted)]">
          삭제되었거나 주소가 잘못된 항목입니다. 목록으로 돌아가 다시 선택해 주세요.
        </p>
        <Link
          href="/admin"
          className="academy-button-primary mt-7"
        >
          관리자 대시보드로 이동
        </Link>
      </section>
    </main>
  );
}
