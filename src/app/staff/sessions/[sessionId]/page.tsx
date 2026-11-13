import { notFound, redirect } from "next/navigation";
import SessionInProgressClient from "./SessionInProgressClient";
import { getStaffSessionDetail, getStaffSessionStudents } from "@/lib/staff-session-queries";
import { getStaffClassAccessContext } from "@/lib/staff-class-access";
import { canSeeStaffFees } from "@/lib/staff-session-rules";

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
  if (session.status !== "IN_PROGRESS") redirect("/staff");
  const [students, query, access] = await Promise.all([
    getStaffSessionStudents(sessionId, session.classId),
    searchParams,
    getStaffClassAccessContext(),
  ]);
  return (
    <SessionInProgressClient
      session={session}
      initialStudents={students}
      initialView={query.view === "attendance" ? "attendance" : "main"}
      // f3: 출석부의 수강료·미납 줄은 원장·부원장만 본다(선생님은 화면·서버 응답 모두에서 빠진다).
      showFees={canSeeStaffFees(access.staff.appUserRole)}
    />
  );
}
