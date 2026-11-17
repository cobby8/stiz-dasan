import { NextRequest } from "next/server";
import { createAdminTiming, requireTimedAdmin, timedJson } from "@/lib/adminTiming";
import { getStudentSiblings, getUnpaidPaymentsForStudents } from "@/lib/queries";
import { maskFinancePayloadForRole } from "@/lib/payments/financeRoleMask";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * 한 학생의 «모든 달» 미납·연체 청구 + 같은 보호자 형제의 미납 — 2026-11-17 원장:
 * 월별로만 보여서 밀린 달을 세 번 나눠 결제한 불편. 수납 관리 «이 학생 미납 전체 현장 결제»와 학생 상세 버튼이 쓴다.
 *
 * 응답: { student: { id, name } | null, payments: 이 학생 미납(오래된 달부터),
 *         siblings: [{ id, name, payments }] — 미납이 있는 형제만 }
 * 미납 청구만 돌려주므로 부원장에게도 금액이 보인다(financeRoleMask 규칙 그대로 한 번 더 거른다).
 * 결제 자체는 기존 현장 결제(POS) 요청 생성이 같은 학생·최대 10건·500만원 규칙을 다시 확인한다.
 */
export async function GET(request: NextRequest) {
    const timing = createAdminTiming("admin-finance-student-unpaid");

    let role: string;
    try {
        role = (await requireTimedAdmin(timing)).appUserRole;
    } catch {
        return timedJson(timing, { error: "Authentication required" }, { status: 401 });
    }

    const studentId = String(request.nextUrl.searchParams.get("studentId") ?? "").trim();
    if (!studentId || studentId.length > 64) {
        return timedJson(timing, { error: "studentId required" }, { status: 400 });
    }

    try {
        const family = await timing.measure("siblings", () => getStudentSiblings(studentId));
        // 보호자 연결이 없는 학생은 본인만
        const ids = family.length > 0 ? family.map((s) => s.id) : [studentId];
        const rows = await timing.measure("unpaid", () => getUnpaidPaymentsForStudents(ids));
        const { payments } = maskFinancePayloadForRole({ payments: rows, summary: {} }, role);

        const own = payments.filter((p) => p.studentId === studentId);
        const siblings = family
            .filter((s) => s.id !== studentId)
            .map((s) => ({ id: s.id, name: s.name, payments: payments.filter((p) => p.studentId === s.id) }))
            .filter((s) => s.payments.length > 0);
        const name = family.find((s) => s.id === studentId)?.name ?? own[0]?.studentName ?? null;

        return timedJson(
            timing,
            { student: name ? { id: studentId, name } : null, payments: own, siblings },
            { headers: NO_STORE },
        );
    } catch (error) {
        console.error("[api/admin/finance/student-unpaid] failed:", error);
        return timedJson(timing, { error: "Failed to load unpaid payments" }, { status: 500 });
    }
}
