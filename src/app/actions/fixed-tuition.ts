"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { addFixedTuition, deleteFixedTuition, FixedTuitionError, listFixedTuition, type FixedTuitionInput, type FixedTuitionRow } from "@/lib/billing/fixed-tuition";

// 학생별 고정 월 수강료(2026-11-16 원장 결정 — 결정표 x4) — 학생 상세 «청구/수납» 탭에서 쓴다.
// 모두 원장(ADMIN) 전용: 부원장은 금액·청구 준비를 못 본다(moneyAccess 규칙). 각 함수 첫 줄에서 requireOwner.

type LoadResult = { ok: true; ready: boolean; rows: FixedTuitionRow[] } | { ok: false; message: string };
type SaveResult = { ok: true; message: string } | { ok: false; message: string };

/** 원장이 읽을 수 있는 오류 문장만 그대로 보이고, 그 밖의 오류는 일반 안내로 바꾼다 */
const failText = (error: unknown, fallback: string) => error instanceof FixedTuitionError ? error.message : fallback;

/** 고정 수강료가 바뀌면 학생 상세와 청구 준비가 다시 읽게 한다 */
function refresh(studentId: string) {
    revalidatePath(`/admin/students/${studentId}`);
    revalidatePath("/admin/finance/prepare");
}

export async function loadFixedTuition(studentId: string): Promise<LoadResult> {
    await requireOwner();
    try {
        const { ready, rows } = await listFixedTuition(prisma, String(studentId ?? ""));
        return { ok: true, ready, rows };
    } catch (error) {
        console.error("[fixed-tuition] 읽기 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: "고정 수강료를 불러오지 못했습니다. 잠시 후 다시 열어 주세요." };
    }
}

export async function saveFixedTuition(input: FixedTuitionInput): Promise<SaveResult> {
    const owner = await requireOwner();
    try {
        const row = await addFixedTuition(prisma, input, owner.appUserId);
        refresh(row.studentId);
        return { ok: true, message: `고정 수강료 월 ${row.amount.toLocaleString("ko-KR")}원을 저장했어요. 청구 준비에서 ${row.startMonth}부터 이 금액으로 계산합니다.` };
    } catch (error) {
        if (!(error instanceof FixedTuitionError)) console.error("[fixed-tuition] 저장 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: failText(error, "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
    }
}

export async function removeFixedTuition(id: string, studentId: string): Promise<SaveResult> {
    await requireOwner();
    try {
        const count = await deleteFixedTuition(prisma, String(id ?? ""), String(studentId ?? ""));
        refresh(String(studentId));
        return count > 0 ? { ok: true, message: "고정 수강료를 지웠어요. 청구 준비는 반별 요금으로 다시 계산합니다." } : { ok: false, message: "이미 지워졌거나 찾을 수 없습니다." };
    } catch (error) {
        if (!(error instanceof FixedTuitionError)) console.error("[fixed-tuition] 삭제 실패:", error instanceof Error ? error.name : "");
        return { ok: false, message: failText(error, "지우지 못했습니다. 잠시 후 다시 시도해 주세요.") };
    }
}
