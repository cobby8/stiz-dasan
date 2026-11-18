import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { registrationReadiness } from "@/lib/enrollment/registration-readiness";
import { getEnrollmentShuttleProgress } from "@/lib/enrollment/shuttle-progress-query";

export const dynamic = "force-dynamic";

const PROCESS_LABELS: Record<string, string> = { PENDING: "승인 대기", APPROVED: "승인", HELD: "보류", PROCESSING: "처리 중", APPLYING: "반영 중", APPLIED: "반영 완료", VERIFIED: "확인 완료", FAILED: "실패", SUCCEEDED: "성공", SKIPPED: "건너뜀", CANCELED: "취소", CANCELLED: "취소", REJECTED: "반려" };
const SOURCE_LABELS: Record<string, string> = { WEBSITE: "사이트", SHEET: "구글시트", RALLYZ: "랠리즈", KAKAO: "카카오" };
const KIND_LABELS: Record<string, string> = { CLASS_ADD: "반 추가", CLASS_CHANGE: "반 변경", RESUME: "복귀", PAUSE: "휴원", WITHDRAW: "퇴원" };

export default async function RegistrationReadinessPage() {
  await requireAdmin();
  // PgBouncer 트랜잭션 모드라 ORM 기본 메서드(findMany 등) 대신 $queryRawUnsafe 로 읽는다(프로젝트 규칙).
  // 결과 모양(필드명·타입)은 예전 findMany 의 select 와 똑같이 맞춘다 — 날짜 칸은 Date, afterJson 은 객체로 온다.
  const applications = await prisma.$queryRawUnsafe<Array<{ id: string; status: string; childName: string; convertedStudentId: string | null; assignedClassId: string | null; shuttleNeeded: boolean; requestedStartOn: Date | null }>>(
    `SELECT id, status, "childName", "convertedStudentId", "assignedClassId", "shuttleNeeded", "requestedStartOn"
       FROM "EnrollmentApplication"
      WHERE status = 'APPROVED'
      ORDER BY "processedAt" DESC
      LIMIT 100`,
  );
  const shuttleProgress = await getEnrollmentShuttleProgress(applications);
  const studentIds = [...new Set(applications.flatMap((app) => app.convertedStudentId ? [app.convertedStudentId] : []))];
  const [enrollments, commandRows, invoices] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ studentId: string; classId: string; startsOn: Date | null }>>(
      `SELECT "studentId", "classId", "startsOn" FROM "Enrollment" WHERE "studentId" = ANY($1::text[]) AND status = 'ACTIVE'`,
      studentIds,
    ),
    prisma.$queryRawUnsafe<Array<{ id: string; studentId: string | null; kind: string; status: string; effectiveMonth: string; createdAt: Date; afterJson: unknown }>>(
      `SELECT id, "studentId", kind, status, "effectiveMonth", "createdAt", "afterJson"
         FROM "OperationsCommand"
        WHERE "studentId" = ANY($1::text[]) AND kind IN ('CLASS_ADD', 'RESUME')`,
      studentIds,
    ),
    prisma.$queryRawUnsafe<Array<{ studentId: string }>>(
      `SELECT "studentId" FROM "PaymentInvoice"
        WHERE "studentId" = ANY($1::text[]) AND "canceledAt" IS NULL
          AND status IN ('ISSUED', 'SENT', 'OVERDUE', 'PAID') AND amount > 0`,
      studentIds,
    ),
  ]);
  // 예전 select 의 syncAttempts(관계 묶음)를 대신한다 — 명령 번호로 재조회 기록을 한 번에 읽어 각 명령에 붙인다.
  const attemptRows = commandRows.length === 0 ? [] : await prisma.$queryRawUnsafe<Array<{ commandId: string; target: string; status: string; verifiedAt: Date | null }>>(
    `SELECT "commandId", target, status, "verifiedAt" FROM "OperationsSyncAttempt" WHERE "commandId" = ANY($1::text[])`,
    commandRows.map((row) => row.id),
  );
  const commands = commandRows.map((row) => ({
    ...row,
    syncAttempts: attemptRows.filter((attempt) => attempt.commandId === row.id)
      .map(({ target, status, verifiedAt }) => ({ target, status, verifiedAt })),
  }));
  // 시트·랠리즈는 은퇴해 등록·재조회·보호자 초대 항목이 없다(출처가 «랠리즈»인 과거 기록 표시는 그대로 둔다).
  return <main className="p-6 space-y-6">
    <h1 className="academy-page-title">입학 완료 확인</h1>
    <p>최근 승인 신청 100건까지 점검합니다. 승인만으로 등록이 완료되지는 않으며, ‘확인 필요’는 실패를 뜻하지 않습니다.</p>
    <p>실제 수강 시작일을 확인하세요. 승인일은 수강 시작일이 아닙니다. 이 화면에서는 발송·청구·장부를 변경하지 않습니다.</p>
    <Link className="underline" href="/admin/inbox?tab=ENROLL">수강 신청함으로 이동</Link>
    {applications.length === 0 && <p>승인된 신청이 없습니다.</p>}
    {applications.map((app) => {
      const result = registrationReadiness({ applicationId: app.id, studentId: app.convertedStudentId,
        assignedClassIds: [...new Set((app.assignedClassId ?? "").split(",").map((id) => id.trim()).filter(Boolean))],
        activeClassIds: enrollments.filter((row) => row.studentId === app.convertedStudentId).map((row) => row.classId),
        requestedStartOn: app.requestedStartOn,
        enrollmentStarts: enrollments.filter(row => row.studentId === app.convertedStudentId).map(row => ({ classId: row.classId, startsOn: row.startsOn })),
        shuttleNeeded: app.shuttleNeeded, shuttleProgress: shuttleProgress[app.id], commands: commands.filter((row) => row.studentId === app.convertedStudentId),
        invoiceCandidates: invoices.filter((row) => row.studentId === app.convertedStudentId).length });
      return <section key={app.id} className="border rounded-xl p-4 space-y-3">
        <h2 className="academy-section-title">{app.childName} · 등록 절차 확인 필요</h2>
        <p className="text-sm break-all">신청 번호: {app.id} / 원생 번호: {app.convertedStudentId ?? "미연결"}</p>
        <ul className="space-y-2">{result.checks.map((check) => <li key={check.key}>
          <strong>{check.label}: {check.status === "VERIFIED" ? check.key === "site" ? "현재 수강 확인" : check.key === "shuttle" ? "배차·안내 전달 확인" : "등록 재조회 확인" : "확인 필요"}</strong><p className="text-sm">{check.detail}</p>
        </li>)}</ul>
        <details className="space-y-3">
          <summary className="cursor-pointer font-medium">등록 원장 증거 {result.evidence.length}건 보기</summary>
          <p className="text-sm">아래 날짜·월은 원장 기록값이며 확정 수강 시작일을 뜻하지 않습니다. 이후 변경·무효화 여부도 별도 대조해야 합니다.</p>
          {result.evidence.length === 0 && <p>연결 후보 없음 · 기존 수강 유지나 복귀 신청은 신규 등록 원장이 없을 수 있습니다.</p>}
          {result.evidence.map((item, index) => <article key={`${item.commandId ?? "missing"}-${index}`} className="space-y-2 rounded border p-3 text-sm break-all">
            <p>처리 번호: {item.commandId ?? "없음"} · 상태: {PROCESS_LABELS[item.status] ?? "상태 확인 필요"}</p>
            <p>원장 신청 번호: {item.applicationId ?? "없음"} · 원생 번호: {item.studentId ?? "없음"}</p>
            <p>반 번호: {item.classId ?? "없음"} · 수강 번호: {item.enrollmentId ?? "없음"}</p>
            <p>출처: {SOURCE_LABELS[item.source ?? ""] ?? "출처 확인 필요"} · 종류: {KIND_LABELS[item.kind ?? ""] ?? "종류 확인 필요"} · 기록 월: {item.effectiveMonth ?? "없음"} · 기록 날짜: {item.eventDate ?? "없음"}</p>
            <p>처리 요청 시각: {item.createdAt ?? "미확인"}</p>
            <p>{item.reasons.length ? `확인 필요: ${item.reasons.join(" · ")}` : "신청·현재 수강·원장의 개시일 일치"}</p>
            {item.targets.map(target => <div key={target.target}>
              <b>시트 재조회 기록</b>
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
