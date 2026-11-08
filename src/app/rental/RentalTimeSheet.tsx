"use client";

/**
 * 체육관 대관 — 시간 고르기 시트(휴대폰: 아래에서 올라오는 시트, PC: 가운데 창).
 *
 * 왜 따로 두나: 시작 칸 70개 + 이용 칸 11개를 화면에 다 펼치면 휴대폰에서 스크롤이 길어진다(원장 승인표 2026-11-08).
 * 그래서 화면에는 «시간 고르기» 버튼 하나만 두고, 누르면 ① 시 → ② 분 → ③ 이용 시간 순서로 고른다.
 *
 * ⚠️ 막힘 규칙을 여기서 새로 만들지 않는다. 서버가 준 buildRentalDay 결과(starts[].available / maxMinutes)만 읽는다
 *    — 서버 검증도 같은 함수라 «화면에선 되는데 신청하면 거절» 이 생기지 않는다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { usePublicOverlayOpen } from "@/components/public-floating";
import {
  RENTAL_DURATION_STEP_MINUTES,
  RENTAL_MIN_MINUTES,
  RENTAL_START_STEP_MINUTES,
  formatWon,
  minuteLabel,
  rentalDurationLabel,
  type RentalDay,
  type RentalStartOption,
} from "@/lib/rental/gym-rental-rules";

/** 한 시 안의 분 칸 — 00·10·20·30·40·50 */
const MINUTE_STEPS = Array.from({ length: 60 / RENTAL_START_STEP_MINUTES }, (_, i) => i * RENTAL_START_STEP_MINUTES);

/** 가능한 시작이 하나라도 있는 «시» 목록 */
export function availableRentalHours(day: RentalDay): number[] {
  const hours = new Set<number>();
  for (const option of day.starts) if (option.available) hours.add(Math.floor(option.minute / 60));
  return [...hours].sort((a, b) => a - b);
}

/** 이용 시간을 그 시작에서 쓸 수 있는 범위로 맞춘다(최소 1시간, 최대 maxMinutes, 30분 단위) */
export function clampRentalDuration(minutes: number, maxMinutes: number): number {
  if (maxMinutes < RENTAL_MIN_MINUTES) return RENTAL_MIN_MINUTES;
  const stepped = Math.round(minutes / RENTAL_DURATION_STEP_MINUTES) * RENTAL_DURATION_STEP_MINUTES;
  return Math.min(maxMinutes, Math.max(RENTAL_MIN_MINUTES, stepped));
}

type Props = {
  open: boolean;
  day: RentalDay;
  dateLabel: string; // "2026년 11월 9일(월)"
  initialStart: number | null;
  initialDuration: number;
  /** 고른 시간의 입금 예정 금액(화면 미리보기 — 서버가 다시 계산한다) */
  priceOf: (durationMinutes: number) => number | null;
  onClose: () => void;
  onConfirm: (startMinute: number, durationMinutes: number) => void;
};

export default function RentalTimeSheet({ open, day, dateLabel, initialStart, initialDuration, priceOf, onClose, onConfirm }: Props) {
  const hours = useMemo(() => availableRentalHours(day), [day]);
  const byMinute = useMemo(() => new Map<number, RentalStartOption>(day.starts.map((s) => [s.minute, s])), [day]);

  // 시트 안에서 고르는 값(«이 시간으로»를 눌러야 신청서에 들어간다)
  const initialOption = initialStart !== null ? byMinute.get(initialStart) : undefined;
  const [hour, setHour] = useState<number | null>(initialOption?.available ? Math.floor(initialOption.minute / 60) : null);
  const [start, setStart] = useState<number | null>(initialOption?.available ? initialOption.minute : null);
  const [duration, setDuration] = useState(initialOption?.available ? clampRentalDuration(initialDuration, initialOption.maxMinutes) : RENTAL_MIN_MINUTES);

  const selected = start !== null ? byMinute.get(start) ?? null : null;
  const maxMinutes = selected?.available ? selected.maxMinutes : 0;
  const price = selected ? priceOf(duration) : null;

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 열려 있는 동안 뒤 화면 스크롤 잠금 + 챗봇 같은 떠 있는 버튼 숨김
  usePublicOverlayOpen(open);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // 열리면 시트 안으로 포커스, ESC 로 닫기, Tab 은 시트 안에서만 돈다(키보드·화면읽기 사용자)
  useEffect(() => {
    if (!open) return;
    const node = dialogRef.current;
    const firstChip = node?.querySelector<HTMLElement>("[data-autofocus='true']");
    (firstChip ?? closeRef.current)?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled])")];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // 열릴 때 한 번만 포커스를 옮긴다(고를 때마다 포커스가 튀지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  function pickHour(h: number) {
    // 시를 바꾸면 분 선택은 처음부터
    setHour(h);
    if (start === null || Math.floor(start / 60) !== h) {
      setStart(null);
      setDuration(RENTAL_MIN_MINUTES);
    }
  }

  function pickStart(option: RentalStartOption) {
    // 시작을 바꾸면 이용 시간은 1시간에서 다시(그 시작에서 가능한 범위 안)
    setStart(option.minute);
    setDuration(clampRentalDuration(RENTAL_MIN_MINUTES, option.maxMinutes));
  }

  const chipBase = "min-h-11 rounded-[var(--color-public-radius)] border text-sm font-bold tabular-nums";
  const chipOn = "border-[var(--color-public-accent)] bg-[var(--color-public-accent)] text-[var(--color-public-white)]";
  const chipOff = "border-[var(--color-public-line)] text-[var(--color-public-ink)]";
  const chipDisabled = "cursor-not-allowed border-dashed border-[var(--color-public-line)] text-[var(--color-public-muted)] opacity-40";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="presentation">
      {/* 바깥(어두운 배경)을 누르면 닫힌다 */}
      <div className="absolute inset-0 bg-[var(--color-public-ink)]/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rental-time-sheet-title"
        className="relative flex max-h-[88vh] w-full flex-col rounded-t-2xl bg-[var(--color-public-paper)] sm:mx-4 sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-public-line)] px-4 py-2">
          <h2 id="rental-time-sheet-title" className="min-w-0 flex-1 text-base font-black text-[var(--color-public-ink)]">
            시간 고르기 <span className="text-sm font-bold text-[var(--color-public-muted)]">{dateLabel}</span>
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--color-public-radius)] text-[var(--color-public-muted)]"
          >
            <FontFreeIcon name="close" size={22} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {/* ① 시 — 가능한 시작이 하나라도 있는 시만 */}
          <section>
            <p className="text-sm font-black text-[var(--color-public-ink)]">① 시작 시</p>
            <div className="mt-1.5 grid grid-cols-5 gap-1.5" role="group" aria-label="시작 시">
              {hours.map((h, index) => (
                <button
                  key={h}
                  type="button"
                  aria-pressed={hour === h}
                  data-autofocus={hour === null ? index === 0 : hour === h}
                  onClick={() => pickHour(h)}
                  className={`${chipBase} ${hour === h ? chipOn : chipOff}`}
                >
                  {h}시
                </button>
              ))}
            </div>
          </section>

          {/* ② 분 — 그 시에서 안 되는 분은 흐리게(누를 수 없음) */}
          {hour !== null && (
            <section>
              <p className="text-sm font-black text-[var(--color-public-ink)]">② 시작 분</p>
              <div className="mt-1.5 grid grid-cols-6 gap-1.5" role="group" aria-label="시작 분">
                {MINUTE_STEPS.map((m) => {
                  const option = byMinute.get(hour * 60 + m);
                  const ok = !!option?.available;
                  const active = start === hour * 60 + m;
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={!ok}
                      aria-pressed={active}
                      aria-label={`${minuteLabel(hour * 60 + m)}${ok ? "" : " 불가"}`}
                      onClick={() => option && pickStart(option)}
                      className={`${chipBase} ${!ok ? chipDisabled : active ? chipOn : chipOff}`}
                    >
                      {String(m).padStart(2, "0")}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* ③ 이용 시간 — 30분씩, 최소 1시간, 최대 = 그 시작에서 이어서 쓸 수 있는 시간 */}
          {selected?.available && (
            <section>
              <p className="text-sm font-black text-[var(--color-public-ink)]">
                ③ 이용 시간 <span className="text-xs font-semibold text-[var(--color-public-muted)]">최대 {rentalDurationLabel(maxMinutes)}</span>
              </p>
              <div className="mt-1.5 flex items-center gap-2" role="group" aria-label="이용 시간">
                <button
                  type="button"
                  onClick={() => setDuration((d) => clampRentalDuration(d - RENTAL_DURATION_STEP_MINUTES, maxMinutes))}
                  disabled={duration <= RENTAL_MIN_MINUTES}
                  aria-label="30분 줄이기"
                  className="public-btn-secondary w-11 px-0 disabled:opacity-40"
                >
                  −
                </button>
                <output aria-live="polite" className="min-w-28 text-center text-lg font-black tabular-nums text-[var(--color-public-ink)]">
                  {rentalDurationLabel(duration)}
                </output>
                <button
                  type="button"
                  onClick={() => setDuration((d) => clampRentalDuration(d + RENTAL_DURATION_STEP_MINUTES, maxMinutes))}
                  disabled={duration >= maxMinutes}
                  aria-label="30분 늘리기"
                  className="public-btn-secondary w-11 px-0 disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </section>
          )}
        </div>

        {/* 하단 고정 줄 — 고른 시간·금액 + 확정 버튼(주인공 버튼 하나) */}
        <div className="flex items-center gap-3 border-t border-[var(--color-public-line)] px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <p className="min-w-0 flex-1 text-sm font-bold tabular-nums text-[var(--color-public-ink)]" aria-live="polite">
            {selected?.available && start !== null
              ? <>{minuteLabel(start)}~{minuteLabel(start + duration)}{price !== null && <span className="text-[var(--color-public-muted)]"> · {formatWon(price)}</span>}</>
              : <span className="text-[var(--color-public-muted)]">시·분을 골라 주세요</span>}
          </p>
          <button
            type="button"
            disabled={!selected?.available || start === null}
            onClick={() => start !== null && onConfirm(start, duration)}
            className="public-btn-primary shrink-0 px-4 text-sm disabled:opacity-40"
          >
            이 시간으로
          </button>
        </div>
      </div>
    </div>
  );
}
