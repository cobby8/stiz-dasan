import { prisma } from "@/lib/prisma";
import { getAccessibleClassIds, requireStaffClassAccess } from "@/lib/staff-class-access";
import { unlinkedMonthlyBillScopeSql } from "@/lib/staff-billing-lookup";
import { resolveStaffBillingGuard } from "@/lib/staff-billing-policy";

export type StaffClassBillingStatus = "UNPAID" | "PENDING_CONFIRMATION" | "PAID";

/** 이 청구가 어떤 근거로 지금 보고 있는 반에 연결됐는지 */
export type StaffClassBillingLinkSource = "PAYMENT" | "ENROLLMENT";

export type StaffClassBillingItem = {
  id: string;
  /** 지금 화면이 보고 있는 반. 항상 값이 있습니다. */
  classId: string;
  /** Payment에 실제로 저장된 반. 과거 데이터는 비어 있습니다. */
  paymentClassId: string | null;
  linkSource: StaffClassBillingLinkSource;
  studentId: string;
  studentName: string;
  title: string;
  amount: number;
  invoiceAmount: number;
  amountMismatch: boolean;
  studentMismatch: boolean;
  paymentStatus: string;
  invoiceStatus: string;
  dueDate: Date;
  paidDate: Date | null;
  invoiceNo: string;
  confirmationStatus: string | null;
  status: StaffClassBillingStatus;
  /** 교사가 납부 확인 요청을 보낼 수 있는지 */
  confirmable: boolean;
  /** 보낼 수 없다면 그 사유 (화면에 그대로 노출) */
  blockReason: string | null;
};

type StaffClassBillingRow = Omit<
  StaffClassBillingItem,
  "status" | "confirmable" | "blockReason"
>;

/**
 * 수업 현장에서 사용할 청구를 한 번의 쿼리로 조회합니다.
 *
 * 반을 찾는 방법이 두 가지입니다.
 *  1) Payment."classId"가 채워져 있으면 그 값을 그대로 신뢰합니다. (앞으로 생성되는 청구)
 *  2) 비어 있으면 학생의 활성 수강(Enrollment)으로 반을 잇습니다. (과거 이관 청구)
 * 2번은 정규 월 수강료(type='MONTHLY')로만 제한합니다. 셔틀·유니폼·특강 청구가
 * 반 정보 없이 정규반 화면에 새어 나오는 것을 막기 위해서입니다.
 *
 * 결제-청구서 금액/학생 일치는 더 이상 "조인 조건"이 아닙니다.
 * 예전에는 값이 어긋나면 청구가 화면에서 통째로 사라졌는데, 사라지는 것보다
 * "불일치" 경고를 띄우는 편이 훨씬 안전하기 때문에 플래그로 올려 보냅니다.
 */
export async function getStaffClassBilling(
  classId: string,
  studentId?: string,
): Promise<StaffClassBillingItem[]> {
  const normalizedClassId = classId.trim();
  const normalizedStudentId = studentId?.trim() || null;
  const access = await requireStaffClassAccess(normalizedClassId);
  // 반 정보 없는 옛 월 청구를 걸러 내려면 «내 담당 반 전부»가 필요하다(청구 탭과 같은 판정)
  const accessibleClassIds = await getAccessibleClassIds(access);

  const rows = await prisma.$queryRawUnsafe<StaffClassBillingRow[]>(
    `SELECT p.id, e."classId", p."classId" AS "paymentClassId",
            CASE WHEN p."classId" IS NULL THEN 'ENROLLMENT' ELSE 'PAYMENT' END AS "linkSource",
            p."studentId", s.name AS "studentName",
            COALESCE(NULLIF(i.title, ''), NULLIF(p.description, ''), '수강료') AS title,
            p.amount, i.amount AS "invoiceAmount",
            (i.amount <> p.amount) AS "amountMismatch",
            (i."studentId" <> p."studentId") AS "studentMismatch",
            p.status AS "paymentStatus", i.status AS "invoiceStatus",
            p."dueDate", p."paidDate", i."invoiceNo",
            confirmation.status AS "confirmationStatus"
       FROM "Payment" p
       JOIN "PaymentInvoice" i
         ON i."paymentId" = p.id
       JOIN "Student" s ON s.id = p."studentId"
       JOIN "Enrollment" e
         ON e."studentId" = p."studentId"
        AND e."classId" = $1
        AND e.status = 'ACTIVE'
       LEFT JOIN LATERAL (
         SELECT request.status
           FROM "StaffPaymentConfirmationRequest" request
          WHERE request."paymentId" = p.id
          ORDER BY request."createdAt" DESC
          LIMIT 1
       ) confirmation ON true
      WHERE (
              p."classId" = $1
              OR (p."classId" IS NULL AND p.type = 'MONTHLY')
            )
        -- 반 정보 없는 옛 월 청구는 «학생의 활성 수강 반이 전부 내 담당 반»일 때만 선생님에게 보인다.
        -- (두 선생님 반을 같이 듣는 학생의 청구가 양쪽에 보이던 구멍. 원장·부원장($4)은 전부)
        AND ${unlinkedMonthlyBillScopeSql("$3", "$4")}
        AND ($2::text IS NULL OR p."studentId" = $2)
        AND p.status IN ('PENDING', 'OVERDUE', 'PAID')
        AND i.status <> 'CANCELED'
      ORDER BY CASE
        WHEN confirmation.status = 'PENDING' THEN 0
        WHEN p.status IN ('PENDING', 'OVERDUE') THEN 1
        ELSE 2
      END, p."dueDate" DESC, s.name`,
    normalizedClassId,
    normalizedStudentId,
    accessibleClassIds,
    access.canAccessAllClasses,
  );

  return rows.map((row) => ({
    ...row,
    status:
      row.confirmationStatus === "PENDING"
        ? "PENDING_CONFIRMATION"
        : row.paymentStatus === "PAID" || row.invoiceStatus === "PAID"
          ? "PAID"
          : "UNPAID",
    ...resolveStaffBillingGuard({
      paymentClassId: row.paymentClassId,
      amountMismatch: row.amountMismatch,
      studentMismatch: row.studentMismatch,
    }),
  }));
}
