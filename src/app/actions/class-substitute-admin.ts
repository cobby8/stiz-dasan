"use server";

// 대타 선생님 지정(f4, 2026-11-13) — 관리자 서버 액션.
// 모두 requireAdmin(원장·부원장) 게이트. DB 는 $queryRawUnsafe/$executeRawUnsafe 만(PgBouncer).
// 대타 권한 판정 자체는 src/lib/staff-class-access.ts 한 곳에서 한다(여기는 지정·취소만).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
import { SEASONAL_SUBSTITUTE_MESSAGE, SUBSTITUTE_TEACHER_SQL, validateSubstituteInput } from "@/lib/staff/classSubstitute";

type ActionResult = { ok: true } | { ok: false; message: string };

function revalidateViews() {
    revalidatePath("/admin/staff");
    revalidatePath("/staff");
}

/** 관리자 확인 실패를 화면에 보일 결과로 바꾼다(예외를 던지면 화면이 오류 페이지로 넘어간다). */
async function adminGate(): Promise<{ ok: true; adminUserId: string } | { ok: false; message: string }> {
    try {
        const admin = await requireAdmin();
        return { ok: true, adminUserId: admin.appUserId };
    } catch {
        return { ok: false, message: "원장·부원장만 대타를 지정할 수 있습니다." };
    }
}

/**
 * 대타 지정. 같은 날 같은 반에 이미 지정이 있으면 선생님을 바꿔 끼운다(한 반·하루에 대타 한 명).
 * - 반이 실제로 있고, 날짜 요일이 그 반 수업 요일과 같아야 한다.
 * - 대타는 선생님 계정만(주 역할 선생님 또는 승인된 선생님 추가 역할). 학부모·기사님 계정은 거부.
 */
export async function assignClassSubstitute(input: {
    date: string;
    classId: string;
    substituteUserId: string;
}): Promise<ActionResult> {
    const gate = await adminGate();
    if (!gate.ok) return gate;

    const date = String(input?.date ?? "").trim();
    const classId = String(input?.classId ?? "").trim();
    const substituteUserId = String(input?.substituteUserId ?? "").trim();
    if (!date || !classId || !substituteUserId) return { ok: false, message: "날짜·반·선생님을 모두 골라 주세요." };

    const classRows = await prisma.$queryRawUnsafe<Array<{ dayOfWeek: string }>>(
        `SELECT "dayOfWeek" FROM "Class" WHERE id = $1 LIMIT 1`,
        classId,
    );
    if (!classRows[0]) return { ok: false, message: "반 정보를 찾을 수 없습니다." };

    const invalid = validateSubstituteInput({ date, classDayOfWeek: classRows[0].dayOfWeek, today: todayKst() });
    if (invalid) return { ok: false, message: invalid };

    // 그날 특강 회차가 연결된 반은 거부(검수 M1) — 출석 명단이 특강 좌석 기준(특강 담당 강사 권한)으로 바뀌어
    // 대타가 수업을 시작해도 명단이 막히고 진행 중 기록만 남는다. 특강은 담당 강사를 바꾸는 게 맞다.
    // 판정은 출석 명단의 특강 전환(getStaffSessionStudents 폴백)과 같은 조건: 연결 반 + 회차 KST 날짜.
    const seasonalRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT sd.id
           FROM "SpecialProgramSessionDate" sd
           JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
          WHERE o."linkedClassId" = $1
            AND (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $2::date
          LIMIT 1`,
        classId,
        date,
    );
    if (seasonalRows[0]) return { ok: false, message: SEASONAL_SUBSTITUTE_MESSAGE };

    // 역할 확인 — 화면 목록과 같은 조건(SUBSTITUTE_TEACHER_SQL)을 서버에서 다시 본다(요청 값 조작 방지).
    const teacherRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT u.id FROM "User" u WHERE u.id = $1 AND ${SUBSTITUTE_TEACHER_SQL} LIMIT 1`,
        substituteUserId,
    );
    if (!teacherRows[0]) return { ok: false, message: "선생님 계정만 대타로 지정할 수 있습니다." };

    await prisma.$executeRawUnsafe(
        `INSERT INTO "ClassSubstitute" (id, date, "classId", "substituteUserId", "createdBy", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW())
         ON CONFLICT (date, "classId") DO UPDATE
           SET "substituteUserId" = EXCLUDED."substituteUserId",
               "createdBy" = EXCLUDED."createdBy",
               "createdAt" = NOW()`,
        date,
        classId,
        substituteUserId,
        gate.adminUserId,
    );
    revalidateViews();
    return { ok: true };
}

/** 대타 지정 취소. 지운 즉시 그 선생님은 그 반 출석부를 다시 못 연다. */
export async function cancelClassSubstitute(input: { id: string }): Promise<ActionResult> {
    const gate = await adminGate();
    if (!gate.ok) return gate;
    const id = String(input?.id ?? "").trim();
    if (!id) return { ok: false, message: "취소할 지정을 찾을 수 없습니다." };

    const deleted = await prisma.$executeRawUnsafe(`DELETE FROM "ClassSubstitute" WHERE id = $1`, id);
    if (!deleted) return { ok: false, message: "이미 취소된 지정입니다. 화면을 새로고침해 주세요." };
    revalidateViews();
    return { ok: true };
}
