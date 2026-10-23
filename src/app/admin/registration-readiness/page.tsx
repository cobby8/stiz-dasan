import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { registrationReadiness } from "@/lib/enrollment/registration-readiness";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

export const dynamic = "force-dynamic";

const PROCESS_LABELS: Record<string, string> = { PENDING: "승인 대기", APPROVED: "승인", HELD: "보류", PROCESSING: "처리 중", APPLYING: "반영 중", APPLIED: "반영 완료", VERIFIED: "확인 완료", FAILED: "실패", SUCCEEDED: "성공", SKIPPED: "건너뜀", CANCELED: "취소", CANCELLED: "취소", REJECTED: "반려" };
const SOURCE_LABELS: Record<string, string> = { WEBSITE: "사이트", SHEET: "구글시트", RALLYZ: "랠리즈", KAKAO: "카카오" };
const KIND_LABELS: Record<string, string> = { CLASS_ADD: "반 추가", CLASS_CHANGE: "반 변경", RESUME: "복귀", PAUSE: "휴원", WITHDRAW: "퇴원" };

export default async function RegistrationReadinessPage() {
  await requireAdmin();
  const applications = await prisma.enrollmentApplication.findMany({
    where: { status: "APPROVED" }, orderBy: { processedAt: "desc" }, take: 100,
    select: { id: true, childName: true, convertedStudentId: true, assignedClassId: true, shuttleNeeded: true },
  });
  const studentIds = [...new Set(applications.flatMap((app) => app.convertedStudentId ? [app.convertedStudentId] : []))];
  const [enrollments, commands, invoices] = await Promise.all([
    prisma.enrollment.findMany({ where: { studentId: { in: studentIds }, status: "ACTIVE" }, select: { studentId: true, classId: true } }),
    prisma.operationsCommand.findMany({ where: { studentId: { in: studentIds }, kind: { in: ["CLASS_ADD", "RESUME"] } },
      select: { id: true, studentId: true, kind: true, status: true, effectiveMonth: true, createdAt: true, afterJson: true,
        syncAttempts: { select: { target: true, status: true, verifiedAt: true } } } }),
    prisma.paymentInvoice.findMany({ where: { studentId: { in: studentIds }, canceledAt: null, status: { in: ["ISSUED", "SENT", "OVERDUE", "PAID"] }, amount: { gt: 0 } }, select: { studentId: true } }),
  ]);
  return <main className="p-6 space-y-6">
    <h1 className="text-2xl font-bold">입학 완료 확인</h1>
    <p>최근 승인 신청 100건까지 점검합니다. 승인만으로 등록이 완료되지는 않으며, ‘확인 필요’는 실패를 뜻하지 않습니다.</p>
    <p>실제 수강 시작일과 외부 등록 기록을 확인하세요. 승인일은 수강 시작일이 아닙니다. 이 화면에서는 발송·청구·장부를 변경하지 않습니다.</p>
    <Link className="underline" href="/admin/apply">신청 관리로 이동</Link>
    {applications.length === 0 && <p>승인된 신청이 없습니다.</p>}
    {applications.map((app) => {
      const result = registrationReadiness({ applicationId: app.id, studentId: app.convertedStudentId,
        assignedClassIds: [...new Set((app.assignedClassId ?? "").split(",").map((id) => id.trim()).filter(Boolean))],
        activeClassIds: enrollments.filter((row) => row.studentId === app.convertedStudentId).map((row) => row.classId),
        shuttleNeeded: app.shuttleNeeded, commands: commands.filter((row) => row.studentId === app.convertedStudentId),
        invoiceCandidates: invoices.filter((row) => row.studentId === app.convertedStudentId).length,
        // 시트 원장 은퇴(기본) 상태면 시트 항목을 만들지 않는다.
        sheetRetired: isSheetSyncRetired(process.env) });
      return <section key={app.id} className="border rounded-xl p-4 space-y-3">
        <h2 className="font-bold">{app.childName} · 등록 절차 확인 필요</h2>
        <p className="text-sm break-all">신청 번호: {app.id} / 원생 번호: {app.convertedStudentId ?? "미연결"}</p>
        <ul className="space-y-2">{result.checks.map((check) => <li key={check.key}>
          <strong>{check.label}: {check.status === "VERIFIED" ? check.key === "site" ? "현재 수강 확인" : "등록 재조회 확인" : "확인 필요"}</strong><p className="text-sm">{check.detail}</p>
        </li>)}</ul>
        <details className="space-y-3">
          <summary className="cursor-pointer font-bold">등록 원장 증거 {result.evidence.length}건 보기</summary>
          <p className="text-sm">아래 날짜·월은 원장 기록값이며 확정 수강 시작일을 뜻하지 않습니다. 이후 변경·무효화 여부도 별도 대조해야 합니다.</p>
          {result.evidence.length === 0 && <p>연결 후보 없음 · 기존 수강 유지나 복귀 신청은 신규 등록 원장이 없을 수 있습니다.</p>}
          {result.evidence.map((item, index) => <article key={`${item.commandId ?? "missing"}-${index}`} className="space-y-2 rounded border p-3 text-sm break-all">
            <p>처리 번호: {item.commandId ?? "없음"} · 상태: {PROCESS_LABELS[item.status] ?? "상태 확인 필요"}</p>
            <p>원장 신청 번호: {item.applicationId ?? "없음"} · 원생 번호: {item.studentId ?? "없음"}</p>
            <p>반 번호: {item.classId ?? "없음"} · 수강 번호: {item.enrollmentId ?? "없음"}</p>
            <p>출처: {SOURCE_LABELS[item.source ?? ""] ?? "출처 확인 필요"} · 종류: {KIND_LABELS[item.kind ?? ""] ?? "종류 확인 필요"} · 기록 월: {item.effectiveMonth ?? "없음"} · 기록 날짜: {item.eventDate ?? "없음"}</p>
            <p>처리 요청 시각: {item.createdAt ?? "미확인"}</p>
            <p>확인 필요: {item.reasons.join(" · ")}</p>
            {item.targets.map(target => <div key={target.target}>
              <b>{target.target === "SHEET" ? "시트" : "Rallyz"} 재조회 기록</b>
              {target.duplicate && <p>중복된 외부 등록 기록 · 대조 필요</p>}
              {target.attempts.length === 0 && <p>재조회 기록 없음</p>}
              {target.attempts.map((attempt, attemptIndex) => <p key={attemptIndex}>{PROCESS_LABELS[attempt.status] ?? "상태 확인 필요"} · {attempt.verifiedAt ?? "시각 없음"} · {attempt.issue ?? "재조회 성공 기록 있음 · 등록 완료 판정은 보류"}</p>)}
            </div>)}
          </article>)}
        </details>
      </section>;
    })}
  </main>;
}
