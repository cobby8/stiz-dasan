"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// 타입만 가져온다(서버 모듈 코드는 화면에 실리지 않는다).
import type { DriverAssignBoard } from "@/lib/shuttle/driverAssign";
import type { ShuttleIntakeDashboard, ShuttleIntakeItem } from "@/lib/enrollment/shuttle-review-types";
import AssignLegView from "./AssignLegView";
import { REVIEW_LABELS } from "@/components/shuttle/intake/ShuttleIntakeClient";

// 관리자 정규배차 화면의 「신규 배차 학생」 한 줄 요약 + 펼침 목록 + 한 칸 배정 모달(2026-11-05 원장 지시).
// 「신규 셔틀 신청」 탭을 따로 두지 않고, 정규배차 화면에서 새 학생을 보고 바로 순서에 넣는다.
//  - 목록 기준 = 기사님 「새 학생 배정」과 같은 getDriverAssignBoard(승인된 셔틀 신청 + 아직 운행표에 없는 칸이 남은 학생).
//    그래서 「배차 완료인데 재검토 필요」처럼 모순된 줄이 생기지 않는다(다 넣은 학생은 목록에서 빠진다).
//  - 넣기 = 기사님 화면과 같은 공용 AssignLegView · 같은 API(/api/staff/shuttle/assign). 관리자도 권한을 통과한다.
//  - 기사 검토 요청 = 기존 /api/admin/shuttle/intake(POST) 그대로. 새 쓰기 경로를 만들지 않는다.
// 이 패널은 조회·넣기만 한다. 아래 회차 카드(RouteSection) 새로고침 여부는 부모(onAssigned)가 정한다.

const ASSIGN_API = "/api/staff/shuttle/assign";
const INTAKE_API = "/api/admin/shuttle/intake";
// 기사 검토 상태는 화면 보조 정보라 몇 쪽(1쪽 50명)만 읽는다. 못 읽어도 배정은 된다.
const MAX_INTAKE_PAGES = 4;
const CHIP = "inline-flex min-h-11 items-center rounded-full border px-3 text-sm";
const BUTTON = "inline-flex min-h-11 items-center justify-center gap-1 rounded-full border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold disabled:opacity-50";

type Target = { studentId: string; legKey: string };
type Driver = { id: string; name: string };

export default function NewStudentDispatchPanel({ month, selectedWeekday, onAssigned }: {
  month: string;
  /** 지금 고른 요일(0=일 ~ 6=토). 그 요일 칸을 강조한다. */
  selectedWeekday: number | null;
  /** 한 칸을 넣은 직후 — 부모가 아래 회차 카드를 다시 불러올지 정한다(저장 안 한 편집이 있으면 덮지 않음). */
  onAssigned: () => void;
}) {
  const [board, setBoard] = useState<DriverAssignBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [notice, setNotice] = useState("");
  const [warn, setWarn] = useState("");
  const [intake, setIntake] = useState<Map<string, ShuttleIntakeItem>>(new Map());
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const seq = useRef(0);
  const intakeSeq = useRef(0);
  // 지금 열린 모달(학생·칸) — 저장이 끝났을 때 「그 학생 모달이 아직 열려 있나」를 본다.
  // 저장 중에 닫았거나 다른 학생 칩을 열었으면 그 모달을 앞 학생의 다음 칸으로 바꾸지 않는다.
  const targetRef = useRef<Target | null>(null);
  useEffect(() => { targetRef.current = target; }, [target]);

  // 남은 칸 목록(다시) 읽기 — 기사님 화면과 같은 API. 결과를 돌려줘 저장 직후 「다음 남은 칸」을 고른다.
  const load = useCallback(async (): Promise<DriverAssignBoard | null> => {
    const current = ++seq.current;
    setLoading(true); setLoadError(false);
    try {
      const res = await fetch(`${ASSIGN_API}?month=${encodeURIComponent(month)}`, { cache: "no-store" });
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

  // 기사 검토 상태(intake) — 학생 ID 로 짝을 맞춘다. 실패하면 배지만 안 보인다(배정은 그대로).
  const loadIntake = useCallback(async () => {
    const current = ++intakeSeq.current;
    try {
      const map = new Map<string, ShuttleIntakeItem>();
      let list: Driver[] = [];
      for (let page = 1; page <= MAX_INTAKE_PAGES; page++) {
        const res = await fetch(`${INTAKE_API}?month=${encodeURIComponent(month)}&page=${page}`, { cache: "no-store" });
        const value = (await res.json().catch(() => null)) as ShuttleIntakeDashboard | null;
        if (!res.ok || !Array.isArray(value?.items)) break;
        // 최근 신청이 먼저 온다 — 같은 학생은 처음 본 것(최근)만 쓴다.
        for (const item of value.items) if (!map.has(item.studentId)) map.set(item.studentId, item);
        if (value.drivers) list = value.drivers;
        if (!value.hasMore) break;
      }
      if (current === intakeSeq.current) { setIntake(map); setDrivers(list); }
    } catch { /* 보조 정보라 조용히 넘어간다 */ }
  }, [month]);

  // 월이 바뀌면 부모가 key 로 이 패널을 새로 그린다(모달·안내 초기화). 여기선 읽기만 한다.
  useEffect(() => { void load(); void loadIntake(); }, [load, loadIntake]);

  // 모달은 Esc 로도 닫는다.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTarget(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  const students = board?.students ?? [];
  const student = target ? students.find((s) => s.studentId === target.studentId) ?? null : null;
  const leg = student && target ? student.legs.find((l) => l.key === target.legKey) ?? student.legs[0] ?? null : null;
  const dayLegCount = selectedWeekday == null ? 0 : students.reduce((n, s) => n + s.legs.filter((l) => l.weekday === selectedWeekday).length, 0);

  // 저장 성공 → 부모에 알림(회차 카드) → 목록 다시 읽기 → 같은 학생의 다음 남은 칸, 없으면 모달 닫기.
  // 단 「지금 열린 모달 = 저장한 학생」일 때만 모달을 움직인다(닫혔으면 그대로, 다른 학생 모달이면 건드리지 않음).
  async function afterSaved(studentId: string, studentName: string, doneLabel: string) {
    setWarn("");
    onAssigned();
    const next = await load();
    const s = next?.students.find((x) => x.studentId === studentId);
    const stillHere = targetRef.current?.studentId === studentId;
    // 다른 학생 모달이 열려 있으면 안내에 이름을 붙여 헷갈리지 않게 한다.
    const who = stillHere ? "" : `${studentName} `;
    if (s && s.legs.length > 0) {
      setNotice(`${who}${doneLabel}에 넣었어요`);
      if (stillHere) setTarget({ studentId, legKey: s.legs[0].key });
    } else {
      setNotice(`${who}${doneLabel}에 넣었어요 · 이 학생은 모두 넣었어요`);
      if (stillHere) setTarget(null);
    }
  }

  function openLeg(studentId: string, legKey: string) { setNotice(""); setWarn(""); setTarget({ studentId, legKey }); }

  return (
    <section className="mt-3 text-[var(--color-academy-ink)]" aria-label="신규 배차 학생">
      {/* 한 줄 요약 — 0명이면 작은 글씨 한 줄로만 남긴다(공간 낭비 최소화). */}
      {loading && !board && <p role="status" className="text-xs text-[var(--color-academy-muted)]">신규 배차 학생 확인 중…</p>}
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-academy-muted)]">
          <span>신규 배차 학생을 불러오지 못했어요.</span>
          <button type="button" onClick={() => void load()} className={BUTTON}>
            <span className="material-symbols-outlined text-lg" aria-hidden="true">refresh</span>다시 시도
          </button>
        </div>
      )}
      {board && !loadError && students.length === 0 && (
        <p className="text-xs text-[var(--color-academy-muted)]">신규 배차 학생 없음</p>
      )}
      {board && students.length > 0 && (
        <button type="button" aria-expanded={expanded} aria-controls="new-student-dispatch-list" onClick={() => setExpanded((v) => !v)}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-left text-sm">
          <span className="material-symbols-outlined text-lg text-[var(--color-academy-primary)]" aria-hidden="true">person_add</span>
          <b>신규 배차 학생 {students.length}명</b>
          <span className="text-[var(--color-academy-muted)]">· 남은 칸 <b className="text-[var(--color-academy-warning)]">{board.openLegCount}</b></span>
          {selectedWeekday != null && dayLegCount > 0 && <span className="text-[var(--color-academy-muted)]">· 이 요일 {dayLegCount}칸</span>}
          <span className="material-symbols-outlined ml-auto text-lg text-[var(--color-academy-muted)]" aria-hidden="true">{expanded ? "expand_less" : "expand_more"}</span>
        </button>
      )}
      {notice && !target && <p role="status" className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-success)]">{notice}</p>}

      {/* 펼침 목록 — 학생 한 명 = 한 줄(좁은 화면에선 줄바꿈). 칩을 누르면 그 칸을 넣는 모달이 뜬다. */}
      {expanded && students.length > 0 && (
        <ul id="new-student-dispatch-list" className="mt-2 overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {students.map((s, i) => {
            const item = intake.get(s.studentId) ?? null;
            return (
              <li key={s.studentId} className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 ${i === 0 ? "" : "border-t border-[var(--color-academy-line)]"}`}>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <b className="break-keep text-sm">{s.name}</b>
                  {s.grade && <span className="text-xs text-[var(--color-academy-muted)]">{s.grade}</span>}
                </span>
                <span className="min-w-0 break-keep text-xs">{s.classes || "수업 확인 필요"}</span>
                <span className="text-xs text-[var(--color-academy-muted)]">희망 {s.wishTime || "없음"}</span>
                <span className="flex flex-wrap gap-1.5" aria-label={`${s.name} 남은 칸`}>
                  {s.legs.map((l) => {
                    // 지금 고른 요일의 칸은 진하게(검정 테두리 + 연한 강조 바탕) — 그 요일 회차 카드와 같이 보며 넣게.
                    const today = l.weekday === selectedWeekday;
                    return (
                      <button key={l.key} type="button" onClick={() => openLeg(s.studentId, l.key)} aria-label={`${s.name} ${l.label} 순서에 넣기`}
                        className={`${CHIP} ${today ? "border-2 border-[var(--color-academy-ink)] bg-[var(--color-academy-primary-soft)] font-bold" : "border-dashed border-[var(--color-academy-muted)] bg-[var(--color-academy-surface)] text-[var(--color-academy-muted)]"}`}>
                        {l.label}
                      </button>
                    );
                  })}
                </span>
                {item && <ReviewRequest item={item} month={month} drivers={drivers} onDone={() => void loadIntake()} />}
              </li>
            );
          })}
        </ul>
      )}

      {/* 한 칸 배정 모달 — 모바일은 하단 시트, 넓은 화면은 가운데. 안의 화면은 기사님과 같은 공용 컴포넌트. */}
      {target && student && leg && board && (
        <div role="dialog" aria-modal="true" aria-labelledby="new-student-assign-title" onClick={() => setTarget(null)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-[color-mix(in_srgb,var(--color-academy-ink)_45%,transparent)] sm:items-center sm:p-4">
          <div onClick={(e) => e.stopPropagation()}
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-2xl bg-[var(--color-academy-canvas)] pb-[env(safe-area-inset-bottom)] sm:rounded-2xl">
            <AssignLegView key={`${student.studentId}:${leg.key}:${leg.routeVersion}`} variant="modal" backLabel="닫기" source="ADMIN_DISPATCH" titleId="new-student-assign-title"
              month={month} board={board} student={student} leg={leg}
              notice={notice} warn={warn} onNotice={(v) => { setNotice(v); setWarn(""); }}
              onBack={() => { setNotice(""); setWarn(""); setTarget(null); }}
              onPickLeg={(legKey) => openLeg(student.studentId, legKey)}
              onSaved={(label) => afterSaved(student.studentId, student.name, label)}
              onStale={(message) => { setWarn(message); void load(); }} />
          </div>
        </div>
      )}
    </section>
  );
}

// 기사 검토 상태 배지 + 「기사 검토 요청」 — 기존 관리자 intake API(POST) 그대로 쓴다.
function ReviewRequest({ item, month, drivers, onDone }: { item: ShuttleIntakeItem; month: string; drivers: Driver[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [driverId, setDriverId] = useState(item.review?.driverUserId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const lock = useRef(false);
  const review = item.review;
  const chosen = drivers.some((d) => d.id === driverId) ? driverId : "";

  async function submit() {
    if (lock.current) return;
    if (!chosen) { setError("검토할 기사님을 선택해 주세요."); return; }
    lock.current = true; setBusy(true); setError(""); setDone("");
    try {
      const res = await fetch(INTAKE_API, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId: item.applicationId, serviceMonth: month, driverUserId: chosen, expectedFingerprint: item.fingerprint }),
      });
      const value = await res.json().catch(() => null);
      if (!res.ok || !value?.ok) throw new Error(value?.error || "검토 요청을 보내지 못했습니다. 다시 시도해 주세요.");
      setOpen(false); setDone("검토를 요청했어요");
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "검토 요청을 보내지 못했습니다.");
    } finally { lock.current = false; setBusy(false); }
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 sm:ml-auto">
      {/* 상태 표시 = 4px 모서리(누르는 칩과 모양을 다르게). 기사 의견은 마우스를 올리면 전문이 보인다. */}
      {review && <span title={review.note ?? undefined} className="rounded bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs font-bold">{REVIEW_LABELS[review.status]}{review.driverName ? ` · ${review.driverName}` : ""}</span>}
      {!open && <button type="button" className={BUTTON} onClick={() => { setOpen(true); setDone(""); }}>{review ? "다시 검토 요청" : "기사 검토 요청"}</button>}
      {open && (
        <>
          <select aria-label={`${item.studentName} 검토 담당 기사`} value={chosen} disabled={busy} onChange={(e) => setDriverId(e.target.value)}
            className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-sm">
            <option value="">기사님 선택</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button type="button" className={BUTTON} disabled={busy || drivers.length === 0} onClick={() => void submit()}>{busy ? "요청 중…" : "요청 보내기"}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => { setOpen(false); setError(""); }}>취소</button>
        </>
      )}
      {review?.note && <span className="w-full break-words text-xs text-[var(--color-academy-muted)]">기사님 의견: {review.note}</span>}
      {done && <span role="status" className="text-xs font-bold text-[var(--color-academy-success)]">{done}</span>}
      {error && <span role="alert" className="w-full break-words text-xs font-bold text-[var(--color-academy-danger)]">{error}</span>}
    </span>
  );
}
