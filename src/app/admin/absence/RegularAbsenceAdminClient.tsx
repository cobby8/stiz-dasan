"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  RegularAbsenceRow,
  RegularAbsenceClassOption,
  MakeupClassOption,
} from "@/lib/regular/admin-regular-absence";
import {
  confirmRegularAbsence,
  revertRegularAbsence,
  cancelRegularAbsenceByAdmin,
  loadRegularAbsences,
  scheduleMakeupForAbsence,
  cancelMakeupForAbsence,
  updateMakeupStatusForAbsence,
} from "@/app/actions/regular-absence-admin";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
// 결석일 묶음(오늘/이번 주/다음 주/이후/지난 건)은 보강 화면과 같은 공용 계산(KST 모듈)
import { groupByUpcomingDate, type UpcomingDateGroupKey } from "@/components/admin/list/upcomingDateGroups";
import { todayKst } from "@/lib/datetime/kst";

// 요일 한글 라벨(보강 반 표시용).
const DAY_KO: Record<string, string> = {
  Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 상태 칩 — 서버가 이미 CANCELLED 는 빼고 주므로 신고됨(미확정)·확정 두 가지. "ALL" = 전체
const STATUS_ALL = "ALL";
const STATUS_CHIPS = [
  { value: "REPORTED", label: "미확정" },
  { value: "CONFIRMED", label: "확정" },
] as const;

// 보강 상태 변경 선택지 — 예전 행의 드롭다운(예약·출석·노쇼)과 같은 값
const MAKEUP_STATUS_OPTIONS = [
  { value: "BOOKED", label: "보강 예약으로", icon: "event_repeat" },
  { value: "ATTENDED", label: "보강 출석", icon: "check_circle" },
  { value: "NO_SHOW", label: "보강 노쇼", icon: "person_off" },
] as const;

// 보기 전환 «날짜별 | 목록» — 기본은 결석일 날짜별 묶음, 선택은 브라우저에 기억
const ABSENCE_VIEW_STORAGE_KEY = "admin-regular-absence-view-mode";
const ABSENCE_VIEW_VALUES = ["date", "list"] as const;
type AbsenceViewMode = (typeof ABSENCE_VIEW_VALUES)[number];
const ABSENCE_VIEW_OPTIONS = [
  { value: "date", label: "날짜별", icon: "calendar_view_week" },
  { value: "list", label: "목록", icon: "view_list" },
] as const;

const ABSENCE_DATE_GROUP_LABELS: Record<UpcomingDateGroupKey, string> = {
  today: "오늘",
  thisWeek: "이번 주",
  nextWeek: "다음 주",
  later: "이후",
  past: "지난 결석",
};

export default function RegularAbsenceAdminClient({
  initial,
}: {
  initial: {
    rows: RegularAbsenceRow[];
    classes: RegularAbsenceClassOption[];
    makeupClasses: MakeupClassOption[];
  };
}) {
  const [rows, setRows] = useState<RegularAbsenceRow[]>(initial.rows);
  const [classId, setClassId] = useState<string>(""); // "" = 전체 반
  const [busyId, setBusyId] = useState<string>("");
  const [err, setErr] = useState("");
  // 보강 지정 폼: 열린 결석 id + 입력값(반/날짜).
  const [makeupOpenId, setMakeupOpenId] = useState<string>("");
  const [makeupClassId, setMakeupClassId] = useState<string>("");
  const [makeupDate, setMakeupDate] = useState<string>("");
  // 상태 칩 선택값, 행 클릭 상세 패널 대상, 보기 방식(날짜별 | 목록)
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_ALL);
  const [detailId, setDetailId] = useState<string>("");
  const [viewMode, setViewMode] = useRememberedListView<AbsenceViewMode>(ABSENCE_VIEW_STORAGE_KEY, ABSENCE_VIEW_VALUES, "date");

  const reload = useCallback(async (cid: string) => {
    setErr("");
    try {
      const res = await loadRegularAbsences({ classId: cid || undefined });
      setRows(res.rows);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const onClassChange = useCallback(
    (cid: string) => {
      setClassId(cid);
      void reload(cid);
    },
    [reload],
  );

  const runAction = useCallback(
    async (id: string, fn: (i: { id: string }) => Promise<unknown>) => {
      setErr("");
      setBusyId(id);
      try {
        await fn({ id });
        await reload(classId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [reload, classId],
  );

  // 보강 지정 폼 열기(반/날짜 입력 초기화).
  const openMakeupForm = useCallback((absenceId: string) => {
    setErr("");
    setMakeupOpenId(absenceId);
    setMakeupClassId("");
    setMakeupDate("");
  }, []);

  // 보강 지정 실행.
  const submitMakeup = useCallback(
    async (absenceId: string) => {
      setErr("");
      setBusyId(absenceId);
      try {
        await scheduleMakeupForAbsence({ absenceId, makeupClassId, makeupDate });
        // 그사이 다른 결석의 창을 열었다면 그 창은 닫지 않는다
        setMakeupOpenId((cur) => (cur === absenceId ? "" : cur));
        await reload(classId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [makeupClassId, makeupDate, reload, classId],
  );

  // 보강 취소.
  const cancelMakeup = useCallback(
    async (absenceId: string, makeupId: string) => {
      setErr("");
      setBusyId(absenceId);
      try {
        await cancelMakeupForAbsence({ makeupId });
        await reload(classId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [reload, classId],
  );

  // 보강 상태 변경(출석/노쇼 등).
  const changeMakeupStatus = useCallback(
    async (absenceId: string, makeupId: string, status: string) => {
      setErr("");
      setBusyId(absenceId);
      try {
        await updateMakeupStatusForAbsence({ makeupId, status });
        await reload(classId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [reload, classId],
  );

  const reportedCount = useMemo(() => rows.filter((r) => r.status === "REPORTED").length, [rows]);

  // 상태 칩으로 거른 목록(반 필터는 예전처럼 서버에서 다시 읽는다)
  const visibleRows = useMemo(
    () => (statusFilter === STATUS_ALL ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
  );
  // 결석일 날짜별 묶음 — r.date 는 서버가 이미 KST 달력 날짜("YYYY-MM-DD")로 준다
  const today = todayKst();
  const dateGroups = useMemo(
    () => groupByUpcomingDate(visibleRows, (r) => r.date, today, ABSENCE_DATE_GROUP_LABELS),
    [visibleRows, today],
  );
  const statusChipItems = STATUS_CHIPS.map((chip) => ({
    value: chip.value,
    label: chip.label,
    count: rows.filter((r) => r.status === chip.value).length,
  }));

  // ⚡·상세 패널이 같이 쓰는 작업 목록 — 예전 카드의 확정/확정 취소·취소 버튼, 보강 상태 드롭다운·보강 취소·보강 지정을
  // 같은 함수·같은 인자로 옮긴 것(확인창이 없던 버튼은 그대로 없음)
  function buildAbsenceActions(r: RegularAbsenceRow): AdminQuickAction[] {
    const id = r.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
    const makeupId = r.makeupId;
    const busy = busyId === id;
    const actions: AdminQuickAction[] = [
      r.status === "CONFIRMED"
        ? { key: "revert", label: "확정 취소", icon: "undo", disabled: busy, onSelect: () => runAction(id, revertRegularAbsence) }
        : { key: "confirm", label: "확정", icon: "check", tone: "primary", disabled: busy, onSelect: () => runAction(id, confirmRegularAbsence) },
      { key: "cancel", label: "신고 취소", icon: "block", disabled: busy, onSelect: () => runAction(id, cancelRegularAbsenceByAdmin) },
    ];
    if (makeupId) {
      // 지금 상태가 아닌 것만(드롭다운에서 같은 값을 다시 고르면 아무 일도 없던 것과 같다)
      for (const option of MAKEUP_STATUS_OPTIONS) {
        if (option.value === (r.makeupStatus ?? "BOOKED")) continue;
        actions.push({ key: `makeup-${option.value}`, label: option.label, icon: option.icon, disabled: busy, onSelect: () => changeMakeupStatus(id, makeupId, option.value) });
      }
      // 예약 상태만 취소(다녀온·노쇼 보강은 «보강 예약으로» 되돌린 뒤 취소 — 서버도 같은 규칙)
      if ((r.makeupStatus ?? "BOOKED") === "BOOKED") {
        actions.push({ key: "makeup-cancel", label: "보강 취소", icon: "event_busy", tone: "danger", disabled: busy, onSelect: () => cancelMakeup(id, makeupId) });
      }
    } else {
      actions.push({ key: "makeup-open", label: "보강 지정", icon: "event_repeat", disabled: busy, onSelect: () => openMakeupForm(id) });
    }
    return actions;
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  // 보기 전환 시 열린 패널은 닫는다
  function changeViewMode(next: AbsenceViewMode) {
    setDetailId("");
    setViewMode(next);
  }

  function statusBadge(r: RegularAbsenceRow) {
    return r.status === "CONFIRMED" ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-success)]">
        <span className="material-symbols-outlined text-sm" aria-hidden="true">check_circle</span>
        {r.statusLabel}
      </span>
    ) : (
      <span className="inline-flex items-center rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-warning)]">
        {r.statusLabel}
      </span>
    );
  }

  function makeupBadge(r: RegularAbsenceRow) {
    return r.makeupId ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-primary-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-primary)]">
        <span className="material-symbols-outlined text-sm" aria-hidden="true">event_repeat</span>
        {r.makeupStatusLabel}
      </span>
    ) : (
      <span className="text-xs text-[var(--color-academy-muted)]">미지정</span>
    );
  }

  // 표 칸 수(날짜별 머리줄 colSpan 용)
  const columnCount = 10;

  // 한 줄 행: 결석일 | 시간 | 원생 | 반 | 사유 | 상태 | 보강 | 보강 반 | 보강일 | 관리(⚡). 신고 시각은 상세 패널에서
  function renderAbsenceRow(r: RegularAbsenceRow) {
    return (
      <tr
        key={r.id}
        tabIndex={0}
        aria-label={`${r.studentName} ${r.dateLabel} 결석 상세 보기`}
        onClick={() => setDetailId(r.id)}
        onKeyDown={(event) => handleRowKeyDown(event, r.id)}
        className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
      >
        {/* 날짜·시간은 오른쪽 + 자릿수 폭 고정 */}
        <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{r.dateLabel}</td>
        <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{r.startTime || "-"}</td>
        <td className="px-2 py-1.5 font-black text-[var(--color-academy-ink)]">{r.studentName}</td>
        <td className="px-2 py-1.5 text-[var(--color-academy-muted)]">{r.className}</td>
        <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] md:table-cell">{r.reasonLabel}</td>
        <td className="px-2 py-1.5">{statusBadge(r)}</td>
        <td className="px-2 py-1.5">{makeupBadge(r)}</td>
        <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] lg:table-cell">{r.makeupId ? r.makeupClassName ?? "반 미지정" : "-"}</td>
        <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-ink)] md:table-cell">{r.makeupDateLabel || "-"}</td>
        {/* 관리: ⚡(확정·취소·보강). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
        <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
          <AdminQuickActionMenu label={`${r.studentName} 결석 빠른 작업`} actions={buildAbsenceActions(r)} />
        </td>
      </tr>
    );
  }

  const detail = detailId ? rows.find((r) => r.id === detailId) ?? null : null;
  const makeupTarget = makeupOpenId ? rows.find((r) => r.id === makeupOpenId) ?? null : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-4">
      {/* 헤더 + 반 필터 */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="flex items-center gap-2 text-lg font-black text-[var(--color-academy-ink)]">
            <span className="material-symbols-outlined text-2xl text-[var(--color-academy-primary)]" aria-hidden="true">event_busy</span>
            정규 수업 결석
          </h2>
          <p className="text-xs text-[var(--color-academy-muted)]">
            (방학특강 결석은 별도 메뉴)
            {reportedCount > 0 && (
              <span className="ml-1 font-bold text-[var(--color-academy-warning)]">미확정 <span className="tabular-nums">{reportedCount}</span>건</span>
            )}
          </p>
        </div>
        <select
          value={classId}
          onChange={(e) => {
            setDetailId(""); // 반을 바꾸면 목록이 다시 읽히므로 열린 패널은 닫는다
            onClassChange(e.target.value);
          }}
          aria-label="반 선택"
          className="min-h-11 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold text-[var(--color-academy-ink)]"
        >
          <option value="">전체 반</option>
          {initial.classes.map((c) => (
            <option key={c.classId} value={c.classId}>
              {c.className}
            </option>
          ))}
        </select>
      </div>

      {err && !makeupTarget && (
        <div className="mb-2 rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-4 py-2 text-sm font-bold text-[var(--color-academy-danger)]">
          {err}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
          접수된 정규수업 결석 신고가 없습니다.
        </div>
      ) : (
        <>
          {/* 상태 칩(누르면 그 상태만, 다시 누르면 전체) + 보기 전환(날짜별 | 목록) */}
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <StatusCountChips
              ariaLabel="결석 신고 상태별 건수"
              items={statusChipItems}
              selected={statusFilter}
              onSelect={(value) => { setStatusFilter(value); setDetailId(""); }}
              allValue={STATUS_ALL}
            />
            <ListViewToggle value={viewMode} options={ABSENCE_VIEW_OPTIONS} ariaLabel="결석 보기 방식" onChange={changeViewMode} />
          </div>

          {visibleRows.length === 0 ? (
            <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
              조건에 맞는 결석 신고가 없습니다.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
              <div className="overflow-x-auto">
                {/* admin-list-table: 글자 왼쪽·날짜/시간 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                <table className="admin-list-table w-full border-collapse text-sm">
                  <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                    <tr>
                      <th className="admin-cell-num px-2 py-2">결석일</th>
                      <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">시간</th>
                      <th className="px-2 py-2">원생</th>
                      <th className="px-2 py-2">반</th>
                      <th className="hidden px-2 py-2 md:table-cell">사유</th>
                      <th className="px-2 py-2">상태</th>
                      <th className="px-2 py-2">보강</th>
                      <th className="hidden px-2 py-2 lg:table-cell">보강 반</th>
                      <th className="admin-cell-num hidden px-2 py-2 md:table-cell">보강일</th>
                      <th className="admin-cell-center px-2 py-2">관리</th>
                    </tr>
                  </thead>
                  {viewMode === "date" ? (
                    // 날짜별 보기: 머리줄 «오늘 · 3건 · 미확정 1» 아래 그 기간 결석들
                    dateGroups.map((group) => {
                      const pending = group.items.filter((r) => r.status === "REPORTED").length;
                      return (
                        <tbody key={group.key} className="divide-y divide-[var(--color-academy-line)]">
                          <tr>
                            <th colSpan={columnCount} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                              {group.label} · <span className="tabular-nums">{group.items.length}</span>건
                              {pending > 0 && <> · 미확정 <span className="tabular-nums">{pending}</span></>}
                            </th>
                          </tr>
                          {group.items.map(renderAbsenceRow)}
                        </tbody>
                      );
                    })
                  ) : (
                    <tbody className="divide-y divide-[var(--color-academy-line)]">{visibleRows.map(renderAbsenceRow)}</tbody>
                  )}
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* 행 클릭 상세 패널 — 이미 받아온 값만(새 조회 없음). 작업 버튼은 ⚡ 와 같은 목록 */}
      {detail && !makeupTarget && (() => {
        const d = detail;
        const panelRows: { label: string; value: React.ReactNode }[] = [
          { label: "결석일", value: <span className="tabular-nums">{d.date} {d.startTime}</span> },
          { label: "반", value: d.className },
          { label: "사유", value: d.reasonLabel },
          { label: "신고", value: d.reportedAtLabel ? <span className="tabular-nums">{d.reportedAtLabel}</span> : null },
          { label: "보강", value: d.makeupId ? `${d.makeupStatusLabel ?? ""}` : "미지정" },
          { label: "보강 반", value: d.makeupId ? d.makeupClassName ?? "반 미지정" : null },
          { label: "보강일", value: d.makeupId && d.makeupDate ? <span className="tabular-nums">{d.makeupDate}</span> : null },
        ].filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
        return (
          <ListDetailPanel onClose={() => setDetailId("")} titleId="absence-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="absence-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.studentName}</h3>
              {statusBadge(d)}
              <button
                type="button"
                onClick={() => setDetailId("")}
                aria-label="닫기"
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
              >
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {panelRows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="font-bold text-[var(--color-academy-muted)]">{row.label}</dt>
                  <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 flex flex-wrap gap-2">
              {buildAbsenceActions(d).map((action) => (
                <button
                  key={action.key}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => { setDetailId(""); void action.onSelect(); }}
                  className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-4 text-sm font-bold disabled:opacity-50 ${
                    action.tone === "danger"
                      ? "border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                      : action.tone === "primary"
                        ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]"
                        : "border-[var(--color-academy-line)] text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                  }`}
                >
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">{action.icon}</span>
                  {action.label}
                </button>
              ))}
            </div>
          </ListDetailPanel>
        );
      })()}

      {/* 보강 지정 창 — 예전 카드 안에 펼쳐지던 입력칸(반 + 날짜)과 같은 값·같은 저장(submitMakeup) */}
      {makeupOpenId && (
        <AdminModal titleId="absence-makeup-form-title" onClose={() => { if (busyId !== makeupOpenId) setMakeupOpenId(""); }} closeOnBackdrop={false} panelClassName="max-w-md p-5">
          <div className="mb-3 flex items-center gap-2">
            <h3 id="absence-makeup-form-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">
              보강 지정{makeupTarget ? ` — ${makeupTarget.studentName} ${makeupTarget.dateLabel} 결석` : ""}
            </h3>
          </div>
          {err && (
            <p className="mb-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{err}</p>
          )}
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs font-bold text-[var(--color-academy-muted)]">
              보강 반
              <select
                value={makeupClassId}
                onChange={(e) => setMakeupClassId(e.target.value)}
                className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-sm font-bold text-[var(--color-academy-ink)]"
              >
                <option value="">-- 반 선택 --</option>
                {initial.makeupClasses.map((c) => (
                  <option key={c.classId} value={c.classId}>
                    {c.className}
                    {` (${DAY_KO[c.dayOfWeek] ?? c.dayOfWeek} ${c.startTime})`}
                    {c.programName ? ` · ${c.programName}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-bold text-[var(--color-academy-muted)]">
              보강일
              <input
                type="date"
                value={makeupDate}
                onChange={(e) => setMakeupDate(e.target.value)}
                className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-sm font-bold text-[var(--color-academy-ink)]"
              />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busyId === makeupOpenId}
              onClick={() => setMakeupOpenId("")}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
            >
              닫기
            </button>
            <button
              type="button"
              disabled={busyId === makeupOpenId || !makeupClassId || !makeupDate}
              onClick={() => submitMakeup(makeupOpenId)}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-[var(--color-academy-primary)] px-3 text-sm font-black text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              보강 지정
            </button>
          </div>
        </AdminModal>
      )}
    </div>
  );
}
