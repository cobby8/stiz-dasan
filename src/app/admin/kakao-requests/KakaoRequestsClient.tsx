"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideKakaoParentIntake, type KakaoIntakeDecision } from "@/app/actions/kakao-parent-intake-admin";
import { prepareKakaoReconfirmationNotice, sendKakaoReconfirmationNotice } from "@/app/actions/kakao-reconfirmation-notice";
import { kakaoFollowupSummary, isKakaoFollowupOverdue, type KakaoFollowupCommand } from "@/lib/kakaoIntakeFollowup";

export type KakaoRequestAdminRow = {
  revision: string;
  id: string; kind: string; sourceText: string; structuredJson: Record<string, unknown> | null; status: string;
  studentId: string | null; studentName: string | null; studentGrade: string | null; parentName: string | null;
  linkedStudents: Array<{ id:string; name:string; grade:string | null }>;
  identityStatus: string; operationsRequestId: string | null; decisionNote: string | null; decidedByName: string | null;
  createdAt: string; decidedAt: string | null;
  currentClassIds: string[];
  commands: KakaoFollowupCommand[];
  hasProcessingError: boolean;
};

export type KakaoClassOption = {
  id: string;
  label: string;
};

type ReviewDetails = {
  effectiveDate: string;
  fromClassId: string;
  toClassId: string;
  shuttleIntent: "" | "START" | "STOP" | "CHANGE" | "EXEMPT";
  details: string;
};

const FILTERS = [["ACTION","처리·후속 필요"],["SUBMITTED","신규"],["HELD","보류"],["FAILED","실패"],["FOLLOWUP","상담·이관 후속"],["DONE","접수 종결"],["ALL","전체"]] as const;
const LABEL: Record<string,string> = { SUBMITTED:"신규 접수", PROCESSING:"처리 중·반영 확인", HELD:"관리자 확인 필요", FAILED:"처리 실패", NEEDS_DETAILS:"추가 확인 필요", APPROVED:"운영 원장 이관", REJECTED:"접수 반려", CONSULTATION:"상담 전환", CONSULTATION_CLOSED:"상담 종결", APPLIED:"자동 반영 완료", CANCELED:"학부모 취소" };
const KIND_LABEL: Record<string, string> = { PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀", CLASS_CHANGE: "반 변경", CLASS_ADD: "반 추가", SHUTTLE_START_STOP: "셔틀 이용 변경", SHUTTLE_CHANGE: "탑승 정보 변경", SHUTTLE_FEE: "셔틀비", CONTACT_CHANGE: "연락처 변경", BILLING_CORRECTION: "청구 정정", OTHER: "기타 문의" };
const TRANSFERABLE = new Set(["PAUSE","WITHDRAW","RESUME","CLASS_CHANGE","CLASS_ADD","SHUTTLE_START_STOP","SHUTTLE_CHANGE","SHUTTLE_FEE","CONTACT_CHANGE","BILLING_CORRECTION"]);
const REVIEWABLE = new Set(["SUBMITTED","HELD","FAILED","NEEDS_DETAILS","CONSULTATION"]);
const formatDate = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone:"Asia/Seoul", dateStyle:"short", timeStyle:"short" }).format(new Date(value));

const NEEDS_FROM_CLASS = new Set(["PAUSE","WITHDRAW","RESUME","CLASS_CHANGE"]);
const NEEDS_TO_CLASS = new Set(["CLASS_CHANGE","CLASS_ADD"]);
const NEEDS_SHUTTLE = new Set(["SHUTTLE_START_STOP","SHUTTLE_CHANGE","SHUTTLE_FEE"]);

function initialDetails(row: KakaoRequestAdminRow): ReviewDetails {
  const value = row.structuredJson ?? {};
  const text = (key: string) => typeof value[key] === "string" ? value[key] as string : "";
  return {
    effectiveDate: text("effectiveDate"),
    fromClassId: text("fromClassId"),
    toClassId: text("toClassId"),
    shuttleIntent: ["START","STOP","CHANGE","EXEMPT"].includes(text("shuttleIntent")) ? text("shuttleIntent") as ReviewDetails["shuttleIntent"] : "",
    details: text("details"),
  };
}

export default function KakaoRequestsClient({ rows, classes, status, schemaReady }: { rows: KakaoRequestAdminRow[]; classes: KakaoClassOption[]; status: string; schemaReady: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState<Record<string,string>>({});
  const [reviewDetails, setReviewDetails] = useState<Record<string,ReviewDetails>>({});
  // 편집을 시작한 버전을 유지해 다른 행 저장 후 새 목록이 와도 오래된 초안을 덮어쓰지 않는다.
  const [editRevisions, setEditRevisions] = useState<Record<string,string>>({});
  function captureRevision(row: KakaoRequestAdminRow) {
    setEditRevisions(current => ({ ...current, [row.id]: current[row.id] ?? row.revision }));
  }
  function reloadRows() {
    if (Object.keys(editRevisions).length && !window.confirm("입력 중인 검토 내용을 버리고 최신 목록을 불러올까요?")) return;
    setNotes({}); setReviewDetails({}); setEditRevisions({}); setError(""); router.refresh();
  }
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Awaited<ReturnType<typeof prepareKakaoReconfirmationNotice>> | null>(null);
  const [noticeResult, setNoticeResult] = useState("");
  function sendNotice() {
    if (!notice || !window.confirm(`SMS 문자 1건\n${notice.studentName} 보호자 ${notice.maskedRecipient}\n표시된 문구 그대로 발송할까요?`)) return;
    startTransition(async () => {
      try {
        const result = await sendKakaoReconfirmationNotice({ approvalId: notice.approvalId, intakeId: notice.intakeId, url: notice.url, channel: "SMS", approved: true });
        setNoticeResult(result.message); setNotice(null); router.refresh();
      } catch { setError("발송 결과를 확인하지 못했습니다. 발송 장부를 확인하고 중복 전송하지 마세요."); setNotice(null); }
    });
  }
  function prepareNotice(id: string) {
    setError("");
    setNotice(null);
    startTransition(async () => {
      try { setNotice(await prepareKakaoReconfirmationNotice(id)); }
      catch (caught) { setError(caught instanceof Error ? caught.message : "안내 준비에 실패했습니다."); }
    });
  }
  const [checkedAt] = useState(() => Date.now());
  function decide(id: string, decision: KakaoIntakeDecision) {
    const row = rows.find(item => item.id === id);
    if (!row) return;
    setError("");
    startTransition(async () => {
      try {
        const detail = reviewDetails[id] ?? initialDetails(row);
        const result = await decideKakaoParentIntake({ intakeId:id, expectedRevision:editRevisions[id] ?? row.revision, decision, note:notes[id], review:{ ...detail, shuttleIntent:detail.shuttleIntent || null } });
        if (!result.ok) return setError(result.message);
        setNotes(current => { const next = { ...current }; delete next[id]; return next; });
        setReviewDetails(current => { const next = { ...current }; delete next[id]; return next; });
        setEditRevisions(current => { const next = { ...current }; delete next[id]; return next; });
        router.refresh();
      } catch (caught) { setError(caught instanceof Error ? caught.message : "처리 중 오류가 발생했습니다."); }
    });
  }
  return <main className="mx-auto max-w-4xl space-y-5 p-4">
    <header><p className="text-sm font-bold text-yellow-600">학부모 채널</p><h1 className="mt-1 text-2xl font-black dark:text-white">카카오 접수함</h1><p className="mt-2 text-sm text-gray-500">검증된 요청은 운영 승인 대기로 이관하며, 관리자 보완값은 학부모 재확인 전 시트·랠리즈·사이트에 반영하거나 알림을 보내지 않습니다.</p></header>
    {!schemaReady && <section role="alert" className="rounded-2xl bg-amber-50 p-5 text-amber-950"><b>접수함을 준비 중입니다.</b><p className="mt-2 text-sm">준비가 끝나면 접수 목록을 확인하고 처리할 수 있습니다.</p></section>}
    <nav className="flex gap-2 overflow-x-auto" aria-label="접수 상태 필터">{FILTERS.map(([value,label]) => <button key={value} type="button" onClick={() => router.push(`/admin/kakao-requests?status=${value}`)} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold ${status===value ? "bg-brand-navy-900 text-white" : "border bg-white text-gray-600"}`}>{label}</button>)}</nav>
    <p className="text-sm">현재 목록 {rows.length}건(최대 200건) · 접수 후 24시간 이상 후속 대상 {rows.filter(row => isKakaoFollowupOverdue(row.status, row.createdAt, checkedAt)).length}건 · 접수/동기화 실패 {rows.filter(row => row.status === "FAILED" || row.commands.some(command => ["FAILED", "PARTIAL"].includes(command.status))).length}건</p>
    <p className="text-xs text-gray-500">상담 전환·운영 원장 이관은 업무 완료가 아닙니다. 접수 종결도 청구·알림 발송 완료를 뜻하지 않습니다.</p>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
    <button type="button" disabled={pending} onClick={reloadRows} className="min-h-11 rounded-xl border px-3 disabled:opacity-40">최신 목록 다시 조회</button>
    {noticeResult && <p role="status">{noticeResult}</p>}
    {notice && <section aria-label="재확인 안내 미리보기" className="rounded-xl border p-4 space-y-2">
      <h2 className="font-bold">{notice.studentName} 학생 보호자 · 재확인 안내 미발송</h2>
      <p className="text-sm">만료: {formatDate(notice.expiresAt)} · 발송 승인 대기</p>
      <p className="text-sm">선택 채널: SMS 문자 · 수신자 {notice.maskedRecipient} · 1건 (카카오 메시지가 아닙니다)</p>
      <p className="text-sm">해당 보호자 대화방을 확인한 뒤 사용하세요. 다시 생성하면 이전 링크는 무효가 됩니다. 이 화면은 안내 준비만 하며 자동 발송하지 않습니다.</p>
      <textarea aria-label="재확인 안내 문구" readOnly value={notice.message} className="w-full min-h-40 rounded border p-2" />
      <button type="button" disabled={pending} onClick={sendNotice} className="min-h-11 rounded border px-3 disabled:opacity-40">위 미리보기 승인 후 SMS 1건 발송</button>
      <button type="button" onClick={() => setNotice(null)} className="min-h-11 underline">미리보기 닫기</button>
    </section>}
    {!schemaReady || rows.length===0 ? <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">{schemaReady ? "해당 요청이 없습니다." : "접수함 준비 후 표시됩니다."}</p> : <ul className="space-y-4">{rows.map(row => {
      const identityOk = row.identityStatus==="ACTIVE" && Boolean(row.studentId);
      const detail = reviewDetails[row.id] ?? initialDetails(row);
      const updateDetail = (key: keyof ReviewDetails, value: string) => {
        captureRevision(row);
        setReviewDetails(current => ({ ...current, [row.id]: { ...(current[row.id] ?? initialDetails(row)), [key]:value } }));
      };
      const currentClasses = classes.filter(option => row.currentClassIds.includes(option.id));
      const followup = kakaoFollowupSummary(row.status, row.commands);
      return <li key={row.id} className="rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-900">
        <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-yellow-100 px-2 py-1 text-xs font-black text-yellow-800">{LABEL[row.status] ?? "상태 확인 필요"}</span><span className="text-xs font-bold text-gray-500">{KIND_LABEL[row.kind] ?? "기타 문의"}</span></div><h2 className="mt-2 text-xl font-black text-gray-950 dark:text-white">{row.studentName ?? "학생 확인 필요"}</h2><p className="mt-1 text-xs text-gray-500">{row.studentGrade ?? "학년 미확인"} · 보호자 {row.parentName ?? "확인 필요"}</p>{row.linkedStudents.length > 1 && <p className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-900"><b>연결 자녀</b> · {row.linkedStudents.map(student => `${student.name}${student.grade ? ` (${student.grade})` : ""}`).join(" · ")}</p>}</div><time className="shrink-0 text-xs text-gray-400">{formatDate(row.createdAt)}</time></div>
        <p className="mt-3 whitespace-pre-wrap rounded-xl bg-gray-50 p-3 text-sm">{row.sourceText}</p>
        {followup && <p className="mt-3 rounded-xl border p-3 text-sm font-bold">{followup}</p>}
        {row.hasProcessingError && <p className="mt-2 text-xs font-bold">처리 보류·오류 기록 있음 · 학생/날짜/필수 정보와 실제 반영 이력을 확인해 주세요.</p>}
        {isKakaoFollowupOverdue(row.status, row.createdAt, checkedAt) && <p className="mt-2 text-xs font-bold">접수 후 24시간 경과 · 후속 진행 여부 확인</p>}
        <section className="mt-3 rounded-xl border p-3 text-xs"><b>보호자·요청 내용 확인</b><p className={identityOk ? "mt-2 text-green-700" : "mt-2 text-red-700"}>{identityOk ? `보호자 인증 완료 · 원생 연결 · 보호자 ${row.parentName ?? "확인"}` : "보호자 인증 또는 원생 연결 확인 필요"}</p><details className="mt-2"><summary className="cursor-pointer">접수 세부 정보 보기</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap">{row.structuredJson ? JSON.stringify(row.structuredJson, null, 2) : "세부 정보 없음"}</pre></details></section>
        <p className="mt-3 rounded-xl bg-blue-50 p-3 text-xs text-blue-900"><b>이관 후:</b> 변경 요청은 승인 대기 상태입니다. 외부 서비스 반영과 알림 발송은 별도 승인 전까지 보류됩니다.</p>
        {row.operationsRequestId && <Link href="/admin/operations-sync" className="mt-2 inline-block text-sm font-bold text-blue-700 underline">생성된 운영 원장 확인</Link>}
        {row.decidedAt && <p className="mt-2 text-xs text-gray-400">{row.decidedByName ?? "관리자"} · {formatDate(row.decidedAt)} · {row.decisionNote ?? "메모 없음"}</p>}
        {row.status === "APPROVED" && row.commands.some(command => command.parentReconfirmationRequired && !command.parentConfirmed) && <button type="button" disabled={pending || !identityOk} onClick={() => prepareNotice(row.id)} className="mt-3 min-h-11 rounded-xl border px-3 disabled:opacity-40">재확인 링크·안내 준비 (미발송)</button>}
        {REVIEWABLE.has(row.status) && <div className="mt-4 space-y-3">
          {TRANSFERABLE.has(row.kind) && <section className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/50 p-3">
            <div><b className="text-sm text-blue-950">관리자 검토 정보</b><p className="mt-1 text-xs text-blue-800">여기서 저장한 내용은 운영 원장 검토안에만 들어갑니다. 시트·랠리즈·사이트 변경이나 알림 발송은 실행되지 않습니다.</p></div>
            <label className="block text-xs font-bold text-gray-700">적용일<input type="date" value={detail.effectiveDate} onChange={event => updateDetail("effectiveDate", event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border bg-white px-3 text-sm font-normal" /></label>
            {NEEDS_FROM_CLASS.has(row.kind) && <label className="block text-xs font-bold text-gray-700">현재 수업<select value={detail.fromClassId} onChange={event => updateDetail("fromClassId", event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border bg-white px-3 text-sm font-normal"><option value="">현재 등록반 선택</option>{currentClasses.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>{currentClasses.length===0 && <span className="mt-1 block font-normal text-red-700">활성·휴원 등록반을 확인할 수 없습니다.</span>}</label>}
            {NEEDS_TO_CLASS.has(row.kind) && <label className="block text-xs font-bold text-gray-700">희망 수업<select value={detail.toClassId} onChange={event => updateDetail("toClassId", event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border bg-white px-3 text-sm font-normal"><option value="">실제 개설반 선택</option>{classes.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
            {NEEDS_SHUTTLE.has(row.kind) && <label className="block text-xs font-bold text-gray-700">셔틀 요청<select value={detail.shuttleIntent} onChange={event => updateDetail("shuttleIntent", event.target.value as ReviewDetails["shuttleIntent"])} className="mt-1 min-h-11 w-full rounded-xl border bg-white px-3 text-sm font-normal"><option value="">요청 의도 선택</option>{row.kind==="SHUTTLE_START_STOP" && <><option value="START">지속 이용 시작</option><option value="STOP">지속 이용 중단</option></>}{row.kind==="SHUTTLE_CHANGE" && <option value="CHANGE">탑승 정보 변경</option>}{row.kind==="SHUTTLE_FEE" && <option value="EXEMPT">셔틀비 면제 검토</option>}</select></label>}
            <label className="block text-xs font-bold text-gray-700">상세 메모<textarea rows={3} maxLength={500} value={detail.details} onChange={event => updateDetail("details", event.target.value)} placeholder="학부모가 확인한 날짜·방향·장소·청구 근거 등을 입력" className="mt-1 w-full rounded-xl border bg-white p-3 text-sm font-normal" /></label>
          </section>}
          <textarea aria-label="검토 및 상담 처리 사유" rows={2} maxLength={500} value={notes[row.id] ?? ""} onChange={e => { captureRevision(row); setNotes(v => ({...v,[row.id]:e.target.value})); }} placeholder="추가 확인·반려·상담 종결 사유 (필수)" className="w-full rounded-xl border p-3 text-sm"/>
          {row.status === "CONSULTATION" && <button type="button" disabled={pending || !notes[row.id]?.trim()} onClick={() => decide(row.id,"CLOSE_CONSULTATION")} className="min-h-11 rounded-xl border px-3 font-bold disabled:opacity-40">사유를 남기고 상담 종결 (안내 미발송)</button>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[["NEEDS_DETAILS","추가 확인"],["CONSULTATION","상담 전환"],["REJECT","접수 반려"]].map(([decision,label]) => <button key={decision} disabled={pending} onClick={() => decide(row.id, decision as KakaoIntakeDecision)} className="min-h-11 rounded-xl border font-bold disabled:opacity-40">{label}</button>)}<button disabled={pending || !identityOk || !TRANSFERABLE.has(row.kind)} onClick={() => decide(row.id,"TRANSFER")} className="min-h-11 rounded-xl bg-[var(--brand-accent)] px-2 font-black text-[var(--brand-accent-contrast)] disabled:opacity-40">검토 정보 저장 및 운영 원장 이관</button></div>
        </div>}
      </li>;
    })}</ul>}
  </main>;
}
