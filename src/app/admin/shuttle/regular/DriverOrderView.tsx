"use client";

import { useEffect, useMemo, useState } from "react";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";
// ⚠️ 기사님 화면과 **같은 순수 함수**로 만든다(별도 로직 금지 — 한쪽만 고쳐지면 원장이 보는 순서와 기사님 순서가 달라진다).
//    selectDriverDayRows: 그 요일 학생 정차행 고르기·정렬 / buildFallbackClasses: 수업시간 섹션 → groupSheetStops 로 정차 묶기.
import { buildFallbackClasses, selectDriverDayRows, type DriverStop } from "@/lib/shuttle/regularDriverRouteLogic";
import { formatRosterMonths, type RosterScope } from "@/lib/shuttle/regularRosterEditLogic";

// 셔틀 명단 → 「기사님 화면(운행 순서)」 보기.
// 정규 배차 저장 노선이 없는 요일에 기사님이 실제로 보는 화면(폴백)을 그대로 보여 주고,
// 정차 단위 ↑↓ 순서와 정차 시각을 고쳐 저장한다(regular-roster PATCH action:"reorder").
// 결석·오늘만 변경은 날짜마다 다르므로 여기서는 빼고(결석 판정 = 항상 false) 정규 순서만 다룬다.

type Dir = "BOARD" | "ALIGHT";
const NOT_ABSENT = () => false;
const DIR_LABEL: Record<Dir, string> = { BOARD: "등원", ALIGHT: "하원" };

/** 칸(수업·방향) 키 */
function cellKey(classTime: string, dir: Dir) { return `${classTime}|${dir}`; }
/** 정차 목록 서명 — 순서·시각·소속 행이 같으면 같은 값. 저장 안 됨 판정과 「명단이 바뀌면 고친 내용 버리기」에 쓴다. */
function stopsSig(stops: DriverStop[]): string {
  return stops.map((s) => `${s.label}@${s.arriveTime ?? ""}:${s.rows.map((r) => r.rowId).join(",")}`).join("|");
}

type Draft = { baseSig: string; stops: DriverStop[] };
/** time 입력칸은 'HH:MM' 두 자리만 받는다 — 명단의 '9:05' 같은 값도 보이도록 맞춘다(형식이 아니면 빈칸). */
function toTimeInput(v: string | null): string {
  const m = (v ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

export default function DriverOrderView({ stops, weekday, serviceMonth, laterMonths, defaultScope, savedRoute, onSaved, onDirtyChange }: {
  stops: RegularShuttleStop[];
  weekday: number;
  serviceMonth: string;
  laterMonths: string[];
  defaultScope: RosterScope;
  /** 방향별로 정규 배차 저장 노선이 기사님 화면을 대신하고 있는지(그 방향은 여기 순서가 쓰이지 않는다). */
  savedRoute: { PICKUP: boolean; DROPOFF: boolean } | null;
  onSaved: (message: string) => Promise<void> | void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  // 기사님 화면과 똑같이 만든다: 요일 행 고르기 → 수업시간 섹션 → 정류장 묶음.
  const classes = useMemo(() => buildFallbackClasses(selectDriverDayRows(stops, weekday), NOT_ABSENT), [stops, weekday]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [scope, setScope] = useState<RosterScope>(defaultScope);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 달이 바뀌면 기본 적용 범위도 다시(지난 달 = 이 달만).
  useEffect(() => { setScope(defaultScope); }, [defaultScope]);

  // 지금 화면의 정차 목록 — 고친 내용(draft)은 그 칸의 원본이 그대로일 때만 쓴다.
  // (저장·다른 편집으로 명단이 바뀌면 옛 순서로 덮어쓰지 않도록 그 칸의 고친 내용은 버린다.)
  function current(classTime: string, dir: Dir, base: DriverStop[]): { stops: DriverStop[]; dirty: boolean } {
    const d = drafts[cellKey(classTime, dir)];
    if (!d || d.baseSig !== stopsSig(base)) return { stops: base, dirty: false };
    return { stops: d.stops, dirty: stopsSig(d.stops) !== stopsSig(base) };
  }

  const anyDirty = classes.some((c) => current(c.classTime, "BOARD", c.board).dirty || current(c.classTime, "ALIGHT", c.alight).dirty);
  useEffect(() => { onDirtyChange?.(anyDirty); }, [anyDirty, onDirtyChange]);
  // 저장 안 한 변경이 있으면 새로고침·탭 닫기 때 브라우저 기본 경고.
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  function edit(classTime: string, dir: Dir, base: DriverStop[], change: (list: DriverStop[]) => DriverStop[]) {
    const { stops: list } = current(classTime, dir, base);
    setDrafts((cur) => ({ ...cur, [cellKey(classTime, dir)]: { baseSig: stopsSig(base), stops: change(list) } }));
    setErr(null);
  }
  // 같은 수업·같은 방향 안에서만 한 칸씩 옮긴다.
  function move(classTime: string, dir: Dir, base: DriverStop[], from: number, to: number) {
    edit(classTime, dir, base, (list) => {
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }
  function setTime(classTime: string, dir: Dir, base: DriverStop[], index: number, value: string) {
    edit(classTime, dir, base, (list) => list.map((s, i) => (i === index ? { ...s, arriveTime: value || null } : s)));
  }
  function reset(classTime: string, dir: Dir) {
    setDrafts((cur) => { const next = { ...cur }; delete next[cellKey(classTime, dir)]; return next; });
  }

  async function save(classTime: string, dir: Dir, list: DriverStop[]) {
    const key = cellKey(classTime, dir);
    if (savingKey) return;
    setSavingKey(key); setErr(null);
    try {
      const r = await fetch("/api/admin/shuttle/regular-roster", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reorder", serviceMonth, scope, weekday, classTime, direction: dir,
          // 정차 = 그 정류장에 묶인 모든 행. 서버가 이 행들의 sortOrder·arriveTime 을 함께 고친다.
          stops: list.map((s) => ({ rowIds: s.rows.map((row) => row.rowId), arriveTime: s.arriveTime })),
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "저장하지 못했습니다.");
      const applied: string[] = Array.isArray(j?.appliedMonths) ? j.appliedMonths : [];
      const skipped: string[] = Array.isArray(j?.skippedMonths) ? j.skippedMonths : [];
      reset(classTime, dir);
      await onSaved(`${classTime} ${DIR_LABEL[dir]} 순서·시각을 저장했습니다${applied.length > 0 ? ` · ${formatRosterMonths(applied)}에 반영` : ""}${skipped.length > 0 ? ` (${formatRosterMonths(skipped)}은 해당 학생 행이 없어 건너뜀)` : ""}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setSavingKey(null);
    }
  }

  // 한 칸(수업·방향)의 정차 목록 — 함수로 호출한다(컴포넌트로 만들면 렌더마다 새로 만들어져 시각 입력 포커스가 풀린다).
  function cell(classTime: string, dir: Dir, base: DriverStop[]) {
    if (base.length === 0) return null;
    const { stops: list, dirty } = current(classTime, dir, base);
    const key = cellKey(classTime, dir);
    const routeSaved = savedRoute ? savedRoute[dir === "BOARD" ? "PICKUP" : "DROPOFF"] : false;
    return (
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-black ${dir === "BOARD" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200"}`}>{dir === "BOARD" ? "⬆ 등원" : "⬇ 하원"}</span>
          <span className="text-[11.5px] font-bold text-gray-400">{list.length}곳 · {list.reduce((n, s) => n + s.rows.length, 0)}명</span>
          {routeSaved && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10.5px] font-black text-violet-700 dark:bg-violet-950/30 dark:text-violet-200">정규 배차 저장 노선 운행 중 — 이 순서는 기사님 화면에 쓰이지 않음</span>}
          {dirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-black text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">● 저장 안 됨</span>}
          <span className="ml-auto flex gap-1.5">
            {dirty && <button type="button" onClick={() => reset(classTime, dir)} className="rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] font-black text-gray-600 dark:border-gray-600 dark:text-gray-200">되돌리기</button>}
            <button type="button" disabled={!dirty || savingKey !== null} onClick={() => void save(classTime, dir, list)}
              className="rounded-lg bg-brand-orange-500 px-2.5 py-1 text-[12px] font-black text-white disabled:opacity-40">{savingKey === key ? "저장 중…" : "💾 저장"}</button>
          </span>
        </div>
        <ol className="mt-1.5 space-y-1.5">
          {list.map((s, i) => (
            <li key={`${s.label}-${s.rows[0]?.rowId ?? i}`} className="flex items-start gap-2 rounded-xl border border-gray-200 bg-white p-2.5 dark:border-gray-700 dark:bg-gray-900/40">
              <div className="flex shrink-0 flex-col gap-0.5" aria-label={`${s.label} 정차 순서 변경`}>
                <button type="button" disabled={i === 0} onClick={() => move(classTime, dir, base, i, i - 1)} aria-label={`${s.label} 위로 이동`}
                  className="grid h-7 w-7 place-items-center rounded-md border border-gray-200 text-xs font-black disabled:opacity-30 dark:border-gray-600">↑</button>
                <button type="button" disabled={i === list.length - 1} onClick={() => move(classTime, dir, base, i, i + 1)} aria-label={`${s.label} 아래로 이동`}
                  className="grid h-7 w-7 place-items-center rounded-md border border-gray-200 text-xs font-black disabled:opacity-30 dark:border-gray-600">↓</button>
              </div>
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-orange-500 text-[12px] font-black text-white">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-black text-gray-900 dark:text-white">{s.label}
                  {s.lat == null && <span title="좌표 없음" className="ml-1 text-[11px] font-black text-amber-500">⚠︎</span>}
                </p>
                <p className="mt-0.5 text-[12.5px] font-bold text-gray-600 dark:text-gray-300">{s.rows.map((row) => row.name).join(", ")}</p>
              </div>
              <input type="time" value={toTimeInput(s.arriveTime)} onChange={(e) => setTime(classTime, dir, base, i, e.target.value)}
                aria-label={`${s.label} ${dir === "BOARD" ? "승차" : "하차"} 시각`}
                className="shrink-0 rounded-lg border border-gray-200 px-1.5 py-1 text-[13px] font-black text-blue-600 dark:border-gray-600 dark:bg-gray-900 dark:text-blue-300" />
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const scopeOptions: { value: RosterScope; label: string; hint: string }[] = [
    { value: "FROM_THIS_MONTH", label: "이 달부터 계속(기본)", hint: laterMonths.length > 0 ? `${formatRosterMonths([serviceMonth, ...laterMonths])} 명단에 함께 반영` : "이후 달은 이 달 명단을 복사해 만듭니다" },
    { value: "THIS_MONTH", label: "이 달만", hint: `${formatRosterMonths([serviceMonth])}만` },
  ];

  return (
    <div className="mt-3">
      <div className="rounded-xl bg-gray-50 px-3 py-2 text-[12px] text-gray-600 dark:bg-gray-900 dark:text-gray-300">
        <p className="font-bold">기사님이 보는 운행 순서 그대로입니다. 같은 정류장 학생은 한 정차로 묶입니다.</p>
        <p className="mt-0.5">정차를 ↑↓로 옮기고 시각을 고친 뒤 칸마다 💾 저장하세요. 저장하면 그 정차 학생 모두의 순서·시각이 바뀝니다.</p>
        <fieldset className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <legend className="sr-only">적용 범위</legend>
          <span className="text-[11px] font-black text-gray-500">적용 범위</span>
          {scopeOptions.map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-[12px] font-bold">
              <input type="radio" name="driver-order-scope" checked={scope === o.value} onChange={() => setScope(o.value)} />
              {o.label}<span className="text-[11px] font-semibold text-gray-400">{o.hint}</span>
            </label>
          ))}
        </fieldset>
      </div>
      {err && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">⚠ {err}</p>}
      {classes.length === 0 && <div className="mt-3 rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-600">이 요일 기사님 화면에 나올 정차가 없습니다.</div>}
      <div className="mt-3 space-y-4">
        {classes.map((c) => (
          <section key={c.classTime} className="rounded-2xl border border-gray-200 p-3 dark:border-gray-700">
            <h4 className="text-[14px] font-black text-gray-900 dark:text-white">🕒 {c.classTime} 수업</h4>
            {cell(c.classTime, "BOARD", c.board)}
            {cell(c.classTime, "ALIGHT", c.alight)}
          </section>
        ))}
      </div>
    </div>
  );
}
