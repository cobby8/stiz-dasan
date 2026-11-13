"use client";

import { useState, useTransition } from "react";
import { customerMessage } from "@/components/parent/customerMessage";

export type KakaoReconfirmationPreview =
  | { status:"ACTIVE"; studentName:string; kind:string; effectiveDate:string; fromClassLabel:string | null; toClassLabel:string | null; shuttleIntent:string | null; details:string; expiresAt:string }
  | { status:"INVALID" | "EXPIRED" | "USED" | "NOT_REQUIRED" };

type Props = {
  preview: KakaoReconfirmationPreview;
  confirm: () => Promise<{ ok:true; status:"CONFIRMED" } | { ok:false; message:string }>;
};

const KIND_LABEL: Record<string,string> = {
  PAUSE:"휴원", WITHDRAW:"퇴원", RESUME:"복귀", CLASS_CHANGE:"수업 변경", CLASS_ADD:"수업 추가",
  SHUTTLE_START_STOP:"정규 셔틀 시작·중단", SHUTTLE_CHANGE:"셔틀 탑승 정보 변경", SHUTTLE_FEE:"셔틀비 면제 검토",
  CONTACT_CHANGE:"연락처 변경", BILLING_CORRECTION:"청구 확인·정정",
};
const SHUTTLE_LABEL: Record<string,string> = { START:"지속 이용 시작", STOP:"지속 이용 중단", CHANGE:"탑승 정보 변경", EXEMPT:"셔틀비 면제 검토" };

export default function KakaoParentReconfirmationClient({ preview, confirm }: Props) {
  const [agreed, setAgreed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  if (preview.status !== "ACTIVE") return <StateCard status={preview.status} />;
  if (confirmed) return <StateCard status="CONFIRMED" />;

  function submit() {
    if (!agreed || pending) return;
    setMessage("");
    startTransition(async () => {
      const result = await confirm();
      if (result.ok) setConfirmed(true);
      else setMessage(customerMessage(result.message, "확정하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    });
  }

  return <main className="min-h-dvh bg-[var(--color-academy-canvas)] px-4 py-8 sm:py-12"><div className="mx-auto max-w-lg">
    <header className="px-1"><p className="text-xs font-medium tracking-[0.2em] text-[var(--color-academy-muted)]">STIZ BASKETBALL</p><h1 className="academy-heading mt-1">요청 내용 재확인</h1><p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">원장님이 정리한 내용을 확인해 주세요. 이 화면에서는 내용을 수정하거나 새 요청을 입력할 수 없습니다.</p></header>
    <section className="mt-5 rounded-3xl bg-[var(--color-academy-surface)] p-5 shadow-sm sm:p-7">
      <div className="rounded-2xl bg-[var(--color-academy-soft)] p-4 text-[var(--color-academy-ink)]"><p className="text-xs text-[var(--color-academy-muted)]">확인할 학생</p><p className="mt-1 text-xl font-bold">{preview.studentName}</p></div>
      <dl className="mt-5 divide-y divide-[var(--color-academy-line)] rounded-2xl border border-[var(--color-academy-line)] px-4">
        <Summary label="요청 종류" value={KIND_LABEL[preview.kind] ?? "기타 요청"} />
        <Summary label="적용일" value={preview.effectiveDate} />
        {preview.fromClassLabel && <Summary label="현재 수업" value={preview.fromClassLabel} />}
        {preview.toClassLabel && <Summary label="희망 수업" value={preview.toClassLabel} />}
        {preview.shuttleIntent && <Summary label="셔틀 요청" value={SHUTTLE_LABEL[preview.shuttleIntent] ?? "셔틀 요청 확인 필요"} />}
        <Summary label="상세 내용" value={preview.details || "추가 내용 없음"} multiline />
      </dl>
      <div className="mt-5 rounded-2xl border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-4 text-sm font-medium leading-6 text-[var(--color-academy-ink)]">확정해도 바로 변경되거나 알림이 발송되지 않습니다. 원장님의 최종 승인 전까지 수업·셔틀·청구 정보와 학원 기록은 바뀌지 않습니다.</div>
      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--color-academy-line-input)] p-4 text-sm font-medium leading-6 text-[var(--color-academy-ink)]"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-academy-primary)]" /><span>{preview.studentName} 학생의 위 요청 내용이 맞음을 확인했습니다.</span></label>
      {message && <p role="alert" className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{message}</p>}
      <button type="button" disabled={!agreed || pending} onClick={submit} className="academy-button-primary mt-4 w-full">{pending ? "확정 처리 중…" : "확인한 내용으로 확정"}</button>
      <p className="mt-4 text-center text-xs leading-5 text-[var(--color-academy-faint)]">이 일회용 링크는 {new Date(preview.expiresAt).toLocaleString("ko-KR")}까지 사용할 수 있습니다.</p>
    </section>
  </div></main>;
}

function Summary({ label, value, multiline=false }: { label:string; value:string; multiline?:boolean }) { return <div className="grid grid-cols-[6rem_1fr] gap-3 py-4"><dt className="text-xs text-[var(--color-academy-faint)]">{label}</dt><dd className={`text-sm font-semibold leading-6 text-[var(--color-academy-ink)] ${multiline ? "whitespace-pre-wrap break-words" : ""}`}>{value}</dd></div>; }

function StateCard({ status }: { status:Exclude<KakaoReconfirmationPreview["status"],"ACTIVE"> | "CONFIRMED" }) {
  const content = {
    INVALID:["올바르지 않은 링크입니다","학원에 새 확인 링크를 요청해 주세요."],
    EXPIRED:["링크 사용 기간이 끝났습니다","학원에 새 확인 링크를 요청해 주세요."],
    USED:["이미 확인을 완료했습니다","같은 링크로 다시 확정할 수 없습니다. 원장님 최종 승인 전에는 실제 변경이나 알림이 없습니다."],
    NOT_REQUIRED:["재확인이 필요하지 않습니다","요청 상태가 변경되었거나 원장님이 다시 검토 중입니다."],
    CONFIRMED:["요청 내용을 확인했습니다","원장님이 최종 승인한 뒤 반영합니다. 그전에는 수업·셔틀·청구 정보 변경이나 알림 발송이 없습니다."],
  }[status];
  return <main className="flex min-h-dvh items-center justify-center bg-[var(--color-academy-canvas)] px-5"><section className="w-full max-w-md rounded-3xl bg-[var(--color-academy-surface)] p-7 text-center shadow-sm"><div className="mx-auto flex size-14 items-center justify-center rounded-full bg-[var(--color-academy-soft)] text-2xl text-[var(--color-academy-muted)]" aria-hidden="true">{status==="CONFIRMED" || status==="USED" ? "✓" : "!"}</div><h1 className="mt-5 text-2xl font-bold text-[var(--color-academy-ink)]">{content[0]}</h1><p className="mt-3 leading-7 text-[var(--color-academy-muted)]">{content[1]}</p></section></main>;
}
