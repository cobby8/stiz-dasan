"use client";

import { useState, type FormEvent } from "react";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

// 셔틀 차량 관리 — 자동 배차가 쓰는 차량(ShuttleVehicle)을 등록·수정·활성/비활성한다.
// (옛 '노선 만들기'는 자동 배차 화면으로 대체되어, 이 화면은 차량 관리만 담당한다.)

type Vehicle = { id: string; name: string; plateNumber?: string | null; capacity: number; notes?: string | null; isActive?: boolean };

const API = "/api/admin/shuttle";

export default function VehicleManagerClient({ initialVehicles }: { initialVehicles: Vehicle[] }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>(initialVehicles ?? []);
  const [modal, setModal] = useState<"new" | Vehicle | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  // 행 클릭 상세 패널(차량 id). 다시 불러와도 최신 값으로 보이게 id 로 찾는다.
  const [detailId, setDetailId] = useState<string | null>(null);

  async function reload() {
    try {
      const r = await fetch(`${API}?direction=PICKUP`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.vehicles)) setVehicles(j.vehicles);
    } catch { /* 유지 */ }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editing = modal && modal !== "new" ? modal : null;
    const v = Object.fromEntries(new FormData(event.currentTarget));
    const data = { name: v.name, plateNumber: v.plateNumber || undefined, capacity: Number(v.capacity), notes: v.notes || undefined };
    setPending(true); setErr(""); setNotice("");
    try {
      const r = await fetch(API, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { resource: "vehicle", id: editing.id, data } : { resource: "vehicle", data }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "저장하지 못했습니다.");
      setNotice(editing ? "차량 정보를 수정했습니다." : "차량을 등록했습니다.");
      setModal(null);
      await reload();
    } catch (e: any) { setErr(e?.message || "저장하지 못했습니다."); }
    finally { setPending(false); }
  }

  async function toggleActive(vehicle: Vehicle) {
    setPending(true); setErr(""); setNotice("");
    try {
      const r = await fetch(API, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "vehicle", id: vehicle.id, data: { isActive: !(vehicle.isActive !== false) } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "변경하지 못했습니다.");
      setNotice(vehicle.isActive !== false ? "차량을 비활성화했습니다." : "차량을 활성화했습니다.");
      await reload();
    } catch (e: any) { setErr(e?.message || "변경하지 못했습니다."); }
    finally { setPending(false); }
  }

  const editing = modal && modal !== "new" ? modal : null;
  const active = vehicles.filter((v) => v.isActive !== false);
  const detailVehicle = detailId ? vehicles.find((v) => v.id === detailId) ?? null : null;

  // ⚡·상세 패널이 같이 쓰는 작업 목록 — 예전 행 버튼(수정·비활성화/활성화)과 같은 동작
  function buildVehicleActions(v: Vehicle): AdminQuickAction[] {
    const on = v.isActive !== false;
    return [
      { key: "edit", label: "수정", icon: "edit", disabled: pending, onSelect: () => setModal(v) },
      { key: "toggle", label: on ? "비활성화" : "활성화", icon: on ? "block" : "check_circle", tone: on ? "default" : "primary", disabled: pending, onSelect: () => toggleActive(v) },
    ];
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-black text-gray-900 dark:text-white">차량 관리</h3>
            {/* 2번째 문장 제거 — 존재하지 않는 「자동 배차」 탭을 가리키던 스테일 안내(실제 탭은 「방학특강 배차」·「정규 배차」) */}
            <p className="mt-0.5 text-[12.5px] text-gray-500 dark:text-gray-400">여기 등록한 활성 차량을 <b>자동 배차</b>가 정원에 맞춰 사용합니다.</p>
          </div>
          <button onClick={() => setModal("new")} className="rounded-xl bg-brand-orange-500 px-4 py-2.5 text-sm font-black text-white">＋ 차량 등록</button>
        </div>

        {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">⚠ {err}</p>}
        {notice && <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs font-bold text-green-700 dark:bg-green-900/30 dark:text-green-200">✓ {notice}</p>}

        <p className="mt-3 text-[12px] font-bold text-gray-500">활성 차량 {active.length}대 · 전체 {vehicles.length}대</p>

        {vehicles.length === 0 && <div className="mt-2 rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">등록된 차량이 없습니다. 「차량 등록」으로 추가하세요.</div>}
        {/* 차량 한 줄 행: 차량명 | 차량번호 | 정원 | 상태 | 관리(⚡). 메모는 상세 패널에서 전부 */}
        {vehicles.length > 0 && (
          <div className="mt-2 overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            <div className="overflow-x-auto">
              <table className="admin-list-table w-full border-collapse text-sm">
                <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                  <tr>
                    <th className="px-2 py-2">차량명</th>
                    <th className="px-2 py-2">차량번호</th>
                    <th className="admin-cell-num px-2 py-2">정원</th>
                    <th className="px-2 py-2">상태</th>
                    <th className="admin-cell-center px-2 py-2">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-academy-line)]">
                  {vehicles.map((v) => {
                    const on = v.isActive !== false;
                    return (
                      <tr
                        key={v.id}
                        tabIndex={0}
                        aria-label={`${v.name} 상세 보기`}
                        onClick={() => setDetailId(v.id)}
                        onKeyDown={(event) => handleRowKeyDown(event, v.id)}
                        className={`cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none ${on ? "" : "opacity-70"}`}
                      >
                        <td className="px-2 py-1.5">
                          <span className="font-black text-[var(--color-academy-ink)]">{v.name}</span>
                          {/* 메모가 있으면 표시만 — 내용은 상세 패널에서 */}
                          {v.notes && <span className="material-symbols-outlined ml-1 align-middle text-base text-[var(--color-academy-muted)]" aria-label="메모 있음" title="메모 있음">sticky_note_2</span>}
                        </td>
                        <td className="px-2 py-1.5 text-[var(--color-academy-muted)]">{v.plateNumber || "-"}</td>
                        <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{v.capacity}인승</td>
                        <td className="px-2 py-1.5">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-black ${on ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>{on ? "활성" : "비활성"}</span>
                        </td>
                        {/* 관리: ⚡ 메뉴(수정·비활성화/활성화). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                        <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                          <AdminQuickActionMenu label={`${v.name} 빠른 작업`} actions={buildVehicleActions(v)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 / 모바일 하단 시트. 작업 버튼은 ⚡ 와 같은 목록(수정은 패널을 닫고 기존 입력창을 연다) */}
      {detailVehicle && !modal && (() => {
        const d = detailVehicle;
        const rows: { label: string; value: React.ReactNode }[] = [
          { label: "차량번호", value: d.plateNumber || "-" },
          { label: "정원", value: <span className="tabular-nums">{d.capacity}인승</span> },
          { label: "상태", value: d.isActive !== false ? "활성(자동 배차에 사용)" : "비활성(자동 배차에서 제외)" },
          { label: "메모", value: d.notes || "-" },
        ];
        return (
          <ListDetailPanel onClose={() => setDetailId(null)} titleId="vehicle-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="vehicle-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.name}</h3>
              <button type="button" onClick={() => setDetailId(null)} aria-label="닫기"
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="font-bold text-[var(--color-academy-muted)]">{row.label}</dt>
                  <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                </div>
              ))}
            </dl>
            {/* 공용 패널 버튼 줄 — ⚡ 와 같은 목록·같은 함수, 위험 작업은 오른쪽 끝으로 떨어진다 */}
            <AdminPanelActions actions={buildVehicleActions(d)} onBeforeSelect={() => setDetailId(null)} />
          </ListDetailPanel>
        );
      })()}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-gray-800 sm:rounded-3xl">
            <h2 className="text-lg font-black text-gray-900 dark:text-white">{editing ? "차량 수정" : "차량 등록"}</h2>
            <form onSubmit={save} className="mt-4 space-y-3">
              <label className="block text-sm font-bold text-gray-600 dark:text-gray-300">차량명
                <input name="name" required autoFocus defaultValue={editing?.name ?? ""} placeholder="예: 스타리아 1호차" className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
              </label>
              <label className="block text-sm font-bold text-gray-600 dark:text-gray-300">차량번호
                <input name="plateNumber" defaultValue={editing?.plateNumber ?? ""} placeholder="예: 12가 3456" className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
              </label>
              <label className="block text-sm font-bold text-gray-600 dark:text-gray-300">승차 정원
                <input name="capacity" type="number" min="1" required defaultValue={editing?.capacity ?? ""} placeholder="예: 15" className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
              </label>
              <label className="block text-sm font-bold text-gray-600 dark:text-gray-300">메모
                <input name="notes" defaultValue={editing?.notes ?? ""} className="mt-1 min-h-11 w-full rounded-xl border border-gray-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
              </label>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setModal(null)} disabled={pending} className="min-h-11 rounded-xl border border-gray-300 px-5 font-bold text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200">취소</button>
                <button type="submit" disabled={pending} className="min-h-11 flex-1 rounded-xl bg-brand-orange-500 px-5 font-black text-white disabled:opacity-50">{pending ? "저장 중…" : editing ? "수정" : "등록"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
