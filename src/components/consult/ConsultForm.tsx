"use client";

/**
 * 상담 신청 폼 — 홈페이지(/apply/consult)와 학부모 앱(/mypage/consult)이 같이 쓰는 부품 하나.
 * (2026-11-10 원장 승인 k1·m4: «학생 인적 사항·희망 수업·요청사항을 입력하면 관리자가 확인 후 유선 연락»)
 *
 * 왜 하나로: 입력 칸·검증·완료 화면이 두 곳에서 갈라지면 한쪽만 고쳐지는 사고가 난다.
 * 화면별로 다른 것은 «색 묶음»(공개 = --color-public-* / 앱 = --color-academy-*)과 보내는 서버 액션뿐이다.
 * 검증의 정본은 서버(consult-rules.validateConsultInput) — 여기서는 같은 규칙으로 먼저 알려 줄 뿐이다.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { submitConsultRequest, submitParentConsultRequest } from "@/app/actions/consult";
import {
  CONSULT_DAY_OPTIONS,
  CONSULT_GRADE_OPTIONS,
  CONSULT_LIMITS,
  CONSULT_TIME_OPTIONS,
  validateConsultInput,
} from "@/lib/consult/consult-rules";

type Mode = "public" | "parent";

type Props = {
  mode: Mode;
  /** 공개 화면에서만 — 챗봇 버튼으로 왔으면 "CHATBOT" */
  source?: "PUBLIC_WEB" | "CHATBOT";
  /** 학부모 앱 — 로그인 계정의 이름·번호를 미리 채운다(고칠 수 있다) */
  initialGuardianName?: string;
  initialGuardianPhone?: string;
  /** 완료 화면의 «급하면 전화» 번호 */
  contactPhone?: string;
  /** 완료 화면의 돌아가기 주소 */
  homeHref?: string;
};

// 색 묶음 — 하드코딩 색 없이 토큰만(공개 화면 / 학원 앱)
const STYLE: Record<Mode, { card: string; ink: string; muted: string; input: string; chipOn: string; chipOff: string; primary: string; secondary: string; error: string; accent: string }> = {
  public: {
    card: "public-card",
    ink: "text-[var(--color-public-ink)]",
    muted: "text-[var(--color-public-muted)]",
    input: "mt-1 block min-h-11 w-full rounded-[var(--color-public-radius)] border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-3 font-normal text-[var(--color-public-ink)]",
    chipOn: "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]",
    chipOff: "border-[var(--color-public-line)] text-[var(--color-public-muted)]",
    primary: "public-btn-primary w-full text-base",
    secondary: "public-btn-secondary",
    error: "border-[var(--color-public-accent)] text-[var(--color-public-accent)]",
    accent: "accent-[var(--color-public-accent)]",
  },
  parent: {
    card: "rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]",
    ink: "text-[var(--color-academy-ink)]",
    muted: "text-[var(--color-academy-muted)]",
    input: "mt-1 block min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 font-normal text-[var(--color-academy-ink)]",
    chipOn: "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)]",
    chipOff: "border-[var(--color-academy-line)] text-[var(--color-academy-muted)]",
    primary: "academy-button-primary w-full",
    secondary: "academy-button-secondary",
    error: "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
    accent: "accent-[var(--color-academy-primary)]",
  },
};

/** 입력 중 휴대폰 번호 모양 010-1234-5678 */
function formatPhoneTyping(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

export default function ConsultForm({ mode, source = "PUBLIC_WEB", initialGuardianName = "", initialGuardianPhone = "", contactPhone, homeHref }: Props) {
  const s = STYLE[mode];
  const [studentName, setStudentName] = useState("");
  const [grade, setGrade] = useState("");
  const [guardianName, setGuardianName] = useState(initialGuardianName);
  const [guardianPhone, setGuardianPhone] = useState(formatPhoneTyping(initialGuardianPhone));
  const [days, setDays] = useState<string[]>([]);
  const [times, setTimes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [privacy, setPrivacy] = useState(false);
  const [honeypot, setHoneypot] = useState(""); // 스팸 방지 숨김 칸(공개 화면만)
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const errorRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  // 오류가 나면 그 상자로, 접수되면 완료 제목으로 화면을 옮긴다(긴 폼 아래에서 눌러도 결과가 보이게)
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: "center" }); }, [error]);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const toggle = (list: string[], value: string, set: (next: string[]) => void) => {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
    setError("");
  };

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = { studentName, grade, guardianName, guardianPhone, preferredDays: days, preferredTimes: times, message, privacyConsent: privacy };
    // 서버와 같은 규칙으로 먼저 확인 — 보내기 전에 쉬운 말로 알려 준다
    const checked = validateConsultInput(input);
    if (!checked.ok) { setError(checked.message); return; }
    startTransition(async () => {
      try {
        const result = mode === "parent"
          ? await submitParentConsultRequest(input)
          : await submitConsultRequest({ ...input, honeypot, source });
        if (!result.ok) { setError(result.message); return; }
        setDone(true);
      } catch {
        setError("신청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
    });
  }

  // ── 접수 완료 화면 — «접수됐어요, 연락드릴게요» ──
  if (done) {
    return (
      <div className={`${s.card} p-4 sm:p-5`} aria-live="polite">
        <div className="flex items-center gap-2">
          <h2 ref={doneRef} tabIndex={-1} className={`text-xl font-bold outline-none ${s.ink}`}>
            상담 신청이 접수됐어요
          </h2>
        </div>
        <p className={`mt-2 text-sm break-keep ${s.muted}`}>
          학원에서 내용을 확인한 뒤 <b className={s.ink}>남겨 주신 번호로 전화드릴게요.</b>
          {contactPhone ? <> 급하시면 <a href={`tel:${contactPhone.replace(/-/g, "")}`} className={`font-medium underline underline-offset-2 ${s.ink}`}>{contactPhone}</a>로 연락해 주세요.</> : null}
        </p>
        <Link href={homeHref ?? "/"} className={`${s.secondary} mt-4 text-sm`}>
          {mode === "parent" ? "홈으로" : "처음으로"}
        </Link>
      </div>
    );
  }

  const chip = (on: boolean) => `min-h-11 rounded-xl border px-3 text-sm font-medium transition-colors ${on ? s.chipOn : s.chipOff}`;

  return (
    <form onSubmit={submit} className={`${s.card} min-w-0 space-y-4 p-4 sm:p-5`} noValidate>
      {/* 스팸 방지 숨김 칸 — 사람에게는 보이지 않는다(공개 화면만) */}
      {mode === "public" && (
        <div aria-hidden="true" className="hidden">
          <label>
            비워 두세요
            <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>
      )}

      {/* 1. 학생 — 이름·학년 한 줄(근접성) */}
      <fieldset className="min-w-0">
        <legend className={`text-base font-bold ${s.ink}`}>학생</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)]">
          <label className={`block text-sm font-medium ${s.ink}`}>
            이름 <span className={s.muted}>(필수)</span>
            <input value={studentName} onChange={(e) => { setStudentName(e.target.value); setError(""); }} maxLength={CONSULT_LIMITS.studentName} autoComplete="off" className={s.input} />
          </label>
          <label className={`block text-sm font-medium ${s.ink}`}>
            학년(나이) <span className={s.muted}>(필수)</span>
            <select value={grade} onChange={(e) => { setGrade(e.target.value); setError(""); }} className={s.input}>
              <option value="">선택</option>
              {CONSULT_GRADE_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
        </div>
      </fieldset>

      {/* 2. 연락받을 분 — 이름(선택)·휴대폰(필수) */}
      <fieldset className="min-w-0">
        <legend className={`text-base font-bold ${s.ink}`}>연락받을 분</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <label className={`block text-sm font-medium ${s.ink}`}>
            보호자 이름 <span className={s.muted}>(선택)</span>
            <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} maxLength={CONSULT_LIMITS.guardianName} autoComplete="name" className={s.input} />
          </label>
          <label className={`block text-sm font-medium ${s.ink}`}>
            휴대폰 번호 <span className={s.muted}>(필수)</span>
            <input value={guardianPhone} onChange={(e) => { setGuardianPhone(formatPhoneTyping(e.target.value)); setError(""); }} inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" className={`${s.input} tabular-nums`} />
          </label>
        </div>
      </fieldset>

      {/* 3. 희망 수업 — 요일·시간대(여러 개 고르기, 선택) */}
      <fieldset className="min-w-0">
        <legend className={`text-base font-bold ${s.ink}`}>희망 수업 <span className={`text-sm font-normal ${s.muted}`}>여러 개 골라도 돼요(선택)</span></legend>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="희망 요일">
          {CONSULT_DAY_OPTIONS.map((d) => (
            <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => toggle(days, d, setDays)} className={`${chip(days.includes(d))} w-11 px-0`}>{d}</button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="희망 시간대">
          {CONSULT_TIME_OPTIONS.map((t) => (
            <button key={t} type="button" aria-pressed={times.includes(t)} onClick={() => toggle(times, t, setTimes)} className={chip(times.includes(t))}>{t}</button>
          ))}
        </div>
      </fieldset>

      {/* 4. 요청사항 */}
      <label className={`block text-base font-bold ${s.ink}`}>
        요청사항 <span className={`text-sm font-normal ${s.muted}`}>(선택)</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={CONSULT_LIMITS.message}
          placeholder="예: 농구는 처음이에요. 형과 같은 시간에 다닐 수 있을까요?"
          className={`${s.input} py-2 text-sm`}
        />
      </label>

      {/* 5. 개인정보 동의(필수) — 무엇을 왜 얼마나 보관하는지 바로 아래 작게 */}
      <label className={`flex min-h-11 cursor-pointer items-start gap-2 text-sm break-keep ${s.ink}`}>
        <input type="checkbox" checked={privacy} onChange={(e) => { setPrivacy(e.target.checked); setError(""); }} className={`mt-0.5 h-5 w-5 shrink-0 ${s.accent}`} />
        <span>
          <b>(필수) 개인정보 수집·이용에 동의합니다.</b>
          <span className={`mt-1 block text-xs ${s.muted}`}>
            수집 항목: 학생 이름·학년(나이), 보호자 이름·휴대폰 번호, 희망 요일·시간, 요청사항 · 목적: 상담 연락 ·
            보유 기간: 상담 종료 후 6개월 · 동의하지 않을 수 있으나, 동의하지 않으면 상담 신청을 할 수 없어요.
          </span>
        </span>
      </label>

      {error && (
        <div ref={errorRef} role="alert" className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${s.error}`}>
          {error}
        </div>
      )}

      {/* 화면의 주인공 버튼은 이것 하나 */}
      <button type="submit" disabled={pending} className={s.primary}>
        {pending ? "보내는 중…" : "상담 신청하기"}
      </button>
      <p className={`-mt-2 text-center text-xs ${s.muted}`}>확인 후 전화로 연락드려요. 신청만으로 등록되지는 않아요.</p>
    </form>
  );
}
