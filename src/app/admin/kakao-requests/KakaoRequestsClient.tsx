"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideKakaoParentIntake, type KakaoIntakeDecision } from "@/app/actions/kakao-parent-intake-admin";
import { prepareKakaoReconfirmationNotice, sendKakaoReconfirmationNotice } from "@/app/actions/kakao-reconfirmation-notice";
import { kakaoFollowupSummary, isKakaoFollowupOverdue, type KakaoFollowupCommand } from "@/lib/kakaoIntakeFollowup";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
// 처리 결과 안내 문자 — 미리보기 후 원장이 «보내기»를 눌러야만 발송(자동 발송 없음)
import CustomerNoticeSender from "@/components/admin/CustomerNoticeSender";
import { isIntakeResultStatus } from "@/lib/customer-notice/templates";
// 목록 행의 접수일·시각은 KST 모듈로만(기기 시간대를 따라가지 않게)
import { formatKstDate, kstLabel } from "@/lib/datetime/kst";
// 정규 셔틀 신청 → 원장 할 일 «셔틀 명단에 넣어 주세요»(셔틀 명단 화면과 같은 판정·같은 완료 함수)
import { isShuttleRosterTask, shuttleRosterTaskDoneAt, shuttleRosterTaskHref, shuttleRosterTaskSummary } from "@/lib/kakaoShuttleRosterTask";
import { completeKakaoShuttleRosterTask } from "@/app/actions/kakao-shuttle-roster-task";

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
const LABEL: Record<string,string> = { SUBMITTED:"신규 접수", PROCESSING:"처리 중·반영 확인", HELD:"관리자 확인 필요", FAILED:"처리 실패", NEEDS_DETAILS:"추가 확인 필요", APPROVED:"운영 원장 이관", REJECTED:"접수 반려", CONSULTATION:"상담 전환", CONSULTATION_CLOSED:"상담 종결", APPLIED:"자동 반영 완료", CANCELED:"학부모 취소", MAKEUP_FLOW:"보강 대화 미완료", ABSENCE_FLOW:"결석 대화 미완료", SHUTTLE_FLOW:"셔틀 대화 미완료" };
const KIND_LABEL: Record<string, string> = { PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀", CLASS_CHANGE: "반 변경", CLASS_ADD: "반 추가", SHUTTLE_START_STOP: "셔틀 이용 변경", SHUTTLE_CHANGE: "탑승 정보 변경", SHUTTLE_FEE: "셔틀비", CONTACT_CHANGE: "연락처 변경", BILLING_CORRECTION: "청구 정정", MAKEUP: "보강", OTHER: "기타 문의" };
const TRANSFERABLE = new Set(["PAUSE","WITHDRAW","RESUME","CLASS_CHANGE","CLASS_ADD","SHUTTLE_START_STOP","SHUTTLE_CHANGE","SHUTTLE_FEE","CONTACT_CHANGE","BILLING_CORRECTION"]);
const REVIEWABLE = new Set(["SUBMITTED","HELD","FAILED","NEEDS_DETAILS","CONSULTATION"]);
const formatDate = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone:"Asia/Seoul", dateStyle:"short", timeStyle:"short" }).format(new Date(value));
// 목록 행용 짧은 시각 «14:05» (KST)
const formatTime = (value: string) => formatKstDate(value, { hour:"2-digit", minute:"2-digit", hour12:false }, "-");

// 상태 이름 — 원장이 «셔틀 명단 반영 완료»로 닫은 접수는 「자동 반영 완료」가 아니라 「셔틀 명단 반영」으로 보인다.
function statusLabel(row: Pick<KakaoRequestAdminRow, "status" | "structuredJson">): string {
  if (row.status === "APPLIED" && shuttleRosterTaskDoneAt(row.structuredJson)) return "셔틀 명단 반영";
  return LABEL[row.status] ?? "상태 확인 필요";
}

const NEEDS_FROM_CLASS =new Set(["PAUSE","WITHDRAW","RESUME","CLASS_CHANGE"]);
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

// 접수 세부 정보를 원시 JSON 대신 «항목: 값» 으로 보여준다.
// 화면에는 사람이 읽는 항목만 내보내고, 내부 번호(…Id)·처리 단계 값은 숨긴다.
const SHUTTLE_INTENT_LABEL: Record<string, string> = { START: "지속 이용 시작", STOP: "지속 이용 중단", CHANGE: "탑승 정보 변경", EXEMPT: "셔틀비 면제 검토" };
function readableDetails(value: Record<string, unknown> | null, classes: KakaoClassOption[]): Array<[string, string]> {
  if (!value) return [];
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim() : "";
  const className = (id: string) => classes.find(option => option.id === id)?.label ?? "선택한 수업(목록에 없음)";
  const items: Array<[string, string]> = [];
  if (text("effectiveDate")) items.push(["적용일", text("effectiveDate")]);
  if (text("fromClassId")) items.push(["기존 수업", className(text("fromClassId"))]);
  if (text("toClassId")) items.push(["바꿀 수업", className(text("toClassId"))]);
  if (text("shuttleIntent")) items.push(["셔틀 요청", SHUTTLE_INTENT_LABEL[text("shuttleIntent")] ?? "셔틀 요청 확인 필요"]);
  if (text("details")) items.push(["요청 내용", text("details")]);
  return items;
}

export default function KakaoRequestsClient({ rows, classes, status, schemaReady, inlineId, onChanged }: {
  rows: KakaoRequestAdminRow[];
  classes: KakaoClassOption[];
  status: string;
  schemaReady: boolean;
  inlineId?: string;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const refresh = onChanged ?? (() => router.refresh());
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
    setNotes({}); setReviewDetails({}); setEditRevisions({}); setError(""); refresh();
  }
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Awaited<ReturnType<typeof prepareKakaoReconfirmationNotice>> | null>(null);
  const [noticeResult, setNoticeResult] = useState("");
  function sendNotice() {
    if (!notice || !window.confirm(`SMS 문자 1건\n${notice.studentName} 보호자 ${notice.maskedRecipient}\n표시된 문구 그대로 발송할까요?`)) return;
    startTransition(async () => {
      try {
        const result = await sendKakaoReconfirmationNotice({ approvalId: notice.approvalId, intakeId: notice.intakeId, url: notice.url, channel: "SMS", approved: true });
        setNoticeResult(result.message); setNotice(null); refresh();
      } catch { setError("발송 결과를 확인하지 못했습니다. 발송 장부를 확인하고 중복 전송하지 마세요."); setNotice(null); }
    });
  }
  function prepareNotice(id: string) {
    setError("");
    setNotice(null);
    startTransition(async () => {
      try { setNotice(await prepareKakaoReconfirmationNotice(id)); }
      catch (caught) { setError(adminErrorText(caught, "안내 준비에 실패했습니다.")); }
    });
  }
  const [checkedAt] = useState(() => Date.now());
  // 방금 처리한 접수 — 새 상태가 오면 결과 문자 «미리보기»를 바로 열어 준다(보내기는 원장이 직접)
  const [justDecidedId, setJustDecidedId] = useState("");
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
        setJustDecidedId(id);
        refresh();
      } catch (caught) { setError(adminErrorText(caught, "처리 중 오류가 발생했습니다.")); }
    });
  }
  // «셔틀 명단에 넣어 주세요» 할 일 완료 표시 — 명단은 바꾸지 않고, 학부모에게 보내지도 않는다.
  function completeRosterTask(id: string, studentName: string | null) {
    if (!window.confirm(`${studentName ?? "학생"} 정규 셔틀 신청을 «셔틀 명단 반영 완료»로 표시할까요?\n셔틀 명단 화면에서 학생을 넣은 뒤 눌러 주세요. 학부모에게 문자는 보내지 않습니다.`)) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await completeKakaoShuttleRosterTask({ intakeId: id });
        if (!result.ok) return setError(result.message);
        refresh();
      } catch (caught) { setError(adminErrorText(caught, "처리 표시를 남기지 못했습니다.")); }
    });
  }
  // 행 클릭 상세 패널 대상 — 예전 카드 본문(원문·검토 입력·결정 버튼)을 그대로 패널에서 연다.
  // 입력 중인 검토값(notes·reviewDetails)은 행 id 로 저장돼 있어 패널을 닫았다 열어도 남는다.
  const [openId, setOpenId] = useState("");
  const openRow = rows.find(item => item.id === (inlineId ?? openId)) ?? null;
  // 행 키보드(Enter·Space) = 상세 패널. 안쪽 요소에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpenId(id);
    }
  }
  const Wrapper = inlineId ? "section" : "main";
  return <Wrapper className={inlineId ? "mt-4 space-y-3" : "mx-auto max-w-4xl space-y-3 p-4"}>
    {!inlineId && <><AdminPageHeader title={<>카카오 접수함 <span className="text-xs font-normal text-[var(--color-academy-muted)]">학부모 채널</span></>} description="검증된 요청은 운영 승인 대기로 이관하며, 관리자 보완값은 학부모 재확인 전 시트·랠리즈·사이트에 반영하거나 알림을 보내지 않습니다." />
    {!schemaReady && <section role="alert" className="rounded-xl bg-[var(--color-academy-warning-soft)] p-4 text-[var(--color-academy-ink)]"><b className="font-semibold">접수함을 준비 중입니다.</b><p className="mt-2 text-sm">준비가 끝나면 접수 목록을 확인하고 처리할 수 있습니다.</p></section>}
    {/* 상태 필터는 서버 조회 주소(?status=)를 바꾸는 기존 방식 그대로 — 한 줄 가로 스크롤 */}
    <nav className="flex gap-2 overflow-x-auto" aria-label="접수 상태 필터">{FILTERS.map(([value,label]) => <button key={value} type="button" aria-pressed={status===value} onClick={() => router.push(`/admin/kakao-requests?status=${value}`)} className={`academy-choice is-tab shrink-0${status===value ? " is-selected" : ""}`}>{label}</button>)}</nav>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-[var(--color-academy-ink)]">현재 목록 <span className="tabular-nums">{rows.length}</span>건(최대 200건) · 접수 후 24시간 이상 후속 대상 <span className="tabular-nums">{rows.filter(row => isKakaoFollowupOverdue(row.status, row.createdAt, checkedAt)).length}</span>건 · 접수/동기화 실패 <span className="tabular-nums">{rows.filter(row => row.status === "FAILED" || row.commands.some(command => ["FAILED", "PARTIAL"].includes(command.status))).length}</span>건</p>
      <button type="button" disabled={pending} onClick={reloadRows} className="academy-button-secondary">최신 목록 다시 조회</button>
    </div>
    <p className="text-xs text-[var(--color-academy-muted)]">상담 전환·운영 원장 이관은 업무 완료가 아닙니다. 접수 종결도 청구·알림 발송 완료를 뜻하지 않습니다.</p>
    {/* 오류는 패널이 열려 있으면 패널 안에 보인다(같은 글 두 번 금지) */}
    </>}
    {error && !openRow && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{error}</p>}
    {noticeResult && <p role="status">{noticeResult}</p>}
    {notice && <section aria-label="재확인 안내 미리보기" className="rounded-xl border p-4 space-y-2">
      <h2 className="academy-section-title">{notice.studentName} 학생 보호자 · 재확인 안내 미발송</h2>
      <p className="text-sm">만료: {formatDate(notice.expiresAt)} · 발송 승인 대기</p>
      <p className="text-sm">선택 채널: SMS 문자 · 수신자 {notice.maskedRecipient} · 1건 (카카오 메시지가 아닙니다)</p>
      <p className="text-sm">해당 보호자 대화방을 확인한 뒤 사용하세요. 다시 생성하면 이전 링크는 무효가 됩니다. 이 화면은 안내 준비만 하며 자동 발송하지 않습니다.</p>
      <textarea aria-label="재확인 안내 문구" readOnly value={notice.message} className="w-full min-h-40 rounded border p-2" />
      <button type="button" disabled={pending} onClick={sendNotice} className="academy-button-secondary">위 미리보기 승인 후 SMS 1건 발송</button>
      <button type="button" onClick={() => setNotice(null)} className="academy-button-text">미리보기 닫기</button>
    </section>}
    {!inlineId && (!schemaReady || rows.length===0 ? <p className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">{schemaReady ? "해당 요청이 없습니다." : "접수함 준비 후 표시됩니다."}</p> : (
      <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
        <div className="overflow-x-auto">
          {/* 한 줄 행: 접수일 | 시각 | 상태 | 종류 | 학생 | 학년 | 보호자 | 확인 필요. 원문·검토·처리는 상세 패널(서버 정렬 그대로: 처리 필요 우선 → 최신순) */}
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-semibold text-[var(--color-academy-muted)]">
              <tr>
                <th className="admin-cell-num px-2 py-2">접수일</th>
                <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">시각</th>
                <th className="px-2 py-2">상태</th>
                <th className="px-2 py-2">종류</th>
                <th className="px-2 py-2">학생</th>
                <th className="hidden px-2 py-2 md:table-cell">학년</th>
                <th className="hidden px-2 py-2 md:table-cell">보호자</th>
                <th className="px-2 py-2">확인 필요</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {rows.map(row => {
                const identityOk = row.identityStatus==="ACTIVE" && Boolean(row.studentId);
                const overdue = isKakaoFollowupOverdue(row.status, row.createdAt, checkedAt);
                // 확인 필요 표시: 짧은 글자 배지만(설명 문장은 패널에서)
                const flags = [
                  !identityOk ? "인증·연결 확인" : null,
                  overdue ? "24시간 경과" : null,
                  row.hasProcessingError ? "오류 기록" : null,
                  isShuttleRosterTask(row) ? "셔틀 명단 넣기" : null,
                ].filter((flag): flag is string => Boolean(flag));
                return <tr
                  key={row.id}
                  tabIndex={0}
                  aria-label={`${row.studentName ?? "학생 확인 필요"} ${KIND_LABEL[row.kind] ?? "기타 문의"} 접수 상세 보기`}
                  onClick={() => setOpenId(row.id)}
                  onKeyDown={event => handleRowKeyDown(event, row.id)}
                  className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                >
                  {/* 날짜·시각은 오른쪽 + 자릿수 폭 고정 */}
                  <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{kstLabel(row.createdAt) || "-"}</td>
                  <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{formatTime(row.createdAt)}</td>
                  <td className="px-2 py-1.5"><span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-ink)]">{statusLabel(row)}</span></td>
                  <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{KIND_LABEL[row.kind] ?? "기타 문의"}</td>
                  <td className="px-2 py-1.5 font-medium text-[var(--color-academy-ink)]">{row.studentName ?? "학생 확인 필요"}</td>
                  <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{row.studentGrade ?? "-"}</td>
                  <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{row.parentName ?? "확인 필요"}</td>
                  <td className="px-2 py-1.5">
                    {flags.length === 0 ? <span className="text-xs text-[var(--color-academy-muted)]">-</span> : <span className="inline-flex gap-1">{flags.map(flag => <span key={flag} className="rounded-full bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-danger)]">{flag}</span>)}</span>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </div>
    ))}
    {/* 행 클릭 상세 패널 — 예전 카드 본문을 그대로 옮겼다(원문·후속 안내·인증 확인·세부 정보·검토 입력·결정 버튼).
        결정·저장 함수(decide)와 인자는 그대로. 재확인 안내 «준비»는 패널을 닫고 기존 미리보기를 연다(발송은 미리보기에서 확인창 후에만) */}
    {openRow && (() => {
      const row = openRow;
      const rowId = row.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
      const identityOk = row.identityStatus==="ACTIVE" && Boolean(row.studentId);
      const detail = reviewDetails[row.id] ?? initialDetails(row);
      const updateDetail = (key: keyof ReviewDetails, value: string) => {
        captureRevision(row);
        setReviewDetails(current => ({ ...current, [row.id]: { ...(current[row.id] ?? initialDetails(row)), [key]:value } }));
      };
      const currentClasses = classes.filter(option => row.currentClassIds.includes(option.id));
      const followup = kakaoFollowupSummary(row.status, row.commands);
      const body = <>
        <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-1 text-xs text-[var(--color-academy-ink)]">{statusLabel(row)}</span><span className="text-xs text-[var(--color-academy-muted)]">{KIND_LABEL[row.kind] ?? "기타 문의"}</span></div><h2 id="kakao-request-detail-panel-title" className="mt-2 break-keep text-xl font-bold text-[var(--color-academy-ink)]">{row.studentName ?? "학생 확인 필요"}</h2><p className="mt-1 text-xs text-[var(--color-academy-muted)]">{row.studentGrade ?? "학년 미확인"} · 보호자 {row.parentName ?? "확인 필요"}</p>{row.linkedStudents.length > 1 && <p className="mt-2 rounded-lg bg-[var(--color-academy-primary-soft)] px-3 py-2 text-xs text-[var(--color-academy-ink)]"><b>연결 자녀</b> · {row.linkedStudents.map(student => `${student.name}${student.grade ? ` (${student.grade})` : ""}`).join(" · ")}</p>}</div>{!inlineId && <button type="button" onClick={() => setOpenId("")} aria-label="닫기" className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"><span className="material-symbols-outlined" aria-hidden="true">close</span></button>}</div>
        <time className="mt-1 block text-xs tabular-nums text-[var(--color-academy-muted)]">{formatDate(row.createdAt)}</time>
        {error && <p role="alert" className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{error}</p>}
        <p className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm">{row.sourceText}</p>
        {followup && <p className="mt-3 rounded-xl border p-3 text-sm font-medium">{followup}</p>}
        {/* 원장 할 일: 정규 셔틀 신청은 셔틀 명단에 넣어야 실제 운행에 반영된다. 넣은 뒤 «반영 완료»를 누르면 접수가 닫힌다. */}
        {isShuttleRosterTask(row) && row.studentId && <section aria-label="셔틀 명단 할 일" className="mt-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
          <b>셔틀 명단에 넣어 주세요</b>
          {shuttleRosterTaskSummary(row.structuredJson) && <p className="mt-1 text-xs">{shuttleRosterTaskSummary(row.structuredJson)}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href={shuttleRosterTaskHref(row.studentId, row.structuredJson)} prefetch={false} target={inlineId ? "_blank" : undefined} rel={inlineId ? "noopener noreferrer" : undefined} className="academy-button-secondary">셔틀 명단 열기</Link>
            <button type="button" disabled={pending} onClick={() => completeRosterTask(rowId, row.studentName)} className="academy-button-secondary">셔틀 명단 반영 완료</button>
          </div>
        </section>}
        {row.hasProcessingError && <p className="mt-2 text-xs font-medium">처리 보류·오류 기록 있음 · 학생/날짜/필수 정보와 실제 반영 이력을 확인해 주세요.</p>}
        {isKakaoFollowupOverdue(row.status, row.createdAt, checkedAt) && <p className="mt-2 text-xs font-medium">접수 후 24시간 경과 · 후속 진행 여부 확인</p>}
        <section className="mt-3 rounded-xl border p-3 text-xs"><b>보호자·요청 내용 확인</b><p className={identityOk ? "mt-2 text-[var(--color-academy-success)]" : "mt-2 text-[var(--color-academy-danger)]"}>{identityOk ? `보호자 인증 완료 · 원생 연결 · 보호자 ${row.parentName ?? "확인"}` : "보호자 인증 또는 원생 연결 확인 필요"}</p><details className="mt-2"><summary className="min-h-11 cursor-pointer py-2">접수 세부 정보 보기</summary>{(() => { const items = readableDetails(row.structuredJson, classes); return items.length ? <dl className="mt-2 space-y-1">{items.map(([label, value]) => <div key={label} className="flex gap-2"><dt className="shrink-0 font-medium">{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd></div>)}</dl> : <p className="mt-2">세부 정보 없음</p>; })()}</details></section>
        <p className="mt-3 rounded-xl bg-[var(--color-academy-primary-soft)] p-3 text-xs text-[var(--color-academy-ink)]"><b>이관 후:</b> 변경 요청은 승인 대기 상태입니다. 외부 서비스 반영과 알림 발송은 별도 승인 전까지 보류됩니다.</p>
        {row.operationsRequestId && <Link href="/admin/operations-sync" target={inlineId ? "_blank" : undefined} rel={inlineId ? "noopener noreferrer" : undefined} className="academy-button-text mt-2">생성된 운영 원장 확인</Link>}
        {row.decidedAt && <p className="mt-2 text-xs text-[var(--color-academy-muted)]">{row.decidedByName ?? "관리자"} · {formatDate(row.decidedAt)} · {row.decisionNote ?? "메모 없음"}</p>}
        {isIntakeResultStatus(row.status) && identityOk && <section aria-label="학부모 결과 안내" className="mt-3 rounded-xl border border-[var(--color-academy-line)] p-3">
          <b className="text-sm text-[var(--color-academy-ink)]">학부모께 처리 결과 안내</b>
          {/* key 에 상태를 넣어, 상태가 바뀌면 새 문구로 미리보기를 다시 만든다 */}
          <div className="mt-2"><CustomerNoticeSender key={`${row.id}:${row.status}`} kind="KAKAO_INTAKE_RESULT" intakeId={row.id} autoOpen={justDecidedId === row.id} hint="문자 문구를 먼저 보여 드려요. «이대로 보내기»를 눌러야만 1건 발송됩니다. 같은 결과는 한 번만 보낼 수 있어요." /></div>
        </section>}
        {row.status === "APPROVED" && row.commands.some(command => command.parentReconfirmationRequired && !command.parentConfirmed) && <button type="button" disabled={pending || !identityOk} onClick={() => { if (!inlineId) setOpenId(""); prepareNotice(rowId); }} className="academy-button-secondary mt-3">재확인 링크·안내 준비 (미발송)</button>}
        {REVIEWABLE.has(row.status) && <div className="mt-4 space-y-3">
          {TRANSFERABLE.has(row.kind) && <section className="space-y-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] p-3">
            <div><b className="text-sm text-[var(--color-academy-ink)]">관리자 검토 정보</b><p className="mt-1 text-xs text-[var(--color-academy-muted)]">여기서 저장한 내용은 운영 원장 검토안에만 들어갑니다. 시트·랠리즈·사이트 변경이나 알림 발송은 실행되지 않습니다.</p></div>
            <label className="block text-xs font-medium text-[var(--color-academy-ink)]">적용일<input type="date" value={detail.effectiveDate} onChange={event => updateDetail("effectiveDate", event.target.value)} className="academy-input mt-1 font-normal" /></label>
            {NEEDS_FROM_CLASS.has(row.kind) && <label className="block text-xs font-medium text-[var(--color-academy-ink)]">현재 수업<select value={detail.fromClassId} onChange={event => updateDetail("fromClassId", event.target.value)} className="academy-input mt-1 font-normal"><option value="">현재 등록반 선택</option>{currentClasses.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>{currentClasses.length===0 && <span className="mt-1 block font-normal text-[var(--color-academy-danger)]">활성·휴원 등록반을 확인할 수 없습니다.</span>}</label>}
            {NEEDS_TO_CLASS.has(row.kind) && <label className="block text-xs font-medium text-[var(--color-academy-ink)]">희망 수업<select value={detail.toClassId} onChange={event => updateDetail("toClassId", event.target.value)} className="academy-input mt-1 font-normal"><option value="">실제 개설반 선택</option>{classes.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
            {NEEDS_SHUTTLE.has(row.kind) && <label className="block text-xs font-medium text-[var(--color-academy-ink)]">셔틀 요청<select value={detail.shuttleIntent} onChange={event => updateDetail("shuttleIntent", event.target.value as ReviewDetails["shuttleIntent"])} className="academy-input mt-1 font-normal"><option value="">요청 의도 선택</option>{row.kind==="SHUTTLE_START_STOP" && <><option value="START">지속 이용 시작</option><option value="STOP">지속 이용 중단</option></>}{row.kind==="SHUTTLE_CHANGE" && <option value="CHANGE">탑승 정보 변경</option>}{row.kind==="SHUTTLE_FEE" && <option value="EXEMPT">셔틀비 면제 검토</option>}</select></label>}
            <label className="block text-xs font-medium text-[var(--color-academy-ink)]">상세 메모<textarea rows={3} maxLength={500} value={detail.details} onChange={event => updateDetail("details", event.target.value)} placeholder="학부모가 확인한 날짜·방향·장소·청구 근거 등을 입력" className="academy-input mt-1 font-normal" /></label>
          </section>}
          <textarea aria-label="검토 및 상담 처리 사유" rows={2} maxLength={500} value={notes[row.id] ?? ""} onChange={e => { captureRevision(row); setNotes(v => ({...v,[row.id]:e.target.value})); }} placeholder="추가 확인·반려·상담 종결 사유 (필수)" className="academy-input"/>
          {row.status === "CONSULTATION" && <button type="button" disabled={pending || !notes[row.id]?.trim()} onClick={() => decide(row.id,"CLOSE_CONSULTATION")} className="academy-button-secondary">사유를 남기고 상담 종결 (안내 미발송)</button>}
          {/* 게슈탈트 근접성: 진행 작업(추가 확인·상담 전환·이관)은 한 칸에, 되돌리기 어려운 «접수 반려»는 구분선 아래 오른쪽 끝 위험색 */}
          <div className="grid grid-cols-2 gap-2">{[["NEEDS_DETAILS","추가 확인"],["CONSULTATION","상담 전환"]].map(([decision,label]) => <button key={decision} disabled={pending} onClick={() => decide(row.id, decision as KakaoIntakeDecision)} className="academy-button-secondary">{label}</button>)}<button disabled={pending || !identityOk || !TRANSFERABLE.has(row.kind)} onClick={() => decide(row.id,"TRANSFER")} className="academy-button-primary col-span-2">검토 정보 저장 및 운영 원장 이관</button></div>
          <div className="flex justify-end border-t border-[var(--color-academy-line)] pt-3"><button type="button" disabled={pending} onClick={() => decide(row.id, "REJECT")} className="academy-button-danger">접수 반려</button></div>
        </div>}
      </>;
      return inlineId ? body : (
        <ListDetailPanel onClose={() => setOpenId("")} titleId="kakao-request-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {body}
        </ListDetailPanel>
      );
    })()}
  </Wrapper>;
}
