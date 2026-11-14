"use client";

/**
 * 체육관 대관 신청 폼(공개).
 * 요금은 화면에서 실시간으로 보여 주지만, 저장 금액은 서버가 같은 함수(calculateRentalFee)로 다시 계산한다.
 * 날짜는 월 달력(오늘~60일), 시작은 10분 단위, 이용은 30분 단위(1~6시간) — 2026-11-08 원장 지시.
 * 시간은 «시간 고르기» 버튼 → 시트(RentalTimeSheet)에서 고른다(칸 80여 개를 화면에 펼치지 않는다 — 승인표 2026-11-08).
 * 재원생 무료(2시간)·보증금 환불 계좌·개인정보 동의 — 2026-11-08 원장 승인.
 * 재원생 무료는 «로그인한 학부모 계정의 연결 재원생»만(원장 지시) — 로그인 여부는 이 화면이 서버 액션으로 묻는다
 * (페이지는 정적 그대로라 캐시가 바뀌지 않는다).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { publicErrorText } from "@/components/ui/public-error-text";
import { addDaysKst, kstDow, todayKst } from "@/lib/datetime/kst";
import {
  RENTAL_BOOKING_DAYS,
  RENTAL_FEE,
  RENTAL_MAX_HEADCOUNT,
  RENTAL_MIN_MINUTES,
  RENTAL_REFUND_BANKS,
  buildRentalCalendar,
  calculateRentalFee,
  checkRentalRefundAccount,
  formatRentalPhone,
  formatRentalTime,
  formatWon,
  minuteLabel,
  rentalDurationLabel,
  shiftYm,
  type RentalDay,
} from "@/lib/rental/gym-rental-rules";
import {
  getRentalMemberContext,
  getRentalSlots,
  submitRentalRequest,
  type RentalMemberContext,
  type RentalSubmitResult,
} from "@/app/actions/rental";
import RentalTimeSheet, { availableRentalHours } from "./RentalTimeSheet";

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

const INPUT_CLASS = "mt-1 block min-h-11 w-full rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-3 font-normal text-[var(--color-public-ink)]";

// homeHref = 접수 뒤 «홈으로» 주소. 공개 화면은 "/"(기본), 학부모 앱 안은 "/mypage"(앱 범위 밖으로 나가지 않게 — 2026-11-14 c9)
export default function RentalClient({ homeHref = "/" }: { homeHref?: string } = {}) {
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const timeButtonRef = useRef<HTMLButtonElement>(null);
  const [headcount, setHeadcount] = useState(6);
  const [useAircon, setUseAircon] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [purpose, setPurpose] = useState("");
  // 재원생 무료 — 로그인한 학부모 계정에 연결된 재원생이 있을 때만 체크칸이 보인다. 서버가 계정 연결·재원을 다시 확인한다.
  const [memberCtx, setMemberCtx] = useState<RentalMemberContext | null>(null);
  const [memberChecked, setMemberChecked] = useState(false);
  const [pickedStudentId, setPickedStudentId] = useState("");
  const memberStudents = memberCtx?.students ?? [];
  const memberFree = memberChecked && memberStudents.length > 0;
  // 학생이 한 명이면 따로 고르지 않는다
  const memberStudentId = memberStudents.length === 1 ? memberStudents[0].id : pickedStudentId;
  // 보증금 환불 계좌(보증금이 있는 신청만)
  const [refundBank, setRefundBank] = useState("");
  const [refundAccount, setRefundAccount] = useState("");
  const [refundHolder, setRefundHolder] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [copied, setCopied] = useState<"" | "account" | "amount">("");
  const [pending, startTransition] = useTransition();
  const errorRef = useRef<HTMLDivElement>(null);
  // 신청 완료 화면(접수증) — 접수 직후 이 카드가 첫 화면에 보이게 스크롤·포커스를 옮긴다
  const receiptRef = useRef<HTMLDivElement>(null);
  const receiptTitleRef = useRef<HTMLHeadingElement>(null);

  // 접수증이 화면에 붙은 «뒤»에 옮긴다(붙기 전에는 옮길 대상이 없다).
  // 예전엔 window.scrollTo(맨 위)라 히어로·요금 안내가 보이고 접수증은 아래로 밀려 있었다(원장 지시 2026-11-08).
  useEffect(() => {
    if (!receipt) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 화면 읽기 프로그램도 «접수되었습니다»부터 읽게 제목에 포커스 — 포커스가 멋대로 스크롤하지 않게 막고 직접 옮긴다
    receiptTitleRef.current?.focus({ preventScroll: true });
    // 위쪽 고정 헤더에 가리지 않게 카드에 scroll-mt 를 줬다
    receiptRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [receipt]);

  // 로그인 계정·연결 재원생을 한 번 묻는다. 신청자 칸이 비어 있으면 계정 이름·번호로 미리 채운다(수정 가능).
  useEffect(() => {
    let alive = true;
    getRentalMemberContext()
      .then((ctx) => {
        if (!alive) return;
        setMemberCtx(ctx);
        if (ctx.name) setName((current) => current || ctx.name);
        if (ctx.phone) setPhone((current) => current || formatRentalPhone(ctx.phone.replace(/\D/g, "")));
      })
      .catch(() => {
        if (alive) setMemberCtx({ signedIn: false, name: "", phone: "", students: [] });
      });
    return () => {
      alive = false;
    };
  }, []);

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

  const openHours = useMemo(() => (day ? availableRentalHours(day) : []), [day]);
  const selectedOption = day && startMinute !== null ? day.starts.find((s) => s.minute === startMinute) ?? null : null;
  // 고른 시간이 그사이 막혔으면(새로 받은 가능 시간 기준) 고른 것으로 치지 않는다
  const timeChosen = startMinute !== null && !!selectedOption?.available && selectedOption.maxMinutes >= durationMinutes;

  // 요금 미리보기 — 재원생 체크 시 무료 적용 «가정»(서버 확인 후 확정)
  const feeOf = (minutes: number) => {
    try {
      return calculateRentalFee({ durationMinutes: minutes, headcount, useAircon, memberFree });
    } catch {
      return null;
    }
  };
  const fee = feeOf(durationMinutes); // 계산이 가벼워 매번 다시 계산한다
  const needsRefundAccount = (fee?.deposit ?? RENTAL_FEE.deposit) > 0;

  // 날짜를 바꾸면 고른 시간은 비운다(다른 날의 칸이라)
  function selectDate(ymd: string) {
    setPickedDate(ymd);
    setStartMinute(null);
    setDurationMinutes(RENTAL_MIN_MINUTES);
  }

  function closeSheet() {
    setSheetOpen(false);
    // 닫으면 포커스를 «시간 고르기» 버튼으로 돌려준다
    requestAnimationFrame(() => timeButtonRef.current?.focus());
  }

  function confirmTime(start: number, minutes: number) {
    setStartMinute(start);
    setDurationMinutes(minutes);
    closeSheet();
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
    if (!timeChosen) return showError("이용할 시간을 골라 주세요. «시간 고르기»를 눌러 주세요.");
    if (!name.trim()) return showError("신청자 이름을 입력해 주세요.");
    if (!phone.trim()) return showError("휴대폰 번호를 입력해 주세요.");
    if (!purpose.trim()) return showError("사용 목적을 입력해 주세요. 예: 동호회 농구 연습");
    if (memberFree && !memberStudentId) return showError("재원생 무료 대관은 학생을 골라 주세요.");
    if (needsRefundAccount) {
      // 서버와 같은 검사 함수 — 화면에서 먼저 알려 준다
      const checked = checkRentalRefundAccount({ refundBank, refundAccount, refundHolder });
      if (!checked.ok) return showError(checked.message);
    }
    if (!agreed) return showError("이용 규칙에 동의해 주세요.");
    if (!agreedPrivacy) return showError("개인정보 수집·이용에 동의해 주세요. 동의하지 않으면 신청할 수 없어요.");
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
          agreedPrivacy,
          memberFree,
          memberStudentId: memberFree ? memberStudentId : "", // 서버가 이 계정의 연결 재원생인지 다시 확인한다
          // 재원생 무료(보증금 0원)면 환불 계좌를 보내지 않는다
          refundBank: needsRefundAccount ? refundBank : "",
          refundAccount: needsRefundAccount ? refundAccount : "",
          refundHolder: needsRefundAccount ? refundHolder : "",
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
        // 스크롤은 접수증이 그려진 뒤 위 useEffect 가 한다(맨 위로 올리지 않는다)
      } catch (err) {
        showError(publicErrorText(err, "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      }
    });
  }

  // 간편송금에 붙여넣기 좋게 — 계좌는 «은행명 계좌번호»(예금주 제외, 서버가 만들어 준다), 금액은 숫자만
  async function copyText(kind: "account" | "amount", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setCopied("");
    }
  }

  // ── 신청 완료 화면: 접수 번호 · 넣은 내용 · 지금 단계 · 다음 할 일 · 입금 계좌 ──
  if (receipt) {
    const nothingToPay = receipt.totalAmount === 0; // 재원생 2시간 이내 = 입금 없음
    const steps = nothingToPay ? ["신청 접수", "원장님 승인", "확정"] : ["신청 접수", "원장님 승인", "입금", "확정"];
    return (
      // scroll-mt-24 = 위쪽 고정 헤더 높이만큼 띄워서 멈춘다(헤더에 제목이 가리지 않게)
      <div ref={receiptRef} className="public-card scroll-mt-24 p-4 sm:p-5" aria-live="polite">
        <div className="flex items-center gap-2">
          {/* tabIndex=-1: Tab 으로 가지는 않지만, 접수 직후 코드로 포커스를 줄 수 있게 */}
          <h2 ref={receiptTitleRef} tabIndex={-1} className="text-xl font-bold text-[var(--color-public-ink)] outline-none">{duplicate ? "이미 접수된 신청입니다" : "대관 신청이 접수되었습니다"}</h2>
        </div>
        <p className="mt-1 text-sm break-keep text-[var(--color-public-muted)]">
          <b className="text-[var(--color-public-ink)]">원장님 승인 후 확정</b>됩니다.
          {nothingToPay ? " 승인 문자를 기다려 주세요." : " 승인 안내를 받으면 아래 계좌로 입금해 주세요."}
        </p>

        {/* 입금 안내 — 첫 화면(스크롤 없이)에 계좌·금액과 복사 버튼이 바로 보이게 제목 바로 아래에 둔다(원장 지시 2026-11-08).
            이 화면에서만 계좌를 보여 준다. 입금할 돈이 없으면 계좌 대신 기다림 안내 */}
        {nothingToPay ? (
          <div className="mt-3 rounded-[var(--color-public-radius)] border border-[var(--color-public-accent)] bg-[var(--color-public-tint)] p-3">
            <p className="text-base font-semibold break-keep text-[var(--color-public-ink)]">입금할 금액이 없어요. 원장님 승인 문자를 기다려 주세요</p>
          </div>
        ) : (
          <div className="mt-3 space-y-2 rounded-[var(--color-public-radius)] border border-[var(--color-public-accent)] bg-[var(--color-public-tint)] p-3">
            {/* 계좌 줄: 계좌 글자 + 바로 옆 [계좌 복사] (근접성 — 복사 버튼을 복사할 값 옆에) */}
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--color-public-muted)]">입금 계좌</p>
                <p className="text-sm font-semibold break-keep text-[var(--color-public-ink)]">{receipt.bankAccount}</p>
              </div>
              <button type="button" onClick={() => copyText("account", receipt.bankCopyText)} className="public-btn-secondary shrink-0 text-sm">
                {copied === "account" ? "계좌를 복사했어요" : "계좌 복사"}
              </button>
            </div>
            {/* 금액 줄: 금액 + 바로 옆 [금액 복사] — 복사값은 숫자만 */}
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--color-public-muted)]">입금할 금액</p>
                <p className="text-2xl font-bold tabular-nums text-[var(--color-public-ink)]">{formatWon(receipt.totalAmount)}</p>
              </div>
              <button type="button" onClick={() => copyText("amount", String(receipt.totalAmount))} className="public-btn-secondary shrink-0 text-sm">
                {copied === "amount" ? "금액을 복사했어요" : "금액 복사"}
              </button>
            </div>
            <p className="text-xs break-keep text-[var(--color-public-muted)]">
              승인 안내를 받은 뒤 입금해 주세요. 입금자명은 신청자 이름으로 해 주세요. 입금이 확인되면 확정됩니다.
            </p>
          </div>
        )}

        {/* 넣은 내용(접수 번호·일시 등) — 입금 안내 아래로 내렸다 */}
        <dl className="mt-4 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-[var(--color-public-muted)]">접수 번호</dt>
          <dd className="font-semibold tabular-nums text-[var(--color-public-ink)]">{receipt.number}</dd>
          <dt className="text-[var(--color-public-muted)]">이용 일시</dt>
          <dd className="font-semibold text-[var(--color-public-ink)]">{longDate(receipt.rentalDate)} {formatRentalTime(receipt.startMinute, receipt.endMinute)}</dd>
          <dt className="text-[var(--color-public-muted)]">인원</dt>
          <dd className="text-[var(--color-public-ink)]">{receipt.headcount}명{receipt.useAircon ? " · 냉난방 사용" : ""}</dd>
          <dt className="text-[var(--color-public-muted)]">이용료</dt>
          <dd className="tabular-nums text-[var(--color-public-ink)]">{formatWon(receipt.usageFee)}{receipt.memberFree ? " (재원생 2시간 무료 적용)" : ""}</dd>
          <dt className="text-[var(--color-public-muted)]">보증금</dt>
          <dd className="tabular-nums text-[var(--color-public-ink)]">{receipt.deposit > 0 ? `${formatWon(receipt.deposit)} (사용 후 환불)` : "없음"}</dd>
        </dl>

        {/* 단계 표시 — 지금 어디인지 */}
        <ol className={`mt-4 grid gap-1 text-center text-xs font-medium ${nothingToPay ? "grid-cols-3" : "grid-cols-4"}`}>
          {steps.map((step, index) => (
            <li
              key={step}
              className={`rounded-[var(--color-public-radius)] border px-1 py-2 ${index === 0
                ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]"
                : "border-[var(--color-public-line)] text-[var(--color-public-muted)]"}`}
            >
              {step}
            </li>
          ))}
        </ol>

        <ul className="mt-4 space-y-1 text-sm break-keep text-[var(--color-public-ink)]">
          <li>· 실내운동화를 꼭 챙겨 오세요.</li>
          <li>· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.</li>
        </ul>
        <Link href={homeHref} className="public-btn-text mt-2">홈으로</Link>
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

      {/* 로그인 안 했으면 맨 위에서 로그인 유도 — 입력하기 전에 보이게(로그인하러 가면 입력값은 사라진다) */}
      {memberCtx && !memberCtx.signedIn && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--color-public-radius)] bg-[var(--color-public-tint)] px-3 py-2">
          <p className="min-w-0 flex-1 text-sm font-medium break-keep text-[var(--color-public-ink)]">재원생 가족이면 로그인하고 신청하면 2시간 무료</p>
          <Link href="/login?redirect=%2Frental" className="public-btn-secondary shrink-0 text-sm">로그인</Link>
        </div>
      )}

      {/* 1. 날짜 — 월 달력. 오늘~60일 안만 고를 수 있고, 지난 날·범위 밖은 흐리게 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-bold text-[var(--color-public-ink)]">날짜</legend>
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPickedYm(shiftYm(viewYm, -1))}
            disabled={viewYm <= firstYm}
            aria-label="이전 달"
            className="flex h-11 shrink-0 items-center justify-center rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] px-3 text-sm font-medium text-[var(--color-public-ink)] disabled:opacity-40"
          >
            이전
          </button>
          <p className="text-sm font-semibold tabular-nums text-[var(--color-public-ink)]" aria-live="polite">{monthTitle(viewYm)}</p>
          <button
            type="button"
            onClick={() => setPickedYm(shiftYm(viewYm, 1))}
            disabled={viewYm >= lastYm}
            aria-label="다음 달"
            className="flex h-11 shrink-0 items-center justify-center rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] px-3 text-sm font-medium text-[var(--color-public-ink)] disabled:opacity-40"
          >
            다음
          </button>
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1 text-center text-xs font-medium text-[var(--color-public-muted)]" aria-hidden="true">
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
                className={`flex min-h-11 flex-col items-center justify-center rounded-[var(--color-public-radius)] border text-sm font-medium leading-tight tabular-nums ${!cell.bookable
                  ? "cursor-not-allowed border-transparent text-[var(--color-public-muted)] opacity-40"
                  : active
                    ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]"
                    : cell.isToday
                      ? "border-[var(--color-public-accent)] text-[var(--color-public-ink)]"
                      : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
              >
                {cell.day}
                {cell.isToday && <span className="text-xs">오늘</span>}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* 2. 시간 — 버튼 하나. 누르면 시트에서 시 → 분 → 이용 시간 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-bold text-[var(--color-public-ink)]">
          시간 <span className="text-sm font-normal text-[var(--color-public-muted)]">{longDate(date)}</span>
        </legend>
        {dayError ? (
          <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-public-accent)]">{dayError}</p>
        ) : !day ? (
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">가능한 시간을 확인하는 중…</p>
        ) : openHours.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">이 날은 비어 있는 시간이 없습니다. 다른 날짜를 골라 주세요.</p>
        ) : (
          <>
            <p className="mt-1 text-xs break-keep text-[var(--color-public-muted)]">
              이용 가능 {minuteLabel(day.openMinute)}~{minuteLabel(day.closeMinute)}
              {day.blocks.length > 0 && (
                <> · 제외 {day.blocks.map((b) => `${BLOCK_LABEL[b.reason]} ${minuteLabel(b.startMinute)}~${minuteLabel(b.endMinute)}`).join(", ")}</>
              )}
            </p>
            <button
              ref={timeButtonRef}
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-haspopup="dialog"
              className={`mt-2 flex min-h-12 w-full items-center gap-2 rounded-[var(--color-public-radius)] border px-3 text-left text-sm font-medium ${timeChosen
                ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]"
                : "border-[var(--color-public-ink)] text-[var(--color-public-ink)]"}`}
            >
              <span className="min-w-0 flex-1 tabular-nums">
                {timeChosen && startMinute !== null ? formatRentalTime(startMinute, startMinute + durationMinutes) : "시간 고르기"}
              </span>
              {timeChosen && <span className="underline underline-offset-2">변경</span>}
            </button>
          </>
        )}
      </fieldset>

      {/* 시트는 열 때마다 새로 만든다(지금 고른 값에서 시작) */}
      {sheetOpen && day && (
        <RentalTimeSheet
          open
          day={day}
          dateLabel={longDate(date)}
          initialStart={startMinute}
          initialDuration={durationMinutes}
          priceOf={(minutes) => feeOf(minutes)?.total ?? null}
          onClose={closeSheet}
          onConfirm={confirmTime}
        />
      )}

      {/* 3. 인원·냉난방 */}
      <fieldset className="min-w-0">
        <legend className="text-base font-bold text-[var(--color-public-ink)]">인원·냉난방</legend>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1" role="group" aria-label="인원">
            <button type="button" onClick={() => changeHeadcount(-1)} aria-label="인원 줄이기" className="public-btn-secondary w-11 px-0!">−</button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={RENTAL_MAX_HEADCOUNT}
              value={headcount}
              onChange={(e) => setHeadcount(Math.min(RENTAL_MAX_HEADCOUNT, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
              aria-label="인원 수"
              className="min-h-11 w-16 rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] text-center font-semibold tabular-nums text-[var(--color-public-ink)]"
            />
            <button type="button" onClick={() => changeHeadcount(1)} aria-label="인원 늘리기" className="public-btn-secondary w-11 px-0!">+</button>
            <span className="ml-1 text-sm text-[var(--color-public-ink)]">명</span>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--color-public-ink)]">
            <input type="checkbox" checked={useAircon} onChange={(e) => setUseAircon(e.target.checked)} className="h-5 w-5 accent-[var(--color-public-accent)]" />
            냉난방 사용(1시간 {formatWon(RENTAL_FEE.airconPerHour)})
          </label>
        </div>
        {headcount > RENTAL_FEE.baseHeadcount && (
          <p className="mt-1 text-xs text-[var(--color-public-muted)]">
            {RENTAL_FEE.baseHeadcount}명을 넘는 {headcount - RENTAL_FEE.baseHeadcount}명은 1인 1시간 {formatWon(RENTAL_FEE.extraPersonPerHour)}이 추가됩니다.
          </p>
        )}
      </fieldset>

      {/* 4. 재원생 무료 — 로그인한 학부모 계정에 연결된 재원생이 있을 때만(없으면 아예 보이지 않는다) */}
      {memberStudents.length > 0 && (
        <fieldset className="min-w-0">
          <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm break-keep text-[var(--color-public-ink)]">
            <input type="checkbox" checked={memberChecked} onChange={(e) => setMemberChecked(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-public-accent)]" />
            <span>
              <b>재원생 무료 대관</b> — 2시간까지 무료(가족·친구 함께 가능). 냉난방·인원 추가는 별도, 보증금은 없어요.
            </span>
          </label>
          {memberChecked && memberStudents.length > 1 && (
            <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="재원생 고르기">
              {memberStudents.map((student) => (
                <button
                  key={student.id}
                  type="button"
                  aria-pressed={pickedStudentId === student.id}
                  onClick={() => setPickedStudentId(student.id)}
                  className={`min-h-11 rounded-[var(--color-public-radius)] border px-3 text-sm font-medium ${pickedStudentId === student.id
                    ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]"
                    : "border-[var(--color-public-line)] text-[var(--color-public-ink)]"}`}
                >
                  {student.name}
                </button>
              ))}
            </div>
          )}
          {memberChecked && memberStudents.length === 1 && (
            <p className="mt-1 text-xs text-[var(--color-public-muted)]">재원생: {memberStudents[0].name}</p>
          )}
        </fieldset>
      )}

      {/* 5. 실시간 요금 */}
      {fee && (
        <div className="rounded-[var(--color-public-radius)] bg-[var(--color-public-tint)] p-3 text-sm" aria-live="polite">
          <dl className="space-y-1">
            <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">시간 요금({rentalDurationLabel(fee.durationMinutes)})</dt><dd className="tabular-nums">{formatWon(fee.baseFee)}</dd></div>
            {fee.freeDiscount > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">재원생 2시간 무료</dt><dd className="tabular-nums">−{formatWon(fee.freeDiscount)}</dd></div>}
            {fee.airconFee > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">냉난방</dt><dd className="tabular-nums">{formatWon(fee.airconFee)}</dd></div>}
            {fee.extraPeopleFee > 0 && <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">인원 추가({fee.extraPeople}명)</dt><dd className="tabular-nums">{formatWon(fee.extraPeopleFee)}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-[var(--color-public-muted)]">보증금(환불)</dt><dd className="tabular-nums">{fee.deposit > 0 ? formatWon(fee.deposit) : "없음"}</dd></div>
          </dl>
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-[var(--color-public-line)] pt-2">
            <span className="font-semibold text-[var(--color-public-ink)]">입금할 금액</span>
            <span className="text-xl font-bold tabular-nums text-[var(--color-public-ink)]">{formatWon(fee.total)}</span>
          </div>
          {!timeChosen && <p className="mt-1 text-xs text-[var(--color-public-muted)]">시간을 고르면 그 시간 기준으로 확정됩니다.</p>}
          {memberFree && <p className="mt-1 text-xs text-[var(--color-public-muted)]">재원생 무료는 서버 확인 후 확정돼요.</p>}
        </div>
      )}

      {/* 6. 신청자 정보 */}
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-base font-bold text-[var(--color-public-ink)]">신청자</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm font-medium text-[var(--color-public-ink)]">
            이름
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="name"
              placeholder="입금자명과 같게"
              className={INPUT_CLASS}
            />
          </label>
          <label className="block text-sm font-medium text-[var(--color-public-ink)]">
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
              className={`${INPUT_CLASS} tabular-nums`}
            />
          </label>
        </div>
        <label className="block text-sm font-medium text-[var(--color-public-ink)]">
          사용 목적
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            maxLength={300}
            placeholder="예: 동호회 농구 연습, 아이 생일 파티"
            className={INPUT_CLASS}
          />
        </label>
      </fieldset>

      {/* 7. 보증금 환불 계좌 — 보증금이 있을 때만(재원생 무료는 보증금 0원이라 숨긴다) */}
      {needsRefundAccount && (
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-base font-bold text-[var(--color-public-ink)]">
            보증금 환불 계좌 <span className="text-sm font-normal text-[var(--color-public-muted)]">사용 후 이 계좌로 돌려드려요</span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
            <label className="block text-sm font-medium text-[var(--color-public-ink)]">
              은행
              <select value={refundBank} onChange={(e) => setRefundBank(e.target.value)} className={INPUT_CLASS}>
                <option value="">은행 선택</option>
                {RENTAL_REFUND_BANKS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-[var(--color-public-ink)]">
              계좌번호
              <input
                value={refundAccount}
                onChange={(e) => setRefundAccount(e.target.value.replace(/[^\d-]/g, "").slice(0, 20))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="숫자만 10~16자리"
                className={`${INPUT_CLASS} tabular-nums`}
              />
            </label>
          </div>
          <label className="block text-sm font-medium text-[var(--color-public-ink)]">
            예금주
            <input value={refundHolder} onChange={(e) => setRefundHolder(e.target.value)} maxLength={20} autoComplete="off" className={INPUT_CLASS} />
          </label>
        </fieldset>
      )}

      {/* 8. 동의 — 이용 규칙 + 개인정보(둘 다 필수) */}
      <div className="space-y-2">
        <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm break-keep text-[var(--color-public-ink)]">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-public-accent)]" />
          <span>
            <b>(필수) 이용 규칙에 동의합니다.</b> 실내운동화 착용, 사용 후 정리정돈·냉난방 끄기, 인원 준수
            {/* 재원생 무료는 보증금이 없어 «차감» 문장을 보이지 않는다(저장 값과는 무관) */}
            {memberFree ? "를 지키겠습니다." : "를 지키지 않으면 보증금이 차감될 수 있습니다."}
          </span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm break-keep text-[var(--color-public-ink)]">
          <input type="checkbox" checked={agreedPrivacy} onChange={(e) => setAgreedPrivacy(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-public-accent)]" />
          <span>
            <b>(필수) 개인정보 수집·이용에 동의합니다.</b>
            <span className="mt-1 block text-xs text-[var(--color-public-muted)]">
              수집 항목: 이름·연락처·보증금 환불 계좌(재원생 무료는 로그인 계정·고른 학생) · 목적: 대관 신청 확인·연락·보증금 환불 ·
              보유 기간: 대관 종료 후 보증금 환불 완료 시점부터 1년(법령이 따로 정한 경우 그 기간) ·
              동의하지 않을 수 있으나, 동의하지 않으면 대관 신청을 할 수 없어요.
            </span>
          </span>
        </label>
      </div>

      {error && (
        <div ref={errorRef} role="alert" className="flex items-center gap-2 rounded-[var(--color-public-radius)] border border-[var(--color-public-accent)] px-3 py-2 text-sm font-medium text-[var(--color-public-accent)]">
          {error}
        </div>
      )}

      {/* 화면의 주인공 버튼은 이것 하나 */}
      <button type="submit" disabled={pending} className="public-btn-primary w-full text-base">
        {pending ? "신청하는 중…" : fee && timeChosen ? `대관 신청하기 · ${formatWon(fee.total)}` : "대관 신청하기"}
      </button>
      <p className="-mt-3 text-center text-xs text-[var(--color-public-muted)]">지금은 신청만 접수돼요. 결제는 원장님 승인 후 계좌이체로 합니다.</p>
    </form>
  );
}
