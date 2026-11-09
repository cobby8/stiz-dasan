"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AcademyTheme from "@/components/academy/AcademyTheme";
import DriverLocationPanel from "@/components/admin/DriverLocationPanel";
import DriverRequestPanel from "@/components/admin/DriverRequestPanel";
import { adminErrorText } from "@/components/admin/adminDisplayText";
// 기사님 화면과 같은 카드 틀(RunBoard) + 같은 순수 조립 함수(buildRegularRunRows) — 관리자 화면 = 기사님 화면.
import RunBoard from "@/components/shuttle/run/RunBoard";
import styles from "@/components/shuttle/DriverWorkspace.module.css";
import NewStudentDispatchPanel from "@/components/shuttle/assign/NewStudentDispatchPanel";
import type { DriverAssignBoard } from "@/lib/shuttle/driverAssign";
import { buildRegularRunRows } from "@/lib/shuttle/regularRunRows";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";
import { parseDriverScheduleTime } from "@/lib/shuttle/driverUpcoming";
import { rosterStudentKeyResolver, WEEKDAY_LABELS, type RosterScope } from "@/lib/shuttle/regularRosterEditLogic";
import type { UnifiedRider, UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";
import { monthNote, RemoveRiderDialog, rosterCall, ScopeFields, StopEditDialog, StudentShuttleDialog, type ReassignLink } from "./RunEditDialogs";

// 관리자 «정규 셔틀 운행표» — 2026-11-09 원장 결정:
//   · 관리자 배차 화면 = 기사님 화면과 똑같이 보이고, 같은 화면에서 직접 수정한다.
//   · 자동 제안(T맵 자동 노선)·차량 이동·⇄ 는 없앴다. 셔틀 명단(RegularShuttleStop)이 유일한 정본이다.
//   · 카드에서: 순서(▲▼·끌기)·시각 · 정류장 수정 · 학생 이름 → 셔틀 정보 창 · × → 명단에서 빼기.
//   · «배정 필요» = 신규 + 반 이동 재배정(기존 신규 배차 패널·같은 API). 반 이동 학생은 카드에도 표시.
//   · 바뀌면 서버가 기사님께 «노선 확인하기» 알림을 보낸다(regularRosterNotify).
// 정렬·편집 상태는 이 화면이 들고, 카드 그리기는 RunBoard(mode="admin")가 한다.

type SortKey = { minutes: number | null; seq: number };
type Dialog =
  | { kind: "student"; rowId: string }
  | { kind: "remove"; rowId: string }
  | { kind: "stop"; rowIds: string[] };

const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function RegularRunEditor({ stops, serviceMonth, months, currentMonth, initialWeekday, initialStudentId }: {
  /** 그 달 셔틀 명단 전체(서버가 읽어 준다 — 저장 뒤 router.refresh 로 다시 받는다). */
  stops: RegularShuttleStop[];
  serviceMonth: string;
  months: string[];
  /** 이번 달(KST, 서버 계산) — 지난 달이면 적용 범위 기본을 «이번 달만»으로. */
  currentMonth: string;
  initialWeekday: number;
  /** 신청 학생 바로 보기(?studentId=) — 그 학생 셔틀 정보 창을 바로 연다. */
  initialStudentId?: string;
}) {
  const router = useRouter();
  const laterMonths = useMemo(() => months.filter((m) => m > serviceMonth).sort(), [months, serviceMonth]);
  const defaultScope: RosterScope = serviceMonth < currentMonth ? "THIS_MONTH" : "FROM_THIS_MONTH";

  // 요일 탭 — 월~토는 항상, 일요일은 명단이 있을 때만. 탭마다 학생 수.
  const dayCounts = useMemo(() => {
    const riders = stops.filter((s) => (s.direction === "BOARD" || s.direction === "ALIGHT") && s.studentName);
    const keyOf = rosterStudentKeyResolver(riders);
    return DOW_ORDER.map((w) => ({ weekday: w, count: new Set(riders.filter((s) => s.weekday === w).map(keyOf)).size }))
      .filter((d) => d.weekday !== 0 || d.count > 0);
  }, [stops]);
  const [weekday, setWeekday] = useState(initialWeekday);

  // 운행표 카드 = 기사님 화면과 같은 함수(결석·오늘만 변경은 날마다 달라 «월+요일» 기본형에선 끈다).
  const rows = useMemo(() => buildRegularRunRows({ stops, weekday }), [stops, weekday]);
  const stopsById = useMemo(() => new Map(stops.filter((s) => s.id).map((s) => [s.id!, s])), [stops]);

  // ── 순서·시각 편집(기사님 화면 UnifiedDriverClient 와 같은 규칙: 같은 묶음 안에서만, 옮기면 시각 칸도 함께) ──
  const [editing, setEditing] = useState(false);
  const [sourceRows, setSourceRows] = useState<UnifiedRow[]>(rows);
  const [sortOverride, setSortOverride] = useState<Record<string, SortKey>>({});
  const [timeOverride, setTimeOverride] = useState<Record<string, string>>({});
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [orderScope, setOrderScope] = useState<RosterScope>(defaultScope);
  const [savingOrder, setSavingOrder] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function displayTime(row: UnifiedRow): string | null {
    return editing && timeOverride[row.key] !== undefined ? timeOverride[row.key] || null : row.time;
  }
  const ordered = useMemo(() => {
    const base = editing ? sourceRows : rows;
    const keyOf = (r: UnifiedRow): SortKey => {
      const k = (editing ? sortOverride[r.key] : undefined) ?? { minutes: r.minutes, seq: r.seq };
      return editing && timeOverride[r.key] !== undefined ? { ...k, minutes: parseDriverScheduleTime(timeOverride[r.key]) } : k;
    };
    return [...base].sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka.minutes == null && kb.minutes == null) return ka.seq - kb.seq;
      if (ka.minutes == null) return 1; // 시간 미정은 맨 끝
      if (kb.minutes == null) return -1;
      return ka.minutes === kb.minutes ? ka.seq - kb.seq : ka.minutes - kb.minutes;
    });
  }, [rows, sourceRows, editing, sortOverride, timeOverride]);

  function moveRow(row: UnifiedRow, dir: -1 | 1) {
    const same = ordered.filter((r) => r.groupKey === row.groupKey && !r.isTerminal);
    const other = same[same.findIndex((r) => r.key === row.key) + dir];
    if (!other) return;
    const keyOf = (r: UnifiedRow): SortKey => ({ minutes: parseDriverScheduleTime(displayTime(r)), seq: sortOverride[r.key]?.seq ?? r.seq });
    const a = keyOf(row), b = keyOf(other);
    setSortOverride((o) => ({ ...o, [row.key]: b, [other.key]: a }));
    const rowTime = displayTime(row), otherTime = displayTime(other);
    setTimeOverride((t) => ({ ...t, [row.key]: otherTime ?? "", [other.key]: rowTime ?? "" }));
  }
  function moveDragged(target: UnifiedRow) {
    if (!dragKey || dragKey === target.key) return;
    const from = ordered.find((r) => r.key === dragKey);
    if (!from || from.groupKey !== target.groupKey || from.isTerminal || target.isTerminal) return;
    const same = ordered.filter((r) => r.groupKey === target.groupKey && !r.isTerminal);
    const fromIdx = same.findIndex((r) => r.key === from.key), toIdx = same.findIndex((r) => r.key === target.key);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...same];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, from);
    const nextSort: Record<string, SortKey> = {}, nextTimes: Record<string, string> = {};
    same.forEach((slot, i) => {
      nextSort[next[i].key] = { minutes: parseDriverScheduleTime(displayTime(slot)), seq: sortOverride[slot.key]?.seq ?? slot.seq };
      nextTimes[next[i].key] = displayTime(slot) ?? "";
    });
    setSortOverride((o) => ({ ...o, ...nextSort }));
    setTimeOverride((t) => ({ ...t, ...nextTimes }));
  }

  function startEditing() { setSourceRows(rows); setSortOverride({}); setTimeOverride({}); setOrderScope(defaultScope); setMessage(null); setError(null); setEditing(true); }
  function cancelEditing() { setEditing(false); setSortOverride({}); setTimeOverride({}); }

  // 저장 = 묶음(수업시간 × 등/하원)마다 명단 «reorder»(그 묶음이 쓰던 순서 번호를 돌려 쓰고 시각을 넣는다).
  // 바뀐 묶음만 보낸다. 수업시간 글자는 명단 행 그대로(공백까지 — 서버가 글자 그대로 비교한다).
  async function saveOrder() {
    if (savingOrder) return;
    const groupPayload = (list: UnifiedRow[], timeOf: (r: UnifiedRow) => string | null) => {
      const out = new Map<string, { rowIds: string[]; arriveTime: string | null }[]>();
      for (const r of list) {
        if (r.isTerminal || r.kind !== "REGULAR") continue;
        const rowIds = r.riders.map((x) => x.checkId);
        if (rowIds.length === 0) continue;
        out.set(r.groupKey, [...(out.get(r.groupKey) ?? []), { rowIds, arriveTime: timeOf(r) }]);
      }
      return out;
    };
    const after = groupPayload(ordered, displayTime);
    const before = groupPayload(sourceRows, (r) => r.time);
    const changed = [...after.entries()].filter(([key, list]) => JSON.stringify(list) !== JSON.stringify(before.get(key)));
    if (changed.length === 0) { cancelEditing(); return; }
    setSavingOrder(true); setError(null); setMessage(null);
    let done = 0;
    let note = "";
    try {
      for (const [, list] of changed) {
        const head = stopsById.get(list[0].rowIds[0]);
        if (!head || head.classTime == null) throw new Error("명단이 그사이 바뀌었습니다. 화면을 새로고침해 주세요.");
        const j = await rosterCall("PATCH", {
          action: "reorder", serviceMonth, scope: orderScope, weekday, classTime: head.classTime,
          direction: head.direction, stops: list,
        });
        note = monthNote(j);
        done += 1;
      }
      setMessage(`순서·시각 저장 완료 · ${done}묶음${note} · 기사님께 알림을 보냈어요`);
      setEditing(false); setSortOverride({}); setTimeOverride({});
    } catch (e) {
      // 앞 묶음은 이미 저장됐을 수 있다 — 몇 묶음이 저장됐는지 알리고 화면을 새로 읽는다.
      setError(`${done > 0 ? `${done}묶음은 저장됐고, ` : ""}${adminErrorText(e, "저장하지 못했습니다.")}`);
      setEditing(false);
    } finally {
      setSavingOrder(false);
      router.refresh();
    }
  }

  // ── 배정 필요(신규·반 이동) 연결 ──
  const [board, setBoard] = useState<DriverAssignBoard | null>(null);
  const [openRequest, setOpenRequest] = useState<{ studentId: string; legKey: string; nonce: number } | null>(null);
  // 옛 칸 행 id → 그 학생의 반 이동 재배정 칸(카드의 «반 이동» 표시·셔틀 정보 창에 쓴다).
  const reassignByRowId = useMemo(() => {
    const map = new Map<string, ReassignLink[]>();
    for (const s of board?.students ?? []) {
      for (const leg of s.legs) {
        if (!leg.reassign) continue;
        const link = { studentId: s.studentId, legKey: leg.key, label: leg.reassign.label };
        for (const id of leg.reassign.replaceRowIds) map.set(id, [...(map.get(id) ?? []), link]);
      }
    }
    return map;
  }, [board]);
  const reassignForStudent = useCallback((rowId: string): ReassignLink[] => {
    const sid = stopsById.get(rowId)?.studentId;
    const s = sid ? board?.students.find((x) => x.studentId === sid) : null;
    return s ? s.legs.filter((l) => l.reassign).map((l) => ({ studentId: s.studentId, legKey: l.key, label: l.reassign!.label })) : reassignByRowId.get(rowId) ?? [];
  }, [board, stopsById, reassignByRowId]);
  function openReassign(link: ReassignLink) { setDialog(null); setOpenRequest({ studentId: link.studentId, legKey: link.legKey, nonce: Date.now() }); }

  // ── 편집 창 ──
  const [dialog, setDialog] = useState<Dialog | null>(() => {
    if (!initialStudentId) return null;
    const hit = stops.find((s) => s.studentId === initialStudentId && s.id && (s.direction === "BOARD" || s.direction === "ALIGHT"));
    return hit ? { kind: "student", rowId: hit.id! } : null;
  });
  function afterSaved(text: string) { setDialog(null); setError(null); setMessage(text); router.refresh(); }

  // 기사님 위치·요청(옛 배차 화면에서 그대로 옮김).
  const [showLocations, setShowLocations] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [pendingRequests, setPendingRequests] = useState(0);
  const loadPendingRequests = useCallback(() => {
    fetch("/api/admin/driver-requests", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { requests?: { status: string }[] } | null) => { if (d?.requests) setPendingRequests(d.requests.filter((r) => r.status === "PENDING").length); })
      .catch(() => null);
  }, []);
  useEffect(() => { loadPendingRequests(); }, [loadPendingRequests]);

  // 등원·하원 수업시간이 다른 학생(명단 자료 점검 — 자동으로 고치지 않는다).
  const mismatches = useMemo(() => {
    const day = stops.filter((s) => s.weekday === weekday && s.studentName && (s.direction === "BOARD" || s.direction === "ALIGHT"));
    const keyOf = rosterStudentKeyResolver(day);
    const by = new Map<string, { name: string; board: string | null; alight: string | null }>();
    for (const s of day) {
      const k = keyOf(s);
      const v = by.get(k) ?? { name: s.studentName!, board: null, alight: null };
      if (s.direction === "BOARD") v.board = s.classTime; else v.alight = s.classTime;
      by.set(k, v);
    }
    return [...by.values()].filter((v) => v.board && v.alight && v.board !== v.alight);
  }, [stops, weekday]);

  function confirmLeave() { return !editing || window.confirm("저장하지 않은 순서·시각 수정이 있습니다. 이동하면 사라집니다. 계속할까요?"); }

  const stopRows = ordered.filter((r) => !r.isTerminal);
  const riderCount = new Set(stopRows.flatMap((r) => r.riders.map((x) => x.checkId))).size;

  // 카드 머리 보조 줄(관리자) — 학생 수 + «정류장 수정».
  function renderStopMeta(row: UnifiedRow) {
    return (
      <>
        <span>{row.riders.length}명</span>
        {!editing && row.kind === "REGULAR" && row.riders.length > 0 && (
          <button type="button" onClick={() => setDialog({ kind: "stop", rowIds: row.riders.map((x) => x.checkId) })}
            className="inline-flex min-h-11 items-center gap-0.5 rounded-lg px-1 text-[13px] font-bold text-[var(--color-academy-primary)] underline underline-offset-2">
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">edit_location_alt</span>정류장 수정
          </button>
        )}
      </>
    );
  }

  // 학생 한 줄(관리자) — 이름(누르면 셔틀 정보 창) · 반 이동 표시 · ×(명단에서 빼기). 탑승 버튼 자리에 × 하나.
  function renderRider(row: UnifiedRow, rider: UnifiedRider) {
    const links = reassignByRowId.get(rider.checkId) ?? [];
    return (
      <div key={`${row.key}:${rider.checkId}`} className={`${styles.rider} rounded-xl bg-gray-50`}>
        <div className={styles.riderMain}>
          <div className={styles.riderInfo}>
            <div className={styles.identity}>
              <button type="button" disabled={editing} onClick={() => setDialog({ kind: "student", rowId: rider.checkId })} aria-label={`${rider.name} 셔틀 정보 수정`}
                className="min-h-11 break-all text-left text-[19px] font-black text-gray-900 underline decoration-dotted underline-offset-4 disabled:no-underline">{rider.name}</button>
              {rider.grade && <span className="text-[14px] text-gray-500">{rider.grade}</span>}
              {links.map((l) => (
                <button key={l.legKey} type="button" disabled={editing} onClick={() => openReassign(l)} aria-label={`${rider.name} ${l.label} 재배정`}
                  className="inline-flex min-h-11 items-center gap-0.5 rounded-md bg-[var(--color-academy-warning)] px-2 text-[13px] font-black text-[var(--color-academy-on-primary)]">
                  <span aria-hidden="true" className="material-symbols-outlined text-[16px] leading-none">swap_horiz</span>반 이동 · 재배정
                </button>
              ))}
            </div>
          </div>
          {!editing && (
            <div className={styles.boardingActions}>
              <button type="button" onClick={() => setDialog({ kind: "remove", rowId: rider.checkId })} aria-label={`${rider.name} 명단에서 빼기`}
                className="grid h-11 w-11 place-items-center rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-danger)]">
                <span aria-hidden="true" className="material-symbols-outlined text-[22px]">close</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-3">
      {/* 한 줄 머리: 제목 · 월 · 기사님 위치·요청(컴팩트 — 히어로 없음) */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-base font-black text-[var(--color-academy-ink)]">정규 셔틀 운행표 <span className="text-xs font-bold text-[var(--color-academy-muted)]">기사님 화면과 같음</span></h3>
        <select value={serviceMonth} aria-label="운행 월" onChange={(e) => { if (confirmLeave()) router.push(`/admin/shuttle/regular-dispatch?month=${encodeURIComponent(e.target.value)}`); }}
          className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold">
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button type="button" onClick={() => setShowLocations(true)} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">map</span>실시간 위치
        </button>
        <button type="button" onClick={() => setShowRequests(true)} className="relative inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">inbox</span>기사 요청
          {pendingRequests > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-academy-danger)] px-1 text-xs font-black text-[var(--color-academy-on-primary)]">{pendingRequests}</span>}
        </button>
      </div>
      {showLocations && <DriverLocationPanel onClose={() => setShowLocations(false)} />}
      {showRequests && <DriverRequestPanel onClose={() => { setShowRequests(false); loadPendingRequests(); }} />}

      {/* 요일 탭(학생 수) */}
      <div role="tablist" aria-label="요일" className="mt-2 flex flex-wrap gap-1 rounded-xl bg-[var(--color-academy-soft)] p-1">
        {dayCounts.map((d) => (
          <button key={d.weekday} type="button" role="tab" aria-selected={weekday === d.weekday}
            onClick={() => { if (d.weekday !== weekday && confirmLeave()) { cancelEditing(); setWeekday(d.weekday); } }}
            className={`min-h-11 rounded-lg px-3 text-sm font-black ${weekday === d.weekday ? "bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] shadow" : "text-[var(--color-academy-muted)]"}`}>
            {WEEKDAY_LABELS[d.weekday]} <span className="text-xs font-bold">{d.count}</span>
          </button>
        ))}
      </div>

      {/* 배정 필요(신규 + 반 이동) — 한 줄 요약, 누르면 펼침. 넣으면 운행표를 다시 읽는다. */}
      <NewStudentDispatchPanel key={serviceMonth} month={serviceMonth} selectedWeekday={weekday}
        onAssigned={() => { setMessage(null); router.refresh(); }} onBoard={setBoard} openRequest={openRequest} />

      {mismatches.length > 0 && (
        <p className="mt-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs font-bold text-[var(--color-academy-warning)]">
          등원·하원 수업시간이 다른 학생 {mismatches.length}명 — {mismatches.map((m) => `${m.name}(등원 ${m.board}/하원 ${m.alight})`).join(", ")}. 학생 이름을 눌러 확인해 주세요.
        </p>
      )}
      {message && <p role="status" className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-success)]">{message}</p>}
      {error && <p role="alert" className="mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>}

      {/* 운행표 — 기사님 화면과 같은 카드(같은 CSS·같은 테마). 탑승 버튼 대신 편집 손잡이. */}
      <AcademyTheme role="driver" className={`${styles.workspace} mx-auto mt-2`}>
        {stopRows.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className={styles.runSummary}>{WEEKDAY_LABELS[weekday]}요일 운행 순서 · {stopRows.length}곳 <span>학생 {riderCount}명</span></p>
            {!editing ? (
              <button type="button" onClick={startEditing} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-bold text-gray-600">↕ 순서·시간 수정</button>
            ) : (
              <div className="flex gap-2">
                <button type="button" onClick={cancelEditing} disabled={savingOrder} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-bold text-gray-600">취소</button>
                <button type="button" onClick={() => void saveOrder()} disabled={savingOrder} className="min-h-11 rounded-lg bg-[var(--color-academy-ink)] px-4 text-[13px] font-black text-[var(--color-academy-surface)]">{savingOrder ? "저장 중…" : "저장"}</button>
              </div>
            )}
          </div>
        )}
        {editing && (
          <div className="mb-2 rounded-xl bg-blue-50 px-3 py-2 text-[13px] font-bold text-blue-700">
            같은 묶음(수업시간·등/하원) 안에서 ▲▼ 또는 끌어서 옮겨요. 옮기면 시각 칸도 함께 바뀌고, 시각을 직접 고칠 수도 있어요.
            <ScopeFields scope={orderScope} onScope={setOrderScope} serviceMonth={serviceMonth} laterMonths={laterMonths} />
          </div>
        )}
        {stopRows.length === 0 && <p className="rounded-2xl bg-gray-50 px-4 py-6 text-center text-[16px] font-bold text-gray-400">{WEEKDAY_LABELS[weekday]}요일에는 운행이 없습니다.</p>}
        <RunBoard
          rows={ordered}
          mode="admin"
          editing={editing}
          dragKey={dragKey}
          onDragKeyChange={setDragKey}
          onDropOn={moveDragged}
          onMove={moveRow}
          displayTime={displayTime}
          onTimeChange={(row, value) => setTimeOverride((t) => ({ ...t, [row.key]: value }))}
          renderStopMeta={renderStopMeta}
          renderRider={renderRider}
        />
      </AcademyTheme>

      {dialog?.kind === "student" && (
        <StudentShuttleDialog key={dialog.rowId} stops={stops} rowId={dialog.rowId} serviceMonth={serviceMonth} laterMonths={laterMonths} defaultScope={defaultScope}
          reassign={reassignForStudent(dialog.rowId)} onOpenReassign={openReassign} onClose={() => setDialog(null)} onSaved={afterSaved} />
      )}
      {dialog?.kind === "remove" && (
        <RemoveRiderDialog key={dialog.rowId} stops={stops} rowId={dialog.rowId} serviceMonth={serviceMonth} laterMonths={laterMonths} defaultScope={defaultScope}
          onClose={() => setDialog(null)} onSaved={afterSaved} />
      )}
      {dialog?.kind === "stop" && (
        <StopEditDialog key={dialog.rowIds.join(",")} stops={stops} rowIds={dialog.rowIds} serviceMonth={serviceMonth} laterMonths={laterMonths} defaultScope={defaultScope}
          onClose={() => setDialog(null)} onSaved={afterSaved} />
      )}
    </div>
  );
}
