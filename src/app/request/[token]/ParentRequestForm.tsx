"use client";

import { useMemo, useState, useTransition } from "react";
import { customerMessage } from "@/components/parent/customerMessage";

export type PublicParentRequestContext = { valid: boolean; linkStatus: "ACTIVE" | "USED" | "EXPIRED" | "INVALID"; studentHint: string | null; expiresAt: string | null };
type ClassOption = { id: string; label: string };
export type RequestCommand = { sourceText: string; kind: string; effectiveDate: string; fromClassId: string | null; toClassId: string | null; shuttleIntent: string | null; details: string; confidence: "HIGH" | "MEDIUM" | "LOW"; warnings: string[]; blockingQuestions: string[] };
export type Interpretation = { studentName: string; currentEnrollments: ClassOption[]; availableClasses: ClassOption[]; draft: { sourceText: string; targetMonth: string; commands: RequestCommand[]; warnings: string[]; blockingQuestions: string[]; readyToSubmit: boolean } };
type Props = { context: PublicParentRequestContext; interpretRequest: (sourceText: string, targetMonth: string) => Promise<Interpretation>; submitRequest: (sourceText: string, targetMonth: string, commands: RequestCommand[]) => Promise<{ ok: true }> };

const REQUEST_TYPES = [["PAUSE", "휴원"], ["WITHDRAW", "퇴원"], ["RESUME", "복귀"], ["CLASS_CHANGE", "수업 변경"], ["CLASS_ADD", "수업 추가"], ["SHUTTLE_START", "셔틀 이용 시작"], ["SHUTTLE_STOP", "셔틀 이용 중단"], ["SHUTTLE_EXEMPT", "셔틀비 면제"], ["SHUTTLE_CHANGE", "셔틀 정보 변경"], ["CONTACT_UPDATE", "연락처 변경"], ["BILLING_CORRECTION", "청구 확인"]] as const;
const CLASS_KINDS = new Set(["CLASS_CHANGE", "CLASS_ADD"]);
const CURRENT_CLASS_KINDS = new Set(["CLASS_CHANGE", "PAUSE", "WITHDRAW", "RESUME"]);
const todayMonth = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 7);

function clientBlocking(command: RequestCommand) {
  const issues: string[] = [];
  if (!command.kind) issues.push("요청 종류를 선택해 주세요.");
  if (!command.effectiveDate) issues.push("희망 적용일을 선택해 주세요.");
  if (CURRENT_CLASS_KINDS.has(command.kind) && !command.fromClassId) issues.push("현재 수업을 선택해 주세요.");
  if (CLASS_KINDS.has(command.kind) && !command.toClassId) issues.push("희망 수업을 선택해 주세요.");
  if (command.kind === "CLASS_CHANGE" && command.fromClassId && command.fromClassId === command.toClassId) issues.push("현재 수업과 다른 수업을 선택해 주세요.");
  if (command.kind.startsWith("SHUTTLE_") && command.shuttleIntent !== shuttleFor(command.kind)) issues.push("셔틀 변경 상태를 확인해 주세요.");
  return issues;
}

export default function ParentRequestForm({ context, interpretRequest, submitRequest }: Props) {
  const [step, setStep] = useState<"WRITE" | "REVIEW">("WRITE");
  const [sourceText, setSourceText] = useState("");
  const [targetMonth, setTargetMonth] = useState(todayMonth);
  const [result, setResult] = useState<Interpretation | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const commands = useMemo(() => result?.draft.commands ?? [], [result]);
  // 명령을 직접 고치면 해당 질문은 해소되므로, 현재 명령에 남아 있는 질문만 차단한다.
  const questions = useMemo(() => commands.flatMap(clientBlocking), [commands]);
  const incomplete = commands.some((c) => clientBlocking(c).length > 0);
  const canSubmit = commands.length > 0 && questions.length === 0 && !incomplete;

  if (!context.valid) return <InvalidLink expired={context.linkStatus === "EXPIRED"} used={context.linkStatus === "USED"} />;
  if (submitted) return <Success />;

  function interpret() {
    if (sourceText.trim().length < 5) return setMessage("원하시는 변경 내용을 조금 더 자세히 적어 주세요.");
    setMessage("");
    startTransition(async () => { try { setResult(await interpretRequest(sourceText.trim(), targetMonth)); setStep("REVIEW"); } catch (e) { setMessage(customerMessage(e, "요청 내용을 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.")); } });
  }
  function update(index: number, patch: Partial<RequestCommand>) {
    setResult((current) => current ? { ...current, draft: { ...current.draft, commands: current.draft.commands.map((c, i) => {
      if (i !== index) return c;
      const next = { ...c, ...patch };
      // 학부모가 항목을 직접 고친 뒤에는 자연어 해석 시점의 경고를 남기지 않는다.
      // 현재 값으로 다시 계산한 필수 확인 항목만 보여 줘야 오래된 경고로 혼동하지 않는다.
      const blockingQuestions = clientBlocking(next);
      return { ...next, warnings: [], blockingQuestions, confidence: blockingQuestions.length ? "LOW" : "HIGH" };
    }), warnings: [], blockingQuestions: [] } } : null);
  }
  function add() {
    if (!result) return;
    setResult({ ...result, draft: { ...result.draft, commands: [...commands, { sourceText: "학부모가 확인 화면에서 추가한 요청", kind: "", effectiveDate: `${targetMonth}-01`, fromClassId: null, toClassId: null, shuttleIntent: null, details: "", confidence: "HIGH", warnings: [], blockingQuestions: [] }] } });
  }
  function submit() {
    if (!canSubmit) return setMessage("확인이 필요한 항목을 모두 수정해 주세요.");
    startTransition(async () => { try { await submitRequest(sourceText.trim(), targetMonth, commands); setSubmitted(true); } catch (e) { setMessage(customerMessage(e, "요청을 접수하지 못했습니다.")); } });
  }

  return <main className="min-h-dvh bg-[var(--color-academy-canvas)] px-4 py-7 sm:py-12"><div className="mx-auto max-w-xl">
    <header className="px-1"><p className="text-xs font-medium tracking-[0.2em] text-[var(--color-academy-muted)]">STIZ BASKETBALL</p><h1 className="academy-heading mt-1">학부모 요청 접수</h1><p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">{context.studentHint ? `${context.studentHint} 학생의 ` : ""}변경 요청을 정확히 확인하고 보내세요.</p></header>
    <div className="mt-5 grid grid-cols-2 gap-2" aria-label="진행 단계"><Step active={step === "WRITE"} number="1" label="편하게 적기" /><Step active={step === "REVIEW"} number="2" label="내용 확인" /></div>
    {step === "WRITE" ? <section className="mt-4 rounded-3xl bg-[var(--color-academy-surface)] p-5 shadow-sm sm:p-7">
      <Info>평소 학원에 문자 보내듯 적어 주세요. 다음 화면에서 정리된 내용을 직접 고칠 수 있습니다.</Info>
      <label className="mt-6 block text-sm font-medium text-[var(--color-academy-ink)]">희망 적용 월<input type="month" value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)} className="academy-input mt-2 font-normal" /></label>
      <label className="mt-6 block text-sm font-medium text-[var(--color-academy-ink)]">요청 내용<textarea autoFocus value={sourceText} onChange={(e) => setSourceText(e.target.value)} rows={7} maxLength={2000} placeholder="예: 9월부터 화요일 수업을 토요일 3교시로 옮기고 셔틀은 이용하지 않을게요." className="academy-input mt-2 font-normal resize-y leading-7" /><span className="mt-1 block text-right text-xs tabular-nums text-[var(--color-academy-faint)]">{sourceText.length}/2000</span></label>
      <Alert message={message} /><button type="button" disabled={isPending || !targetMonth} onClick={interpret} className="academy-button-primary mt-2 w-full">{isPending ? "요청 내용 확인 중…" : "요청 내용 정리하기"}</button>
    </section> : result && <section className="mt-4 space-y-4">
      <Info><strong>{result.studentName} 학생</strong>의 요청을 아래처럼 이해했습니다. 변경 전과 변경 후를 비교하고, 잘못된 항목은 직접 수정해 주세요.</Info>
      {(result.draft.warnings.length > 0 || questions.length > 0) && <div className="rounded-2xl border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-4"><p className="font-semibold text-[var(--color-academy-ink)]">확인이 필요해요</p><ul className="mt-2 text-sm leading-6 text-[var(--color-academy-ink)]">{[...questions, ...result.draft.warnings].map((q, i) => <li key={`${q}-${i}`}>• {q}</li>)}</ul></div>}
      {commands.map((command, index) => <CommandCard key={index} command={command} index={index} current={result.currentEnrollments} available={result.availableClasses} update={update} remove={() => setResult({ ...result, draft: { ...result.draft, commands: commands.filter((_, i) => i !== index) } })} />)}
      <button type="button" onClick={add} className="academy-button-secondary w-full">다른 요청 추가</button>
      <div className="rounded-3xl bg-[var(--color-academy-surface)] p-5 shadow-sm"><h2 className="academy-section-title">보내기 전에 꼭 확인해 주세요</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[var(--color-academy-muted)]"><Guard>이 요청은 원장님 검토대기로 접수됩니다.</Guard><Guard>제출 즉시 수업·셔틀 정보가 바뀌지 않습니다.</Guard><Guard>예상 청구 영향: <strong>원장 확인 필요</strong></Guard><Guard>청구서와 안내 문자도 별도 승인 전까지 보류됩니다.</Guard></ul><Alert message={message} /><div className="mt-2 grid grid-cols-[auto_1fr] gap-2"><button type="button" onClick={() => setStep("WRITE")} className="academy-button-secondary" aria-label="요청 내용 다시 입력">다시 입력</button><button type="button" disabled={isPending || !canSubmit} onClick={submit} className="academy-button-primary">{isPending ? "접수 중…" : canSubmit ? "확인한 내용으로 요청 보내기" : "확인할 항목이 남아 있어요"}</button></div></div>
    </section>}
    <p className="mt-4 text-center text-xs leading-5 text-[var(--color-academy-faint)]">이 링크는 {context.expiresAt ? new Date(context.expiresAt).toLocaleString("ko-KR") : "정해진 시간"}까지 사용할 수 있습니다.</p>
  </div></main>;
}

function CommandCard({ command, index, current, available, update, remove }: { command: RequestCommand; index: number; current: ClassOption[]; available: ClassOption[]; update: (i: number, patch: Partial<RequestCommand>) => void; remove: () => void }) {
  const needsClass = CLASS_KINDS.has(command.kind);
  const needsCurrent = CURRENT_CLASS_KINDS.has(command.kind);
  const details = detailsField(command.kind);
  const currentLabel = optionLabel(current, command.fromClassId) || "해당 없음";
  const nextLabel = command.kind === "CLASS_CHANGE" || command.kind === "CLASS_ADD"
    ? optionLabel(available, command.toClassId) || "선택 필요"
    : requestTypeLabel(command.kind) || "선택 필요";
  return <article className={`rounded-3xl border bg-[var(--color-academy-surface)] p-4 shadow-sm sm:p-5 ${command.confidence === "LOW" || command.blockingQuestions.length ? "border-[var(--color-academy-warning)]" : "border-[var(--color-academy-line)]"}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs text-[var(--color-academy-faint)]">요청 {index + 1}</p><p className="mt-1 font-semibold text-[var(--color-academy-ink)]">정리된 변경 내용</p></div><button type="button" onClick={remove} className="academy-button-text academy-button-sm shrink-0" aria-label={`요청 ${index + 1} 삭제`}>삭제</button></div>
  <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 rounded-2xl bg-[var(--color-academy-canvas)] p-3" aria-label={`요청 ${index + 1} 변경 전후 요약`}>
    <SummaryValue label="변경 전" value={currentLabel} />
    <span className="flex items-center text-[var(--color-academy-faint)]" aria-hidden="true">→</span>
    <SummaryValue label="변경 후" value={nextLabel} />
  </div>
  <div className="mt-4 grid gap-4 sm:grid-cols-2">
    <Select label="요청 종류" value={command.kind === "UNKNOWN" ? "" : command.kind} onChange={(kind) => update(index, { kind, fromClassId: CLASS_KINDS.has(kind) ? command.fromClassId : null, toClassId: CLASS_KINDS.has(kind) ? command.toClassId : null, shuttleIntent: shuttleFor(kind) })} options={REQUEST_TYPES.map(([id, label]) => ({ id, label }))} />
    <label className="text-sm font-medium text-[var(--color-academy-ink)]">희망 적용일<input type="date" value={command.effectiveDate} onChange={(e) => update(index, { effectiveDate: e.target.value })} className="academy-input mt-2 font-normal" /></label>
    {needsCurrent && <Select label="현재 수업" value={command.fromClassId ?? ""} onChange={(v) => update(index, { fromClassId: v || null })} options={current} empty="현재 수업 선택" />}
    {needsClass && <Select label="변경할 수업" value={command.toClassId ?? ""} onChange={(v) => update(index, { toClassId: v || null })} options={available} empty="실제 개설반 선택" />}
    {(command.kind === "SHUTTLE_CHANGE" || command.shuttleIntent) && <Select label="셔틀 변경" value={command.shuttleIntent ?? ""} onChange={(v) => update(index, { shuttleIntent: v || null })} options={[{ id: "START", label: "이용 시작" }, { id: "STOP", label: "이용 중단" }, { id: "EXEMPT", label: "셔틀비 면제" }, { id: "CHANGE", label: "탑승 정보 변경" }]} empty="셔틀 상태 선택" />}
  </div><label className="mt-4 block text-sm font-medium text-[var(--color-academy-ink)]">{details.label}<textarea value={command.details} onChange={(e) => update(index, { details: e.target.value })} rows={3} maxLength={1000} placeholder={details.placeholder} className="academy-input mt-2 font-normal leading-6" /><span className="mt-1 block text-xs leading-5 text-[var(--color-academy-faint)]">{details.help}</span></label>{(command.warnings.length > 0 || command.blockingQuestions.length > 0) && <ul className="mt-3 rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm leading-6 text-[var(--color-academy-ink)]">{[...command.blockingQuestions, ...command.warnings].map((x, i) => <li key={`${x}-${i}`}>• {x}</li>)}</ul>}</article>;
}

function Select({ label, value, onChange, options, empty }: { label: string; value: string; onChange: (v: string) => void; options: readonly ClassOption[]; empty?: string }) { return <label className="text-sm font-medium text-[var(--color-academy-ink)]">{label}<select value={value} onChange={(e) => onChange(e.target.value)} className="academy-input mt-2 font-normal"><option value="">{empty ?? "선택해 주세요"}</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>; }
function optionLabel(options: readonly ClassOption[], id: string | null) { return options.find((option) => option.id === id)?.label ?? ""; }
function requestTypeLabel(kind: string) { return REQUEST_TYPES.find(([id]) => id === kind)?.[1] ?? ""; }
function detailsField(kind: string) {
  if (kind === "SHUTTLE_START" || kind === "SHUTTLE_CHANGE") return { label: "탑승 정보", placeholder: "예: 등원 1호점 앞 버스정류장, 오후 4시 20분 / 하원은 이용하지 않음", help: "등원·하원을 나눠 장소와 희망 시간을 적어 주세요. 실제 시간은 배차 확정 후 안내됩니다." };
  if (kind === "CONTACT_UPDATE") return { label: "변경할 연락처", placeholder: "예: 보호자 연락처 01012345678", help: "누구의 연락처인지와 새 번호를 숫자만 적어 주세요." };
  if (kind === "BILLING_CORRECTION") return { label: "확인할 청구 정보", placeholder: "예: 9월 셔틀비 50,000원이 중복 청구된 것 같습니다.", help: "대상 월, 항목, 확인이 필요한 금액을 함께 적어 주세요." };
  return { label: "추가 설명", placeholder: "원장님이 확인할 내용을 적어 주세요.", help: "필요한 내용만 적고 주민등록번호 등 민감한 개인정보는 입력하지 마세요." };
}
function SummaryValue({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-xs text-[var(--color-academy-faint)]">{label}</p><p className="mt-1 break-words text-sm font-semibold leading-5 text-[var(--color-academy-ink)]">{value}</p></div>; }
function shuttleFor(kind: string) { return kind === "SHUTTLE_START" ? "START" : kind === "SHUTTLE_STOP" ? "STOP" : kind === "SHUTTLE_EXEMPT" ? "EXEMPT" : kind === "SHUTTLE_CHANGE" ? "CHANGE" : null; }
function Step({ active, number, label }: { active: boolean; number: string; label: string }) { return <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium ${active ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]" : "bg-[var(--color-academy-surface)] text-[var(--color-academy-faint)]"}`}><span className={`flex size-6 items-center justify-center rounded-full tabular-nums ${active ? "bg-[var(--color-academy-surface)]" : "bg-[var(--color-academy-soft)]"}`}>{number}</span>{label}</div>; }
function Info({ children }: { children: React.ReactNode }) { return <div className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-4 text-sm leading-6 text-[var(--color-academy-ink)]"><p>{children}</p></div>; }
function Guard({ children }: { children: React.ReactNode }) { return <li>{children}</li>; }
function Alert({ message }: { message: string }) { return <p role="alert" className="mt-3 min-h-5 text-sm font-medium text-[var(--color-academy-danger)]">{message}</p>; }
function Success() { return <main className="flex min-h-dvh items-center justify-center bg-[var(--color-academy-canvas)] px-5"><section className="w-full max-w-md rounded-3xl bg-[var(--color-academy-surface)] p-7 text-center shadow-sm"><h1 className="text-2xl font-bold text-[var(--color-academy-ink)]">요청을 접수했습니다</h1><p className="mt-3 leading-7 text-[var(--color-academy-muted)]">원장님이 내용을 확인하고 승인한 뒤 반영합니다. 승인한 뒤에만 수업·셔틀 정보가 변경됩니다.</p><p className="mt-5 rounded-xl bg-[var(--color-academy-warning-soft)] px-4 py-3 text-sm font-medium text-[var(--color-academy-ink)]">청구서나 안내 문자도 별도 승인 전에는 발송되지 않습니다.</p></section></main>; }
function InvalidLink({ expired, used = false }: { expired: boolean; used?: boolean }) { return <main className="flex min-h-dvh items-center justify-center bg-[var(--color-academy-canvas)] px-5"><section className="w-full max-w-md rounded-3xl bg-[var(--color-academy-surface)] p-7 text-center shadow-sm"><h1 className="text-2xl font-bold text-[var(--color-academy-ink)]">{used ? "이미 요청을 접수했습니다" : expired ? "링크 사용 기간이 끝났습니다" : "올바르지 않은 링크입니다"}</h1><p className="mt-3 leading-7 text-[var(--color-academy-muted)]">{used ? "원장님 검토 대기 중입니다. 추가 요청이 있다면 학원에 새 링크를 요청해 주세요." : "학원에 새 요청 링크를 보내 달라고 말씀해 주세요."}</p>{used && <p className="mt-5 rounded-xl bg-[var(--color-academy-warning-soft)] px-4 py-3 text-sm font-medium text-[var(--color-academy-ink)]">승인 전에는 수업·셔틀·청구 정보가 변경되지 않습니다.</p>}</section></main>; }
