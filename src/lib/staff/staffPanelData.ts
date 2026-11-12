// 스태프 관리 화면의 덧붙임 조회(2026-11-12) — 이미 있는 표만 읽는다(새 표·칸 없음).
//   1) 추가 역할 직원: UserRoleGrant ACTIVE + 주 역할이 학부모인 계정(보기 전용 줄)
//   2) 초대 문자 마지막 발송: NotificationDelivery(eventType STAFF_INVITATION, 발송 기록 원장)
//   3) 담당 반: 시간표 배정(ScheduleSlot·ClassSlotOverride·CustomClassSlot 의 coachId) + 슬롯 없는 반의 담당자
//      — 선생님 앱의 담당 수업 판정(src/lib/staff-class-access.ts)과 같은 기준
// 조회가 실패해도 화면 전체가 죽지 않게 각자 빈 목록으로 돌려준다(보조 정보라서).
import { prisma } from "@/lib/prisma";
import type { RosterClassAssignment, RosterGrantUser } from "@/lib/staff/staffRoster";

export type StaffInviteLastSend = {
    invitationId: string;
    status: string;
    /** 마지막 발송 시도 시각(ISO) */
    at: string;
};

function iso(value: unknown): string {
    const date = value instanceof Date ? value : new Date(String(value ?? ""));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export async function getStaffRoleGrantUsers(): Promise<RosterGrantUser[]> {
    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string | null; roles: string[] | null; coachId: string | null }>>(
            `SELECT u.id, u.name, u.phone,
                    ARRAY_AGG(DISTINCT g.role ORDER BY g.role) AS roles,
                    (SELECT c.id FROM "Coach" c WHERE c."userId" = u.id LIMIT 1) AS "coachId"
               FROM "UserRoleGrant" g
               JOIN "User" u ON u.id = g."userId"
              WHERE g.status = 'ACTIVE' AND u.role = 'PARENT' AND u."withdrawnAt" IS NULL
              GROUP BY u.id, u.name, u.phone
              ORDER BY u.name ASC`,
        );
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            phone: row.phone ?? null,
            roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
            coachId: row.coachId ?? null,
        }));
    } catch (error) {
        console.error("[staffPanelData] 추가 역할 직원 조회 실패:", error instanceof Error ? error.message : String(error));
        return [];
    }
}

export async function getStaffInviteLastSends(): Promise<StaffInviteLastSend[]> {
    try {
        // 초대·재발송 문자의 발송 기록 열쇠(stableEventKey) = 초대 id 또는 «초대 id:manual-resend:…»
        const rows = await prisma.$queryRawUnsafe<Array<{ invitationId: string; status: string; at: Date }>>(
            `SELECT DISTINCT ON (split_part(d."stableEventKey", ':', 1))
                    split_part(d."stableEventKey", ':', 1) AS "invitationId",
                    d.status, COALESCE(d."sentAt", d."failedAt", d."createdAt") AS at
               FROM "NotificationDelivery" d
              WHERE d."eventType" = 'STAFF_INVITATION' AND d.channel = 'SMS'
                AND split_part(d."stableEventKey", ':', 1) IN (
                  SELECT id FROM "StaffInvitation" WHERE status = 'PENDING'
                )
              ORDER BY split_part(d."stableEventKey", ':', 1), d."createdAt" DESC`,
        );
        return rows.map((row) => ({ invitationId: row.invitationId, status: row.status, at: iso(row.at) }));
    } catch (error) {
        console.error("[staffPanelData] 초대 문자 발송 기록 조회 실패:", error instanceof Error ? error.message : String(error));
        return [];
    }
}

export async function getStaffClassAssignments(): Promise<RosterClassAssignment[]> {
    try {
        return await prisma.$queryRawUnsafe<RosterClassAssignment[]>(
            `SELECT c.id AS "classId", c.name, c."dayOfWeek", c."startTime", x."coachId", NULL::text AS "instructorUserId"
               FROM "Class" c
               JOIN (
                 SELECT "slotKey", "coachId" FROM "ScheduleSlot" WHERE "coachId" IS NOT NULL
                 UNION
                 SELECT "slotKey", "coachId" FROM "ClassSlotOverride" WHERE "coachId" IS NOT NULL
                 UNION
                 SELECT id AS "slotKey", "coachId" FROM "CustomClassSlot" WHERE "coachId" IS NOT NULL
               ) x ON x."slotKey" = c."slotKey"
             UNION ALL
             SELECT c.id AS "classId", c.name, c."dayOfWeek", c."startTime", NULL::text AS "coachId", c."instructorId" AS "instructorUserId"
               FROM "Class" c
              WHERE c."slotKey" IS NULL AND c."instructorId" IS NOT NULL`,
        );
    } catch (error) {
        console.error("[staffPanelData] 담당 반 조회 실패:", error instanceof Error ? error.message : String(error));
        return [];
    }
}
