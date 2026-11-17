"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requireOwner } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { addOtherRevenue, deleteOtherRevenue, listOtherRevenue, updateOtherRevenue, type OtherRevenueRow } from "@/lib/billing/other-revenue";
import { OtherRevenueError, type OtherRevenueInput } from "@/lib/billing/other-revenue-rules";

// 기타 매출(2026-11-17) — /admin/other-revenue 화면에서 쓴다.
// 모두 원장(ADMIN) 전용: 부원장은 금액을 못 본다(moneyAccess 규칙). 각 함수 첫 줄에서 requireOwner.

type LoadResult = { ok: true; ready: boolean; rows: OtherRevenueRow[] } | { ok: false; message: string };
type SaveResult = { ok: true; message: string } | { ok: false; message: string };

/** 원장이 읽을 수 있는 오류 문장만 그대로 보이고, 그 밖의 오류는 일반 안내로 바꾼다 */
const failText = (error: unknown, fallback: string) => error instanceof OtherRevenueError ? error.message : fallback;

/** 기타 매출이 바뀌면 이 화면과 통계(수납 탭 «기타 매출» 줄)가 다시 읽게 한다 */
function refresh() {
    revalidatePath("/admin/other-revenue");
    revalidateTag("admin-stats", { expire: 0 });
}

/**
 * 감사 기록(누가 언제 무엇을 적고·고치고·지웠는지). 기록이 실패해도 본 작업은 이미 끝났으므로 되돌리지 않고 로그만 남긴다.
 * OperationsAuditLog 관례(gen_random_uuid · actorType ADMIN · detailsJson)를 따른다.
 */
async function audit(action: "OTHER_REVENUE_CREATED" | "OTHER_REVENUE_UPDATED" | "OTHER_REVENUE_DELETED", actorUserId: string, row: OtherRevenueRow) {
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
             VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3::jsonb)`,
            action, actorUserId, JSON.stringify({
                otherRevenueId: row.id, revenueDate: row.revenueDate, category: row.category,
                title: row.title, amount: row.amount, method: row.method,
            }));
    } catch (error) {
        console.error("[other-revenue] 감사 기록 실패:", error instanceof Error ? error.name : "");
    }
}

export async function loadOtherRevenue(ym: string): Promise<LoadResult> {
    await requireOwner();
    try {
        const { ready, rows } = await listOtherRevenue(prisma, String(ym ?? ""));
        return { ok: true, ready, rows };
    } catch (error) {
        if (!(error instanceof OtherRevenueError)) console.error("[other-revenue] 읽기 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: failText(error, "기타 매출을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.") };
    }
}

export async function createOtherRevenue(input: OtherRevenueInput): Promise<SaveResult> {
    const owner = await requireOwner();
    try {
        const row = await addOtherRevenue(prisma, input, owner.appUserId);
        await audit("OTHER_REVENUE_CREATED", owner.appUserId, row);
        refresh();
        return { ok: true, message: `${row.revenueDate} ${row.amount.toLocaleString("ko-KR")}원을 적었어요.` };
    } catch (error) {
        if (!(error instanceof OtherRevenueError)) console.error("[other-revenue] 추가 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: failText(error, "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
    }
}

export async function editOtherRevenue(id: string, input: OtherRevenueInput): Promise<SaveResult> {
    const owner = await requireOwner();
    try {
        const row = await updateOtherRevenue(prisma, String(id ?? ""), input);
        if (!row) return { ok: false, message: "이미 지워졌거나 찾을 수 없습니다. 화면을 새로고침해 주세요." };
        await audit("OTHER_REVENUE_UPDATED", owner.appUserId, row);
        refresh();
        return { ok: true, message: "고친 내용을 저장했어요." };
    } catch (error) {
        if (!(error instanceof OtherRevenueError)) console.error("[other-revenue] 수정 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: failText(error, "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
    }
}

export async function removeOtherRevenue(id: string): Promise<SaveResult> {
    const owner = await requireOwner();
    try {
        const row = await deleteOtherRevenue(prisma, String(id ?? ""));
        if (!row) return { ok: false, message: "이미 지워졌거나 찾을 수 없습니다." };
        await audit("OTHER_REVENUE_DELETED", owner.appUserId, row);
        refresh();
        return { ok: true, message: "기타 매출 한 건을 지웠어요." };
    } catch (error) {
        if (!(error instanceof OtherRevenueError)) console.error("[other-revenue] 삭제 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: failText(error, "지우지 못했습니다. 잠시 후 다시 시도해 주세요.") };
    }
}
