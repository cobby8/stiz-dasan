"use client";

/**
 * 체육관 대관 신청 폼(공개).
 * 요금은 화면에서 실시간으로 보여 주지만, 저장 금액은 서버가 같은 함수(calculateRentalFee)로 다시 계산한다.
 * 날짜는 월 달력(오늘~60일), 시작은 10분 단위, 이용은 30분 단위(1~6시간) — 2026-11-08 원장 지시.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { publicErrorText } from "@/components/ui/public-error-text";
import { addDaysKst, kstDow, todayKst } from "@/lib/datetime/kst";
import {
  RENTAL_BOOKING_DAYS,
  RENTAL_DURATION_STEP_MINUTES,
  RENTAL_FEE,
  RENTAL_MAX_HEADCOUNT,
  RENTAL_MIN_MINUTES,
  buildRentalCalendar,
  calculateRentalFee,
  formatRentalPhone,
  formatRentalTime,
  formatWon,
  minuteLabel,
  rentalDurationLabel,
  shiftYm,
  type RentalDay,
  type RentalStartOption,
} from "@/lib/rental/gym-rental-rules";
import { getRentalSlots, submitRentalRequest, type RentalSubmitResult } from "@/app/actions/rental";

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
const BLOCK_LABEL = { CLASS: "수업", BOOKED: "예약" } as const;

// 「오늘」은 바뀌어도 알릴 필요가 없다 — 서버 렌더 때는 빈 값, 손님 기기에서는 그 순간의 한국 날짜
const noopSubscribe = () => () => {};

type Receipt = Extract<RentalSubmitResult, { ok: true }>["receipt"];

function longDate(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일(${DOW_KO[kstDow(ymd)]})`;
}

function monthTitle(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return `${y}년 ${m}월`;
}

/** 시작 후보를 «시» 단위 줄로 묶는다(가능한 칸이 하나도 없는 시는 뺀다) — 근접성: 같은 시끼리 한 줄 */
function groupByHour(starts: RentalStartOption[]): Array<{ hour: number; options: RentalStartOption[] }> {
  const rows = new Map<number, RentalStartOption[]>();
  for (const option of starts) {
    const hour = Math.floor(option.minute / 60);
    rows.set(hour, [...(rows.get(hour) ?? []), option]);
  }
  return [...rows.entries()]
    .filter(([, options]) => options.some((o) => o.available))
    .map(([hour, options]) => ({ hour, options }));
}

export default function RentalClient() {
  // 「오늘」은 손님 기기에서 연 순간에 정한다 — 페이지는 미리 만들어 두는(정적) 화면이라
  // 서버가 만든 시점의 날짜를 쓰면 다음 날 화면이 어제부터 시작한다.
  const today = useSyncExternalStore(noopSubscribe, () => todayKst(), () => "");
  const lastDay = useMemo(() => (today ? addDaysKst(today, RENTAL_BOOKING_DAYS) : ""), [today]);

  const [pickedDate, setPickedDate] = useState("");
  const date = pickedDate || today; // 고르기 전에는 오늘
  // 달력에 보이는 달("YYYY-MM"). 고르기 전에는 오늘이 있는 달.
  const [pickedYm, setPickedYm] = useState("");
  const viewYm = pickedYm || today.slice(0, 7);
  const firstYm = today.slice(0, 7);
  const lastYm = lastDay.slice(0, 7);
  const calendar = useMemo(() => (viewYm && today ? buildRentalCalendar(viewYm, today) : []), [viewYm, today]);

  // 가능 시간은 «어느 날짜의 것인지»와 함께 둔다 — 날짜를 바꾸면 옛 날짜 칸이 잠깐이라도 보이지 않게
  const [dayState, setDayState] = useState<{ date: string; day: RentalDay | null; error: string }>({ date: "", day: null, error: "" });
  const day = dayState.date === date ? dayState.day : null;
  const dayError = dayState.date === date ? dayState.error : "";
  const [startMinute, setStartMinute] = useState<number | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(RENTAL_MIN_MINUTES);
  const [headcount, setHeadcount] = useState(6);
  const [useAircon, setUseAircon] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [purpose, setPurpose] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const errorRef = useRef<HTMLDivElement>(null);

  // 날짜가 바뀌면 그날 가능 시간을 새로 받는다. 늦게 온 옛 응답이 새 날짜를 덮지 않게 막는다.
  useEffect(() => {
    if (!date) return;
    let alive = true;
    getRentalSlots(date)
      .then((result) => {
        if (!alive) return;
        setDayState({ date, day: result.ok ? result.day : null, error: result.ok ? "" : result.message });
      })
      .catch(() => {
        if (alive) setDayState({ date, day: null, error: "가능한 시간을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
      });
    return () => {
      alive = false;
    };
  }, [date]);

  const startRows = useMemo(() => (day ? groupByHour(day.starts) : []), [day]);
  const selectedOption = day && startMinute !== null ? day.starts.find((s) => s.minute === startMinute) ?? null : null;
  const maxMinutes = selectedOption?.available ? selectedOption.maxMinutes : 0;
  // 이용 시간 칩: 1시간, 1시간 30분, … 그 시작 시각에서 이어서 쓸 수 있는 최대까지
  const durationChoices = useMemo(() => {
    const list: number[] = [];
    for (let m = RENTAL_MIN_MINUTES; m <= maxMinutes; m += RENTAL_DURATION_STEP_MINUTES) list.push(m);
    return list;
  }, [maxMinutes]);
  const fee = useMemo(() => {
    try {
      return calculateRentalFee({ durationMinutes, headcount, useAircon });
    } catch {
      return null;
    }
  }, [durationMinutes, headcount, useAircon]);

  // 날짜를 바꾸면 고른 시간은 비운다(다른 날의 칸이라)
  function selectDate(ymd: string) {
    setPickedDate(ymd);
    setStartMinute(null);
    setDurationMinutes(RENTAL_MIN_MINUTES);
  }

  function chooseStart(option: RentalStartOption) {
    setStartMinute(option.minute);
    // 이어서 쓸 수 있는 시간보다 길게 골라 둔 상태면 줄인다
    setDurationMinutes((current) => Math.min(Math.max(RENTAL_MIN_MINUTES, current), Math.max(RENTAL_MIN_MINUTES, option.maxMinutes)));
  }

  function changeHeadcount(delta: number) {
    setHeadcount((current) => Math.min(RENTAL_MAX_HEADCOUNT, Math.max(1, current + delta)));
  }

  function showError(message: string) {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (startMinute === null || !selectedOption?.available) return showError("이용할 시작 시간을 골라 주세요.");
    if (!name.trim()) return showError("신청자 이름을 입력해 주세요.");
    if (!phone.trim()) return showError("휴대폰 번호를 입력해 주세요.");
    if (!purpose.trim()) return showError("사용 목적을 입력해 주세요. 예: 동호회 농구 연습");
    if (!agreed) return showError("이용 규칙에 동의해 주세요.");
    startTransition(async () => {
      try {
        const result = await submitRentalRequest({
          rentalDate: date,
          startMinute, // 그날 KST 0시부터 분 — 서버가 10분 단위·영업 시간·겹침을 다시 검사한다
          durationMinutes,
          headcount,
          useAircon,
          applicantName: name,
          applicantPhone: phone,
          purpose,
          agreedRules: agreed,
          honeypot,
        });
        if (!result.ok) {
          showError(publicErrorText(result.message, "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
          // 그사이 다른 대관이 승인됐을 수 있으니 시간을 새로 받는다
          const fresh = await getRentalSlots(date);
          if (fresh.ok) setDayState({ date, day: fresh.day, error: "" });
          return;
        }
        setReceipt(result.receipt);
        setDuplicate(result.duplicate);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (err) {
        showError(publicErrorText(err, "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      }
    });
  }

  async function copyAccount(text: string) {
    try {
      await navigator.clipboard.writeText(text.replace(/\s*\(.*\)\s*$/, ""));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  // ── 신청 완료 화면: 접수 번호 · 넣은 내용 · 지금 단계 · 다음 할 일 · 입금 계좌 ──
  if (receipt) {
    return (
      <div className="public-card p-4 sm:p-5" aria-live="polite">
        <div className="flex items-center gap-2">
          <FontFreeIcon name="check_circle" size={28} className="text-[var(--color-public-accent)]" />
          <h2 className="text-xl font-black text-[var(--color-public-ink)]">{duplicate ? "이미 접수된 신청입니다" : "대관 신청이 접수되었습니다"}</h2>
        </div>
        <p className="mt-1 text-sm break-keep text-[var(--color-public-muted)]">
          <b className="text-[var(--color-public-ink)]">원장님 승인 후 확정</b>됩니다. 승인 안내를 받으면 아래 계좌로 입금해 주세요.
        </p>

        {/* 단계 표시 — 지금 어디인지 */}
        <ol className="mt-4 grid grid-cols-4 gap-1 text-center text-xs font-bold">
          {["신청 접수", "원장님 승인", "입금", "확정"].map((step, index) => (
            <li
              key={step}
              className={`rounded-[var(--color-public-radius)] border px-1 py-2 ${index === 0
                ? "border-[var(--color-public-accent)] bg-[var(--color-public-accent)] text-[var(--color-public-white)]"
                : "border-[var(--color-public-line)] text-[var(--color-public-muted)]"}`}
            >
              {step}
            </li>
          ))}
        </ol>

        <dl className="mt-4 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-[var(--color-public-muted)]">접수 번호</dt>
          <dd className="font-bold tabular-nums text-[var(--color-public-ink)]">{receipt.number}</dd>
          <dt className="text-[var(--color-public-muted)]">이용 일시</dt>
          <dd className="font-bold text-[var(--color-public-ink)]">{longDate(receipt.rentalDate)} {formatRentalTime(receipt.startMinute, receipt.endMinute)}</dd>
          <dt className="text-[var(--color-public-muted)]">인원</dt>
          <dd className="text-[var(--color-public-ink)]">{receipt.headcount}명{receipt.useAircon ? " · 냉난방 사용" : ""}</dd>
          <dt className="text-[var(--color-public-muted)]">이용료</dt>
          <dd className="tabular-nums text-[var(--color-public-ink)]">{formatWon(receipt.usageFee)}</dd>
          <dt className="text-[var(--color-public-muted)]">보증금</dt>
          <dd className="tabular-nums text-[var(--color-public-ink)]">{formatWon(receipt.deposit)} (사용 후 환불)</dd>
        </dl>

        {/* 입금 안내 — 이 화면에서만 계좌를 보여 준다 */}
        <div className="mt-4 rounded-[var(--color-public-radius)] border border-[var(--color-public-accent)] bg-[var(--color-public-tint)] p-3">
          <p className="text-sm font-bold text-[var(--color-public-muted)]">입금할 금액</p>
          <p className="text-2xl font-black tabular-nums text-[var(--color-public-ink)]">{formatWon(receipt.totalAmount)}</p>
          <p className="mt-2 text-sm font-bold break-keep text-[var(--color-public-ink)]">{receipt.bankAccount}</p>
          <p className="mt-1 text-xs break-keep text-[var(--color-public-muted)]">
            승인 안내를 받은 뒤 입금해 주세요. 입금자명은 신청자 이름으로 해 주세요. 입금이 확인되면 확정됩니다.
          </p>
          <button type="button" onClick={() => copyAccount(receipt.bankAccount)} className="public-btn-secondary mt-2 w-full text-sm">
            {copied ? "계좌번호를 복사했어요" : "계좌번호 복사"}
          </button>
        </div>

        <ul className="mt-4 space-y-1 text-sm break-keep text-[var(--color-public-ink)]">
          <li>· 실내운동화를 꼭 챙겨 오세요.</li>
          <li>· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.</li>
        </ul>
        <Link href="/" className="public-btn-text mt-2">홈으로</Link>
      </div>
    );
  }

  // ── 신청 폼 ── (오늘 날짜를 정하기 전 한 순간은 자리만 잡아 둔다)
  if (!date) {
    return <div className="public-card min-h-64 p-4 text-sm text-[var(--color-public-muted)]">신청서를 준비하는 중…</div>;
  }
  return (
    <form onSubmit={submit} className="public-card min-w-0 space-y-5 p-4 sm:p-5" noValidate>
      {/* 스팸 방지 숨김 칸 — 사람에게는 보이지 않는다 */}
      <div aria-hidden="true" className="hidden">
        <label>
          비워 두세요
          <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </label>
      </div>

      {/* 1. 날짜 — 월 달력. 오늘~60일 안만 고를 수 있고, 지난 날·범위 밖은 흐리게 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-black text-[var(--color-public-ink)]">날짜</legend>
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPickedYm(shiftYm(viewYm, -1))}
            disabled={viewYm <= firstYm}
            aria-label="이전 달"
            className="flex h-11 w-11 items-center justify-center rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] text-[var(--color-public-ink)] disabled:opacity-40"
          >
            <FontFreeIcon name="chevron_left" size={20} />
          </button>
          <p className="text-sm font-black tabular-nums text-[var(--color-public-ink)]" aria-live="polite">{monthTitle(viewYm)}</p>
          <button
            type="button"
            onClick={() => setPickedYm(shiftYm(viewYm, 1))}
            disabled={viewYm >= lastYm}
            aria-label="다음 달"
            className="flex h-11 w-11 items-center justify-center rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] text-[var(--color-public-ink)] disabled:opacity-40"
          >
            <FontFreeIcon name="chevron_right" size={20} />
          </button>
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1 text-center text-xs font-bold text-[var(--color-public-muted)]" aria-hidden="true">
          {DOW_KO.map((d) => <span key={d} className="py-1">{d}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-1" role="group" aria-label={`${monthTitle(viewYm)} 날짜`}>
          {calendar.map((cell, index) => {
            if (!cell) return <span key={`blank-${index}`} aria-hidden="true" />;
            const active = cell.date === date;
            return (
              <button
                key={cell.date}
                type="button"
                disabled={!cell.bookable}
                aria-pressed={active}
                aria-label={`${longDate(cell.date)}${cell.isToday ? " 오늘" : ""}`}
                onClick={() => selectDate(cell.date)}
                className={`flex min-h-11 flex-col items-center justify-center rounded-[var(--color-public-radius)] border text-sm font-bold leading-tight tabular-nums ${!cell.bookable
                  ? "cursor-not-allowed border-transparent text-[var(--color-public-muted)] opacity-40"
                  : active
                    ? "border-[var(--color-public-ink)] bg-[var(--color-public-ink)] text-[var(--color-public-paper)]"
                    : cell.isToday
                      ? "border-[var(--color-public-accent)] text-[var(--color-public-ink)]"
                      : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
              >
                {cell.day}
                {cell.isToday && <span className="text-xs font-semibold">오늘</span>}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* 2. 시간 — 시작 10분 단위(시별 한 줄), 이용 30분 단위 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-black text-[var(--color-public-ink)]">
          시작 시간 <span className="text-sm font-bold text-[var(--color-public-muted)]">{longDate(date)}</span>
        </legend>
        {dayError ? (
          <p role="alert" className="mt-2 text-sm font-bold text-[var(--color-public-accent)]">{dayError}</p>
        ) : !day ? (
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">가능한 시간을 확인하는 중…</p>
        ) : startRows.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">이 날은 비어 있는 시간이 없습니다. 다른 날짜를 골라 주세요.</p>
        ) : (
          <>
            <p className="mt-1 text-xs break-keep text-[var(--color-public-muted)]">
              이용 가능 {minuteLabel(day.openMinute)}~{minuteLabel(day.closeMinute)}
              {day.blocks.length > 0 && (
                <> · 제외 {day.blocks.map((b) => `${BLOCK_LABEL[b.reason]} ${minuteLabel(b.startMinute)}~${minuteLabel(b.endMinute)}`).join(", ")}</>
              )}
            </p>
            <div className="mt-2 space-y-1" role="group" aria-label="시작 시간">
              {startRows.map((row) => (
                <div key={row.hour} className="grid grid-cols-6 gap-1">
                  {row.options.map((option) => {
                    const active = option.minute === startMinute;
                    return (
                      <button
                        key={option.minute}
                        type="button"
                        disabled={!option.available}
                        aria-pressed={active}
                        onClick={() => chooseStart(option)}
                        className={`min-h-11 rounded-[var(--color-public-radius)] border text-sm font-bold tabular-nums ${!option.available
                          ? "cursor-not-allowed border-dashed border-[var(--color-public-line)] text-[var(--color-public-muted)] opacity-40"
                          : active
                            ? "border-[var(--color-public-accent)] bg-[var(--color-public-accent)] text-[var(--color-public-white)]"
                            : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}

        {startMinute !== null && durationChoices.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-bold text-[var(--color-public-ink)]">
              이용 시간 <span className="font-semibold text-[var(--color-public-muted)]">{formatRentalTime(startMinute, startMinute + durationMinutes)}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="이용 시간">
              {durationChoices.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={durationMinutes === m}
                  onClick={() => setDurationMinutes(m)}
                  className={`min-h-11 rounded-[var(--color-public-radius)] border px-3 text-sm font-bold ${durationMinutes === m
                    ? "border-[var(--color-public-ink)] bg-[var(--color-public-ink)] text-[var(--color-public-paper)]"
                    : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
                >
                  {rentalDurationLabel(m)}
                </button>
              ))}
            </div>
          </div>
        )}
      </fieldset>

      {/* 3. 인원·냉난방 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-black text-[var(--color-public-ink)]">인원·냉난방</legend>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1" role="group" aria-label="인원">
            <button type="button" onClick={() => changeHeadcount(-1)} aria-label="인원 줄이기" className="public-btn-secondary w-11 px-0">−</button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={RENTAL_MAX_HEADCOUNT}
              value={headcount}
              onChange={(e) => setHeadcount(Math.min(RENTAL_MAX_HEADCOUNT, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
              aria-label="인원 수"
              className="min-h-11 w-16 rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] text-center font-bold tabular-nums text-[var(--color-public-ink)]"
            />
            <button type="button" onClick={() => changeHeadcount(1)} aria-label="인원 늘리기" className="public-btn-secondary w-11 px-0">+</button>
            <span className="ml-1 text-sm text-[var(--color-public-ink)]">명</span>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold text-[var(--color-public-ink)]">
            <input type="checkbox" checked={useAircon} onChange={(e) => setUseAircon(e.target.checked)} className="h-5 w-5 accent-[var(--color-public-accent)]" />
            냉난방 사용(30분당 {formatWon(RENTAL_FEE.airconPerHalfHour)})
          </label>
        </div>
        {headcount > RENTAL_FEE.baseHeadcount && (
          <p className="mt-1 text-xs text-[var(--color-public-muted)]">
            {RENTAL_FEE.baseHeadcount}명을 넘는 {headcount - RENTAL_FEE.baseHeadcount}명은 1인·30분당 {formatWon(RENTAL_FEE.extraPersonPerHalfHour)}이 추가됩니다.
          </p>
        )}
      </fieldset>

      {/* 4. 실시간 요금 */}
      {fee && (
        <div className="rounded-[var(--color-public-radius)] bg-[var(--color-public-tint)] p-3 text-sm" aria-live="polite">
          <dl className="space-y-1">
            <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">시간 요금({rentalDurationLabel(fee.durationMinutes)})</dt><dd className="tabular-nums">{formatWon(fee.baseFee)}</dd></div>
            {fee.airconFee > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">냉난방</dt><dd className="tabular-nums">{formatWon(fee.airconFee)}</dd></div>}
            {fee.extraPeopleFee > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">인원 추가({fee.extraPeople}명)</dt><dd className="tabular-nums">{formatWon(fee.extraPeopleFee)}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">보증금(환불)</dt><dd className="tabular-nums">{formatWon(fee.deposit)}</dd></div>
          </dl>
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-[var(--color-public-line)] pt-2">
            <span className="font-bold text-[var(--color-public-ink)]">입금할 금액</span>
            <span className="text-xl font-black tabular-nums text-[var(--color-public-ink)]">{formatWon(fee.total)}</span>
          </div>
          {startMinute === null && <p className="mt-1 text-xs text-[var(--color-public-muted)]">시작 시간을 고르면 그 시간 기준으로 확정됩니다.</p>}
        </div>
      )}

      {/* 5. 신청자 정보 */}
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-base font-black text-[var(--color-public-ink)]">신청자</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm font-bold text-[var(--color-public-ink)]">
            이름
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="name"
              placeholder="입금자명과 같게"
              className="mt-1 block min-h-11 w-full rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-3 font-normal text-[var(--color-public-ink)]"
            />
          </label>
          <label className="block text-sm font-bold text-[var(--color-public-ink)]">
            휴대폰
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => {
                const digits = phone.replace(/\D/g, "");
                if (digits.length >= 10) setPhone(formatRentalPhone(digits));
              }}
              inputMode="tel"
              autoComplete="tel"
              placeholder="010-1234-5678"
              className="mt-1 block min-h-11 w-full rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-3 font-normal tabular-nums text-[var(--color-public-ink)]"
            />
          </label>
        </div>
        <label className="block text-sm font-bold text-[var(--color-public-ink)]">
          사용 목적
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            maxLength={300}
            placeholder="예: 동호회 농구 연습, 아이 생일 파티"
            className="mt-1 block min-h-11 w-full rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-3 font-normal text-[var(--color-public-ink)]"
          />
        </label>
      </fieldset>

      {/* 6. 규칙 동의 */}
      <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm break-keep text-[var(--color-public-ink)]">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-public-accent)]" />
        <span>
          <b>이용 규칙에 동의합니다.</b> 실내운동화 착용, 사용 후 정리정돈·냉난방 끄기, 인원 준수를 지키지 않으면 보증금이 차감될 수 있습니다.
          연락처는 대관 안내에만 씁니다.
        </span>
      </label>

      {error && (
        <div ref={errorRef} role="alert" className="flex items-center gap-2 rounded-[var(--color-public-radius)] border border-[var(--color-public-accent)] px-3 py-2 text-sm font-bold text-[var(--color-public-accent)]">
          <FontFreeIcon name="error" size={18} />
          {error}
        </div>
      )}

      {/* 화면의 주인공 버튼은 이것 하나 */}
      <button type="submit" disabled={pending} className="public-btn-primary w-full text-base">
        {pending ? "신청하는 중…" : fee && startMinute !== null ? `대관 신청하기 · ${formatWon(fee.total)}` : "대관 신청하기"}
      </button>
      <p className="-mt-3 text-center text-xs text-[var(--color-public-muted)]">지금은 신청만 접수돼요. 결제는 원장님 승인 후 계좌이체로 합니다.</p>
    </form>
  );
}
