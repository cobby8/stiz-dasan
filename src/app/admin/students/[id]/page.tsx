import StudentDetailClient from "./StudentDetailClient";
import { getStudentActivity, getClasses, getStudentShuttleLocations } from "@/lib/queries";
import { notFound } from "next/navigation";
import { getStudentTenure } from "@/lib/student-tenure-query";

export const revalidate = 30;

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    // 학생 활동 데이터(무변경)·반 목록·실제 배차용 셔틀 위치를 병렬 조회
    // getClasses는 학생관리 목록 페이지가 쓰는 기존 쿼리를 그대로 재사용
    // getStudentShuttleLocations는 배차용 StudentShuttleLocation 조회(신규, getStudentActivity 무변경)
    // getStudentTenure: 총 재원기간(옛 시트 기준값 + 사이트 수강 기록). 실패하면 null 이라 화면은 그대로
    const [data, classes, shuttleLocations, tenure] = await Promise.all([
        getStudentActivity(id),
        getClasses(),
        getStudentShuttleLocations(id),
        getStudentTenure(id),
    ]);
    if (!data) notFound();

    // 사진 사용 동의 링크는 클라이언트 헤더 우측 액션으로 이동함
    return <StudentDetailClient studentId={id} data={data} classes={classes} shuttleLocations={shuttleLocations} tenure={tenure} />;
}
