"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import AdminModal from "@/components/admin/AdminModal";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";
import { formatRosterMonths, rosterStudentKeyResolver, WEEKDAY_LABELS, type RosterScope } from "@/lib/shuttle/regularRosterEditLogic";

// 관리자 정규 셔틀 운행표의 편집 창 3종(2026-11-09 원장 결정 «관리자 화면 = 기사님 화면, 그 화면에서 직접 수정»).
//   ① 학생 셔틀 정보 — 학생 이름을 누르면 그 달 «요일 × 등원/하원» 칸의 정류장·시각을 한 번에 고친다(editStudent).
//   ② 명단에서 빼기 — × 를 누르면 이 칸만 / 이 요일 등·하원 / 이 달 전체 × 이번 달만 / 이번 달부터 계속(DELETE).
//   ③ 정류장 수정 — 카드의 «정류장 수정»: 그 정류장 이름·위치(editStop, 같은 이름 전체 선택).
// 저장은 모두 기존 명단 편집 API(/api/admin/shuttle/regular-roster) — 새 쓰기 경로를 만들지 않는다.
// 서버가 저장 뒤 기사님께 «노선 확인하기» 알림을 보낸다(regularRosterNotify).
// 색은 학원 테마 CSS 변수만, 터치 44px·글자 12px 이상(디자인 교과서 원칙).

export const ROSTER_API = "/api/admin/shuttle/regular-roster";
const DIR_KO = { BOARD: "등원", ALIGHT: "하원" } as const;
const rank = (w: number) => (w === 0 ? 7 : w); // 월 → 일 순서

/** 명단 편집 API 호출 공통 — 실패하면 서버의 한국어 메시지를 그대로 던진다. */
export async function rosterCall(method: "PATCH" | "DELETE", body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(ROSTER_API, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && typeof j.error === "string" && j.error) || "처리하지 못했습니다.");
  return (j ?? {}) as Record<string, unknown>;
}

/** 결과 안내 끝에 «11월·12월에 반영»을 붙인다(이후 달 반영 결과). */
export function monthNote(j: Record<string, unknown>): string {
  const applied = Array.isArray(j.appliedMonths) ? (j.appliedMonths as string[]) : [];
  const skipped = Array.isArray(j.skippedMonths) ? (j.skippedMonths as string[]) : [];
  if (applied.length === 0) return "";
  return ` · ${formatRosterMonths(applied)}에 반영${skipped.length > 0 ? ` (${formatRosterMonths(skipped)}은 같은 칸이 없어 건너뜀)` : ""}`;
}

type ScopeProps = { scope: RosterScope; onScope: (s: RosterScope) => void; serviceMonth: string; laterMonths: string[] };

/** 적용 범위(이번 달만 / 이번 달부터 계속) — 명단이 달별이라 이미 만들어진 다음 달에도 반영할지 고른다. */
export function ScopeFields({ scope, onScope, serviceMonth, laterMonths }: ScopeProps) {
  const options: { value: RosterScope; label: string; hint: string }[] = [
    { value: "FROM_THIS_MONTH", label: "이번 달부터 계속", hint: laterMonths.length > 0 ? `${formatRosterMonths([serviceMonth, ...laterMonths])} 명단에 함께 반영` : "다음 달 명단은 이 달을 복사해 만들어져요" },
    { value: "THIS_MONTH", label: "이번 달만", hint: `${formatRosterMonths([serviceMonth])} 명단만` },
  ];
  return (
    <fieldset className="mt-3">
      <legend className="text-xs font-bold text-[var(--color-academy-muted)]">적용 범위</legend>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.value} className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${scope === o.value ? "border-[var(--color-academy-ink)]" : "border-[var(--color-academy-line)]"}`}>
            <input type="radio" name="run-edit-scope" className="mt-1 h-4 w-4" checked={scope === o.value} onChange={() => onScope(o.value)} />
            <span><b>{o.label}</b><span className="block text-xs text-[var(--color-academy-muted)]">{o.hint}</span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** 창 아래 버튼 줄 — 왼쪽 «그만»(글자 버튼) · 오른쪽 끝 확정(근접성: 두 버튼을 떼어 둔다). */
function Footer({ busy, onCancel, onSave, saveLabel, danger = false, disabled = false }: { busy: boolean; onCancel: () => void; onSave: () => void; saveLabel: string; danger?: boolean; disabled?: boolean }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 px-2 text-sm font-bold text-[var(--color-academy-muted)]">그만</button>
      <button type="button" onClick={onSave} disabled={busy || disabled}
        className={`min-h-11 rounded-lg px-5 text-sm font-black disabled:opacity-50 ${danger ? "bg-[var(--color-academy-danger-fill)] text-[var(--color-academy-on-primary)]" : "bg-[var(--color-academy-ink)] text-[var(--color-academy-surface)]"}`}>
        {busy ? "저장 중…" : saveLabel}
      </button>
    </div>
  );
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>;
}

/** 그 달 명단 한 학생의 등·하원 행(명단 화면과 같은 학생 판정 rosterStudentKeyResolver). */
export function studentRowsOf(stops: readonly RegularShuttleStop[], rowId: string): RegularShuttleStop[] {
  const riders = stops.filter((s) => (s.direction === "BOARD" || s.direction === "ALIGHT") && s.studentName && s.id);
  const keyOf = rosterStudentKeyResolver(riders);
  const me = riders.find((s) => s.id === rowId);
  if (!me) return [];
  const key = keyOf(me);
  return riders
    .filter((s) => keyOf(s) === key)
    .sort((a, b) => rank(a.weekday) - rank(b.weekday) || (a.direction === b.direction ? 0 : a.direction === "BOARD" ? -1 : 1) || String(a.classTime).localeCompare(String(b.classTime)));
}

/** 그 달 정류장 이름 목록(입력칸 추천) + 이름 → 좌표(기존 정류장을 고르면 좌표도 같이 따라온다). */
function useStopBook(stops: readonly RegularShuttleStop[]) {
  return useMemo(() => {
    const coords = new Map<string, { latitude: number; longitude: number }>();
    for (const s of stops) {
      const name = s.stopName?.trim();
      if (!name || coords.has(name) || s.latitude == null || s.longitude == null) continue;
      coords.set(name, { latitude: s.latitude, longitude: s.longitude });
    }
    return { names: [...coords.keys()].sort((a, b) => a.localeCompare(b, "ko")), coords };
  }, [stops]);
}

type Draft = { stopName: string; arriveTime: string; latitude: number | null; longitude: number | null };
const draftOf = (s: RegularShuttleStop): Draft => ({ stopName: s.stopName, arriveTime: s.arriveTime ?? "", latitude: s.latitude ?? null, longitude: s.longitude ?? null });
const sameDraft = (a: Draft, b: Draft) => a.stopName.trim() === b.stopName.trim() && (a.arriveTime || "") === (b.arriveTime || "") && a.latitude === b.latitude && a.longitude === b.longitude;

/** 반 이동 재배정 칸(운행표 «배정 필요»에서 넘겨받음). */
export type ReassignLink = { studentId: string; legKey: string; label: string };

// ── ① 학생 셔틀 정보 ─────────────────────────────────────────────

export function StudentShuttleDialog({ stops, rowId, serviceMonth, laterMonths, defaultScope, reassign, onOpenReassign, onClose, onSaved }: {
  stops: RegularShuttleStop[];
  rowId: string;
  serviceMonth: string;
  laterMonths: string[];
  defaultScope: RosterScope;
  /** 이 학생의 반 이동 재배정 칸(있으면 위에 보여 주고 누르면 배정 창을 연다). */
  reassign: ReassignLink[];
  onOpenReassign: (link: ReassignLink) => void;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const rows = useMemo(() => studentRowsOf(stops, rowId), [stops, rowId]);
  const book = useStopBook(stops);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(rows.map((r) => [r.id!, draftOf(r)])));
  const [scope, setScope] = useState<RosterScope>(defaultScope);
  const [picker, setPicker] = useState<string | null>(null); // 지도로 고르는 칸(행 id)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = rows[0]?.studentName ?? "";
  const studentId = rows.find((r) => r.studentId)?.studentId ?? null;
  const changed = rows.filter((r) => drafts[r.id!] && !sameDraft(drafts[r.id!], draftOf(r)));

  // 이름을 기존 정류장으로 바꾸면 그 정류장 좌표도 함께(새 이름이면 좌표는 그대로 — 지도로 정한다).
  function setName(id: string, value: string) {
    const hit = book.coords.get(value.trim());
    setDrafts((d) => ({ ...d, [id]: { ...d[id], stopName: value, ...(hit ?? {}) } }));
  }

  async function save() {
    if (busy || changed.length === 0) return;
    if (changed.some((r) => !drafts[r.id!].stopName.trim())) { setError("정류장 이름을 입력해 주세요."); return; }
    setBusy(true); setError(null);
    try {
      const j = await rosterCall("PATCH", {
        action: "editStudent", serviceMonth, scope, studentId,
        changes: changed.map((r) => {
          const d = drafts[r.id!];
          return { rowId: r.id, stopName: d.stopName.trim(), arriveTime: d.arriveTime || null, latitude: d.latitude, longitude: d.longitude };
        }),
      });
      onSaved(`${name} 학생 ${changed.length}칸을 고쳤어요${monthNote(j)} · 기사님께 알림을 보냈어요`);
    } catch (e) {
      setError(adminErrorText(e, "저장하지 못했습니다."));
      setBusy(false);
    }
  }

  const pickRow = picker ? rows.find((r) => r.id === picker) : null;
  const pickDraft = picker ? drafts[picker] : null;
  return (
    <>
      {!picker && (
        <AdminModal titleId="run-student-title" onClose={() => { if (!busy) onClose(); }} panelClassName="max-w-2xl p-4" closeOnBackdrop={false}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="run-student-title" className="text-lg font-black text-[var(--color-academy-ink)]">{name} · 셔틀 정보 ({Number(serviceMonth.slice(5))}월)</h3>
            {studentId && <Link href={`/admin/students/${encodeURIComponent(studentId)}`} className="inline-flex min-h-11 items-center text-sm font-bold text-[var(--color-academy-primary)] underline">학생 상세</Link>}
          </div>
          {reassign.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm">
              <b className="text-[var(--color-academy-warning)]">반 이동 재배정 필요</b>
              {reassign.map((l) => (
                <button key={l.legKey} type="button" onClick={() => onOpenReassign(l)}
                  className="inline-flex min-h-11 items-center rounded-full border border-[var(--color-academy-ink)] bg-[var(--color-academy-surface)] px-3 font-bold">{l.label}</button>
              ))}
            </div>
          )}
          {rows.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-academy-muted)]">이 달 명단에서 이 학생 칸을 찾지 못했어요. 화면을 새로고침해 주세요.</p>
          ) : (
            // 칸 한 줄 = 요일·방향·수업 | 정류장 | 시각 | 지도. 바뀐 칸은 강조(저장 대상).
            <ul className="mt-3 divide-y divide-[var(--color-academy-line)] rounded-lg border border-[var(--color-academy-line)]">
              {rows.map((r) => {
                const d = drafts[r.id!];
                const dirty = !sameDraft(d, draftOf(r));
                return (
                  <li key={r.id} className={`grid grid-cols-[4.5rem_1fr] items-center gap-2 px-2 py-2 sm:grid-cols-[6.5rem_1fr_7rem_auto] ${dirty ? "bg-[var(--color-academy-primary-soft)]" : ""}`}>
                    <span className="text-sm font-black text-[var(--color-academy-ink)]">{WEEKDAY_LABELS[r.weekday]} {DIR_KO[r.direction as "BOARD" | "ALIGHT"]}<span className="block text-xs font-semibold text-[var(--color-academy-muted)]">{r.classTime ?? "수업 미정"}</span></span>
                    <input list="run-stop-names" value={d.stopName} onChange={(e) => setName(r.id!, e.target.value)} aria-label={`${WEEKDAY_LABELS[r.weekday]} ${DIR_KO[r.direction as "BOARD" | "ALIGHT"]} 정류장`}
                      className="h-11 min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-sm" />
                    <input type="time" value={d.arriveTime} onChange={(e) => setDrafts((x) => ({ ...x, [r.id!]: { ...x[r.id!], arriveTime: e.target.value } }))} aria-label={`${WEEKDAY_LABELS[r.weekday]} ${DIR_KO[r.direction as "BOARD" | "ALIGHT"]} 정차 시각`}
                      className="col-start-2 h-11 min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-sm sm:col-start-auto" />
                    <button type="button" onClick={() => setPicker(r.id!)} className="col-start-2 inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold sm:col-start-auto">
                      <span className="material-symbols-outlined text-lg" aria-hidden="true">map</span>지도
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <datalist id="run-stop-names">{book.names.map((n) => <option key={n} value={n} />)}</datalist>
          <p className="mt-2 text-xs text-[var(--color-academy-muted)]">목록의 기존 정류장을 고르면 위치도 같이 바뀌어요. 정류장이 바뀌면 운행표에서 순서·시각을 확인해 주세요. 칸 추가는 «배정 필요», 빼기는 운행표의 × 로 해요.</p>
          <ScopeFields scope={scope} onScope={setScope} serviceMonth={serviceMonth} laterMonths={laterMonths} />
          <ErrorBox error={error} />
          <Footer busy={busy} onCancel={onClose} onSave={() => void save()} saveLabel={changed.length > 0 ? `${changed.length}칸 저장` : "바뀐 칸 없음"} disabled={changed.length === 0} />
        </AdminModal>
      )}
      {/* 지도 창 — 장소명 필수(정류장 이름이 «다산동 4002-1» 같은 주소로 남지 않게). 지도 중에는 입력 창을 내린다. */}
      {picker && pickRow && pickDraft && (
        <LocationPickerModal
          title={`${WEEKDAY_LABELS[pickRow.weekday]} ${DIR_KO[pickRow.direction as "BOARD" | "ALIGHT"]} 정류장 위치`}
          requirePlaceName
          initialValue={pickDraft.latitude != null && pickDraft.longitude != null
            ? { address: pickDraft.stopName, placeName: pickDraft.stopName, latitude: pickDraft.latitude, longitude: pickDraft.longitude, source: "MAP_PIN" }
            : undefined}
          onConfirm={(loc: MapLocationData) => {
            setDrafts((d) => ({ ...d, [picker]: { ...d[picker], stopName: loc.placeName?.trim() || d[picker].stopName, latitude: loc.latitude, longitude: loc.longitude } }));
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

// ── ② 명단에서 빼기 ─────────────────────────────────────────────

type RemoveRange = "CELL" | "DAY" | "MONTH";

export function RemoveRiderDialog({ stops, rowId, serviceMonth, laterMonths, defaultScope, onClose, onSaved }: {
  stops: RegularShuttleStop[];
  rowId: string;
  serviceMonth: string;
  laterMonths: string[];
  defaultScope: RosterScope;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const all = useMemo(() => studentRowsOf(stops, rowId), [stops, rowId]);
  const me = all.find((r) => r.id === rowId) ?? null;
  const [range, setRange] = useState<RemoveRange>("CELL");
  const [scope, setScope] = useState<RosterScope>(defaultScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const dayRows = all.filter((r) => r.weekday === me.weekday);
  const ids = (range === "CELL" ? [me] : range === "DAY" ? dayRows : all).map((r) => r.id!);
  const cellLabel = `${WEEKDAY_LABELS[me.weekday]} ${DIR_KO[me.direction as "BOARD" | "ALIGHT"]}`;
  const options: { value: RemoveRange; label: string; hint: string }[] = [
    { value: "CELL", label: `이 칸만 (${cellLabel})`, hint: me.stopName },
    { value: "DAY", label: `${WEEKDAY_LABELS[me.weekday]}요일 등·하원`, hint: `${dayRows.length}칸` },
    { value: "MONTH", label: "이 학생 셔틀 전체", hint: `${Number(serviceMonth.slice(5))}월 ${all.length}칸` },
  ];

  async function remove() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const j = await rosterCall("DELETE", { serviceMonth, scope, ids });
      onSaved(`${me!.studentName} 학생 ${ids.length}칸을 명단에서 뺐어요${monthNote(j)} · 기사님께 알림을 보냈어요`);
    } catch (e) {
      setError(adminErrorText(e, "빼지 못했습니다."));
      setBusy(false);
    }
  }

  return (
    <AdminModal titleId="run-remove-title" onClose={() => { if (!busy) onClose(); }} panelClassName="max-w-md p-5" closeOnBackdrop={false}>
      <h3 id="run-remove-title" className="text-lg font-black text-[var(--color-academy-ink)]">{me.studentName} 학생을 셔틀 명단에서 뺄까요?</h3>
      <p className="mt-1 text-sm text-[var(--color-academy-muted)]">퇴원·셔틀 중단일 때 써요. 하루만 안 타는 건 결석·«오늘만 변경»으로 해 주세요.</p>
      <fieldset className="mt-3">
        <legend className="text-xs font-bold text-[var(--color-academy-muted)]">뺄 칸</legend>
        <div className="mt-1 grid gap-2">
          {options.map((o) => (
            <label key={o.value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${range === o.value ? "border-[var(--color-academy-danger)]" : "border-[var(--color-academy-line)]"}`}>
              <input type="radio" name="run-remove-range" className="h-4 w-4" checked={range === o.value} onChange={() => setRange(o.value)} />
              <b>{o.label}</b><span className="text-xs text-[var(--color-academy-muted)]">{o.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <ScopeFields scope={scope} onScope={setScope} serviceMonth={serviceMonth} laterMonths={laterMonths} />
      <ErrorBox error={error} />
      <Footer busy={busy} onCancel={onClose} onSave={() => void remove()} saveLabel={`${ids.length}칸 빼기`} danger />
    </AdminModal>
  );
}

// ── ③ 정류장 수정(카드 하나 = 같은 정류장에 서는 학생들) ─────────────────

export function StopEditDialog({ stops, rowIds, serviceMonth, laterMonths, defaultScope, onClose, onSaved }: {
  stops: RegularShuttleStop[];
  /** 그 카드의 학생 행 id(같은 정류장에 함께 서는 학생들). */
  rowIds: string[];
  serviceMonth: string;
  laterMonths: string[];
  defaultScope: RosterScope;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const rows = useMemo(() => rowIds.map((id) => stops.find((s) => s.id === id)).filter((s): s is RegularShuttleStop => Boolean(s)), [stops, rowIds]);
  const first = rows[0] ?? null;
  const book = useStopBook(stops);
  const [draft, setDraft] = useState<Draft>(() => (first ? draftOf(first) : { stopName: "", arriveTime: "", latitude: null, longitude: null }));
  // 같은 이름 정류장이 다른 요일·칸에도 있으면 함께 고칠지(기본 꺼짐 — 이 카드 학생들만).
  const sameNameCount = first ? stops.filter((s) => s.stopName === first.stopName && !rowIds.includes(s.id ?? "")).length : 0;
  const [applyToAll, setApplyToAll] = useState(false);
  const [scope, setScope] = useState<RosterScope>(defaultScope);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!first) return null;
  const unchanged = draft.stopName.trim() === first.stopName.trim() && draft.latitude === (first.latitude ?? null) && draft.longitude === (first.longitude ?? null);

  async function save() {
    if (busy || unchanged) return;
    if (!draft.stopName.trim()) { setError("정류장 이름을 입력해 주세요."); return; }
    setBusy(true); setError(null);
    try {
      const stop = (r: RegularShuttleStop) => ({ stopName: draft.stopName.trim(), arriveTime: r.arriveTime ?? null, latitude: draft.latitude, longitude: draft.longitude });
      let last: Record<string, unknown> = {};
      if (applyToAll) {
        // 같은 이름 전체 — 한 번에(서버가 이 달 같은 이름 행 이름·좌표를 함께 바꾼다). 시각은 학생마다 그대로.
        last = await rosterCall("PATCH", { action: "editStop", serviceMonth, scope, id: first!.id, stop: stop(first!), applyToAll: true });
      } else {
        // 이 카드 학생들만 — 학생마다 한 번씩(시각은 각자 그대로 둔다).
        for (const r of rows) last = await rosterCall("PATCH", { action: "editStop", serviceMonth, scope, id: r.id, stop: stop(r), applyToAll: false });
      }
      onSaved(`정류장을 «${draft.stopName.trim()}»(으)로 고쳤어요${monthNote(last)} · 순서·시각을 확인해 주세요`);
    } catch (e) {
      setError(adminErrorText(e, "저장하지 못했습니다."));
      setBusy(false);
    }
  }

  return (
    <>
      {!picker && (
        <AdminModal titleId="run-stop-title" onClose={() => { if (!busy) onClose(); }} panelClassName="max-w-md p-5" closeOnBackdrop={false}>
          <h3 id="run-stop-title" className="text-lg font-black text-[var(--color-academy-ink)]">정류장 수정 · {first.stopName}</h3>
          <p className="mt-1 text-sm text-[var(--color-academy-muted)]">{rows.map((r) => r.studentName).join(", ")} · {WEEKDAY_LABELS[first.weekday]} {DIR_KO[first.direction as "BOARD" | "ALIGHT"]}</p>
          <div className="mt-3 flex gap-2">
            <input list="run-stop-names-one" value={draft.stopName} aria-label="정류장 이름"
              onChange={(e) => { const v = e.target.value; const hit = book.coords.get(v.trim()); setDraft((d) => ({ ...d, stopName: v, ...(hit ?? {}) })); }}
              className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm" />
            <button type="button" onClick={() => setPicker(true)} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold">
              <span className="material-symbols-outlined text-lg" aria-hidden="true">map</span>지도
            </button>
          </div>
          <datalist id="run-stop-names-one">{book.names.map((n) => <option key={n} value={n} />)}</datalist>
          {sameNameCount > 0 && (
            <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
              <span>이 달 «{first.stopName}» 정류장 모두({sameNameCount}칸 더, 다른 요일 포함) 함께 고치기</span>
            </label>
          )}
          <ScopeFields scope={scope} onScope={setScope} serviceMonth={serviceMonth} laterMonths={laterMonths} />
          <ErrorBox error={error} />
          <Footer busy={busy} onCancel={onClose} onSave={() => void save()} saveLabel="저장" disabled={unchanged} />
        </AdminModal>
      )}
      {picker && (
        <LocationPickerModal
          title="정류장 위치"
          requirePlaceName
          initialValue={draft.latitude != null && draft.longitude != null
            ? { address: draft.stopName, placeName: draft.stopName, latitude: draft.latitude, longitude: draft.longitude, source: "MAP_PIN" }
            : undefined}
          onConfirm={(loc: MapLocationData) => { setDraft((d) => ({ ...d, stopName: loc.placeName?.trim() || d.stopName, latitude: loc.latitude, longitude: loc.longitude })); setPicker(false); }}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );
}
