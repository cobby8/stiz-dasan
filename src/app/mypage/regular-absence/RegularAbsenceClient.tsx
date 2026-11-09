"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { UpcomingChild, UpcomingClassDate } from "@/lib/regular/parent-regular-absence";
import type { RegularMakeupRow } from "@/lib/regular/parent-regular-makeup";
import { groupByUpcomingDate } from "@/components/admin/list/upcomingDateGroups";
import { todayKst } from "@/lib/datetime/kst";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { presetFirst } from "@/lib/mypage/requestPreset";

// 날짜 묶음 이름 — 가까운 수업일이 먼저 보이게(오늘 → 이번 주 → 다음 주 → 이후)
const DATE_GROUP_LABELS = { today: "오늘", thisWeek: "이번 주", nextWeek: "다음 주", later: "이후", past: "지난 수업" };

// 결석 사유 선택지(정규 5종). 방학특강과 동일 집합.
const REASONS: { value: string; label: string }[] = [
  { value: "ILLNESS_INJURY", label: "질병/부상" },
  { value: "PERSONAL", label: "개인 사정" },
  { value: "FAMILY_TRIP", label: "가족 여행" },
  { value: "SCHOOL_EVENT", label: "학교 행사" },
  { value: "ETC", label: "기타" },
];

// 결석 신고의 보강권 상태 → 행에 붙는 짧은 글(2026-11-10: 신고 즉시 보강권 발급)
const CREDIT_NOTE: Record<string, string> = {
  AVAILABLE: "보강권 1장",
  RESERVED: "보강 예약됨",
  USED: "보강 완료",
  NO_SHOW: "보강 불참",
};

// 이미 보강을 들었거나(무단 불참 포함) — 신고 취소를 막는 상태(서버도 같은 규칙으로 막는다)
function creditBlocksCancel(d: UpcomingClassDate) {
  return d.makeupCredit === "USED" || d.makeupCredit === "NO_SHOW";
}

// 다가오는 날짜 하나를 나타내는 카드용 키(자녀·반·날짜 조합).
function dateKey(d: UpcomingClassDate) {
  return `${d.studentId}|${d.classId}|${d.date}`;
}

export default function RegularAbsenceClient({
  initial,
  makeups = [],
  presetStudentId = null,
}: {
  initial: UpcomingChild[];
  makeups?: RegularMakeupRow[];
  /** 수업 탭 반 카드에서 온 아이 — 그 아이 날짜를 맨 위에(나머지 순서는 그대로) */
  presetStudentId?: string | null;
}) {
  const [children, setChildren] = useState<UpcomingChild[]>(initial);
  const [openKey, setOpenKey] = useState<string>(""); // 신고 폼이 열린 날짜 키
  const [reason, setReason] = useState<Record<string, string>>({}); // 날짜별 선택 사유
  const [busyKey, setBusyKey] = useState<string>("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  // 서버에서 최신 상태 재조회.
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/mypage/regular-absence", { cache: "no-store" });
      const j = await r.json();
      if (r.ok) setChildren(j.children || []);
    } catch {
      /* noop */
    }
  }, []);

  // 결석 신고.
  const report = useCallback(
    async (d: UpcomingClassDate) => {
      const key = dateKey(d);
      const r = reason[key];
      if (!r) {
        setErr("결석 사유를 선택해 주세요.");
        return;
      }
      setErr("");
      setMsg("");
      setBusyKey(key);
      try {
        const res = await fetch("/api/mypage/regular-absence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId: d.studentId,
            classId: d.classId,
            date: d.date,
            reason: r,
          }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || "신고에 실패했습니다.");
        // 신고 즉시 보강권이 나갔으면 그 사실을 한 줄로 알린다
        setMsg(j?.makeupCreditIssued ? "결석을 신고했어요. 보강권 1장이 생겼어요." : "결석을 신고했어요. 학원에서 확인합니다.");
        setOpenKey("");
        await reload();
      } catch (e) {
        setErr(customerMessage(e, "결석 신고를 접수하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      } finally {
        setBusyKey("");
      }
    },
    [reason, reload],
  );

  // 결석 신고 취소.
  const cancel = useCallback(
    async (d: UpcomingClassDate) => {
      const key = dateKey(d);
      setErr("");
      setMsg("");
      setBusyKey(key);
      try {
        const res = await fetch("/api/mypage/regular-absence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            studentId: d.studentId,
            classId: d.classId,
            date: d.date,
            // 보강 예약이 있는 결석은 확인 문구(«보강 예약도 함께 취소돼요»)를 보고 누른 것이므로 함께 취소를 허락한다
            confirmMakeupCancel: d.makeupCredit === "RESERVED",
          }),
        });
        const j = await res.json();
        if (!res.ok) {
          // 화면을 연 뒤 보강 예약이 생긴 경우 — 최신 상태를 다시 읽어 «보강 예약도 함께 취소돼요» 확인 문구가 뜨게 한다
          if (j?.code === "MAKEUP_BOOKING_CONFIRM_REQUIRED") await reload();
          throw new Error(j?.error || "취소에 실패했습니다.");
        }
        setMsg(
          j?.makeupBookingCanceled
            ? "결석 신고와 보강 예약을 취소했어요."
            : j?.makeupCreditRevoked
              ? "결석 신고를 취소했어요. 보강권도 함께 회수됐어요."
              : "결석 신고를 취소했어요.",
        );
        await reload();
      } catch (e) {
        setErr(customerMessage(e, "결석 신고를 취소하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      } finally {
        setBusyKey("");
      }
    },
    [reload],
  );

  const hasAnyClass = useMemo(
    () => children.some((c) => c.classes.some((cl) => cl.dates.length > 0)),
    [children],
  );

  // 자녀별로 반을 펼쳐 수업일 하나하나를 날짜 묶음에 넣는다(반 카드 안의 작은 카드 → 날짜별 한 줄 행).
  // 오늘은 KST 모듈로만 구한다.
  const childGroups = useMemo(() => {
    const today = todayKst();
    return presetFirst(children, presetStudentId, (child) => child.studentId)
      .map((child) => ({
        studentId: child.studentId,
        studentName: child.studentName,
        groups: groupByUpcomingDate(child.classes.flatMap((cl) => cl.dates), (d) => d.date, today, DATE_GROUP_LABELS),
      }))
      .filter((child) => child.groups.length > 0);
  }, [children, presetStudentId]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* 헤더 */}
      <div className="mb-2 flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href="/mypage" aria-label="마이페이지로" className="academy-back-link">
          <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-black text-[var(--color-academy-ink)]">
          <span className="material-symbols-outlined text-[var(--color-academy-ink)]">event_busy</span>
          정규수업 결석 신고
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        신고한 결석은 선생님과 기사님에게 표시됩니다.
      </p>

      {/* 예정 보강(읽기 전용) — 관리자가 지정한 자녀의 보강 일정 */}
      {makeups.length > 0 && (
        <div className="mb-4 rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)] p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-black text-[var(--color-academy-info)]">
            <span className="material-symbols-outlined text-lg">event_repeat</span>
            예정 보강
          </h2>
          <ul className="divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-xl bg-white">
            {makeups.map((m) => (
              // 한 줄 행: 학생 · 보강 반(줄바꿈 허용) · 보강 날짜(오른쪽) · 상태 / 아래 줄에 원래 결석
              <li key={m.id} className="px-3 py-2">
                <div className="flex min-h-7 items-center gap-2">
                  <span className="shrink-0 text-sm font-black text-[var(--color-academy-ink)]">{m.studentName}</span>
                  <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-muted)]">{m.makeupClassName ?? "보강 반"}</span>
                  {m.makeupDateLabel && (
                    <span className="shrink-0 text-right text-sm font-bold tabular-nums text-[var(--color-academy-ink)]">{m.makeupDateLabel}</span>
                  )}
                  <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-info)]">
                    {m.statusLabel}
                  </span>
                </div>
                {(m.originalClassName || m.originalDateLabel) && (
                  <p className="text-xs text-[var(--color-academy-faint)]">
                    (결석: {m.originalClassName ?? ""}
                    {m.originalDateLabel ? ` ${m.originalDateLabel}` : ""})
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[var(--color-academy-muted)]">
            보강 일정은 학원에서 지정합니다. 변경이 필요하면 학원으로 문의해 주세요.
          </p>
        </div>
      )}

      {msg && (
        <div className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] px-4 py-3 text-sm font-bold text-[var(--color-academy-success)]">
          {msg}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm font-bold text-[var(--color-academy-danger)]">
          {err}
        </div>
      )}

      {!hasAnyClass ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-academy-line-input)] bg-white px-6 py-16 text-center text-sm text-[var(--color-academy-muted)]">
          다가오는 정규수업이 없습니다.
        </div>
      ) : (
        <div className="space-y-5">
          {childGroups.map((child) => (
            <div key={child.studentId}>
              <h2 className="mb-2 px-1 text-sm font-black text-[var(--color-academy-ink)]">{child.studentName}</h2>
              <div className="space-y-3">
                {child.groups.map((group) => (
                  // 날짜 묶음(오늘/이번 주/다음 주/이후) — 묶음 제목 오른쪽에 건수
                  <section
                    key={group.key}
                    aria-label={`${child.studentName} ${group.label}`}
                    className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white"
                  >
                    <h3 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)]">
                      <span>{group.label}</span>
                      <span className="tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
                    </h3>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                      {group.items.map((d) => {
                        const key = dateKey(d);
                        const busy = busyKey === key;
                        return (
                          <li key={key} className="px-3 py-1.5">
                            {/* 한 줄 행: 반·시각(왼쪽, 줄바꿈 허용) · 날짜(오른쪽, 숫자 폭 고정) · 동작 버튼 */}
                            <div className="flex min-h-11 flex-wrap items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="break-keep text-sm font-bold text-[var(--color-academy-ink)]">
                                  {d.className}
                                  <span className="ml-1.5 text-xs font-normal tabular-nums text-[var(--color-academy-faint)]">{d.startTime}</span>
                                </p>
                                {/* 상태 배지와 사유를 따로 나눠 보인다(«확정됨 · 사유» 이어 붙이지 않음) */}
                                {d.locked ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-success)]">
                                      <span className="material-symbols-outlined text-sm">check_circle</span>
                                      확정됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{d.reasonLabel}</span>}
                                    <span className="text-xs text-[var(--color-academy-faint)]">학원 확정 (변경은 문의)</span>
                                  </p>
                                ) : d.reported ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-warning)]">
                                      결석 신고됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{d.reasonLabel}</span>}
                                    {/* 신고 즉시 발급된 보강권 상태(짧게) */}
                                    {d.makeupCredit && CREDIT_NOTE[d.makeupCredit] && (
                                      <span className="text-xs font-bold text-[var(--color-academy-info)]">{CREDIT_NOTE[d.makeupCredit]}</span>
                                    )}
                                  </p>
                                ) : null}
                              </div>
                              <span className="shrink-0 text-right text-sm font-bold tabular-nums text-[var(--color-academy-ink)]">{d.dateLabel}</span>

                              {/* 액션 — 기존과 같은 조건·같은 함수(신고 취소 / 결석 신고 폼 열기) */}
                              {d.locked ? null : d.reported && creditBlocksCancel(d) ? (
                                // 이미 그 결석의 보강을 들었다 — 신고 취소 불가(서버도 막는다)
                                <span className="basis-full text-xs text-[var(--color-academy-muted)]">보강을 이미 들어 취소할 수 없어요 (학원 문의)</span>
                              ) : d.reported ? (
                                // 신고 취소 = 그 자리 확인(C-M1) 후 기존 cancel(d) 그대로
                                <InlineConfirm
                                  label="신고 취소"
                                  question={d.makeupCredit === "RESERVED" ? "보강 예약도 함께 취소돼요. 이 결석 신고를 취소할까요?" : "이 결석 신고를 취소할까요?"}
                                  confirmLabel="신고 취소하기"
                                  onConfirm={() => cancel(d)}
                                  pending={busy}
                                  openClassName="basis-full"
                                />
                              ) : openKey === key ? null : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey(key)}
                                  // 행의 «여는» 버튼 = 옅은 바탕(tonal). 꽉 찬 색은 폼 안 «신고하기»만(M-08)
                                  className="academy-button-tonal shrink-0"
                                >
                                  결석 신고
                                </button>
                              )}
                            </div>

                            {/* 신고 폼(사유 선택) — 기존 그대로: 사유 고르고 «신고하기» */}
                            {openKey === key && !d.reported && (
                              <div className="mb-1.5 mt-1 flex flex-wrap items-center gap-2">
                                <select
                                  value={reason[key] || ""}
                                  onChange={(e) => setReason((prev) => ({ ...prev, [key]: e.target.value }))}
                                  className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-white px-2 text-sm font-bold text-[var(--color-academy-ink)]"
                                  aria-label="결석 사유"
                                >
                                  <option value="">사유 선택</option>
                                  {REASONS.map((r) => (
                                    <option key={r.value} value={r.value}>
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => report(d)}
                                  className="academy-button-primary"
                                >
                                  신고하기
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey("")}
                                  className="academy-button-text"
                                >
                                  닫기
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
