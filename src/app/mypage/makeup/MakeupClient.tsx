"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ParentMakeupOverview, ParentCredit, MakeupOption } from "@/lib/makeup/parent-makeup";
// 남은 자리는 숫자 대신 3단계(여유/임박/마감)로(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";
import { fetchMakeupOptions, bookMakeupAction, cancelMakeupAction } from "@/app/actions/parent-makeup";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { todayKst } from "@/lib/datetime/kst";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { REQUEST_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import { presetFirst } from "@/lib/mypage/requestPreset";

const DOW_KO: Record<string, string> = {
  Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

/** 상태 뱃지 — 학부모가 한눈에 "쓸 수 있나"를 알아야 한다. */
function statusBadge(c: ParentCredit, expired: boolean) {
  // 색 = 공용 지도(statusTones): 사용 가능 정상 · 예약(진행 중) 정보 · 무단 불참 위험 · 끝난 것 중립
  if (expired) return { label: "기간 만료", cls: TONE_BADGE_CLASS.neutral };
  switch (c.status) {
    case "AVAILABLE": return { label: "사용 가능", cls: TONE_BADGE_CLASS.success };
    case "RESERVED":  return { label: "예약 완료", cls: TONE_BADGE_CLASS[REQUEST_TONE.RESERVED] };
    case "USED":      return { label: "보강 완료", cls: TONE_BADGE_CLASS[REQUEST_TONE.USED] };
    case "NO_SHOW":   return { label: "무단 불참", cls: TONE_BADGE_CLASS.danger };
    case "REVOKED":   return { label: "출결 정정", cls: TONE_BADGE_CLASS.neutral };
    default:          return { label: "기간 만료", cls: TONE_BADGE_CLASS.neutral };
  }
}

/** 상태 칩 분류 — 서버 집계(credit-rules.summarize)와 같은 순서로 판정한다. 칩 숫자 = 보이는 행 수. */
type CreditGroup = "available" | "reserved" | "used" | "expired";
function creditGroupOf(c: ParentCredit, today: string): CreditGroup {
  if (c.status === "USED" || c.status === "NO_SHOW") return "used";
  if (c.status === "EXPIRED" || c.status === "REVOKED") return "expired";
  if (c.expiresYmd < today) return "expired";
  if (c.status === "RESERVED") return "reserved";
  return "available";
}
const CREDIT_GROUPS: { value: CreditGroup; label: string }[] = [
  { value: "available", label: "사용 가능" },
  { value: "reserved", label: "예약 중" },
  { value: "used", label: "사용 완료" },
  { value: "expired", label: "만료" },
];

// presetStudentId = 수업 탭 반 카드에서 온 아이 — 그 아이 보강권을 맨 위에(나머지 순서는 그대로)
export default function MakeupClient({ initial, presetStudentId = null }: { initial: ParentMakeupOverview; presetStudentId?: string | null }) {
  const router = useRouter();
  const [openId, setOpenId] = useState("");            // 반 선택이 열린 보강권
  const [options, setOptions] = useState<MakeupOption[]>([]);
  const [pick, setPick] = useState<{ classId: string; ymd: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  // 상태 칩으로 고른 묶음("ALL" = 전체)
  const [groupFilter, setGroupFilter] = useState("ALL");

  // 오늘은 KST 로 구한다(toISOString 은 새벽 0~9시에 어제가 나와 만료 판정이 하루 늦어진다)
  const today = todayKst();

  // 보강권을 펼치면서 그 학생이 갈 수 있는 반을 불러온다.
  const open = useCallback(async (credit: ParentCredit) => {
    if (openId === credit.id) { setOpenId(""); return; }
    setErr(""); setMsg(""); setPick(null); setOptions([]);
    setOpenId(credit.id);
    setBusy(credit.id);
    try {
      const r = await fetchMakeupOptions(credit.id);
      if (!r.ok) { setErr(customerMessage(r.message, "불러오지 못했습니다.")); setOpenId(""); return; }
      setOptions(r.options || []);
    } catch {
      setErr("불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setOpenId("");
    } finally {
      setBusy("");
    }
  }, [openId]);

  const book = useCallback(async (creditId: string) => {
    if (!pick) { setErr("보강받을 수업과 날짜를 골라 주세요."); return; }
    setErr(""); setMsg(""); setBusy(creditId);
    try {
      const r = await bookMakeupAction({ creditId, classId: pick.classId, dateYmd: pick.ymd });
      if (!r.ok) { setErr(customerMessage(r.message, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.")); return; }
      setMsg(r.message);
      setOpenId(""); setPick(null);
      router.refresh();
    } finally {
      setBusy("");
    }
  }, [pick, router]);

  const cancel = useCallback(async (creditId: string) => {
    setErr(""); setMsg(""); setBusy(creditId);
    try {
      const r = await cancelMakeupAction(creditId);
      if (!r.ok) { setErr(customerMessage(r.message, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.")); return; }
      setMsg(r.message);
      router.refresh();
    } finally {
      setBusy("");
    }
  }, [router]);

  const credits = presetFirst(initial.credits, presetStudentId, (c) => c.studentId);
  const creditChips = CREDIT_GROUPS.map((g) => ({
    value: g.value,
    label: g.label,
    count: credits.filter((c) => creditGroupOf(c, today) === g.value).length,
  }));
  const visibleCredits = groupFilter === "ALL" ? credits : credits.filter((c) => creditGroupOf(c, today) === groupFilter);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* 헤더 */}
      <div className="mb-2 flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href="/mypage" aria-label="마이페이지로" className="academy-back-link">
          <span aria-hidden="true">←</span>
        </Link>
        <h1 className="academy-heading">
          보강 예약
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        결석 1회당 보강권 1장이 발급됩니다. <strong>결석일로부터 2개월</strong> 안에 사용해 주세요.
        기간이 지나면 자동으로 소멸합니다.
      </p>

      {/* 잔여 집계 — 예전 4칸 판(약 70px)을 상태 칩 한 줄로. 칩을 누르면 그 상태만 본다. */}
      <div className="mb-3">
        <StatusCountChips items={creditChips} selected={groupFilter} onSelect={setGroupFilter} ariaLabel="보강권 상태별 건수" />
      </div>

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

      {credits.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-academy-line-input)] bg-white px-6 py-16 text-center text-sm text-[var(--color-academy-muted)]">
          발급된 보강권이 없습니다.
        </div>
      ) : (
        // 카드 묶음 대신 한 목록 안의 행(divide-y)으로 — 휴대폰 첫 화면에 더 많은 보강권이 보이게
        <ul className="divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
          {visibleCredits.map((c) => {
            const expired = c.expiresYmd < today && (c.status === "AVAILABLE" || c.status === "RESERVED");
            const badge = statusBadge(c, expired);
            const canBook = c.status === "AVAILABLE" && !expired;
            return (
              <li key={c.id} className="px-3 py-2.5">
                {/* 1줄: 학생 · 구분(정규/방학특강) · 상태(오른쪽) — «·»로 잇던 글을 요소로 나눔 */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-[var(--color-academy-ink)]">{c.studentName}</span>
                  <span className="rounded-full border border-[var(--color-academy-line)] px-2 py-0.5 text-xs text-[var(--color-academy-muted)]">
                    {c.sourceLabel}
                  </span>
                  <span className={`ml-auto inline-flex items-center rounded px-2 py-0.5 text-xs ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>
                {/* 2줄: 결석일(왼쪽) · 사용 기한(오른쪽, 숫자 폭 고정) */}
                <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 text-xs text-[var(--color-academy-muted)]">
                  <span className="tabular-nums">{c.absenceLabel} 결석</span>
                  <span className="text-right tabular-nums">사용 기한 {c.expiresLabel}까지</span>
                </div>

                {/* 예약 완료 상태 */}
                {c.booking && c.status === "RESERVED" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-academy-info-soft)] py-1 pl-3 pr-1">
                    {/* 예약한 반(왼쪽, 줄바꿈 허용) · 날짜(오른쪽) · 취소 버튼 */}
                    <span className="min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-info)]">{c.booking.className}</span>
                    <span className="shrink-0 text-sm tabular-nums text-[var(--color-academy-info)]">{c.booking.dateLabel}</span>
                    {/* 예약 취소 = 그 자리 확인(C-M1) 후 기존 cancel(c.id) 그대로 */}
                    <InlineConfirm
                      label="예약 취소"
                      question="이 보강 예약을 취소할까요?"
                      confirmLabel="예약 취소하기"
                      onConfirm={() => cancel(c.id)}
                      pending={busy === c.id}
                    />
                  </div>
                )}

                {/* 예약하기 */}
                {canBook && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => open(c)}
                      disabled={busy === c.id}
                      // 행의 «여는» 버튼 = 보조(secondary), 열린 뒤 «닫기» = 글자 버튼. 꽉 찬 색은 폼 안 최종 «이 날짜로 예약»만(M-08)
                      className={`${openId === c.id ? "academy-button-text" : "academy-button-secondary"} w-full`}
                    >
                      {openId === c.id ? "닫기" : "보강 예약하기"}
                    </button>

                    {openId === c.id && (
                      <div className="mt-3 space-y-2">
                        {busy === c.id && options.length === 0 && (
                          <p className="text-xs text-[var(--color-academy-muted)]">수업을 불러오는 중…</p>
                        )}
                        {busy !== c.id && options.length === 0 && (
                          <p className="rounded-xl bg-[var(--color-academy-soft)] px-3 py-4 text-center text-xs text-[var(--color-academy-muted)]">
                            지금 예약할 수 있는 수업이 없습니다. 학원으로 문의해 주세요.
                          </p>
                        )}
                        {options.map((o) => (
                          <div key={o.classId} className="rounded-xl border border-[var(--color-academy-line)] p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-sm font-semibold text-[var(--color-academy-ink)]">
                                {o.className}
                                <span className="ml-2 text-xs font-normal tabular-nums text-[var(--color-academy-muted)]">
                                  {DOW_KO[o.dayOfWeek] ?? o.dayOfWeek} {o.startTime}
                                  {o.endTime ? `~${o.endTime}` : ""}
                                </span>
                              </div>
                              <span className={`text-xs font-semibold ${SEAT_LEVEL_TEXT_CLASS[o.seatLevel]}`}>
                                {SEAT_LEVEL_LABEL[o.seatLevel]}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-[var(--color-academy-faint)]">
                              대상 학년 {o.grades.join("·")}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {o.dates.map((d) => {
                                const on = pick?.classId === o.classId && pick?.ymd === d.ymd;
                                return (
                                  <button
                                    key={d.ymd}
                                    type="button"
                                    // 고른 날짜 칩 = academy-choice(체크·연한 바탕), 제출 버튼과 구분(C-M2)
                                    aria-pressed={on}
                                    onClick={() => setPick({ classId: o.classId, ymd: d.ymd })}
                                    className="academy-choice tabular-nums"
                                  >
                                    {d.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                        {options.length > 0 && (
                          <button
                            type="button"
                            onClick={() => book(c.id)}
                            disabled={busy === c.id || !pick}
                            className="academy-button-primary w-full"
                          >
                            이 날짜로 예약
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-5 text-xs leading-relaxed text-[var(--color-academy-faint)]">
        · 보강은 학년이 맞는 다른 수업으로만 예약할 수 있습니다.<br />
        · 예약을 미리 취소하면 보강권은 그대로 유지됩니다.<br />
        · 예약 후 알리지 않고 오지 않으면 보강권을 사용한 것으로 처리됩니다.
      </p>
    </div>
  );
}
