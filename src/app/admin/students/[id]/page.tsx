import StudentDetailClient from "./StudentDetailClient";
import { getStudentActivity, getClasses, getStudentShuttleLocations } from "@/lib/queries";
import { notFound } from "next/navigation";
import { getStudentTenure } from "@/lib/student-tenure-query";
import { isBillingParentSendEnabled } from "@/lib/billing/parentSendGuard";
import { requireAdmin } from "@/lib/auth-guard";
import { isFinanceOwnerRole } from "@/lib/payments/studentBillingRules";
import StudentShuttleAssignment from "./StudentShuttleAssignment";

// 참고: 아래 requireAdmin() 이 로그인 쿠키를 읽으므로 이 페이지는 사실상 요청마다 새로 그린다(동적).
// 30초 캐시 값은 예전 설정 그대로 남겨 둔 것이고, 청구 변경 뒤 화면 갱신은 클라이언트 loadData(no-store)가 맡는다.
export const revalidate = 30;

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    // 학생 활동 데이터(무변경)·반 목록·실제 배차용 셔틀 위치를 병렬 조회
    // getClasses는 학생관리 목록 페이지가 쓰는 기존 쿼리를 그대로 재사용
    // getStudentShuttleLocations는 배차용 StudentShuttleLocation 조회(신규, getStudentActivity 무변경)
    // getStudentTenure: 총 재원기간(옛 시트 기준값 + 사이트 수강 기록). 실패하면 null 이라 화면은 그대로
    // requireAdmin: 청구서 수정·삭제 메뉴를 원장(재무 소유자)에게만 보이려고 역할을 읽는다(서버 판정과 같은 기준)
    const [data, classes, shuttleLocations, tenure, adminUser] = await Promise.all([
        getStudentActivity(id),
        getClasses(),
        getStudentShuttleLocations(id),
        getStudentTenure(id),
        requireAdmin(),
    ]);
    if (!data) notFound();

    // 사진 사용 동의 링크는 클라이언트 헤더 우측 액션으로 이동함
    // 청구서 발행 창의 «학부모 알림» 칸 — 사이트 발송 잠금(서버 환경변수)이면 끈 채로 잠근다
    return <StudentDetailClient studentId={id} data={data} classes={classes} shuttleLocations={shuttleLocations} shuttleAssignment={<StudentShuttleAssignment studentId={id} />} tenure={tenure} billingParentSendEnabled={isBillingParentSendEnabled()} canManageFinance={isFinanceOwnerRole(adminUser.appUserRole)} />;
}
