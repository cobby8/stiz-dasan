"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
// 타입만 가져온다(서버 모듈 코드는 화면에 실리지 않는다).
import type { DriverAssignBoard } from "@/lib/shuttle/driverAssign";
import type { AssignLegPlan, AssignStudentPlan } from "@/lib/shuttle/driverAssignLogic";

// 기사님 「새 학생 배정」 화면 — 시안 ① 목록 → ② 한 칸 배정.
// 교과서 규칙: 한 묶음에 채운 주 버튼은 하나(검정 = ink) · 상태 표시는 4px 모서리 · 누르는 칩은 알약 · 터치 44px · 글자 12px 이상.
// 색은 학원 테마 CSS 변수만 쓴다(하드코딩 색 금지).

const WEEKDAY_FULL = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const FAIL = "넣지 못했어요. 잠시 뒤 다시 해 주세요.";
// 서버가 돌려주는 안내 중 화면에 그대로 보여도 되는 것(코드로 고른다 — 원문을 그대로 띄우지 않는다).
const KNOWN: Record<string, string> = {
  ALREADY_ASSIGNED: "이미 운행표에 있어요.",
  ROUTE_CHANGED: "운행표가 그사이 바뀌었어요. 새 순서를 다시 불러왔어요.",
  NOT_CLASS_DAY: "이 요일에 다니는 수업이 없어요.",
  NOT_ELIGIBLE: "셔틀 신청이 승인된 학생이 아니에요.",
  FORBIDDEN: "이 작업을 처리할 권한이 없습니다.",
  LOCATION_REQUIRED: "학생 위치가 없어 새 정류장을 만들 수 없어요. 기존 정류장을 골라 주세요.",
  ROSTER_INPUT: "넣을 정보가 맞지 않아요. 목록을 새로 불러와 다시 골라 주세요.",
  MONTH_OUT_OF_RANGE: "이번 달·다음 달 운행표에만 넣을 수 있어요.",
};

type Choice = { kind: "JOIN"; stopIndex: number } | { kind: "INSERT"; position: number };
type View = { mode: "list" } | { mode: "assign"; studentId: string; legKey: string };

function monthLabel(m: string) { return `${Number(m.slice(5, 7))}월`; }

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
    return <AssignView key={`${student.studentId}:${leg.key}:${leg.routeVersion}`} month={month} board={board!} student={student} leg={leg}
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

function AssignView({ month, board, student, leg, notice, warn, onNotice, onBack, onPickLeg, onSaved, onStale }: {
  month: string;
  board: DriverAssignBoard;
  student: AssignStudentPlan;
  leg: AssignLegPlan;
  notice: string;
  warn: string;
  onNotice: (v: string) => void;
  onBack: () => void;
  onPickLeg: (legKey: string) => void;
  onSaved: (label: string) => Promise<void>;
  onStale: (message: string) => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(leg.defaultChoice);
  // 새 정류장 자리는 따로 기억한다 — 「기존 정류장」을 눌렀다가 돌아와도 고른 자리가 남게.
  const [position, setPosition] = useState(leg.defaultPosition);
  const [withLater, setWithLater] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);

  const n = leg.route.length;
  const isNew = choice?.kind === "INSERT";
  const place = leg.direction === "BOARD" ? student.pickup ?? student.dropoff : student.dropoff ?? student.pickup;
  const months = [month, ...board.laterMonths].map(monthLabel).join("·");

  async function save() {
    if (lock.current || !choice || leg.blocked) return;
    lock.current = true; setSaving(true); setError(""); onNotice("");
    try {
      const res = await fetch("/api/staff/shuttle/assign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month, studentId: student.studentId, weekday: leg.weekday, direction: leg.direction,
          choice: choice.kind === "INSERT" ? { kind: "INSERT", position } : choice,
          routeVersion: leg.routeVersion, includeNextMonth: board.laterMonths.length > 0 && withLater,
        }),
      });
      const value = await res.json().catch(() => null);
      if (res.ok && value?.ok) { await onSaved(leg.label); return; }
      const code = typeof value?.code === "string" ? value.code : "";
      if (res.status === 409) {
        // 같은 칸이 이미 들어갔거나 순서가 바뀜 → 알려 주고 새 목록을 읽는다(새 순서로 다시 고르게).
        onStale(KNOWN[code] ?? FAIL);
        return;
      }
      setError(KNOWN[code] ?? FAIL);
    } catch {
      setError(FAIL);
    } finally {
      lock.current = false; setSaving(false);
    }
  }

  // ② 순서 목록 — 새로 넣을 자리(+)를 끼워 보여 준다. 합류면 그 정류장 바로 뒤, 새 정류장이면 고른 자리.
  const plusAt = choice?.kind === "JOIN" ? choice.stopIndex + 1 : position;
  const joinedStop = choice?.kind === "JOIN" ? leg.route[choice.stopIndex] : null;
  const rows: { no: string; stop: string; riders: string; mine?: boolean }[] = [];
  leg.route.forEach((s, i) => {
    if (choice && i === plusAt) rows.push(plusRow());
    rows.push({ no: String(i + 1), stop: `${s.label}${s.arriveTime ? ` · ${s.arriveTime}` : ""}`, riders: s.riders.join(", ") });
  });
  if (choice && plusAt >= n) rows.push(plusRow());
  function plusRow() {
    return joinedStop
      ? { no: "+", stop: `${student.name} 여기서 함께 ${leg.direction === "BOARD" ? "탑승" : "하차"}`, riders: `${joinedStop.label} · 새로 넣을 자리`, mine: true }
      : { no: "+", stop: `${student.name} 새 정류장`, riders: `${leg.newStop?.name ?? ""} · 새로 넣을 자리`, mine: true };
  }
  const endRow = leg.direction === "BOARD" ? `학원 도착 · ${leg.startTime} 수업` : null;
  const startRow = leg.direction === "ALIGHT" ? "학원 출발" : null;

  const radio = (active: boolean) => `flex min-h-11 w-full min-w-0 items-start gap-3 rounded-lg bg-[var(--color-academy-surface)] p-3 text-left ${active ? "border-2 border-[var(--color-academy-ink)]" : "border border-[var(--color-academy-line)]"}`;

  return (
    <main className="mx-auto w-full min-w-0 max-w-lg text-[var(--color-academy-ink)]">
      <header className="space-y-2 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-3">
        <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--color-academy-muted)]">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">chevron_left</span>목록
        </button>
        <div className="min-w-0">
          <h1 className="break-keep text-xl font-bold">{student.name} · {leg.label}</h1>
          <p className="text-sm text-[var(--color-academy-muted)]">{WEEKDAY_FULL[leg.weekday]} {leg.startTime} 시작{student.wishTime ? ` · 희망 ${student.wishTime}` : ""}</p>
        </div>
        {/* 칸 선택 = 누르는 알약 칩(선택 = 검정 채움). 가로로 넘치지 않게 줄바꿈한다. */}
        {student.legs.length > 1 && (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="남은 칸 고르기">
            {student.legs.map((l) => (
              <button key={l.key} type="button" role="tab" aria-selected={l.key === leg.key} disabled={saving} onClick={() => onPickLeg(l.key)}
                className={`min-h-11 rounded-full border px-4 text-sm ${l.key === leg.key ? "border-[var(--color-academy-ink)] bg-[var(--color-academy-ink)] text-[var(--color-academy-surface)]" : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]"}`}>
                {l.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="space-y-6 p-4">
        {notice && <p role="status" className="rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-success)]">{notice}</p>}
        {warn && <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-warning)]">{warn}</p>}
        {leg.blocked && <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-warning)]">{leg.blocked}</p>}

        <section className="space-y-2" aria-labelledby="where-title">
          <h2 id="where-title" className="text-base font-bold">① 어디서 {leg.direction === "BOARD" ? "태울까요" : "내릴까요"}?</h2>
          <p className="break-words text-xs text-[var(--color-academy-muted)]">학생 위치: {place ?? "등록 안 됨"}</p>
          <div role="radiogroup" aria-labelledby="where-title" className="space-y-2">
            {leg.joinOptions.map((o) => {
              const active = choice?.kind === "JOIN" && choice.stopIndex === o.stopIndex;
              return (
                <button key={o.stopIndex} type="button" role="radio" aria-checked={active} disabled={saving} onClick={() => setChoice({ kind: "JOIN", stopIndex: o.stopIndex })} className={radio(active)}>
                  <Dot active={active} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-words text-sm font-bold">{o.label}
                      {o.recommended && <span className="ml-1 rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-px text-xs font-medium text-[var(--color-academy-primary)]">추천</span>}
                    </span>
                    <span className="text-xs text-[var(--color-academy-muted)]">
                      지금 서는 정류장{o.distanceMeters != null ? ` · 학생 위치에서 약 ${o.distanceMeters}m` : ""} · 이미 {o.riders}명
                    </span>
                  </span>
                </button>
              );
            })}
            {leg.newStop && (
              <button type="button" role="radio" aria-checked={isNew} disabled={saving} onClick={() => setChoice({ kind: "INSERT", position })} className={radio(isNew)}>
                <Dot active={isNew} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-bold">학생 위치에 새 정류장
                    {leg.defaultChoice?.kind === "INSERT" && <span className="ml-1 rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-px text-xs font-medium text-[var(--color-academy-primary)]">추천</span>}
                  </span>
                  <span className="break-words text-xs text-[var(--color-academy-muted)]">{leg.newStop.name} · 이름은 넣은 뒤 고칠 수 있어요</span>
                </span>
              </button>
            )}
          </div>
          <p className="text-xs text-[var(--color-academy-muted)]">{leg.reason}</p>
        </section>

        <section className="space-y-2" aria-labelledby="order-title">
          <h2 id="order-title" className="text-base font-bold">② 몇 번째로 {leg.direction === "BOARD" ? "태울까요" : "내릴까요"}?</h2>
          <p className="text-xs text-[var(--color-academy-muted)]">지금 기사님 화면의 {leg.label} 순서예요.</p>
          <ol className="overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            {startRow && <RouteRow no="출발" stop={startRow} riders="" first />}
            {rows.map((r, i) => <RouteRow key={`${r.no}-${i}`} no={r.no} stop={r.stop} riders={r.riders} mine={r.mine} first={!startRow && i === 0} />)}
            {endRow && <RouteRow no="도착" stop={endRow} riders="" first={rows.length === 0} />}
          </ol>
          {n === 0 && <p className="text-xs text-[var(--color-academy-muted)]">이 수업·방향에 아직 정차가 없어 첫 정차로 들어가요.</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!isNew || saving || position <= 0} onClick={() => { const p = Math.max(0, position - 1); setPosition(p); setChoice({ kind: "INSERT", position: p }); }}
              className="min-h-11 flex-1 rounded-full border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-sm disabled:opacity-40">한 칸 위로</button>
            <button type="button" disabled={!isNew || saving || position >= n} onClick={() => { const p = Math.min(n, position + 1); setPosition(p); setChoice({ kind: "INSERT", position: p }); }}
              className="min-h-11 flex-1 rounded-full border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-sm disabled:opacity-40">한 칸 아래로</button>
          </div>
          {choice?.kind === "JOIN" && <p className="text-xs text-[var(--color-academy-muted)]">기존 정류장에 함께 타면 그 정류장 순서를 따라요. 순서를 바꾸려면 새 정류장을 고르세요.</p>}
        </section>

        {board.laterMonths.length > 0 && (
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={withLater} disabled={saving} onChange={(e) => setWithLater(e.target.checked)} className="h-5 w-5 accent-[var(--color-academy-ink)]" />
            {months} 운행표에 같이 넣기
          </label>
        )}

        <div className="space-y-2">
          {error && (
            <div role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">
              <p>{error}</p>
              {error === FAIL && (
                <button type="button" onClick={() => void save()} className="mt-1 inline-flex min-h-11 items-center gap-1 underline">
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">refresh</span>다시 시도
                </button>
              )}
            </div>
          )}
          {/* 이 화면의 채운 주 버튼은 이것 하나(검정). */}
          <button type="button" disabled={saving || !choice || Boolean(leg.blocked)} onClick={() => void save()}
            className="flex h-[52px] w-full items-center justify-center rounded-lg bg-[var(--color-academy-ink)] text-base font-bold text-[var(--color-academy-surface)] disabled:opacity-50">
            {saving ? "넣는 중…" : `${leg.label} 순서에 넣기`}
          </button>
        </div>
      </div>
    </main>
  );
}

function Dot({ active }: { active: boolean }) {
  return (
    <span aria-hidden="true" className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${active ? "border-[var(--color-academy-ink)]" : "border-[var(--color-academy-line)]"}`}>
      {active && <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-academy-ink)]" />}
    </span>
  );
}

function RouteRow({ no, stop, riders, mine, first }: { no: string; stop: string; riders: string; mine?: boolean; first?: boolean }) {
  return (
    <li className={`flex min-w-0 items-center gap-3 p-3 ${first ? "" : "border-t border-[var(--color-academy-line)]"} ${mine ? "bg-[var(--color-academy-primary-soft)] outline-dashed outline-2 -outline-offset-2 outline-[var(--color-academy-primary)]" : ""}`}>
      <span className={`grid h-7 min-w-7 shrink-0 place-items-center rounded-full px-1 text-xs font-bold ${mine ? "bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>{no}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`break-words text-sm ${mine ? "font-bold" : ""}`}>{stop}</span>
        {riders && <span className="break-words text-xs text-[var(--color-academy-muted)]">{riders}</span>}
      </span>
    </li>
  );
}
