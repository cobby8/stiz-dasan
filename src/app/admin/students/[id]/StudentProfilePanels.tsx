"use client";

// 학생 상세의 두 칸 (2026-11-14 원장 결정 b4·b5)
//  ① «정보 변경 요청» — 학부모가 신청한 이름·생년월일 변경. [승인]하면 그 칸 하나가 바뀌고, [반려]는 사유를 남길 수 있다.
//     확인할 신청이 있을 때만 눈에 띄는 주의색 칸으로 보이고, 없으면 최근 처리 이력만 접어 둔다.
//  ② «건강·알레르기·특이사항» — 학부모가 적은 글을 보고 고친다(선생님 수업 화면·기사님 운행표에 보인다).
// 데이터는 화면(StudentDetailClient)이 한 번 읽어 넘긴다 — 이 파일은 그리기와 버튼만.
import { useEffect, useState, useTransition } from "react";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { statusToneClass } from "@/components/admin/StatusBadge";
import { decideStudentProfileChange, saveStudentHealthNote } from "@/app/actions/student-profile-admin";
import type { ChildChangeRequest } from "@/lib/parent/childEdit";
import { CHANGE_STATUS_LABEL, HEALTH_NOTE_MAX, changeLine } from "@/lib/parent/childEditRules";

const dot = (ymd: string | null) => (ymd ? ymd.replaceAll("-", ".") : "");

export function ProfileChangeRequestsPanel({
  studentId,
  requests,
  onChanged,
}: {
  studentId: string;
  requests: ChildChangeRequest[];
  /** 처리 뒤 — 새 목록을 받고, 학생 정보(이름·생년월일)를 다시 읽게 한다 */
  onChanged: (requests: ChildChangeRequest[], approved: boolean) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const { confirm, confirmDialog } = useAdminConfirm();

  const pending = requests.filter((r) => r.status === "PENDING");
  const history = requests.filter((r) => r.status !== "PENDING");
  if (requests.length === 0) return null;

  async function decide(request: ChildChangeRequest, decision: "APPROVE" | "REJECT") {
    if (decision === "APPROVE") {
      const ok = await confirm({
        title: "변경을 승인할까요?",
        description: `${changeLine(request)} — 승인하면 바로 바뀝니다.`,
        confirmLabel: "승인",
        tone: "primary",
      });
      if (!ok) return;
    }
    setBusyId(request.id); setError("");
    try {
      const result = await decideStudentProfileChange(studentId, request.id, decision, decision === "REJECT" ? note : undefined);
      if (!result.ok) { setError(result.error); return; }
      setRejecting(null); setNote("");
      onChanged(result.requests, decision === "APPROVE");
    } catch {
      setError("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={`academy-panel mb-4 p-4 ${pending.length > 0 ? "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)]" : ""}`}>
      <h3 className="academy-section-title">
        정보 변경 요청
        {pending.length > 0 && <span className="ml-2 text-xs font-normal tabular-nums text-[var(--color-academy-warning)]">확인할 것 {pending.length}건</span>}
      </h3>
      {error && <p role="alert" className="mt-2 text-sm text-[var(--color-academy-danger)]">{error}</p>}
      {pending.length > 0 && (
        <ul className="mt-2 divide-y divide-[var(--color-academy-line)]">
          {pending.map((request) => (
            <li key={request.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                  {changeLine(request)}
                  <span className="block text-xs font-normal tabular-nums text-[var(--color-academy-muted)]">
                    {[request.requesterName ? `${request.requesterName} 신청` : "학부모 신청", dot(request.createdYmd)].filter(Boolean).join(" · ")}
                  </span>
                </p>
                <button type="button" disabled={busyId !== null} onClick={() => void decide(request, "APPROVE")} className="academy-button-primary academy-button-sm">
                  {busyId === request.id ? "처리 중…" : "승인"}
                </button>
                <button type="button" disabled={busyId !== null} aria-expanded={rejecting === request.id} onClick={() => { setRejecting(rejecting === request.id ? null : request.id); setNote(""); }} className="academy-button-secondary academy-button-sm">
                  반려
                </button>
              </div>
              {rejecting === request.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label="반려 사유" placeholder="반려 사유(학부모에게 보여요, 선택)" className="academy-input min-w-0 flex-1" />
                  <button type="button" disabled={busyId !== null} onClick={() => void decide(request, "REJECT")} className="academy-button-danger-solid academy-button-sm">반려하기</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* 처리 이력 — 누가 무엇을 언제 바꿨는지(신청 표가 곧 변경 이력) */}
      {history.length > 0 && (
        <details className="mt-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-xs text-[var(--color-academy-muted)]">지난 요청 {history.length}건 펼치기</summary>
          <ul className="divide-y divide-[var(--color-academy-line)]">
            {history.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <span className={`rounded px-1.5 py-0.5 text-xs ${statusToneClass(request.status === "APPROVED" ? "success" : "neutral")}`}>{CHANGE_STATUS_LABEL[request.status] ?? request.status}</span>
                <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                  {changeLine(request)}
                  {request.note && <span className="block text-xs text-[var(--color-academy-muted)]">{request.note}</span>}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-academy-muted)]">{dot(request.decidedYmd ?? request.createdYmd)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {confirmDialog}
    </div>
  );
}

export function StudentHealthNotePanel({ studentId, initialNote, cardClassName }: { studentId: string; initialNote: string; cardClassName: string }) {
  const [note, setNote] = useState(initialNote);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  // 다른 학생으로 넘어가거나 다시 읽으면 새 값으로
  useEffect(() => { setNote(initialNote); setSaved(false); setError(""); }, [initialNote, studentId]);

  function save() {
    setError(""); setSaved(false);
    startTransition(async () => {
      const result = await saveStudentHealthNote(studentId, note).catch(() => ({ ok: false as const, error: "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." }));
      if (!result.ok) { setError(result.error); return; }
      setSaved(true);
    });
  }

  return (
    <div className={`${cardClassName} mt-4`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="academy-section-title flex items-center gap-2">
          건강·알레르기·특이사항
          <span className="text-xs font-normal text-[var(--color-academy-faint)]">학부모가 적어요 · 선생님·기사님에게 보여요</span>
        </h3>
        <button type="button" onClick={save} disabled={pending} className="academy-button-primary academy-button-sm">{pending ? "저장 중..." : "저장"}</button>
      </div>
      <textarea
        value={note}
        onChange={(e) => { setNote(e.target.value); setSaved(false); }}
        rows={2}
        maxLength={HEALTH_NOTE_MAX}
        aria-label="건강·알레르기·특이사항"
        placeholder="천식, 견과류 알레르기, 안경 착용"
        className="academy-input resize-none"
      />
      {error && <p role="alert" className="mt-2 text-xs text-[var(--color-academy-danger)]">{error}</p>}
      {saved && <p className="mt-2 text-xs font-medium text-[var(--color-academy-success)]">저장됨</p>}
    </div>
  );
}
