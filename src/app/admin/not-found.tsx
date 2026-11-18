import Link from "next/link";
import ScopeBackLink from "@/components/navigation/ScopeBackLink";

export default function AdminNotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <section className="w-full max-w-lg rounded-3xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
        <h1 className="academy-page-title">정보를 찾을 수 없습니다</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--color-academy-muted)]">
          삭제되었거나 주소가 잘못된 항목입니다. 목록으로 돌아가 다시 선택해 주세요.
        </p>
        {/* 안내 문구가 «목록으로 돌아가»인데 대시보드 버튼만 있었다(2026-11-17) —
            방금 있던 화면(목록)으로 돌아가는 글자 링크를 주 버튼 옆에 둔다. 기록이 없으면 대시보드 */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <ScopeBackLink fallbackHref="/admin" className="academy-button-secondary">
            ← 이전 화면
          </ScopeBackLink>
          <Link href="/admin" className="academy-button-primary">
            관리자 대시보드로 이동
          </Link>
        </div>
      </section>
    </main>
  );
}
