import { prisma } from "@/lib/prisma";
import { getAccessibleClassIds, getStaffClassAccessContext } from "@/lib/staff-class-access";
import { resolveStaffBillingGuard } from "@/lib/staff-billing-policy";
import { normalizePhoneNumber } from "@/lib/staff-contacts";
import { notMergedStudent } from "@/lib/studentVisibility";
import { todayKst } from "@/lib/datetime/kst";
import { resolveBillingMonth, splitBillingMonth, unlinkedMonthlyBillScopeSql } from "@/lib/staff-billing-lookup";

export type StaffStudentListItem = { id: string; name: string; school: string | null; grade: string | null; studentPhone: string | null; parentName: string; parentPhone: string | null; classNames: string[] };
export type StaffBillingListItem = { id: string; classId: string; paymentClassId: string | null; studentName: string; className: string; title: string; amount: number; invoiceAmount: number; amountMismatch: boolean; studentMismatch: boolean; status: string; dueDate: Date; paidDate: Date | null; invoiceNo: string | null; confirmationStatus: string | null; confirmable: boolean; blockReason: string | null };
type StaffBillingRow = Omit<StaffBillingListItem, "confirmable" | "blockReason">;
type StudentRow = Omit<StaffStudentListItem, "classNames"> & { classNames: string[] | null };

/** 담당 수업을 먼저 확정한 뒤 그 수업의 활성 수강생만 조회합니다. */
export async function getStaffStudents(): Promise<StaffStudentListItem[]> {
  const access = await getStaffClassAccessContext();
  const classIds = await getAccessibleClassIds(access);
  if (!classIds.length) return [];
  const rows = await prisma.$queryRawUnsafe<StudentRow[]>(
    `SELECT s.id, s.name, s.school, s.grade, s.phone AS "studentPhone",
            p.name AS "parentName", p.phone AS "parentPhone",
            array_agg(DISTINCT c.name ORDER BY c.name) AS "classNames"
     FROM "Student" s JOIN "User" p ON p.id = s."parentId"
     JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
     JOIN "Class" c ON c.id = e."classId"
     -- 병합으로 흡수된 학생은 담당 반 명단에서 제외한다
     WHERE e."classId" = ANY($1::text[]) AND ${notMergedStudent("s")}
     GROUP BY s.id, s.name, s.school, s.grade, s.phone, p.name, p.phone ORDER BY s.name`, classIds);
  return rows.map((row) => ({ ...row, studentPhone: normalizePhoneNumber(row.studentPhone), parentPhone: normalizePhoneNumber(row.parentPhone), classNames: row.classNames ?? [] }));
}

/** 교사용 청구 화면은 담당 학생 범위의 조회만 제공하고 상태를 직접 바꾸지 않습니다. */
export async function getStaffBilling(options: { month?: string } = {}): Promise<StaffBillingListItem[]> {
  const access = await getStaffClassAccessContext();
  const classIds = await getAccessibleClassIds(access);
  if (!classIds.length) return [];
  // 달은 바깥(주소창)에서 오는 값이라 여기서 한 번 더 검사한다 — 이상하면 이번 달(KST).
  // 반 id 는 화면에서 받지 않는다(담당 반은 서버가 로그인 계정으로만 정한다).
  const currentMonth = todayKst().slice(0, 7);
  const { year, month } = splitBillingMonth(resolveBillingMonth(options.month, currentMonth));

  // 반 연결은 두 갈래입니다. Payment."classId"가 있으면 그 값을 신뢰하고,
  // 비어 있는 과거 청구는 학생의 활성 수강(Enrollment)으로 잇되 정규 월 수강료만 허용합니다.
  // (셔틀·유니폼·특강 청구가 반 정보 없이 새어 나오는 것을 막기 위한 제한입니다.)
  // 한 학생이 여러 반을 들으면 같은 청구가 반마다 잡히므로 DISTINCT ON으로 1건만 남깁니다.
  const rows = await prisma.$queryRawUnsafe<StaffBillingRow[]>(
    `SELECT * FROM (
       SELECT DISTINCT ON (p.id)
              p.id,e."classId",p."classId" AS "paymentClassId",
              s.name AS "studentName",c.name AS "className",
              COALESCE(NULLIF(i.title,''),NULLIF(p.description,''),'수강료') AS title,
              p.amount,i.amount AS "invoiceAmount",
              (i.amount <> p.amount) AS "amountMismatch",
              (i."studentId" <> p."studentId") AS "studentMismatch",
              p.status,p."dueDate",p."paidDate",p."invoiceNo",
              r.status AS "confirmationStatus"
         FROM "Payment" p
         JOIN "PaymentInvoice" i ON i."paymentId"=p.id
         JOIN "Student" s ON s.id=p."studentId"
         JOIN "Enrollment" e ON e."studentId"=p."studentId" AND e.status='ACTIVE' AND e."classId"=ANY($1::text[])
         JOIN "Class" c ON c.id=e."classId"
         LEFT JOIN LATERAL (SELECT status FROM "StaffPaymentConfirmationRequest" r WHERE r."paymentId"=p.id ORDER BY r."createdAt" DESC LIMIT 1) r ON true
        WHERE (p."classId"=e."classId" OR (p."classId" IS NULL AND p.type='MONTHLY'))
          -- 반 정보 없는 옛 월 수강료는 «그 학생의 활성 수강 반이 전부 내 담당 반»일 때만 선생님에게 보인다.
          -- 두 선생님 반을 같이 듣는 학생의 청구가 양쪽에 보이던 구멍을 막는다. 원장·부원장($2)은 전부.
          -- 같은 규칙: staff-billing-lookup.ts canSeeUnlinkedMonthlyBill (반별 청구 시트도 같은 조각을 쓴다)
          AND ${unlinkedMonthlyBillScopeSql("$1", "$2")}
          -- 미납은 달과 상관없이 항상 포함(옛 미납이 숨으면 수납 누락), 납부 완료·환불은 고른 달 것만
          AND (p.status IN ('PENDING','OVERDUE') OR (p.status IN ('PAID','REFUNDED') AND p.year=$3::int AND p.month=$4::int))
          -- 환불하면 청구서가 취소(CANCELED)로 바뀌므로, 환불 건만 취소 청구서를 허용한다
          AND (i.status <> 'CANCELED' OR p.status='REFUNDED')
        ORDER BY p.id,(p."classId" IS NULL),c.name
     ) b
     ORDER BY CASE WHEN b.status IN ('OVERDUE','PENDING') THEN 0 ELSE 1 END,b."dueDate" DESC,b."studentName"`, classIds, access.canAccessAllClasses, year, month,
  );

  return rows.map((row) => ({
    ...row,
    ...resolveStaffBillingGuard({
      paymentClassId: row.paymentClassId,
      amountMismatch: row.amountMismatch,
      studentMismatch: row.studentMismatch,
    }),
  }));
}
