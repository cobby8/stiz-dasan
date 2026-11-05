"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
// 타입만 가져온다(서버 모듈 코드는 화면에 실리지 않는다).
import type { DriverAssignBoard } from "@/lib/shuttle/driverAssign";
// 「한 칸 배정」 화면은 관리자 정규배차 모달과 같이 쓰는 공용 컴포넌트다(2026-11-05) — 모양·동작은 그대로 옮겼다.
import AssignLegView, { monthLabel } from "@/components/shuttle/assign/AssignLegView";

// 기사님 「새 학생 배정」 화면 — 시안 ① 목록 → ② 한 칸 배정.
// 교과서 규칙: 한 묶음에 채운 주 버튼은 하나(검정 = ink) · 상태 표시는 4px 모서리 · 누르는 칩은 알약 · 터치 44px · 글자 12px 이상.
// 색은 학원 테마 CSS 변수만 쓴다(하드코딩 색 금지).

type View = { mode: "list" } | { mode: "assign"; studentId: string; legKey: string };

export default function DriverAssignClient({ month }: { month: string }) {
  const [board, setBoard] = useState<DriverAssignBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<View>({ mode: "list" });
  const [notice, setNotice] = useState("");
  // 409(이미 들어감·순서 바뀜) 안내 — 목록을 다시 읽으면 배정 화면이 새로 그려지므로 부모가 들고 있는다.
  const [warn, setWarn] = useState("");
  const seq = useRef(0);

  // 목록을 (다시) 읽는다. 읽은 결과를 돌려줘 저장 직후 「다음 남은 칸」을 고를 때 쓴다.
  const load = useCallback(async (): Promise<DriverAssignBoard | null> => {
    const current = ++seq.current;
    setLoading(true); setLoadError(false);
    try {
      const res = await fetch(`/api/staff/shuttle/assign?month=${encodeURIComponent(month)}`, { cache: "no-store" });
      const value = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(value?.students)) throw new Error("load");
      if (current === seq.current) setBoard(value as DriverAssignBoard);
      return value as DriverAssignBoard;
    } catch {
      if (current === seq.current) setLoadError(true);
      return null;
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const student = view.mode === "assign" ? board?.students.find((s) => s.studentId === view.studentId) ?? null : null;
  const leg = student && view.mode === "assign" ? student.legs.find((l) => l.key === view.legKey) ?? student.legs[0] ?? null : null;

  // 저장 성공 → 목록 다시 읽기 → 같은 학생의 다음 남은 칸, 없으면 목록으로.
  async function afterSaved(studentId: string, doneLabel: string) {
    setWarn("");
    const next = await load();
    const s = next?.students.find((x) => x.studentId === studentId);
    if (s && s.legs.length > 0) {
      setNotice(`${doneLabel}에 넣었어요`);
      setView({ mode: "assign", studentId, legKey: s.legs[0].key });
    } else {
      setNotice(`${doneLabel}에 넣었어요 · 이 학생은 모두 넣었어요`);
      setView({ mode: "list" });
    }
  }

  if (view.mode === "assign" && student && leg) {
    return <AssignLegView key={`${student.studentId}:${leg.key}:${leg.routeVersion}`} month={month} board={board!} student={student} leg={leg}
      notice={notice} warn={warn} onNotice={(v) => { setNotice(v); setWarn(""); }}
      onBack={() => { setNotice(""); setWarn(""); setView({ mode: "list" }); }}
      onPickLeg={(legKey) => { setNotice(""); setWarn(""); setView({ mode: "assign", studentId: student.studentId, legKey }); }}
      onSaved={(label) => afterSaved(student.studentId, label)}
      onStale={(message) => { setWarn(message); void load(); }} />;
  }

  const students = board?.students ?? [];
  return (
    <main className="mx-auto w-full min-w-0 max-w-lg text-[var(--color-academy-ink)]">
      <header className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-bold">새 학생 배정</h1>
          <span className="text-sm text-[var(--color-academy-muted)]">{monthLabel(month)} 운행</span>
        </div>
        {board && (
          <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
            배정할 학생 <b className="text-[var(--color-academy-ink)]">{students.length}명</b> · 남은 칸 <b className="text-[var(--color-academy-warning)]">{board.openLegCount}칸</b>
          </p>
        )}
      </header>
      <div className="space-y-4 p-4">
        {notice && <p role="status" className="rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-success)]">{notice}</p>}
        {warn && <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-warning)]">{warn}</p>}
        {loading && !board && <p role="status" className="text-sm">불러오는 중…</p>}
        {loadError && (
          <div role="alert" className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3 text-sm">
            <p>목록을 불러오지 못했어요. 잠시 뒤 다시 해 주세요.</p>
            <button type="button" onClick={() => void load()} className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-full border border-[var(--color-academy-line)] px-4 font-bold">
              <span className="material-symbols-outlined text-lg" aria-hidden="true">refresh</span>다시 시도
            </button>
          </div>
        )}
        {board && students.length === 0 && !loadError && (
          <p className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-5 text-sm">지금 배정할 학생이 없어요.</p>
        )}
        {students.map((s) => (
          <section key={s.studentId} className="min-w-0 space-y-3 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4">
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="truncate text-lg font-bold">{s.name}</h2>
                {s.grade && <span className="shrink-0 text-sm text-[var(--color-academy-muted)]">{s.grade}</span>}
                {/* 상태 표시 = 4px 모서리(누르는 칩과 모양을 다르게) */}
                <span className="ml-auto shrink-0 rounded bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-academy-warning)]">{s.legs.length}칸 남음</span>
              </div>
              <p className="break-keep text-sm">{s.classes || "수업 확인 필요"}</p>
              <p className="text-xs text-[var(--color-academy-muted)]">희망 시각 {s.wishTime || "없음"}</p>
            </div>
            <dl className="space-y-1.5 rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm">
              <div className="flex min-w-0 gap-2"><dt className="w-8 shrink-0 text-[var(--color-academy-muted)]">승차</dt><dd className="min-w-0 break-words">{s.pickup ?? "위치 없음"}</dd></div>
              <div className="flex min-w-0 gap-2"><dt className="w-8 shrink-0 text-[var(--color-academy-muted)]">하차</dt><dd className="min-w-0 break-words">{s.dropoff ?? "위치 없음"}</dd></div>
            </dl>
            <ul className="flex flex-wrap gap-2" aria-label="남은 칸">
              {s.legs.map((l) => (
                <li key={l.key} className="rounded border border-dashed border-[var(--color-academy-muted)] px-2 py-1 text-xs text-[var(--color-academy-muted)]">{l.label} · 남음</li>
              ))}
            </ul>
            <button type="button" onClick={() => { setNotice(""); setView({ mode: "assign", studentId: s.studentId, legKey: s.legs[0].key }); }}
              className="flex h-12 w-full items-center justify-center rounded-lg bg-[var(--color-academy-ink)] text-base font-bold text-[var(--color-academy-surface)]">
              배정 시작
            </button>
          </section>
        ))}
        <p className="text-center text-xs text-[var(--color-academy-muted)]">이미 운행표에 있는 학생은 여기 나오지 않아요.</p>
        <Link href="/staff/shuttle" className="flex min-h-11 items-center justify-center gap-1 text-sm font-bold text-[var(--color-academy-muted)]">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">arrow_back</span>운행 관리로
        </Link>
      </div>
    </main>
  );
}
