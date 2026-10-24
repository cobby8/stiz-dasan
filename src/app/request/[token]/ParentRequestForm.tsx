"use client";

import { useMemo, useState, useTransition } from "react";

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
    startTransition(async () => { try { setResult(await interpretRequest(sourceText.trim(), targetMonth)); setStep("REVIEW"); } catch (e) { setMessage(e instanceof Error ? e.message : "요청 내용을 해석하지 못했습니다."); } });
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
    startTransition(async () => { try { await submitRequest(sourceText.trim(), targetMonth, commands); setSubmitted(true); } catch (e) { setMessage(e instanceof Error ? e.message : "요청을 접수하지 못했습니다."); } });
  }

  return <main className="min-h-dvh bg-slate-50 px-4 py-7 sm:py-12"><div className="mx-auto max-w-xl">
    <header className="px-1"><p className="text-xs font-black tracking-[0.2em] text-lime-600">STIZ BASKETBALL</p><h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">학부모 요청 접수</h1><p className="mt-2 text-sm leading-6 text-slate-600">{context.studentHint ? `${context.studentHint} 학생의 ` : ""}변경 요청을 정확히 확인하고 보내세요.</p></header>
    <div className="mt-5 grid grid-cols-2 gap-2" aria-label="진행 단계"><Step active={step === "WRITE"} number="1" label="자연어로 입력" /><Step active={step === "REVIEW"} number="2" label="해석 결과 확인" /></div>
    {step === "WRITE" ? <section className="mt-4 rounded-3xl bg-white p-5 shadow-xl shadow-slate-200/60 sm:p-7">
      <Info>평소 학원에 문자 보내듯 적어 주세요. 다음 화면에서 해석된 내용을 직접 고칠 수 있습니다.</Info>
      <label className="mt-6 block text-sm font-black text-slate-900">희망 적용 월<input type="month" value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base" /></label>
      <label className="mt-6 block text-sm font-black text-slate-900">요청 내용<textarea autoFocus value={sourceText} onChange={(e) => setSourceText(e.target.value)} rows={7} maxLength={2000} placeholder="예: 9월부터 화요일 수업을 토요일 3교시로 옮기고 셔틀은 이용하지 않을게요." className="mt-2 w-full resize-y rounded-xl border border-slate-300 px-4 py-3 text-base leading-7 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /><span className="mt-1 block text-right text-xs font-medium text-slate-400">{sourceText.length}/2000</span></label>
      <Alert message={message} /><button type="button" disabled={isPending || !targetMonth} onClick={interpret} className="mt-2 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 text-base font-black text-white disabled:opacity-50"><Icon name="auto_awesome" />{isPending ? "요청 내용 확인 중…" : "요청 내용 해석"}</button>
    </section> : result && <section className="mt-4 space-y-4">
      <Info><strong>{result.studentName} 학생</strong>의 요청을 아래처럼 이해했습니다. 변경 전과 변경 후를 비교하고, 잘못된 항목은 직접 수정해 주세요.</Info>
      {(result.draft.warnings.length > 0 || questions.length > 0) && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4"><p className="flex items-center gap-2 font-black text-amber-950"><Icon name="help" />확인이 필요해요</p><ul className="mt-2 text-sm leading-6 text-amber-900">{[...questions, ...result.draft.warnings].map((q, i) => <li key={`${q}-${i}`}>• {q}</li>)}</ul></div>}
      {commands.map((command, index) => <CommandCard key={index} command={command} index={index} current={result.currentEnrollments} available={result.availableClasses} update={update} remove={() => setResult({ ...result, draft: { ...result.draft, commands: commands.filter((_, i) => i !== index) } })} />)}
      <button type="button" onClick={add} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white text-sm font-black text-slate-700"><Icon name="add_circle" />다른 요청 추가</button>
      <div className="rounded-3xl bg-white p-5 shadow-xl shadow-slate-200/60"><h2 className="font-black text-slate-950">보내기 전에 꼭 확인해 주세요</h2><ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600"><Guard icon="check_circle">이 요청은 원장님 검토대기로 접수됩니다.</Guard><Guard icon="pause_circle">제출 즉시 수업·셔틀 정보가 바뀌지 않습니다.</Guard><Guard icon="receipt_long">예상 청구 영향: <strong>원장 확인 필요</strong></Guard><Guard icon="notifications_paused">청구서와 안내 문자도 별도 승인 전까지 보류됩니다.</Guard></ul><Alert message={message} /><div className="mt-2 grid grid-cols-[auto_1fr] gap-2"><button type="button" onClick={() => setStep("WRITE")} className="min-h-14 rounded-2xl border border-slate-300 px-4 font-black text-slate-700" aria-label="요청 내용 다시 입력"><Icon name="arrow_back" /></button><button type="button" disabled={isPending || !canSubmit} onClick={submit} className="min-h-14 rounded-2xl bg-slate-950 px-5 text-base font-black text-white disabled:opacity-40">{isPending ? "접수 중…" : canSubmit ? "확인한 내용으로 요청 보내기" : "확인할 항목이 남아 있어요"}</button></div></div>
    </section>}
    <p className="mt-4 text-center text-xs leading-5 text-slate-500">이 링크는 {context.expiresAt ? new Date(context.expiresAt).toLocaleString("ko-KR") : "정해진 시간"}까지 사용할 수 있습니다.</p>
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
  return <article className={`rounded-3xl border bg-white p-4 shadow-sm sm:p-5 ${command.confidence === "LOW" || command.blockingQuestions.length ? "border-amber-300" : "border-slate-200"}`}><div className="flex justify-between"><div><p className="text-xs font-black text-slate-400">요청 {index + 1}</p><p className="mt-1 font-black text-slate-950">해석된 변경 내용</p></div><button type="button" onClick={remove} className="flex size-10 items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`요청 ${index + 1} 삭제`}><Icon name="delete" /></button></div>
  <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 rounded-2xl bg-slate-50 p-3" aria-label={`요청 ${index + 1} 변경 전후 요약`}>
    <SummaryValue label="변경 전" value={currentLabel} />
    <span className="flex items-center text-slate-400" aria-hidden="true"><Icon name="arrow_forward" /></span>
    <SummaryValue label="변경 후" value={nextLabel} />
  </div>
  <div className="mt-4 grid gap-4 sm:grid-cols-2">
    <Select label="요청 종류" value={command.kind === "UNKNOWN" ? "" : command.kind} onChange={(kind) => update(index, { kind, fromClassId: CLASS_KINDS.has(kind) ? command.fromClassId : null, toClassId: CLASS_KINDS.has(kind) ? command.toClassId : null, shuttleIntent: shuttleFor(kind) })} options={REQUEST_TYPES.map(([id, label]) => ({ id, label }))} />
    <label className="text-sm font-black text-slate-800">희망 적용일<input type="date" value={command.effectiveDate} onChange={(e) => update(index, { effectiveDate: e.target.value })} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-medium" /></label>
    {needsCurrent && <Select label="현재 수업" value={command.fromClassId ?? ""} onChange={(v) => update(index, { fromClassId: v || null })} options={current} empty="현재 수업 선택" />}
    {needsClass && <Select label="변경할 수업" value={command.toClassId ?? ""} onChange={(v) => update(index, { toClassId: v || null })} options={available} empty="실제 개설반 선택" />}
    {(command.kind === "SHUTTLE_CHANGE" || command.shuttleIntent) && <Select label="셔틀 변경" value={command.shuttleIntent ?? ""} onChange={(v) => update(index, { shuttleIntent: v || null })} options={[{ id: "START", label: "이용 시작" }, { id: "STOP", label: "이용 중단" }, { id: "EXEMPT", label: "셔틀비 면제" }, { id: "CHANGE", label: "탑승 정보 변경" }]} empty="셔틀 상태 선택" />}
  </div><label className="mt-4 block text-sm font-black text-slate-800">{details.label}<textarea value={command.details} onChange={(e) => update(index, { details: e.target.value })} rows={3} maxLength={1000} placeholder={details.placeholder} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-base font-medium leading-6" /><span className="mt-1 block text-xs font-medium leading-5 text-slate-500">{details.help}</span></label>{(command.warnings.length > 0 || command.blockingQuestions.length > 0) && <ul className="mt-3 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">{[...command.blockingQuestions, ...command.warnings].map((x, i) => <li key={`${x}-${i}`}>• {x}</li>)}</ul>}</article>;
}

function Select({ label, value, onChange, options, empty }: { label: string; value: string; onChange: (v: string) => void; options: readonly ClassOption[]; empty?: string }) { return <label className="text-sm font-black text-slate-800">{label}<select value={value} onChange={(e) => onChange(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-medium"><option value="">{empty ?? "선택해 주세요"}</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>; }
function optionLabel(options: readonly ClassOption[], id: string | null) { return options.find((option) => option.id === id)?.label ?? ""; }
function requestTypeLabel(kind: string) { return REQUEST_TYPES.find(([id]) => id === kind)?.[1] ?? ""; }
function detailsField(kind: string) {
  if (kind === "SHUTTLE_START" || kind === "SHUTTLE_CHANGE") return { label: "탑승 정보", placeholder: "예: 등원 1호점 앞 버스정류장, 오후 4시 20분 / 하원은 이용하지 않음", help: "등원·하원을 나눠 장소와 희망 시간을 적어 주세요. 실제 시간은 배차 확정 후 안내됩니다." };
  if (kind === "CONTACT_UPDATE") return { label: "변경할 연락처", placeholder: "예: 보호자 연락처 01012345678", help: "누구의 연락처인지와 새 번호를 숫자만 적어 주세요." };
  if (kind === "BILLING_CORRECTION") return { label: "확인할 청구 정보", placeholder: "예: 9월 셔틀비 50,000원이 중복 청구된 것 같습니다.", help: "대상 월, 항목, 확인이 필요한 금액을 함께 적어 주세요." };
  return { label: "추가 설명", placeholder: "원장님이 확인할 내용을 적어 주세요.", help: "필요한 내용만 적고 주민등록번호 등 민감한 개인정보는 입력하지 마세요." };
}
function SummaryValue({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-[11px] font-black text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-black leading-5 text-slate-900">{value}</p></div>; }
function shuttleFor(kind: string) { return kind === "SHUTTLE_START" ? "START" : kind === "SHUTTLE_STOP" ? "STOP" : kind === "SHUTTLE_EXEMPT" ? "EXEMPT" : kind === "SHUTTLE_CHANGE" ? "CHANGE" : null; }
function Step({ active, number, label }: { active: boolean; number: string; label: string }) { return <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black ${active ? "bg-slate-950 text-white" : "bg-white text-slate-400"}`}><span className={`flex size-6 items-center justify-center rounded-full ${active ? "bg-lime-400 text-slate-950" : "bg-slate-100"}`}>{number}</span>{label}</div>; }
function Icon({ name }: { name: string }) { return <span className="material-symbols-outlined align-middle" aria-hidden="true">{name}</span>; }
function Info({ children }: { children: React.ReactNode }) { return <div className="flex gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-bold leading-6 text-blue-950"><Icon name="info" /><p>{children}</p></div>; }
function Guard({ icon, children }: { icon: string; children: React.ReactNode }) { return <li className="flex gap-2"><span className="text-amber-600"><Icon name={icon} /></span><span>{children}</span></li>; }
function Alert({ message }: { message: string }) { return <p role="alert" className="mt-3 min-h-5 text-sm font-bold text-red-600">{message}</p>; }
function Success() { return <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5"><section className="w-full max-w-md rounded-3xl bg-white p-7 text-center shadow-xl"><div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Icon name="task_alt" /></div><h1 className="mt-5 text-2xl font-black">요청을 접수했습니다</h1><p className="mt-3 leading-7 text-slate-600">원장님이 내용을 확인하고 승인한 뒤 반영합니다. 승인한 뒤에만 수업·셔틀 정보가 변경됩니다.</p><p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">청구서나 안내 문자도 별도 승인 전에는 발송되지 않습니다.</p></section></main>; }
function InvalidLink({ expired, used = false }: { expired: boolean; used?: boolean }) { return <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5"><section className="w-full max-w-md rounded-3xl bg-white p-7 text-center shadow-xl"><Icon name={used ? "task_alt" : "lock"} /><h1 className="mt-4 text-2xl font-black">{used ? "이미 요청을 접수했습니다" : expired ? "링크 사용 기간이 끝났습니다" : "올바르지 않은 링크입니다"}</h1><p className="mt-3 leading-7 text-slate-600">{used ? "원장님 검토 대기 중입니다. 추가 요청이 있다면 학원에 새 링크를 요청해 주세요." : "학원에 새 요청 링크를 보내 달라고 말씀해 주세요."}</p>{used && <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">승인 전에는 수업·셔틀·청구 정보가 변경되지 않습니다.</p>}</section></main>; }
