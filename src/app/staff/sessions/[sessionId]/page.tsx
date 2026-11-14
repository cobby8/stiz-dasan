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
  // 2026-11-14 원장 지시: 완료한 수업도 들어가서 보고 고칠 수 있다 — «수업 한 화면» 부품이 완료한 수업 본문(다시 보기)을 고른다.
  // 시작 전(PLANNED) 수업은 예전처럼 홈으로 보낸다.
  if (session.status !== "IN_PROGRESS" && session.status !== "COMPLETED") redirect("/staff");
  const [students, query, access] = await Promise.all([
    getStaffSessionStudents(sessionId, session.classId),
    searchParams,
    getStaffClassAccessContext(),
  ]);
  return (
    <SessionInProgressClient
      // 진행 중 → 완료로 바뀌면 화면 상태를 처음부터 다시 만든다
      key={`${session.id}:${session.status}`}
      session={session}
      initialStudents={students}
      initialView={query.view === "attendance" ? "attendance" : "main"}
      // f3: 출석부의 수강료·미납 줄은 원장·부원장만 본다(선생님은 화면·서버 응답 모두에서 빠진다).
      showFees={canSeeStaffFees(access.staff.appUserRole)}
      // 완료한 수업의 수정 기간: 원장·부원장은 제한 없음(선생님은 수업일 포함 7일) — 서버 저장도 같은 판정 함수로 다시 막는다.
      editUnlimited={access.canAccessAllClasses}
    />
  );
}
