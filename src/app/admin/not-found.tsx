import Link from "next/link";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

export default function AdminNotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <section className="w-full max-w-lg rounded-3xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]">
          <FontFreeIcon name="error" size={30} />
        </span>
        <h1 className="mt-5 text-2xl font-black text-[var(--color-academy-ink)]">정보를 찾을 수 없습니다</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--color-academy-muted)]">
          삭제되었거나 주소가 잘못된 항목입니다. 목록으로 돌아가 다시 선택해 주세요.
        </p>
        <Link
          href="/admin"
          className="mt-7 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--color-academy-primary)] px-5 font-black text-[var(--color-academy-on-primary)]"
        >
          <FontFreeIcon name="home" size={19} />
          관리자 대시보드로 이동
        </Link>
      </section>
    </main>
  );
}
