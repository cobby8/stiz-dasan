"use client";

import { useRef, useState } from "react";
// 타입만 가져온다(서버 모듈 코드는 화면에 실리지 않는다).
import type { DriverAssignBoard } from "@/lib/shuttle/driverAssign";
import type { AssignLegPlan, AssignStudentPlan } from "@/lib/shuttle/driverAssignLogic";

// 「한 칸 배정」 공용 화면 — 기사님 「새 학생 배정」(/staff/shuttle/assign)과 관리자 정규배차 모달이 같이 쓴다(2026-11-05).
// ① 어디서 태울까(합류 후보·다른 요일 정류장·새 정류장) → ② 몇 번째로(순서 위·아래) → 「순서에 넣기」.
// 넣기는 두 화면 모두 같은 API(/api/staff/shuttle/assign → assignDriverCell)를 쓴다 — 새 쓰기 경로를 만들지 않는다.
// 교과서 규칙: 한 묶음에 채운 주 버튼은 하나(검정 = ink) · 상태 표시는 4px 모서리 · 누르는 칩은 알약 · 터치 44px · 글자 12px 이상.
// 색은 학원 테마 CSS 변수만 쓴다(하드코딩 색 금지).

const WEEKDAY_FULL = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
export const FAIL = "넣지 못했어요. 잠시 뒤 다시 해 주세요.";
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

// OTHER = 같은 달 다른 요일·반 정류장(그 칸엔 없음) — 그 이름·좌표로 새 정차가 정해진 자리에 들어간다.
type Choice = { kind: "JOIN"; stopIndex: number } | { kind: "INSERT"; position: number } | { kind: "OTHER"; key: string };
type JoinOption = AssignLegPlan["joinOptions"][number];
const optionChoice = (o: JoinOption): Choice => (o.otherDay ? { kind: "OTHER", key: o.key ?? "" } : { kind: "JOIN", stopIndex: o.stopIndex ?? 0 });
const sameOption = (c: Choice | null, o: JoinOption) => (o.otherDay ? c?.kind === "OTHER" && c.key === o.key : c?.kind === "JOIN" && c.stopIndex === o.stopIndex);

export function monthLabel(m: string) { return `${Number(m.slice(5, 7))}월`; }

export default function AssignLegView({ month, board, student, leg, notice, warn, onNotice, onBack, onPickLeg, onSaved, onStale, variant = "page", backLabel = "목록", source, titleId }: {
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
  /** page = 기사님 화면 한 장 · modal = 관리자 정규배차 모달(하단 시트) 안. 모양·동작은 같고 감싸는 틀만 다르다. */
  variant?: "page" | "modal";
  /** 머리의 뒤로 버튼 문구(기사님 = 목록, 관리자 모달 = 닫기). */
  backLabel?: string;
  /** 관리자 정규배차에서 넣으면 "ADMIN_DISPATCH" — 서버가 관리자 역할일 때만 감사 기록 via 로 쓴다. */
  source?: "ADMIN_DISPATCH";
  /** 모달 제목 연결용(aria-labelledby). */
  titleId?: string;
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
          ...(source ? { source } : {}), // 관리자 화면 표시(기사님 화면은 보내지 않아 요청 모양이 그대로)
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

  // ② 순서 목록 — 새로 넣을 자리(+)를 끼워 보여 준다. 합류면 그 정류장 바로 뒤, 다른 요일 정류장이면 서버가 정한 자리, 새 정류장이면 고른 자리.
  const otherOpt = choice?.kind === "OTHER" ? leg.joinOptions.find((o) => sameOption(choice, o)) ?? null : null;
  const plusAt = choice?.kind === "JOIN" ? choice.stopIndex + 1 : otherOpt ? otherOpt.position ?? n : position;
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
      : { no: "+", stop: `${student.name} 새 정류장`, riders: `${otherOpt ? otherOpt.label : leg.newStop?.name ?? ""} · 새로 넣을 자리`, mine: true };
  }
  const endRow = leg.direction === "BOARD" ? `학원 도착 · ${leg.startTime} 수업` : null;
  const startRow = leg.direction === "ALIGHT" ? "학원 출발" : null;

  const radio = (active: boolean) => `flex min-h-11 w-full min-w-0 items-start gap-3 rounded-lg bg-[var(--color-academy-surface)] p-3 text-left ${active ? "border-2 border-[var(--color-academy-ink)]" : "border border-[var(--color-academy-line)]"}`;

  // 페이지에선 main, 모달 안에선 div(한 화면에 main 은 하나여야 한다).
  const Root = variant === "modal" ? "div" : "main";
  const Title = variant === "modal" ? "h2" : "h1";
  return (
    <Root className="mx-auto w-full min-w-0 max-w-lg text-[var(--color-academy-ink)]">
      <header className="space-y-2 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-3">
        <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--color-academy-muted)]">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">{variant === "modal" ? "close" : "chevron_left"}</span>{backLabel}
        </button>
        <div className="min-w-0">
          <Title id={titleId} className="break-keep text-xl font-bold">{student.name} · {leg.label}</Title>
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
              const active = sameOption(choice, o);
              return (
                <button key={o.key ?? `i${o.stopIndex}`} type="button" role="radio" aria-checked={active} disabled={saving} onClick={() => setChoice(optionChoice(o))} className={radio(active)}>
                  <Dot active={active} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-words text-sm font-bold">{o.label}
                      {o.recommended && <span className="ml-1 rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-px text-xs font-medium text-[var(--color-academy-primary)]">추천</span>}
                    </span>
                    <span className="text-xs text-[var(--color-academy-muted)]">
                      {o.otherDay ? "다른 요일 정류장" : "지금 서는 정류장"}{o.distanceMeters != null ? ` · 학생 위치에서 약 ${o.distanceMeters}m` : ""}{o.otherDay ? "" : ` · 이미 ${o.riders}명`}
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
          {choice?.kind === "OTHER" && <p className="text-xs text-[var(--color-academy-muted)]">다른 요일 정류장은 운행 거리가 가장 적게 늘어나는 자리에 들어가요.</p>}
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
    </Root>
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
