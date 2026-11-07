"use client";

/**
 * 체육관 대관 신청 폼(공개).
 * 요금은 화면에서 실시간으로 보여 주지만, 저장 금액은 서버가 같은 함수(calculateRentalFee)로 다시 계산한다.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { publicErrorText } from "@/components/ui/public-error-text";
import { addDaysKst, kstDow, todayKst } from "@/lib/datetime/kst";
import {
  RENTAL_BOOKING_DAYS,
  RENTAL_FEE,
  RENTAL_MAX_HEADCOUNT,
  calculateRentalFee,
  formatRentalPhone,
  formatWon,
  maxContinuousHours,
  rentalTimeLabel,
  type RentalSlot,
} from "@/lib/rental/gym-rental-rules";
import { getRentalSlots, submitRentalRequest, type RentalSubmitResult } from "@/app/actions/rental";

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
const QUICK_DAYS = 14; // 날짜 칩으로 바로 고를 수 있는 날 수(그 뒤는 달력 입력)
const REASON_LABEL: Record<RentalSlot["reason"], string> = { OPEN: "", CLASS: "수업", BOOKED: "예약됨", PAST: "지남" };

// 「오늘」은 바뀌어도 알릴 필요가 없다 — 서버 렌더 때는 빈 값, 손님 기기에서는 그 순간의 한국 날짜
const noopSubscribe = () => () => {};

type Receipt = Extract<RentalSubmitResult, { ok: true }>["receipt"];

function dateChipLabel(ymd: string) {
  const [, m, d] = ymd.split("-").map(Number);
  return { day: `${m}/${d}`, dow: DOW_KO[kstDow(ymd)] };
}

function longDate(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일(${DOW_KO[kstDow(ymd)]})`;
}

export default function RentalClient() {
  // 「오늘」은 손님 기기에서 연 순간에 정한다 — 페이지는 미리 만들어 두는(정적) 화면이라
  // 서버가 만든 시점의 날짜를 쓰면 다음 날 화면이 어제부터 시작한다.
  const today = useSyncExternalStore(noopSubscribe, () => todayKst(), () => "");
  const lastDay = useMemo(() => (today ? addDaysKst(today, RENTAL_BOOKING_DAYS) : ""), [today]);
  const quickDates = useMemo(() => (today ? Array.from({ length: QUICK_DAYS }, (_, i) => addDaysKst(today, i)) : []), [today]);

  const [pickedDate, setPickedDate] = useState("");
  const date = pickedDate || today; // 고르기 전에는 오늘
  // 가능 시간은 «어느 날짜의 것인지»와 함께 둔다 — 날짜를 바꾸면 옛 날짜 칸이 잠깐이라도 보이지 않게
  const [slotState, setSlotState] = useState<{ date: string; slots: RentalSlot[] | null; error: string }>({ date: "", slots: null, error: "" });
  const slots = slotState.date === date ? slotState.slots : null;
  const slotError = slotState.date === date ? slotState.error : "";
  const [startHour, setStartHour] = useState<number | null>(null);
  const [hours, setHours] = useState(1);
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
        setSlotState({ date, slots: result.ok ? result.slots : null, error: result.ok ? "" : result.message });
      })
      .catch(() => {
        if (alive) setSlotState({ date, slots: null, error: "가능한 시간을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
      });
    return () => {
      alive = false;
    };
  }, [date]);

  const maxHours = slots && startHour !== null ? maxContinuousHours(slots, startHour) : 0;
  const fee = useMemo(() => {
    try {
      return calculateRentalFee({ hours: Math.max(1, hours), headcount, useAircon });
    } catch {
      return null;
    }
  }, [hours, headcount, useAircon]);
  const openCount = slots?.filter((slot) => slot.available).length ?? 0;

  // 날짜를 바꾸면 고른 시간은 비운다(다른 날의 칸이라)
  function selectDate(ymd: string) {
    setPickedDate(ymd);
    setStartHour(null);
    setHours(1);
  }

  function chooseStart(hour: number) {
    setStartHour(hour);
    // 이어서 쓸 수 있는 시간보다 길게 골라 둔 상태면 줄인다
    const max = slots ? maxContinuousHours(slots, hour) : 1;
    setHours((current) => Math.min(Math.max(1, current), Math.max(1, max)));
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
    if (startHour === null) return showError("이용할 시작 시간을 골라 주세요.");
    if (!name.trim()) return showError("신청자 이름을 입력해 주세요.");
    if (!phone.trim()) return showError("휴대폰 번호를 입력해 주세요.");
    if (!purpose.trim()) return showError("사용 목적을 입력해 주세요. 예: 동호회 농구 연습");
    if (!agreed) return showError("이용 규칙에 동의해 주세요.");
    startTransition(async () => {
      try {
        const result = await submitRentalRequest({
          rentalDate: date,
          startHour,
          hours,
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
          if (fresh.ok) setSlotState({ date, slots: fresh.slots, error: "" });
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
          <dd className="font-bold text-[var(--color-public-ink)]">{longDate(receipt.rentalDate)} {rentalTimeLabel(receipt.startHour, receipt.endHour)}</dd>
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

      {/* 1. 날짜 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-black text-[var(--color-public-ink)]">날짜</legend>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="날짜 바로 고르기">
          {quickDates.map((ymd) => {
            const label = dateChipLabel(ymd);
            const active = ymd === date;
            return (
              <button
                key={ymd}
                type="button"
                aria-pressed={active}
                onClick={() => selectDate(ymd)}
                className={`flex min-h-11 min-w-12 shrink-0 flex-col items-center justify-center rounded-[var(--color-public-radius)] border px-2 text-xs font-bold leading-tight ${active
                  ? "border-[var(--color-public-ink)] bg-[var(--color-public-ink)] text-[var(--color-public-paper)]"
                  : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
              >
                <span className="tabular-nums">{label.day}</span>
                <span className={active ? "" : "text-[var(--color-public-muted)]"}>{label.dow}</span>
              </button>
            );
          })}
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm text-[var(--color-public-muted)]">
          다른 날짜
          <input
            type="date"
            value={date}
            min={today}
            max={lastDay}
            onChange={(e) => e.target.value && selectDate(e.target.value)}
            className="min-h-11 rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-2 text-[var(--color-public-ink)]"
          />
        </label>
      </fieldset>

      {/* 2. 시간 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-black text-[var(--color-public-ink)]">
          시작 시간 <span className="text-sm font-bold text-[var(--color-public-muted)]">{longDate(date)}</span>
        </legend>
        {slotError ? (
          <p role="alert" className="mt-2 text-sm font-bold text-[var(--color-public-accent)]">{slotError}</p>
        ) : !slots ? (
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">가능한 시간을 확인하는 중…</p>
        ) : openCount === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">이 날은 비어 있는 시간이 없습니다. 다른 날짜를 골라 주세요.</p>
        ) : (
          <div className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="group" aria-label="시작 시간">
            {slots.map((slot) => {
              const inRange = startHour !== null && slot.hour >= startHour && slot.hour < startHour + hours;
              return (
                <button
                  key={slot.hour}
                  type="button"
                  disabled={!slot.available}
                  aria-pressed={inRange}
                  onClick={() => chooseStart(slot.hour)}
                  className={`flex min-h-11 flex-col items-center justify-center rounded-[var(--color-public-radius)] border text-sm font-bold leading-tight tabular-nums ${!slot.available
                    ? "cursor-not-allowed border-dashed border-[var(--color-public-line)] text-[var(--color-public-muted)] opacity-60"
                    : inRange
                      ? "border-[var(--color-public-accent)] bg-[var(--color-public-accent)] text-[var(--color-public-white)]"
                      : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
                >
                  {slot.label}
                  {!slot.available && <span className="text-xs font-semibold">{REASON_LABEL[slot.reason]}</span>}
                </button>
              );
            })}
          </div>
        )}

        {startHour !== null && maxHours > 0 && (
          <div className="mt-3">
            <p className="text-sm font-bold text-[var(--color-public-ink)]">
              이용 시간 <span className="font-semibold text-[var(--color-public-muted)]">{rentalTimeLabel(startHour, startHour + hours)}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="이용 시간">
              {Array.from({ length: maxHours }, (_, i) => i + 1).map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-pressed={hours === h}
                  onClick={() => setHours(h)}
                  className={`min-h-11 rounded-[var(--color-public-radius)] border px-3 text-sm font-bold ${hours === h
                    ? "border-[var(--color-public-ink)] bg-[var(--color-public-ink)] text-[var(--color-public-paper)]"
                    : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
                >
                  {h}시간
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
            냉난방 사용(시간당 {formatWon(RENTAL_FEE.airconPerHour)})
          </label>
        </div>
        {headcount > RENTAL_FEE.baseHeadcount && (
          <p className="mt-1 text-xs text-[var(--color-public-muted)]">
            {RENTAL_FEE.baseHeadcount}명을 넘는 {headcount - RENTAL_FEE.baseHeadcount}명은 1인·1시간당 {formatWon(RENTAL_FEE.extraPersonPerHour)}이 추가됩니다.
          </p>
        )}
      </fieldset>

      {/* 4. 실시간 요금 */}
      {fee && (
        <div className="rounded-[var(--color-public-radius)] bg-[var(--color-public-tint)] p-3 text-sm" aria-live="polite">
          <dl className="space-y-1">
            <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">시간 요금({fee.hours}시간)</dt><dd className="tabular-nums">{formatWon(fee.baseFee)}</dd></div>
            {fee.airconFee > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">냉난방</dt><dd className="tabular-nums">{formatWon(fee.airconFee)}</dd></div>}
            {fee.extraPeopleFee > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">인원 추가({fee.extraPeople}명)</dt><dd className="tabular-nums">{formatWon(fee.extraPeopleFee)}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">보증금(환불)</dt><dd className="tabular-nums">{formatWon(fee.deposit)}</dd></div>
          </dl>
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-[var(--color-public-line)] pt-2">
            <span className="font-bold text-[var(--color-public-ink)]">입금할 금액</span>
            <span className="text-xl font-black tabular-nums text-[var(--color-public-ink)]">{formatWon(fee.total)}</span>
          </div>
          {startHour === null && <p className="mt-1 text-xs text-[var(--color-public-muted)]">시작 시간을 고르면 그 시간 기준으로 확정됩니다.</p>}
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
        {pending ? "신청하는 중…" : fee && startHour !== null ? `대관 신청하기 · ${formatWon(fee.total)}` : "대관 신청하기"}
      </button>
      <p className="-mt-3 text-center text-xs text-[var(--color-public-muted)]">지금은 신청만 접수돼요. 결제는 원장님 승인 후 계좌이체로 합니다.</p>
    </form>
  );
}
