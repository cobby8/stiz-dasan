"use client";

import { useEffect, useRef, useState } from "react";
import { RouteMapCanvas } from "@/components/seasonal/DispatchRouteMap";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";

// 정규 셔틀 배차 — 한 방향(등원=BOARD / 하원=ALIGHT)의 노선 목록 + 지도.
// 방학특강 배차와 같은 모양: 드래그(⠿)로 순서 변경 → 지도·경로 재계산 → 저장(sortOrder·arriveTime).

export type Geo = { lat: number; lng: number; name: string };
export type ShuttleGeo = { academy: Geo; depot: Geo | null; hub: Geo | null };

function tel(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? `tel:${d}` : null; }

// 같은 정류장(이름 기준)끼리 학생을 묶어 정차 하나로 만든다. 첫 도착시각·좌표를 대표로 쓴다.
type GroupedStop = {
  label: string;
  arriveTime: string | null;
  lat: number | null;
  lng: number | null;
  rowIds: string[]; // 이 정차에 속한 DB 행 id들(저장 시 sortOrder·arriveTime 갱신 대상)
  students: { name: string; studentPhone: string | null; parentPhone: string | null }[];
};
function groupStops(rows: RegularShuttleStop[]): GroupedStop[] {
  const order: string[] = [];
  const map = new Map<string, GroupedStop>();
  for (const r of rows) {
    const key = r.stopName;
    let g = map.get(key);
    if (!g) {
      g = { label: r.stopName, arriveTime: r.arriveTime, lat: r.latitude ?? null, lng: r.longitude ?? null, rowIds: [], students: [] };
      map.set(key, g); order.push(key);
    }
    if (g.lat == null && r.latitude != null) { g.lat = r.latitude; g.lng = r.longitude ?? null; }
    if (!g.arriveTime && r.arriveTime) g.arriveTime = r.arriveTime;
    if (r.id) g.rowIds.push(r.id);
    if (r.studentName) g.students.push({ name: r.studentName, studentPhone: r.studentPhone, parentPhone: r.parentPhone });
  }
  return order.map((k) => map.get(k)!);
}

type Pt = { lat: number; lng: number };

export default function RegularRouteSection({ dayStops, classTime, direction, serviceMonth, geo, onSaved }: {
  dayStops: RegularShuttleStop[];
  classTime: string;
  direction: "BOARD" | "ALIGHT";
  serviceMonth: string;
  geo: ShuttleGeo;
  onSaved?: () => void;
}) {
  const isPickup = direction === "BOARD";
  const startPt = isPickup ? (geo.depot ?? geo.academy) : geo.academy;
  const endPt = isPickup ? geo.academy : (geo.depot ?? geo.academy);

  // 이 (수업×방향)에 해당하는 행만 골라 그룹으로. dayStops/수업/방향이 바뀌면 다시 만든다.
  const rows = dayStops.filter((s) => s.classTime === classTime && s.direction === direction && s.studentName).sort((a, b) => a.sortOrder - b.sortOrder);
  const [order, setOrder] = useState<GroupedStop[]>(() => groupStops(rows));
  const [path, setPath] = useState<Pt[] | undefined>(undefined);
  const [rerouting, setRerouting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  // 원래 행들의 sortOrder '슬롯'(오름차순) — 저장 시 이 값들을 새 순서대로 다시 매겨 다른 수업/방향과 안 겹치게 한다.
  const slotsRef = useRef<number[]>([]);
  const rerouteTimer = useRef<number | null>(null);

  // 입력(요일·수업·방향)이 바뀌면 그룹·슬롯을 다시 만들고 경로도 다시 그린다.
  const sig = rows.map((r) => `${r.id}:${r.sortOrder}`).join("|");
  useEffect(() => {
    const g = groupStops(rows);
    setOrder(g);
    slotsRef.current = rows.map((r) => r.sortOrder).sort((a, b) => a - b);
    setSaveMsg(null); setErr(null);
    void reroute(g);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  async function reroute(g: GroupedStop[]) {
    const withCoord = g.filter((s) => s.lat != null && s.lng != null);
    if (withCoord.length === 0) { setPath(undefined); return; }
    setRerouting(true);
    try {
      const r = await fetch("/api/admin/seasonal/dispatch/reroute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: { lat: startPt.lat, lng: startPt.lng }, end: { lat: endPt.lat, lng: endPt.lng }, waypoints: withCoord.map((s) => ({ lat: s.lat, lng: s.lng })) }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.path) setPath(j.path as Pt[]); else setPath(undefined);
    } catch { setPath(undefined); }
    finally { setRerouting(false); }
  }
  function scheduleReroute(g: GroupedStop[]) {
    if (rerouteTimer.current) window.clearTimeout(rerouteTimer.current);
    rerouteTimer.current = window.setTimeout(() => { void reroute(g); }, 500);
  }

  function reorder(from: number, to: number) {
    setOrder((cur) => {
      if (from < 0 || to < 0 || from >= cur.length || to >= cur.length || from === to) return cur;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setPath(undefined); // 순서가 바뀌었으니 옛 경로는 잠깐 지우고 재계산
      scheduleReroute(next);
      return next;
    });
  }

  function setArrive(idx: number, value: string) {
    setOrder((cur) => cur.map((s, i) => (i === idx ? { ...s, arriveTime: value || null } : s)));
  }

  async function save() {
    if (saving) return;
    setSaving(true); setErr(null); setSaveMsg(null);
    try {
      // 새 순서대로 행 id를 펼치고, 원래 슬롯(sortOrder) 값을 앞에서부터 다시 매긴다.
      const orderedRowIds: string[] = [];
      const arriveByRow = new Map<string, string | null>();
      for (const s of order) for (const id of s.rowIds) { orderedRowIds.push(id); arriveByRow.set(id, s.arriveTime); }
      const slots = slotsRef.current;
      const updates = orderedRowIds.map((id, i) => ({ id, sortOrder: slots[i] ?? i, arriveTime: arriveByRow.get(id) ?? null }));
      const r = await fetch("/api/admin/shuttle/regular-order", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceMonth, updates }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      setSaveMsg("저장했습니다");
      onSaved?.();
    } catch (e: any) { setErr(e?.message || "저장하지 못했습니다."); }
    finally { setSaving(false); }
  }

  const withCoord = order.filter((g) => g.lat != null && g.lng != null);
  const totalStudents = order.reduce((a, g) => a + g.students.length, 0);
  const missingCoord = order.length - withCoord.length;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <span className={`grid h-8 w-8 place-items-center rounded-xl text-lg ${isPickup ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200"}`}>{isPickup ? "⬆" : "⬇"}</span>
          <div>
            <p className="text-[15px] font-black text-gray-900 dark:text-white">{classTime} · {isPickup ? "등원" : "하원"}</p>
            <p className="text-[11.5px] font-bold text-gray-500">{order.length}개 정차 · {totalStudents}명{missingCoord > 0 ? ` · ⚠︎ 좌표없음 ${missingCoord}` : ""}{rerouting ? " · 🔄 경로 재계산…" : ""}</p>
          </div>
        </div>
        <button onClick={save} disabled={saving || order.length === 0} className="rounded-lg bg-brand-orange-500 px-2.5 py-1.5 text-[12px] font-black text-white disabled:opacity-50">{saving ? "저장 중…" : "💾 저장"}</button>
      </div>

      {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">⚠ {err}</p>}
      {saveMsg && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-[11.5px] font-bold text-green-700 dark:bg-green-900/30 dark:text-green-200">✓ {saveMsg}</p>}

      {order.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">이 수업 {isPickup ? "등원" : "하원"} 정차가 없습니다.</div>
      ) : (
        <div className="mt-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
          {/* 목록 */}
          <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
            <ol className="divide-y divide-gray-100 dark:divide-gray-700">
              <li className="flex items-center gap-2.5 bg-gray-50/60 px-3 py-2 dark:bg-gray-900/40">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-gray-600 text-[11px] text-white">{isPickup ? "🚏" : "🏫"}</span>
                <span className="text-[12px] font-bold text-gray-600 dark:text-gray-300">{startPt.name} 출발</span>
              </li>
              {order.map((g, i) => (
                <li key={i}
                  onDragOver={(e) => { if (drag != null) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); if (drag != null && drag !== i) reorder(drag, i); setDrag(null); }}
                  className={`flex items-start gap-2 px-3 py-2.5 ${drag === i ? "opacity-40" : ""}`}>
                  <span draggable onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDrag(null)} title="드래그해서 순서 변경" className="mt-0.5 shrink-0 cursor-move select-none text-base leading-none text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">⠿</span>
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-orange-500 text-[11px] font-black text-white">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-bold text-gray-900 dark:text-white">{g.label}</span>
                      <span className="shrink-0 rounded bg-lime-200 px-1.5 text-[10px] font-black text-brand-navy-900">{g.students.length}명</span>
                      {g.lat == null && <span title="좌표 없음" className="shrink-0 text-[11px] font-black text-amber-500">⚠︎</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-gray-500">
                      {g.students.map((st, k) => { const t = tel(st.parentPhone); return <span key={k} className="font-bold text-gray-700 dark:text-gray-200">{st.name}{t && <a href={t} draggable={false} className="ml-0.5 text-green-600">📞</a>}</span>; })}
                    </div>
                  </div>
                  {/* 휴대폰에서는 드래그가 불안정하므로 한 칸씩 확실하게 이동하는 버튼을 함께 제공합니다. */}
                  <div className="flex shrink-0 flex-col gap-1 sm:hidden" aria-label={`${g.label} 정차 순서 변경`}>
                    <button type="button" disabled={i === 0} onClick={() => reorder(i, i - 1)} aria-label={`${g.label} 위로 이동`} className="grid h-7 w-7 place-items-center rounded-md border border-gray-200 text-xs font-black disabled:opacity-30 dark:border-gray-600">↑</button>
                    <button type="button" disabled={i === order.length - 1} onClick={() => reorder(i, i + 1)} aria-label={`${g.label} 아래로 이동`} className="grid h-7 w-7 place-items-center rounded-md border border-gray-200 text-xs font-black disabled:opacity-30 dark:border-gray-600">↓</button>
                  </div>
                  <input type="time" value={g.arriveTime ?? ""} onChange={(e) => setArrive(i, e.target.value)} draggable={false}
                    title={`${isPickup ? "승차" : "하차"} 시각`}
                    className="shrink-0 rounded-lg border border-gray-200 px-1.5 py-0.5 text-[11.5px] font-black text-blue-600 dark:border-gray-600 dark:bg-gray-900 dark:text-blue-300" />
                </li>
              ))}
              <li className="flex items-center gap-2.5 bg-gray-50 px-3 py-2.5 dark:bg-gray-900">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-navy-900 text-[11px] text-white">{isPickup ? "🏫" : "🚏"}</span>
                <span className="text-[12.5px] font-bold text-gray-700 dark:text-gray-200">{endPt.name} {isPickup ? "도착" : "복귀"}</span>
              </li>
            </ol>
          </div>

          {/* 지도 */}
          <aside className="mt-3 lg:mt-0 lg:sticky lg:top-4">
            <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
              <div className="bg-brand-navy-900 px-3 py-2 text-xs font-black text-white">🗺 {isPickup ? "등원" : "하원"} 경로{rerouting ? " · 🔄" : ""}{missingCoord > 0 ? " (좌표 있는 정차만)" : ""}</div>
              <RouteMapCanvas
                start={{ lat: startPt.lat, lng: startPt.lng, label: isPickup ? "차고지" : "학원" }}
                end={{ lat: endPt.lat, lng: endPt.lng, label: isPickup ? "학원" : "차고지" }}
                stops={withCoord.map((g, i) => ({ lat: g.lat!, lng: g.lng!, label: g.label, badge: String(i + 1), kind: "stop" as const }))}
                path={path}
                heightClass="h-[42vh] lg:h-[48vh]"
              />
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
