"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const ITEMS: Array<{ key: string; href: string; label: string; icon: string }> = [
  { key: "overview", href: "/admin/seasonal?tab=overview", label: "운영 현황", icon: "dashboard" },
  { key: "seasons", href: "/admin/seasonal?tab=seasons", label: "시즌·반", icon: "calendar_month" },
  { key: "applications", href: "/admin/seasonal?tab=applications", label: "신청 관리", icon: "assignment_ind" },
  { key: "attendance", href: "/admin/seasonal/attendance", label: "출석 관리", icon: "fact_check" },
  { key: "makeup", href: "/admin/seasonal/attendance?view=makeup", label: "보강 관리", icon: "cached" },
  { key: "absence", href: "/admin/seasonal/absence", label: "결석 신고 처리", icon: "event_busy" },
];

// 활성 탭 판정 — 경로(pathname) + ?view 쿼리 조합. 기존 판정 결과와 동일하다.
function resolveActiveKey(pathname: string, view: string | null): string {
  if (pathname.startsWith("/admin/seasonal/attendance")) return view === "makeup" ? "makeup" : "attendance";
  if (pathname.startsWith("/admin/seasonal/absence")) return "absence";
  return "";
}

// 탭 바 UI만 담당(순수 렌더). 활성 키는 바깥에서 넘겨받는다.
// makeupPending = 승인 대기 보강 건수. 0이면 뱃지를 숨긴다.
function TabsView({ active, makeupPending = 0 }: { active: string; makeupPending?: number }) {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-[var(--color-academy-line)] bg-white p-1.5" aria-label="방학특강 메뉴">
        {ITEMS.map((it) => {
          const on = it.key === active;
          // "보강 관리" 탭에만, 대기 건수가 1건 이상일 때만 빨간 뱃지를 붙인다.
          const badge = it.key === "makeup" && makeupPending > 0 ? makeupPending : 0;
          return (
            // Link = 클라이언트 사이드 이동. <a>와 달리 페이지 전체를 새로고침하지 않는다.
            <Link
              key={it.key}
              href={it.href}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold ${on ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"}`}
            >
              <span className="material-symbols-outlined text-xl">{it.icon}</span>
              {it.label}
              {badge > 0 && (
                // 빨간 뱃지 — bg-[var(--color-academy-danger)] + 흰 글자는 라이트/다크 모두에서 대비가 충분하다.
                // aria-label로 스크린리더에도 "승인 대기 N건"이 읽히게 한다.
                <span
                  aria-label={`승인 대기 ${badge}건`}
                  title={`승인 대기 ${badge}건`}
                  className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--color-academy-danger)] px-1.5 py-0.5 text-[11px] font-black leading-none text-white"
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// useSearchParams()를 쓰는 부분만 분리 — Suspense 경계 안에 두기 위함.
function TabsWithSearchParams({ makeupPending }: { makeupPending?: number }) {
  const pathname = usePathname();
  // 첫 렌더부터 ?view 값을 알 수 있어 "출석 관리 → 보강 관리" 깜빡임이 없다.
  const view = useSearchParams().get("view");
  return <TabsView active={resolveActiveKey(pathname, view)} makeupPending={makeupPending} />;
}

// 방학특강 섹션 공통 탭 바 — 출석/보강/셔틀 페이지 상단에 표시. (신청·반 관리 페이지는 자체 nav 사용)
// makeupPending은 서버 페이지에서 내려주는 승인 대기 보강 건수(선택값). 없으면 뱃지 없이 기존과 동일하게 동작한다.
export default function SeasonalSectionTabs({ makeupPending = 0 }: { makeupPending?: number } = {}) {
  const pathname = usePathname();
  return (
    // 페이지 파일을 건드리지 않도록 Suspense 경계를 이 컴포넌트 안에서 처리한다.
    // fallback은 쿼리를 뺀 경로만으로 판정 → 레이아웃이 동일해 시각적 흔들림이 없다.
    <Suspense fallback={<TabsView active={resolveActiveKey(pathname, null)} makeupPending={makeupPending} />}>
      <TabsWithSearchParams makeupPending={makeupPending} />
    </Suspense>
  );
}
