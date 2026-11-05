// 학생 상세 «총 재원기간» 조회 — 계산은 순수 모듈(student-tenure.ts)에 맡기고 여기선 재료만 모은다
//
// getStudentActivity 는 손대지 않고(기존 화면 조회 보존) 별도 함수로 둔다.
// 마이그레이션(Student.tenure* 칸)이 아직 운영에 없으면 SELECT 가 실패하는데,
// 그때 학생 상세 화면 전체가 죽지 않도록 null 을 돌려 «표시 안 함» 으로 넘어간다.
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { computeStudentTenure, type StudentTenure } from "@/lib/student-tenure";

type BaselineRow = {
  tenureBaselineMonths: number | null;
  tenureBaselineThrough: string | null;
  tenureFirstMonth: string | null;
};

export async function getStudentTenure(studentId: string): Promise<StudentTenure | null> {
  try {
    const [baselineRows, liveRows] = await Promise.all([
      prisma.$queryRawUnsafe<BaselineRow[]>(
        `SELECT "tenureBaselineMonths", "tenureBaselineThrough", "tenureFirstMonth"
         FROM "Student" WHERE id = $1`,
        studentId,
      ),
      // 사이트 기록의 수강 달 = 수강료 청구 달 ∪ 실제 출석한 수업의 달
      // - Payment: year/month 가 있는 수강료(MONTHLY·TUITION)만, 취소·환불 등은 제외(PAID·PENDING)
      prisma.$queryRawUnsafe<{ ym: string }[]>(
        `SELECT DISTINCT ym FROM (
           SELECT to_char(make_date(p.year, p.month, 1), 'YYYY-MM') AS ym
           FROM "Payment" p
           WHERE p."studentId" = $1
             AND p.type IN ('MONTHLY', 'TUITION')
             AND p.status IN ('PAID', 'PENDING', 'OVERDUE') -- 청구된 달 = 수강한 달(연체도 수강은 함)
             AND p.year IS NOT NULL
             AND p.month BETWEEN 1 AND 12
           UNION
           -- Session.date 는 «KST 날짜 자정»으로 저장된다(staff-class-people.ts 등과 같은 읽기)
           SELECT to_char(se.date, 'YYYY-MM') AS ym
           FROM "Attendance" a
           JOIN "Session" se ON se.id = a."sessionId"
           WHERE a."studentId" = $1
             AND a.status IN ('PRESENT', 'LATE')
         ) t`,
        studentId,
      ),
    ]);

    const base = baselineRows[0];
    if (!base) return null;

    return computeStudentTenure({
      baselineMonths: base.tenureBaselineMonths === null ? null : Number(base.tenureBaselineMonths),
      baselineThrough: base.tenureBaselineThrough,
      firstMonth: base.tenureFirstMonth,
      liveMonths: liveRows.map((row) => row.ym),
      currentMonth: todayKst().slice(0, 7), // KST 오늘의 "YYYY-MM"
    });
  } catch (error) {
    // 재원기간은 부가 정보라 실패해도 상세 화면은 그대로 보여준다
    console.error("[getStudentTenure] failed:", error);
    return null;
  }
}
