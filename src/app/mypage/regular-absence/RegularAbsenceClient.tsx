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
// AVAILABLE(보강권 1장)은 글자가 아니라 «보강 예약하기» 버튼으로 보인다(2026-11-14 — 보강 화면으로 바로 이어지게)
const CREDIT_NOTE: Record<string, string> = {
  RESERVED: "보강 예약됨",
  USED: "보강 완료",
  NO_SHOW: "보강 불참",
};

// 이미 보강을 들었거나(무단 불참 포함) — 신고 취소를 막는 상태(서버도 같은 규칙으로 막는다)
function creditBlocksCancel(d: UpcomingClassDate) {
  return d.makeupCredit === "USED" || d.makeupCredit === "NO_SHOW";
}

// 수업 시작 1시간 전이 지난 줄에 보이는 글 — 서버 오류 문구(regularAbsenceRules.ABSENCE_CHANGE_CLOSED_MESSAGE)와 같은 글
const CHANGE_CLOSED_TEXT = "수업 1시간 전이 지나 여기서 바꿀 수 없습니다. 학원으로 연락해 주세요.";

// 지금 신고·취소·사유 변경을 받을 수 있는 줄인가(서버가 준 값 — 서버도 같은 규칙으로 다시 막는다).
// 값이 없으면(옛 응답) 열린 것으로 본다: 막는 쪽은 서버다.
function changeOpen(d: UpcomingClassDate) {
  return d.changeOpen !== false;
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

  // 결석 신고 · 사유 변경(신고된 줄에서 다른 사유로 다시 보내면 서버가 사유만 바꾼다 — 보강권은 다시 생기지 않는다).
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
        if (!res.ok) {
          // 화면을 연 뒤 마감(수업 1시간 전)이 지난 경우 — 다시 읽어 그 줄이 «학원으로 연락» 글로 바뀌게 한다
          if (j?.code === "ABSENCE_CHANGE_CLOSED") await reload();
          throw new Error(j?.error || "신고에 실패했습니다.");
        }
        // 사유 변경이면 그 사실만, 새 신고면 보강권이 나갔는지를 한 줄로 알린다
        setMsg(
          d.reported
            ? "결석 사유를 바꿨어요."
            : j?.makeupCreditIssued
              ? "결석을 신고했어요. 보강권 1장이 생겼어요."
              : "결석을 신고했어요. 학원에서 확인합니다.",
        );
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
          // 화면을 연 뒤 마감(수업 1시간 전)이 지난 경우도 다시 읽는다
          if (j?.code === "ABSENCE_CHANGE_CLOSED") await reload();
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
          <span aria-hidden="true">←</span>
        </Link>
        <h1 className="academy-heading">
          정규수업 결석 신고
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        신고한 결석은 선생님과 기사님에게 표시됩니다. 신고·취소·사유 변경은 수업 시작 1시간 전까지 할 수 있습니다.
      </p>

      {/* 예정 보강(읽기 전용) — 관리자가 지정한 자녀의 보강 일정 */}
      {makeups.length > 0 && (
        <div className="mb-4 rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)] p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-academy-info)]">
            예정 보강
          </h2>
          <ul className="divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-xl bg-white">
            {makeups.map((m) => (
              // 한 줄 행: 학생 · 보강 반(줄바꿈 허용) · 보강 날짜(오른쪽) · 상태 / 아래 줄에 원래 결석
              <li key={m.id} className="px-3 py-2">
                <div className="flex min-h-7 items-center gap-2">
                  <span className="shrink-0 text-sm font-semibold text-[var(--color-academy-ink)]">{m.studentName}</span>
                  <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-muted)]">{m.makeupClassName ?? "보강 반"}</span>
                  {m.makeupDateLabel && (
                    <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{m.makeupDateLabel}</span>
                  )}
                  <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">
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
            보강권으로 비슷한 학년 반의 빈자리를 골라 예약할 수 있습니다.
          </p>
        </div>
      )}

      {msg && (
        <div className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] px-4 py-3 text-sm font-medium text-[var(--color-academy-success)]">
          {msg}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm font-medium text-[var(--color-academy-danger)]">
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
              <h2 className="mb-2 px-1 text-sm font-semibold text-[var(--color-academy-ink)]">{child.studentName}</h2>
              <div className="space-y-3">
                {child.groups.map((group) => (
                  // 날짜 묶음(오늘/이번 주/다음 주/이후) — 묶음 제목 오른쪽에 건수
                  <section
                    key={group.key}
                    aria-label={`${child.studentName} ${group.label}`}
                    className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white"
                  >
                    <h3 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--color-academy-ink)]">
                      <span>{group.label}</span>
                      <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
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
                                <p className="break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                                  {d.className}
                                  <span className="ml-1.5 text-xs font-normal tabular-nums text-[var(--color-academy-faint)]">{d.startTime}</span>
                                </p>
                                {/* 상태 배지와 사유를 따로 나눠 보인다(«확정됨 · 사유» 이어 붙이지 않음) */}
                                {d.locked ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-success)]">
                                      확정됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{d.reasonLabel}</span>}
                                    <span className="text-xs text-[var(--color-academy-faint)]">학원 확정 (변경은 문의)</span>
                                  </p>
                                ) : d.reported ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-warning)]">
                                      결석 신고됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{d.reasonLabel}</span>}
                                    {/* 보강권 상태(짧게) — 사용 가능(AVAILABLE)은 아래 «보강 예약하기» 버튼으로 보인다 */}
                                    {d.makeupCredit && CREDIT_NOTE[d.makeupCredit] && (
                                      <span className="text-xs text-[var(--color-academy-info)]">{CREDIT_NOTE[d.makeupCredit]}</span>
                                    )}
                                  </p>
                                ) : null}
                              </div>
                              <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{d.dateLabel}</span>

                              {/* 동작 버튼은 한 묶음으로 다음 줄에 — 좁은 화면(360px)에서 반 이름 칸이 눌리지 않게(2026-11-14 검수) */}
                              <div className="flex basis-full flex-wrap items-center justify-end gap-2">
                              {/* 보강권이 있으면 보강 예약 화면으로(그 아이 보강권이 맨 위에 오게 studentId 를 붙인다).
                                  마감·확정과 상관없이 보인다 — 보강권은 결석 신고를 못 바꿔도 쓸 수 있다 */}
                              {d.reported && d.makeupCredit === "AVAILABLE" && (
                                <Link
                                  href={`/mypage/makeup?studentId=${encodeURIComponent(d.studentId)}`}
                                  className="academy-button-tonal shrink-0"
                                >
                                  보강 예약하기
                                </Link>
                              )}

                              {/* 액션 — 신고 취소 · 사유 변경 / 결석 신고 폼 열기. 수업 1시간 전이 지나면 글로 바뀐다 */}
                              {d.locked ? null : !changeOpen(d) ? (
                                // 마감 뒤 — 버튼 대신 안내 글(서버도 같은 규칙으로 막는다)
                                <span className="basis-full text-xs text-[var(--color-academy-muted)]">{CHANGE_CLOSED_TEXT}</span>
                              ) : d.reported && creditBlocksCancel(d) ? (
                                // 이미 그 결석의 보강을 들었다 — 신고 취소 불가(서버도 막는다)
                                <span className="basis-full text-xs text-[var(--color-academy-muted)]">보강을 이미 들어 취소할 수 없어요 (학원 문의)</span>
                              ) : d.reported ? (
                                <>
                                  {/* 사유 변경 = 아래 사유 칸을 지금 사유로 채워 연다(글자 버튼 — 꽉 찬 색은 폼 안 최종 버튼만) */}
                                  {openKey !== key && (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => {
                                        setReason((prev) => ({ ...prev, [key]: d.reason || "" }));
                                        setOpenKey(key);
                                      }}
                                      className="academy-button-text shrink-0"
                                    >
                                      사유 변경
                                    </button>
                                  )}
                                  {/* 신고 취소 = 그 자리 확인(C-M1) 후 기존 cancel(d) 그대로 */}
                                  <InlineConfirm
                                    label="신고 취소"
                                    question={d.makeupCredit === "RESERVED" ? "보강 예약도 함께 취소돼요. 이 결석 신고를 취소할까요?" : "이 결석 신고를 취소할까요?"}
                                    confirmLabel="신고 취소하기"
                                    onConfirm={() => cancel(d)}
                                    pending={busy}
                                    openClassName="basis-full"
                                  />
                                </>
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
                            </div>

                            {/* 사유 칸 — 새 신고: 사유 고르고 «신고하기» / 신고된 줄: 다른 사유를 골라 «사유 바꾸기»(같은 report 길) */}
                            {openKey === key && !d.locked && changeOpen(d) && !(d.reported && creditBlocksCancel(d)) && (
                              <div className="mb-1.5 mt-1 flex flex-wrap items-center gap-2">
                                <select
                                  value={reason[key] || ""}
                                  onChange={(e) => setReason((prev) => ({ ...prev, [key]: e.target.value }))}
                                  className="academy-input min-w-32 flex-1"
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
                                  // 사유 변경인데 같은 사유면 보낼 것이 없다
                                  disabled={busy || (d.reported && (reason[key] || "") === (d.reason || ""))}
                                  onClick={() => report(d)}
                                  className="academy-button-primary"
                                >
                                  {d.reported ? "사유 바꾸기" : "신고하기"}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey("")}
                                  className="academy-button-text"
                                >
                                  닫기
                                </button>
                                {/* 날짜 변경은 따로 없다 — 취소 후 다시 신고 */}
                                {d.reported && (
                                  <p className="basis-full text-xs text-[var(--color-academy-muted)]">
                                    날짜를 바꾸려면 취소한 뒤 다시 신고해 주세요.
                                  </p>
                                )}
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
