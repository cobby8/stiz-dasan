"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

// 현황판을 주간 달력으로 배치하는 계산은 순수 모듈로 분리해 테스트로 잠가 뒀다.
import { buildAttendanceCalendar, calendarCellDateLabel } from "@/lib/seasonal/attendanceCalendar";
import { ATTENDANCE_TONE, TONE_BADGE_CLASS, TONE_SOLID_CLASS, TONE_TEXT_CLASS } from "@/lib/ui/statusTones";

type Offering = {
  id: string; seasonId: string; title: string; capacity: number | null;
  targetGrades: string | null; instructorName: string | null; dateCount: number; enrolledSlots: number;
};
type Season = { id: string; title: string; status: string };
type BoardDate = {
  sessionDateId: string; round: number; dateLabel: string; dayLabel: string; weekdayKey?: string;
  startTime: string; endTime: string;
  ymd: string; location: string | null; capacity: number | null; scheduled: number; makeup: number;
  present: number; late: number; absent: number; excused: number; unchecked: number; checked: number;
  state: "DONE" | "LIVE" | "PLANNED";
  // 그날 코트에 실제로 들어오는 전체 인원(같은 코트를 함께 쓰는 형제 반 합산) / 그 정원.
  // scheduled(이 반 인원)와 기준이 다르므로 화면에서 구분해 표시한다.
  courtOccupied?: number | null; courtCapacity?: number | null;
};
type RosterRow = {
  enrollmentDateId: string; kind: string; enrollmentStatus: string; attendanceStatus: string | null;
  arrivedAt: string | null; attendanceNote: string | null; itemId: string; childName: string;
  childGrade: string | null; childSchool: string | null; parentName: string; parentPhone: string; originAbsence: string | null;
  // 학생이 신청한 요일 (예: ["MON","WED"] / "월·수") — 날짜별 명단 인원 차이를 설명하기 위한 정보
  selectedWeekdays?: string[]; selectedWeekdayLabel?: string | null;
  // 코트 합산 명단: 이 좌석이 속한 반 이름 + 현재 열린 반과 같은지 여부(강조용)
  offeringTitle?: string | null; isThisOffering?: boolean; sessionDateId?: string;
};

// 출결 버튼·표시 색 = 공용 지도(statusTones): 출석 정상 · 지각 주의 · 결석 위험
const ATT = [
  { key: "PRESENT", label: "출석", cls: TONE_SOLID_CLASS[ATTENDANCE_TONE.PRESENT], soft: TONE_BADGE_CLASS[ATTENDANCE_TONE.PRESENT] },
  { key: "LATE", label: "지각", cls: TONE_SOLID_CLASS[ATTENDANCE_TONE.LATE], soft: TONE_BADGE_CLASS[ATTENDANCE_TONE.LATE] },
  { key: "ABSENT", label: "결석", cls: TONE_SOLID_CLASS[ATTENDANCE_TONE.ABSENT], soft: TONE_BADGE_CLASS[ATTENDANCE_TONE.ABSENT] },
];

async function getJSON(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "요청 실패");
  return j;
}
async function postJSON(body: any) {
  const r = await fetch("/api/admin/seasonal/attendance", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "요청 실패");
  return j;
}

export default function SeasonalAttendanceClient({ initial }: { initial: { seasons: Season[]; offerings: Offering[] } }) {
  // router.refresh()는 서버 컴포넌트(상단 탭의 보강 대기 뱃지)를 다시 그리게 한다. 화면 상태는 유지된다.
  const router = useRouter();
  const [tab, setTab] = useState<"attendance" | "makeup">("attendance");
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "makeup") setTab("makeup");
  }, []);
  const [seasonId, setSeasonId] = useState<string>(initial.seasons[0]?.id ?? "");
  const offeringsInSeason = useMemo(
    () => initial.offerings.filter((o) => !seasonId || o.seasonId === seasonId),
    [initial.offerings, seasonId],
  );
  const [offeringId, setOfferingId] = useState<string>(offeringsInSeason[0]?.id ?? "");
  const offering = useMemo(() => initial.offerings.find((o) => o.id === offeringId) ?? null, [initial.offerings, offeringId]);

  const [board, setBoard] = useState<BoardDate[]>([]);
  const [selDate, setSelDate] = useState<string>("");
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rosterMeta, setRosterMeta] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [makeups, setMakeups] = useState<any>({ pending: [], assigned: [], stats: {} });
  const [modal, setModal] = useState<any>(null); // makeup-options payload

  // keepSelection: 출석을 한 명 찍을 때마다 현황판을 다시 불러오는데, 그때 날짜를 다시 고르면
  // 보고 있던 회차가 진행중인 날(없으면 첫날)로 튄다. 갱신일 때는 보던 날짜를 그대로 둔다.
  const loadBoard = useCallback(async (oid: string, opts?: { keepSelection?: boolean }) => {
    if (!oid) return;
    setErr(""); setBusy(true);
    try {
      const data = await getJSON(`/api/admin/seasonal/attendance?view=board&offeringId=${oid}`);
      const dates: BoardDate[] = data.dates || [];
      setBoard(dates);
      setSelDate((cur) => {
        // 보던 날짜가 목록에 그대로 있으면 유지한다.
        if (opts?.keepSelection && cur && dates.some((d) => d.sessionDateId === cur)) return cur;
        const live = dates.find((d) => d.state === "LIVE");
        return live?.sessionDateId || dates[0]?.sessionDateId || "";
      });
    } catch (e) { setErr((e as Error).message); setBoard([]); } finally { setBusy(false); }
  }, []);

  const loadRoster = useCallback(async (sid: string) => {
    if (!sid) { setRoster([]); setRosterMeta(null); return; }
    setBusy(true);
    try {
      const data = await getJSON(`/api/admin/seasonal/attendance?view=roster&sessionDateId=${sid}`);
      setRoster(data.rows || []); setRosterMeta(data.date || null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);

  const loadMakeups = useCallback(async () => {
    try { setMakeups(await getJSON(`/api/admin/seasonal/attendance?view=makeups&seasonId=${seasonId}`)); }
    catch (e) { setErr((e as Error).message); }
  }, [seasonId]);

  useEffect(() => { if (offeringId) void loadBoard(offeringId); }, [offeringId, loadBoard]);
  useEffect(() => { if (selDate) void loadRoster(selDate); }, [selDate, loadRoster]);
  useEffect(() => { if (tab === "makeup") void loadMakeups(); }, [tab, loadMakeups]);
  useEffect(() => { setOfferingId(offeringsInSeason[0]?.id ?? ""); }, [seasonId]); // eslint-disable-line

  const selBoard = board.find((d) => d.sessionDateId === selDate) || null;

  async function mark(row: RosterRow, status: string) {
    const next = row.attendanceStatus === status ? null : status;
    try {
      await postJSON({ action: "attendance", enrollmentDateId: row.enrollmentDateId, status: next });
      setRoster((prev) => prev.map((r) => r.enrollmentDateId === row.enrollmentDateId ? { ...r, attendanceStatus: next } : r));
      void loadBoard(offeringId, { keepSelection: true });
    } catch (e) { setErr((e as Error).message); }
  }

  async function openMakeup(row: RosterRow) {
    try { setModal(await getJSON(`/api/admin/seasonal/attendance?view=makeup-options&enrollmentDateId=${row.enrollmentDateId}`)); }
    catch (e) { setErr((e as Error).message); }
  }

  async function assignSeasonal(sessionDateId: string) {
    if (!modal) return;
    try {
      await postJSON({ action: "makeup-create", enrollmentDateId: modal.absence.enrollmentDateId, targetType: "SEASONAL", targetSessionDateId: sessionDateId });
      setModal(null); void loadBoard(offeringId, { keepSelection: true }); void loadRoster(selDate);
    } catch (e) { setErr((e as Error).message); }
  }
  async function assignRegular(c: any) {
    if (!modal) return;
    try {
      await postJSON({ action: "makeup-create", enrollmentDateId: modal.absence.enrollmentDateId, targetType: "REGULAR", targetClassId: c.classId, targetDate: c.nextDate });
      setModal(null); void loadRoster(selDate);
    } catch (e) { setErr((e as Error).message); }
  }
  async function decide(id: string, decision: string) {
    try {
      await postJSON({ action: "makeup-decide", makeupId: id, decision });
      void loadMakeups(); void loadBoard(offeringId, { keepSelection: true });
      // 승인·거절하면 대기 건수가 줄어드므로 상단 탭 뱃지도 즉시 갱신한다.
      router.refresh();
    }
    catch (e) { setErr((e as Error).message); }
  }

  const capOf = (d: BoardDate) => d.courtCapacity ?? d.capacity ?? offering?.capacity ?? 12;
  // 정원과 직접 비교해야 하는 값은 "코트 전체 인원"이다. 서버가 값을 못 주면(구버전 응답 등)
  // 예전처럼 이 반 인원으로 대체해 화면이 깨지지 않게 한다.
  const courtOf = (d: BoardDate) => (typeof d.courtOccupied === "number" ? d.courtOccupied : null);
  const gaugeOf = (d: BoardDate) => courtOf(d) ?? d.scheduled;
  const barColor = (d: BoardDate) => {
    const cap = capOf(d); const pct = cap ? gaugeOf(d) / cap : 0;
    return pct >= 1 ? "bg-[var(--color-academy-danger)]" : pct >= 0.83 ? "bg-[var(--color-academy-warning)]" : "bg-[var(--brand-accent)]";
  };
  // 회차 목록을 주간 달력(가로=요일, 세로=주차)으로 접는다. 배치 계산은 순수 함수가 담당한다.
  const calendar = useMemo(() => buildAttendanceCalendar(board), [board]);

  // 달력 셀 하나 — 날짜 / (이 반 · 코트전체/정원) / 초과 경고 / 게이지 순으로 압축해 보여준다.
  // 시간·N일차·출결 상세는 title(마우스 올리면 보이는 설명)로 옮겼다.
  const renderBoardCell = (d: BoardDate) => {
    const cap = capOf(d);
    const court = courtOf(d);                    // 그날 코트 전체 인원(형제 반 합산) — 없으면 null
    const over = court != null && court > cap;   // 정원 초과 여부(정원과 비교되는 값은 코트 전체다)
    const pending = d.unchecked > 0 && d.state !== "PLANNED"; // 출결 체크가 덜 끝난 날
    const title = `${d.dateLabel}(${d.dayLabel}) · ${d.round}일차 · ${d.startTime}~${d.endTime}`
      + ` · 이 반 ${d.scheduled}명${court != null ? ` · 코트 전체 ${court}/${cap}${over ? " ⚠ 정원 초과" : ""}` : ""}`
      + ` · 출${d.present}/지${d.late}/결${d.absent}/보${d.makeup}${pending ? ` · 미확인 ${d.unchecked}` : ""}`;
    return (
      <button key={d.sessionDateId} onClick={() => setSelDate(d.sessionDateId)} title={title}
        className={`min-w-0 rounded-lg border p-1.5 text-left ${selDate === d.sessionDateId ? "border-[var(--brand-accent)] ring-1 ring-[var(--brand-accent)]" : "border-[var(--color-academy-line)]"} ${d.state === "LIVE" ? "bg-[var(--color-academy-info-soft)]" : "bg-white"}`}>
        <div className="flex items-start justify-between gap-0.5">
          <span className="text-xs font-black leading-none">{calendarCellDateLabel(d.ymd, calendar.multiMonth)}</span>
          {/* 미확인이 남은 날은 눈에 띄게 — 체크를 빠뜨리지 않게 하는 표시 */}
          {pending && <span className="rounded-full bg-[var(--color-academy-warning-soft)] px-1 text-[9px] font-black leading-4 text-[var(--color-academy-warning)]">{d.unchecked}</span>}
        </div>
        {/* 앞 숫자 = 이 반 인원, 뒤 숫자 = 코트 전체/정원 (아래 ※ 설명 참고) */}
        <div className="mt-1 truncate text-[10px] font-black leading-none">
          <span className="text-[var(--color-academy-muted)]">{d.scheduled}</span>
          {court != null && <> · <span className={over ? "text-[var(--color-academy-danger)]" : ""}>{court}/{cap}</span></>}
        </div>
        {over && <div className="mt-0.5 text-[9px] font-black leading-none text-[var(--color-academy-danger)]">⚠ 초과</div>}
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-academy-line)]">
          <div className={`h-full rounded-full ${barColor(d)}`} style={{ width: `${Math.min(100, cap ? (gaugeOf(d) / cap) * 100 : 0)}%` }} />
        </div>
      </button>
    );
  };

  // 선택한 날짜의 코트 인원/정원 — 상단 KPI와 명단 헤더에서 함께 쓴다.
  const selCourt = selBoard ? courtOf(selBoard) : null;
  const selCourtCap = selBoard ? capOf(selBoard) : null;
  const selCourtOver = selCourt != null && selCourtCap != null && selCourt > selCourtCap;

  return (
    <div className="mx-auto max-w-6xl p-4">
      {/* 페이지 제목은 상위 서버 페이지의 공통 SeasonalHeader가 담당한다(중복 방지).
          여기서는 시즌·특강 선택 드롭다운만 우측에 배치한다. */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1" />
        <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)}
          className="min-h-10 rounded-lg border border-[var(--color-academy-line)] bg-white px-2 text-sm font-bold">
          {initial.seasons.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}
          className="min-h-10 rounded-lg border border-[var(--color-academy-line)] bg-white px-2 text-sm font-bold">
          {offeringsInSeason.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      </div>

      {err && <div className="mb-3 rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{err}</div>}

      {tab === "attendance" && (
        <>
          {offering && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-academy-line)] bg-white px-4 py-3">
              <span className="text-base font-black">{offering.title}</span>
              <span className="text-xs font-bold text-[var(--color-academy-muted)]">{offering.targetGrades || ""} · 운영 {offering.dateCount}일 · 담당 {offering.instructorName || "-"}</span>
              <div className="flex-1" />
              {/* 정원은 "반 1개"가 아니라 같은 코트를 함께 쓰는 반을 합친 하루 기준이라는 점을 라벨에 명시 */}
              <span className="rounded-full bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)] px-3 py-1 text-xs font-black">코트 정원: 하루 {offering.capacity ?? 12}명</span>
            </div>
          )}

          {selBoard && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {/* 정원과 비교되는 숫자는 "코트 전체 인원"이다. 이 반 인원은 보조 설명으로 함께 보여준다. */}
              {selCourt != null
                ? <Kpi n={`${selCourt}/${selCourtCap}`} l={selCourtOver ? "이 날 코트 인원 · 정원 초과" : "이 날 코트 인원 · 정원"}
                    c={selCourtOver ? "text-[var(--color-academy-danger)]" : ""} sub={`이 반 ${selBoard.scheduled}명`} />
                : <Kpi n={`${selBoard.scheduled}${selBoard.capacity ? "/" + selBoard.capacity : ""}`} l="이 날짜 인원" />}
              <Kpi n={selBoard.present} l="출석" c={TONE_TEXT_CLASS.success} />
              <Kpi n={selBoard.late} l="지각" c={TONE_TEXT_CLASS.warning} />
              <Kpi n={selBoard.absent} l="결석" c={TONE_TEXT_CLASS.danger} />
              <Kpi n={selBoard.makeup} l="보강생" c={TONE_TEXT_CLASS.info} />
            </div>
          )}

          <div className="mb-1 text-sm font-black">회차(날짜)별 현황 <span className="font-bold text-[var(--color-academy-muted)]">· 총 {board.length}일</span></div>
          {/* 주간 달력: 가로=수업이 있는 요일, 세로=주차. 그 주에 수업이 없는 칸은 비워 날짜 간격이 보이게 한다.
              열은 1fr로 나눠 가지므로 요일이 많아도 가로 스크롤이 생기지 않는다. */}
          <div className="rounded-xl border border-[var(--color-academy-line)] bg-white p-2">
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${calendar.columns.length || 1}, minmax(0, 1fr))` }}>
              {calendar.columns.map((c) => (
                <div key={c.key} className="pb-0.5 text-center text-[11px] font-black text-[var(--color-academy-muted)]">{c.label}</div>
              ))}
              {/* 행(주차)을 한 줄로 펴서 그린다 — 열 개수가 고정이라 순서대로 채우면 주차 행이 된다. */}
              {calendar.weeks.flatMap((w, wi) =>
                w.cells.map((d, ci) =>
                  d ? renderBoardCell(d)
                    : <div key={`${w.weekStart}-${wi}-${ci}`} className="min-h-[46px] rounded-lg border border-dashed border-[var(--color-academy-line)]" />,
                ),
              )}
              {board.length === 0 && <div className="col-span-full p-4 text-center text-sm text-[var(--color-academy-faint)]">회차가 없습니다.</div>}
            </div>
            {/* 날짜 값이 이상해 달력에 못 놓은 회차가 있어도 화면에서 사라지지 않게 따로 붙인다(정상 데이터에선 비어 있음). */}
            {calendar.unplaced.length > 0 && (
              <div className="mt-1 grid grid-cols-3 gap-1 sm:grid-cols-6">{calendar.unplaced.map((d) => renderBoardCell(d))}</div>
            )}
          </div>
          {/* 두 숫자가 서로 다른 기준임을 분명히 알린다 — 13명 > 정원 12 같은 모순으로 보이지 않도록.
              (3문단이던 설명을 한 줄로 압축. 정원과 비교되는 값은 '이 반'이 아니라 '코트 전체'라는 점은 반드시 남긴다.) */}
          <p className="mt-2 px-1 text-[11px] font-bold text-[var(--color-academy-muted)]">※ <b>이 반</b> = 그 날짜 이 반 인원(정규+보강생) · <b>코트 전체</b> = 같은 시간·코트를 쓰는 반을 모두 합친 인원/정원(초과 시 빨강). 학생마다 신청 요일이 달라 날짜별 인원이 다를 수 있습니다.</p>

          {rosterMeta && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-academy-line)] px-4 py-3">
                <span className="text-sm font-black">{rosterMeta.dateLabel} ({rosterMeta.dayLabel}) 명단</span>
                <span className="text-xs font-bold text-[var(--color-academy-muted)]">
                  · {rosterMeta.startTime}~{rosterMeta.endTime}
                  {/* 명단은 이제 코트 전체(형제 반 합산) 기준이라 카드의 "코트 전체" 인원과 일치한다 */}
                  {typeof rosterMeta.totalApprovedStudents === "number"
                    ? ` · 이 반 명부 ${rosterMeta.totalApprovedStudents}명(요일 무관) · 이 날(${rosterMeta.dayLabel}) 코트 전체 ${roster.length}명`
                    : ` · ${roster.length}명`}
                </span>
                {/* 정원과 비교되는 값은 반 명부가 아니라 "그날 코트 전체 인원"이다 — 기준이 다름을 문구로 분리해 보여준다 */}
                {typeof rosterMeta.courtOccupied === "number" && (
                  <span className={`text-xs font-bold ${
                    rosterMeta.courtOccupied > (rosterMeta.courtCapacity ?? rosterMeta.capacity ?? 12)
                      ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
                    · 이 날 코트 전체 {rosterMeta.courtOccupied}/{rosterMeta.courtCapacity ?? rosterMeta.capacity ?? 12}
                    {rosterMeta.courtOccupied > (rosterMeta.courtCapacity ?? rosterMeta.capacity ?? 12) ? " ⚠ 정원 초과" : ""}
                  </span>
                )}
              </div>
              <table className="w-full text-sm">
                <thead><tr className="text-[11px] uppercase text-[var(--color-academy-muted)]">
                  <th className="p-2">학생</th><th className="p-2">학년</th><th className="p-2">비고</th><th className="p-2">출결</th><th className="p-2">보강</th>
                </tr></thead>
                <tbody>
                  {roster.map((r) => {
                    const cur = ATT.find((a) => a.key === r.attendanceStatus);
                    return (
                      <tr key={r.enrollmentDateId} className={`border-t border-[var(--color-academy-line)] ${r.kind === "MAKEUP" ? "bg-[var(--color-academy-info-soft)]" : r.attendanceStatus === "ABSENT" ? "bg-[var(--color-academy-danger-soft)]" : ""}`}>
                        <td className="p-2 text-center font-bold">
                          {r.childName}{r.kind === "MAKEUP" && <span className={`ml-1 rounded px-1 text-[11px] font-black ${TONE_BADGE_CLASS.info}`}>보강생</span>}
                          {/* 반(offering) 뱃지 — 코트 합산 명단이라 형제 반이 섞이므로 각 학생의 반을 표시한다 */}
                          {r.offeringTitle && (
                            <div className="mt-0.5">
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                                r.isThisOffering
                                  ? "bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                                  : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>
                                {r.offeringTitle}
                              </span>
                            </div>
                          )}
                          {/* 학생이 신청한 요일 뱃지 — 왜 이 학생이 특정 날짜에만 보이는지 알 수 있게 한다 */}
                          {r.selectedWeekdayLabel && (
                            <div className="mt-0.5">
                              <span className="rounded bg-[var(--color-academy-soft)] px-1.5 py-0.5 text-[10px] font-black text-[var(--color-academy-muted)]">
                                신청 {r.selectedWeekdayLabel}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-center text-[var(--color-academy-muted)]">{r.childGrade || "-"}</td>
                        <td className="p-2 text-center text-xs text-[var(--color-academy-muted)]">{r.kind === "MAKEUP" && r.originAbsence ? `← ${r.originAbsence} 결석분` : "-"}</td>
                        <td className="p-2">
                          <div className="flex justify-center gap-1">
                            {ATT.map((a) => (
                              <button key={a.key} onClick={() => mark(r, a.key)}
                                className={`min-h-8 rounded-lg px-2 text-xs font-black ${r.attendanceStatus === a.key ? a.cls : "border border-[var(--color-academy-line)] text-[var(--color-academy-muted)]"}`}>{a.label}</button>
                            ))}
                          </div>
                        </td>
                        <td className="p-2 text-center">
                          {r.kind === "REGULAR" && r.attendanceStatus === "ABSENT"
                            ? <button onClick={() => openMakeup(r)} className="min-h-8 rounded-lg bg-[var(--brand-accent)] px-2 text-xs font-black text-[var(--brand-accent-contrast)]">보강 배정</button>
                            : <span className="text-xs text-[var(--color-academy-faint)]">{cur ? cur.label : "-"}</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {roster.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-sm text-[var(--color-academy-faint)]">이 날짜에 배정된 학생이 없습니다.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "makeup" && (
        <MakeupTab makeups={makeups} onDecide={decide} />
      )}

      {modal && <MakeupModal modal={modal} onClose={() => setModal(null)} onSeasonal={assignSeasonal} onRegular={assignRegular} />}
    </div>
  );
}

// sub: 보조 설명 한 줄(예: "이 반 6명") — 기준이 다른 두 숫자를 한 카드에 같이 보여줄 때 쓴다.
function Kpi({ n, l, c, sub }: { n: any; l: string; c?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-2.5">
      <div className={`text-xl font-black ${c || ""}`}>{n}</div>
      <div className="mt-1 text-[11px] font-bold text-[var(--color-academy-muted)]">{l}</div>
      {sub && <div className="mt-0.5 text-[11px] font-bold text-[var(--color-academy-faint)]">{sub}</div>}
    </div>
  );
}
// (달력 전환으로 카드 안 배지(Pill·StateBadge)는 셀에서 빠졌다 — 출/지/결/보 상세는 아래 명단과 셀 title에서 확인한다.)

function MakeupTab({ makeups, onDecide }: { makeups: any; onDecide: (id: string, d: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Kpi n={makeups.pending?.length ?? 0} l="승인 대기" c={TONE_TEXT_CLASS.warning} />
        <Kpi n={makeups.stats?.scheduled ?? 0} l="보강 예정" c={TONE_TEXT_CLASS.info} />
        <Kpi n={makeups.stats?.attended ?? 0} l="보강 완료" c={TONE_TEXT_CLASS.success} />
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
        <div className="border-b border-[var(--color-academy-line)] px-4 py-3 text-sm font-black">🔔 학부모 보강신청 · 승인 대기</div>
        {(makeups.pending || []).map((m: any) => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 border-t border-[var(--color-academy-line)] px-4 py-3 first:border-t-0">
            <div className="min-w-[180px] flex-1">
              <div className="font-black">{m.childName} <span className="text-xs font-bold text-[var(--color-academy-muted)]">{m.childGrade || ""} · {m.offeringTitle}</span></div>
              <div className="mt-0.5 text-xs font-bold text-[var(--color-academy-muted)]">{m.absentLabel} 결석 <span className="text-[var(--brand-accent)]">→</span> {m.targetLabel || "정규수업"}</div>
            </div>
            {m.targetFilled != null && <span className="rounded-full bg-[var(--color-academy-success-soft)] px-2 py-1 text-xs font-black text-[var(--color-academy-success)]">{m.targetFilled}/{m.targetCapacity} · 여유</span>}
            <div className="flex gap-1">
              <button onClick={() => onDecide(m.id, "REJECT")} className="min-h-9 rounded-lg border border-[var(--color-academy-line)] px-3 text-xs font-black">거절</button>
              <button onClick={() => onDecide(m.id, "APPROVE")} className="min-h-9 rounded-lg bg-[var(--brand-accent)] px-3 text-xs font-black text-[var(--brand-accent-contrast)]">승인</button>
            </div>
          </div>
        ))}
        {(makeups.pending || []).length === 0 && <div className="p-6 text-center text-sm text-[var(--color-academy-faint)]">대기 중인 보강신청이 없습니다.</div>}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
        <div className="border-b border-[var(--color-academy-line)] px-4 py-3 text-sm font-black">📅 배정된 보강</div>
        <table className="w-full text-sm">
          <thead><tr className="text-[11px] uppercase text-[var(--color-academy-muted)]"><th className="p-2">학생</th><th className="p-2">원 결석</th><th className="p-2">보강</th><th className="p-2">유형</th><th className="p-2">상태</th><th className="p-2">작업</th></tr></thead>
          <tbody>
            {(makeups.assigned || []).map((m: any) => (
              <tr key={m.id} className="border-t border-[var(--color-academy-line)]">
                <td className="p-2 text-center font-bold">{m.childName}</td>
                <td className="p-2 text-center">{m.absentLabel}</td>
                <td className="p-2 text-center">{m.targetLabel}</td>
                <td className="p-2 text-center text-xs">{m.targetType === "SEASONAL" ? "특강" : "정규수업"}</td>
                <td className="p-2 text-center text-xs font-black">{({ SCHEDULED: "예정", ATTENDED: "완료", NO_SHOW: "미출석" } as any)[m.status] || m.status}</td>
                <td className="p-2 text-center">
                  <div className="flex justify-center gap-1">
                    {m.status === "SCHEDULED" && <button onClick={() => onDecide(m.id, "ATTENDED")} className="min-h-8 rounded-lg border border-[var(--color-academy-line)] px-2 text-xs font-black">출석확정</button>}
                    <button onClick={() => onDecide(m.id, "CANCEL")} className="min-h-8 rounded-lg border border-[var(--color-academy-line)] px-2 text-xs font-bold text-[var(--color-academy-danger)]">취소</button>
                  </div>
                </td>
              </tr>
            ))}
            {(makeups.assigned || []).length === 0 && <tr><td colSpan={6} className="p-6 text-center text-sm text-[var(--color-academy-faint)]">배정된 보강이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MakeupModal({ modal, onClose, onSeasonal, onRegular }: { modal: any; onClose: () => void; onSeasonal: (id: string) => void; onRegular: (c: any) => void }) {
  const a = modal.absence;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-lg overflow-auto rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-academy-line)] px-5 py-4">
          <span className="text-base font-black">🔄 보강 배정</span>
          <span className="text-xs font-bold text-[var(--color-academy-muted)]">· {a.childName} ({a.childGrade || "-"}) · {a.absentLabel} 결석</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[var(--color-academy-faint)]">✕</button>
        </div>
        <div className="p-5">
          {modal.alreadyAssigned ? (
            <div className="rounded-xl bg-[var(--color-academy-warning-soft)] p-4 text-sm font-bold text-[var(--color-academy-warning)]">이미 보강이 배정된 결석입니다.</div>
          ) : (
            <>
              <div className="mb-2 text-sm font-black">① 같은 특강의 다른 날짜 <span className="font-bold text-[var(--color-academy-muted)]">· 정원 여유 있는 날만</span></div>
              {modal.seasonalCandidates.length === 0 && <div className="mb-3 rounded-lg bg-[var(--color-academy-soft)] p-3 text-xs font-bold text-[var(--color-academy-muted)]">2개월 이내 여유 날짜가 없습니다. 아래 정규수업으로 배정하세요.</div>}
              {modal.seasonalCandidates.map((s: any) => (
                <button key={s.sessionDateId} onClick={() => onSeasonal(s.sessionDateId)}
                  className="mb-2 flex w-full items-center gap-3 rounded-xl border border-[var(--color-academy-line)] p-3 text-left hover:border-[var(--brand-accent)]">
                  <div className="font-black">{s.label}</div>
                  <div className="flex-1" />
                  <span className="rounded-full bg-[var(--color-academy-success-soft)] px-2 py-1 text-xs font-black text-[var(--color-academy-success)]">{s.filled}/{s.capacity} · 여유 {s.remaining}</span>
                </button>
              ))}

              <div className="mb-2 mt-4 text-sm font-black">② 정규수업으로 보강 <span className="font-bold text-[var(--color-academy-muted)]">· 학년 구성 비슷한 반 추천</span></div>
              {modal.regularCandidates.length === 0 && <div className="mb-2 rounded-lg bg-[var(--color-academy-soft)] p-3 text-xs font-bold text-[var(--color-academy-muted)]">추천 가능한 정규수업이 없습니다.</div>}
              {modal.regularCandidates.map((c: any) => (
                <button key={c.classId} onClick={() => onRegular(c)}
                  className="mb-2 flex w-full items-center gap-3 rounded-xl border border-[var(--color-academy-line)] p-3 text-left hover:border-[var(--brand-accent)]">
                  <div>
                    <div className="font-black">{c.nextLabel} · {c.name}{c.gradeDiff != null && <span className="ml-1 rounded bg-[var(--color-academy-success-soft)] px-1 text-[10px] font-black text-[var(--color-academy-success)]">유사학년</span>}</div>
                    <div className="mt-0.5 text-xs font-bold text-[var(--color-academy-muted)]">{c.schedule} · 담당 {c.instructor || "-"}</div>
                  </div>
                  <div className="flex-1" />
                  <span className="rounded-full bg-[var(--color-academy-soft)] px-2 py-1 text-xs font-black text-[var(--color-academy-muted)]">{c.enrolled}/{c.capacity ?? "-"}</span>
                </button>
              ))}

              <div className="mt-3 rounded-xl bg-[var(--color-academy-soft)] p-3 text-xs font-bold text-[var(--color-academy-muted)]">보강 규칙: 결석일로부터 2개월 이내(~{modal.windowEndLabel}) · 결석 1건당 보강 1건 · 정원 찬 날짜는 선택 불가.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
