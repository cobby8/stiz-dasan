"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { UpcomingChild, UpcomingClassDate } from "@/lib/regular/parent-regular-absence";
import type { RegularMakeupRow } from "@/lib/regular/parent-regular-makeup";
import { groupByUpcomingDate } from "@/components/admin/list/upcomingDateGroups";
import { todayKst } from "@/lib/datetime/kst";

// 날짜 묶음 이름 — 가까운 수업일이 먼저 보이게(오늘 → 이번 주 → 다음 주 → 이후)
const DATE_GROUP_LABELS = { today: "오늘", thisWeek: "이번 주", nextWeek: "다음 주", later: "이후", past: "지난 수업" };

// 결석 사유 선택지(정규 5종). 방학특강과 동일 집합.
const REASONS: { value: string; label: string }[] = [
  { value: "ILLNESS_INJURY", label: "질병/부상" },
  { value: "PERSONAL", label: "개인 사정" },
  { value: "FAMILY_TRIP", label: "가족 여행" },
  { value: "SCHOOL_EVENT", label: "학교 행사" },
  { value: "ETC", label: "기타" },
];

// 다가오는 날짜 하나를 나타내는 카드용 키(자녀·반·날짜 조합).
function dateKey(d: UpcomingClassDate) {
  return `${d.studentId}|${d.classId}|${d.date}`;
}

export default function RegularAbsenceClient({
  initial,
  makeups = [],
}: {
  initial: UpcomingChild[];
  makeups?: RegularMakeupRow[];
}) {
  const [children, setChildren] = useState<UpcomingChild[]>(initial);
  const [openKey, setOpenKey] = useState<string>(""); // 신고 폼이 열린 날짜 키
  const [reason, setReason] = useState<Record<string, string>>({}); // 날짜별 선택 사유
  const [busyKey, setBusyKey] = useState<string>("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  // 서버에서 최신 상태 재조회.
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/mypage/regular-absence", { cache: "no-store" });
      const j = await r.json();
      if (r.ok) setChildren(j.children || []);
    } catch {
      /* noop */
    }
  }, []);

  // 결석 신고.
  const report = useCallback(
    async (d: UpcomingClassDate) => {
      const key = dateKey(d);
      const r = reason[key];
      if (!r) {
        setErr("결석 사유를 선택해 주세요.");
        return;
      }
      setErr("");
      setMsg("");
      setBusyKey(key);
      try {
        const res = await fetch("/api/mypage/regular-absence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId: d.studentId,
            classId: d.classId,
            date: d.date,
            reason: r,
          }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || "신고에 실패했습니다.");
        setMsg("결석을 신고했어요. 학원에서 확인합니다.");
        setOpenKey("");
        await reload();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyKey("");
      }
    },
    [reason, reload],
  );

  // 결석 신고 취소.
  const cancel = useCallback(
    async (d: UpcomingClassDate) => {
      const key = dateKey(d);
      setErr("");
      setMsg("");
      setBusyKey(key);
      try {
        const res = await fetch("/api/mypage/regular-absence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            studentId: d.studentId,
            classId: d.classId,
            date: d.date,
          }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || "취소에 실패했습니다.");
        setMsg("결석 신고를 취소했어요.");
        await reload();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyKey("");
      }
    },
    [reload],
  );

  const hasAnyClass = useMemo(
    () => children.some((c) => c.classes.some((cl) => cl.dates.length > 0)),
    [children],
  );

  // 자녀별로 반을 펼쳐 수업일 하나하나를 날짜 묶음에 넣는다(반 카드 안의 작은 카드 → 날짜별 한 줄 행).
  // 오늘은 KST 모듈로만 구한다.
  const childGroups = useMemo(() => {
    const today = todayKst();
    return children
      .map((child) => ({
        studentId: child.studentId,
        studentName: child.studentName,
        groups: groupByUpcomingDate(child.classes.flatMap((cl) => cl.dates), (d) => d.date, today, DATE_GROUP_LABELS),
      }))
      .filter((child) => child.groups.length > 0);
  }, [children]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* 헤더 */}
      <div className="mb-2 flex items-center gap-2">
        <Link href="/mypage" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-black text-brand-navy-900 dark:text-white">
          <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">event_busy</span>
          정규수업 결석 신고
        </h1>
      </div>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        신고한 결석은 선생님과 기사님에게 표시됩니다.
      </p>

      {/* 예정 보강(읽기 전용) — 관리자가 지정한 자녀의 보강 일정 */}
      {makeups.length > 0 && (
        <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 dark:border-blue-950 dark:bg-blue-950/30">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-black text-blue-800 dark:text-blue-300">
            <span className="material-symbols-outlined text-lg">event_repeat</span>
            예정 보강
          </h2>
          <ul className="divide-y divide-blue-100 overflow-hidden rounded-xl bg-white dark:divide-blue-950 dark:bg-gray-900">
            {makeups.map((m) => (
              // 한 줄 행: 학생 · 보강 반(줄바꿈 허용) · 보강 날짜(오른쪽) · 상태 / 아래 줄에 원래 결석
              <li key={m.id} className="px-3 py-2">
                <div className="flex min-h-7 items-center gap-2">
                  <span className="shrink-0 text-sm font-black text-gray-900 dark:text-gray-100">{m.studentName}</span>
                  <span className="min-w-0 flex-1 break-keep text-sm text-gray-600 dark:text-gray-300">{m.makeupClassName ?? "보강 반"}</span>
                  {m.makeupDateLabel && (
                    <span className="shrink-0 text-right text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100">{m.makeupDateLabel}</span>
                  )}
                  <span className="inline-flex shrink-0 items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-black text-blue-700 dark:bg-blue-900 dark:text-blue-200">
                    {m.statusLabel}
                  </span>
                </div>
                {(m.originalClassName || m.originalDateLabel) && (
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    (결석: {m.originalClassName ?? ""}
                    {m.originalDateLabel ? ` ${m.originalDateLabel}` : ""})
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            보강 일정은 학원에서 지정합니다. 변경이 필요하면 학원으로 문의해 주세요.
          </p>
        </div>
      )}

      {msg && (
        <div className="mb-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-bold text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
          {msg}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {err}
        </div>
      )}

      {!hasAnyClass ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          다가오는 정규수업이 없습니다.
        </div>
      ) : (
        <div className="space-y-5">
          {childGroups.map((child) => (
            <div key={child.studentId}>
              <h2 className="mb-2 px-1 text-sm font-black text-gray-900 dark:text-gray-100">{child.studentName}</h2>
              <div className="space-y-3">
                {child.groups.map((group) => (
                  // 날짜 묶음(오늘/이번 주/다음 주/이후) — 묶음 제목 오른쪽에 건수
                  <section
                    key={group.key}
                    aria-label={`${child.studentName} ${group.label}`}
                    className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white dark:border-gray-800 dark:bg-gray-800"
                  >
                    <h3 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)] dark:bg-gray-900 dark:text-gray-100">
                      <span>{group.label}</span>
                      <span className="tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
                    </h3>
                    <ul className="divide-y divide-[var(--color-academy-line)] dark:divide-gray-700">
                      {group.items.map((d) => {
                        const key = dateKey(d);
                        const busy = busyKey === key;
                        return (
                          <li key={key} className="px-3 py-1.5">
                            {/* 한 줄 행: 반·시각(왼쪽, 줄바꿈 허용) · 날짜(오른쪽, 숫자 폭 고정) · 동작 버튼 */}
                            <div className="flex min-h-11 items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="break-keep text-sm font-bold text-brand-navy-900 dark:text-white">
                                  {d.className}
                                  <span className="ml-1.5 text-xs font-normal tabular-nums text-gray-400">{d.startTime}</span>
                                </p>
                                {/* 상태 배지와 사유를 따로 나눠 보인다(«확정됨 · 사유» 이어 붙이지 않음) */}
                                {d.locked ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-black text-green-700 dark:bg-green-950 dark:text-green-300">
                                      <span className="material-symbols-outlined text-sm">check_circle</span>
                                      확정됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-gray-600 dark:text-gray-300">{d.reasonLabel}</span>}
                                    <span className="text-xs text-gray-400">학원 확정 (변경은 문의)</span>
                                  </p>
                                ) : d.reported ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-black text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                                      결석 신고됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-gray-600 dark:text-gray-300">{d.reasonLabel}</span>}
                                  </p>
                                ) : null}
                              </div>
                              <span className="shrink-0 text-right text-sm font-bold tabular-nums text-gray-800 dark:text-gray-100">{d.dateLabel}</span>

                              {/* 액션 — 기존과 같은 조건·같은 함수(신고 취소 / 결석 신고 폼 열기) */}
                              {d.locked ? null : d.reported ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => cancel(d)}
                                  className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-gray-300 px-3 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                                >
                                  신고 취소
                                </button>
                              ) : openKey === key ? null : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey(key)}
                                  className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand-orange-500 px-3 text-xs font-black text-white hover:opacity-90 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                >
                                  결석 신고
                                </button>
                              )}
                            </div>

                            {/* 신고 폼(사유 선택) — 기존 그대로: 사유 고르고 «신고하기» */}
                            {openKey === key && !d.reported && (
                              <div className="mb-1.5 mt-1 flex flex-wrap items-center gap-2">
                                <select
                                  value={reason[key] || ""}
                                  onChange={(e) => setReason((prev) => ({ ...prev, [key]: e.target.value }))}
                                  className="min-h-11 rounded-lg border border-gray-200 bg-white px-2 text-sm font-bold text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                  aria-label="결석 사유"
                                >
                                  <option value="">사유 선택</option>
                                  {REASONS.map((r) => (
                                    <option key={r.value} value={r.value}>
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => report(d)}
                                  className="inline-flex min-h-11 items-center rounded-lg bg-brand-orange-500 px-3 text-xs font-black text-white hover:opacity-90 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                >
                                  신고하기
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey("")}
                                  className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400"
                                >
                                  닫기
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
