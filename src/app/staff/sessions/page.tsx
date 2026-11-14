import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { kstLabel } from "@/lib/datetime/kst";
import { getStaffPastSessions } from "@/lib/staff-past-sessions";
import { DRIVER_ENTRY_PATH } from "@/lib/staff-session-rules";
import { STAFF_PAST_SESSION_LIST_DAYS, groupPastSessions } from "@/lib/staff/sessionEditWindow";

export const dynamic = "force-dynamic";

/**
 * 선생님 «지난 수업» — 오늘 포함 최근 14일의 완료한 수업을 날짜별로 한 줄씩(2026-11-14 원장 지시).
 * 줄을 누르면 그 수업 화면(완료한 수업 다시 보기·고치기)으로 간다.
 * 한 줄 = 시간 · 반 이름 · 출석 n · 결석 n. 수업 피드가 비었거나 학부모에게 아직 안 보낸 수업은 작은 표시를 붙인다.
 */
export default async function StaffPastSessionsPage() {
  const staff = await requireStaff();
  // 선생님 화면이 없는 사람(기사님만)은 기사님 첫 화면으로 — 홈과 같은 규칙
  if (!staff.roles.teacher) redirect(DRIVER_ENTRY_PATH);

  const groups = groupPastSessions(await getStaffPastSessions());

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 pb-8 pt-5">
      <header className="flex items-end justify-between gap-3">
        <h1 className="academy-heading">지난 수업</h1>
        <p className="text-sm text-[var(--color-academy-muted)]">최근 {STAFF_PAST_SESSION_LIST_DAYS}일</p>
      </header>

      {groups.length === 0 ? (
        <p role="status" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-5 text-sm text-[var(--color-academy-muted)]">
          최근 {STAFF_PAST_SESSION_LIST_DAYS}일 동안 완료한 수업이 없습니다.
        </p>
      ) : groups.map((group) => (
        <section key={group.ymd} aria-label={`${kstLabel(group.ymd)} 수업`}>
          <h2 className="mb-1 text-sm font-medium tabular-nums text-[var(--color-academy-muted)]">{kstLabel(group.ymd)}</h2>
          <ul className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            {group.rows.map((row) => (
              <li key={row.sessionId} className="border-b border-[var(--color-academy-line)] last:border-b-0">
                {/* 한 수업 = 한 줄 행(시간 | 반 | 출석·결석). 줄 전체가 그 수업으로 가는 링크다(터치 56px) */}
                <Link
                  href={`/staff/sessions/${row.sessionId}`}
                  aria-label={`${kstLabel(row.ymd)} ${row.className} 수업 열기`}
                  className="flex min-h-14 items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-academy-soft)]"
                >
                  <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--color-academy-ink)]">{row.startTime}–{row.endTime}</span>
                  {/* 반 이름은 자르지 않고 줄바꿈 허용(말줄임 금지) */}
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    <span className="break-keep font-semibold text-[var(--color-academy-ink)]">{row.className}</span>
                    {row.seasonal && <span className="rounded bg-[var(--color-academy-info-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-info)]">특강</span>}
                    {!row.hasFeed && <span className="rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-warning)]">피드 없음</span>}
                    {!row.published && <span className="rounded bg-[var(--color-academy-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-muted)]">안 보냄</span>}
                  </span>
                  <span className="shrink-0 text-right text-xs tabular-nums">
                    <span className="text-[var(--color-academy-success)]">출석 {row.presentCount}</span>
                    <span className="text-[var(--color-academy-faint)]"> · </span>
                    <span className="text-[var(--color-academy-danger)]">결석 {row.absentCount}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
