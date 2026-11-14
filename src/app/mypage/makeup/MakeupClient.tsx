"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import ParentBackLink from "@/components/parent/ParentBackLink";
import { useRouter } from "next/navigation";
import type { ParentMakeupOverview, ParentCredit, MakeupOption } from "@/lib/makeup/parent-makeup";
// 남은 자리는 숫자 대신 3단계(여유/임박/마감)로(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";
import { fetchMakeupOptions, bookMakeupAction, cancelMakeupAction, rescheduleMakeupAction } from "@/app/actions/parent-makeup";
import { CHANGE_CLOSED_MESSAGE, PARENT_CHANGE_CUTOFF_TEXT } from "@/lib/parent/changeDeadline";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { todayKst } from "@/lib/datetime/kst";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { REQUEST_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import { presetFirst } from "@/lib/mypage/requestPreset";

const DOW_KO: Record<string, string> = {
  Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 후보가 0건일 때 이유별 안내(2026-11-14) — 서버(parent-makeup)가 준 emptyReason 을 그대로 글로 바꾼다.
// 이유를 모르는 옛 응답은 기본 글로.
// 원장 지시(2026-11-14): «학원에 문의하지 않고 해결할 수 있는 기능은 바로 해당 화면에서 해결» —
// 글 끝에 «학원으로 문의해 주세요»를 붙이지 않고, 글 아래에 «여기서 할 수 있는 일» 버튼을 둔다(EMPTY_REASON_ACTIONS).
const EMPTY_REASON_TEXT: Record<string, string> = {
  NO_GRADE: "아이 학년을 알 수 없어 수업을 고르지 못했어요.",
  NO_MATCH: "학년이 맞는 다른 수업이 아직 없어요.",
  NO_DATE: "사용 기한 안에 열리는 수업 날짜가 없어요.",
  FULL: "학년이 맞는 수업이 지금은 모두 마감이에요. 자리가 나면 다시 보여요.",
};
const EMPTY_DEFAULT_TEXT = "지금 예약할 수 있는 수업이 없어요.";

// 이유별로 «이 자리에서 할 수 있는 일» — record = 아이 정보에서 학년 확인 · retry = 다시 확인(자리는 수시로 바뀐다).
// «학원에 문의» 버튼은 이유와 상관없이 하나만 붙는다(학원만 풀 수 있는 일: 반 개설·기한 연장·학년 정정).
const EMPTY_REASON_ACTIONS: Record<string, readonly ("record" | "retry")[]> = {
  NO_GRADE: ["record"],
  NO_MATCH: [],
  NO_DATE: [],
  FULL: ["retry"],
};
// 홈의 «학원에 메시지 보내기» 폼을 바로 연다(MyPageClient 가 이 #주소를 받아 폼을 편다)
const ACADEMY_ASK_HREF = "/mypage#parent-request-form";

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
  // 반 선택을 연 까닭: 새 예약("book") / 예약한 보강의 날짜 바꾸기("move" · 2026-11-15)
  const [openMode, setOpenMode] = useState<"book" | "move">("book");
  const [options, setOptions] = useState<MakeupOption[]>([]);
  const [emptyReason, setEmptyReason] = useState("");   // 후보 0건인 이유(서버가 준 값)
  const [pick, setPick] = useState<{ classId: string; ymd: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  // 상태 칩으로 고른 묶음("ALL" = 전체)
  const [groupFilter, setGroupFilter] = useState("ALL");

  // 오늘은 KST 로 구한다(toISOString 은 새벽 0~9시에 어제가 나와 만료 판정이 하루 늦어진다)
  const today = todayKst();

  // 그 보강권으로 갈 수 있는 반을 불러온다 — 처음 펼칠 때와 «다시 확인»이 같은 길을 쓴다.
  // mode "move" = 예약 중인 보강의 날짜 바꾸기(2026-11-15) — 서버가 지금 예약한 반·날짜를 뺀 후보를 준다.
  const load = useCallback(async (creditId: string, mode: "book" | "move" = "book") => {
    setErr(""); setMsg(""); setPick(null); setOptions([]); setEmptyReason("");
    setOpenMode(mode);
    setOpenId(creditId);
    setBusy(creditId);
    try {
      const r = await fetchMakeupOptions(creditId, mode === "move");
      if (!r.ok) { setErr(customerMessage(r.message, "불러오지 못했습니다.")); setOpenId(""); return; }
      setOptions(r.options || []);
      setEmptyReason(r.emptyReason || "");
    } catch {
      setErr("불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setOpenId("");
    } finally {
      setBusy("");
    }
  }, []);

  // 보강권을 펼치면서 그 학생이 갈 수 있는 반을 불러온다(열려 있으면 닫는다).
  const open = useCallback(async (credit: ParentCredit, mode: "book" | "move" = "book") => {
    if (openId === credit.id) { setOpenId(""); return; }
    await load(credit.id, mode);
  }, [openId, load]);

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

  // 날짜 바꾸기 — 서버가 «옛 예약 취소 + 새 예약»을 한 번에 한다(보강권은 예약 상태 그대로. 실패하면 옛 예약이 남는다).
  const reschedule = useCallback(async (creditId: string) => {
    if (!pick) { setErr("바꿀 수업과 날짜를 골라 주세요."); return; }
    setErr(""); setMsg(""); setBusy(creditId);
    try {
      const r = await rescheduleMakeupAction({ creditId, classId: pick.classId, dateYmd: pick.ymd });
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

  // 후보 목록(반 · 날짜 칩) — 새 예약과 날짜 바꾸기가 같은 모양을 쓴다(최종 버튼은 부르는 쪽이 붙인다)
  const optionList = (c: ParentCredit) => (
    <>
      {busy === c.id && options.length === 0 && (
        <p className="text-xs text-[var(--color-academy-muted)]">수업을 불러오는 중…</p>
      )}
      {busy !== c.id && options.length === 0 && (
        // 빈 목록 = 이유 한 줄 + 그 자리에서 할 수 있는 일(막다른 곳을 만들지 않는다) — 새 예약·날짜 바꾸기 공통
        <div className="rounded-xl bg-[var(--color-academy-soft)] px-3 py-3">
          <p className="break-keep text-center text-sm text-[var(--color-academy-ink)]">
            {EMPTY_REASON_TEXT[emptyReason] ?? EMPTY_DEFAULT_TEXT}
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {(EMPTY_REASON_ACTIONS[emptyReason] ?? []).includes("record") && (
              // 학년은 생년월일로 계산한다 — 아이 정보에서 생년월일·학년이 맞는지 본다
              <Link href={`/mypage/record?child=${encodeURIComponent(c.studentId)}`} className="academy-button-secondary">
                아이 정보에서 학년 확인
              </Link>
            )}
            {(EMPTY_REASON_ACTIONS[emptyReason] ?? []).includes("retry") && (
              // 다시 확인 — 지금 열려 있는 까닭(새 예약 / 날짜 바꾸기) 그대로 다시 부른다
              <button type="button" onClick={() => load(c.id, openMode)} className="academy-button-secondary">
                다시 확인
              </button>
            )}
            {/* 학원만 풀 수 있는 일은 이 버튼 하나로 — 홈의 메시지 폼이 바로 열린다 */}
            <Link href={ACADEMY_ASK_HREF} className="academy-button-secondary">
              학원에 문의
            </Link>
          </div>
        </div>
      )}
      {options.map((o) => (
        // 후보 한 줄 행: 반 이름 · 요일 시간 · 대상 학년 · 남은 자리(글자 — 학생 수 숫자는 싣지 않는다) / 아래에 날짜 칩
        <div key={o.classId} className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-keep text-sm font-semibold text-[var(--color-academy-ink)]">{o.className}</span>
            <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">
              {DOW_KO[o.dayOfWeek] ?? o.dayOfWeek} {o.startTime}
              {o.endTime ? `~${o.endTime}` : ""}
            </span>
            {(o.gradeLabel || o.grades.length > 0) && (
              <span className="text-xs text-[var(--color-academy-muted)]">
                대상 {o.gradeLabel || o.grades.join("·")}
              </span>
            )}
            <span className={`ml-auto shrink-0 text-xs font-medium ${SEAT_LEVEL_TEXT_CLASS[o.seatLevel]}`}>
              {SEAT_LEVEL_LABEL[o.seatLevel]}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
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
    </>
  );

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
        <ParentBackLink fallbackHref="/mypage" ariaLabel="마이페이지로" className="academy-back-link" />
        <h1 className="academy-heading">
          보강 예약
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        보강권은 결석일부터 2개월 안에 써 주세요.
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
                  <div className="mt-2 rounded-xl bg-[var(--color-academy-info-soft)] py-1 pl-3 pr-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* 예약한 반(왼쪽, 줄바꿈 허용) · 날짜(오른쪽) · 동작 버튼 */}
                      <span className="min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-info)]">{c.booking.className}</span>
                      <span className="shrink-0 text-sm tabular-nums text-[var(--color-academy-info)]">{c.booking.dateLabel}</span>
                      {c.booking.changeOpen === false ? (
                        // 마감 뒤(보강 수업 시작 1시간 전이 지남·지난 보강) — 버튼 대신 안내 글(서버도 같은 규칙으로 막는다 · 2026-11-15)
                        <span className="basis-full py-1 pr-2 text-xs text-[var(--color-academy-muted)]">{CHANGE_CLOSED_MESSAGE}</span>
                      ) : (
                        // 동작 버튼 한 묶음(날짜 바꾸기 · 예약 취소) — 좁은 화면(360px)에서는 다음 줄로 내려간다
                        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => open(c, "move")}
                            disabled={busy === c.id}
                            className="academy-button-text shrink-0"
                          >
                            {openId === c.id && openMode === "move" ? "닫기" : "날짜 바꾸기"}
                          </button>
                          {/* 예약 취소 = 그 자리 확인(C-M1) 후 기존 cancel(c.id) 그대로 */}
                          <InlineConfirm
                            label="예약 취소"
                            question="이 보강 예약을 취소할까요?"
                            confirmLabel="예약 취소하기"
                            onConfirm={() => cancel(c.id)}
                            pending={busy === c.id}
                          />
                        </span>
                      )}
                    </div>
                    {/* 날짜 바꾸기 칸 — 지금 예약한 반·날짜를 뺀 후보에서 고른다 */}
                    {openId === c.id && openMode === "move" && c.booking.changeOpen !== false && (
                      <div className="mt-2 space-y-2 pb-1 pr-2">
                        {optionList(c)}
                        {options.length > 0 && (
                          <button
                            type="button"
                            onClick={() => reschedule(c.id)}
                            disabled={busy === c.id || !pick}
                            className="academy-button-primary w-full"
                          >
                            이 날짜로 바꾸기
                          </button>
                        )}
                      </div>
                    )}
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
                        {/* 후보 목록·빈 목록 화면은 날짜 바꾸기와 함께 쓰는 optionList 한 곳에 있다 */}
                        {optionList(c)}
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
        예약·예약 취소·날짜 바꾸기는 수업 시작 {PARENT_CHANGE_CUTOFF_TEXT} 전까지 할 수 있어요.<br />
        알리지 않고 빠지면 보강권이 사용 처리돼요.
      </p>
    </div>
  );
}
