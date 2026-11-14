import { notFound, redirect } from "next/navigation";
import SessionInProgressClient from "./SessionInProgressClient";
import { getStaffSessionDetail, getStaffSessionStudents } from "@/lib/staff-session-queries";
import { getStaffClassAccessContext } from "@/lib/staff-class-access";
import { canSeeStaffFees } from "@/lib/staff-session-rules";
import { kstLabel } from "@/lib/datetime/kst";
import { staffSessionEditWindow } from "@/lib/staff/sessionEditWindow";

export const dynamic = "force-dynamic";

export default async function StaffSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { sessionId } = await params;
  const session = await getStaffSessionDetail(sessionId);
  if (!session) notFound();
  // 2026-11-14 원장 지시: 완료한 수업도 들어가서 보고 고칠 수 있다 — 같은 화면을 «다시 보기»(review) 모양으로 연다.
  // 시작 전(PLANNED) 수업은 예전처럼 홈으로 보낸다.
  const completed = session.status === "COMPLETED";
  if (session.status !== "IN_PROGRESS" && !completed) redirect("/staff");
  const [students, query, access] = await Promise.all([
    getStaffSessionStudents(sessionId, session.classId),
    searchParams,
    getStaffClassAccessContext(),
  ]);
  // 고칠 수 있는가 — 서버 저장(사진·영상·한 줄·메모·출결 정정)과 같은 판정 함수. 원장·부원장은 기간 제한 없음.
  const editWindow = staffSessionEditWindow({
    status: session.status,
    sessionYmd: session.sessionYmd,
    todayYmd: session.todayYmd,
    unlimited: access.canAccessAllClasses,
  });
  return (
    <SessionInProgressClient
      // 진행 중 → 완료로 바뀌면 화면 상태를 처음부터 다시 만든다
      key={`${session.id}:${session.status}`}
      session={session}
      initialStudents={students}
      initialView={query.view === "attendance" ? "attendance" : "main"}
      // f3: 출석부의 수강료·미납 줄은 원장·부원장만 본다(선생님은 화면·서버 응답 모두에서 빠진다).
      showFees={canSeeStaffFees(access.staff.appUserRole)}
      mode={completed ? "review" : "live"}
      review={completed ? {
        editable: editWindow.ok,
        published: session.published,
        dateLabel: `${kstLabel(session.sessionYmd)} ${session.startTime}~${session.endTime}`,
      } : undefined}
    />
  );
}
