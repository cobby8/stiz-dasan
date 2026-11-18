"use server";

/**
 * 학부모 «체험 신청 확인·변경·취소» (로그인 없음)
 *
 * - 열쇠: 신청 때 적은 아이 이름 + 학부모 휴대폰(숫자만 비교). 진행 중 신청만 보인다.
 * - 응답에는 연락처·학교·생년월일 같은 개인정보를 싣지 않는다(일정·상태만).
 * - 무차별 조회 방지: 접속 주소별·(이름+번호)별 시도 횟수 제한(원문은 저장하지 않고 해시만).
 * - 변경·취소는 신청 행을 잠근 뒤 DB 값으로 다시 판단하고, 관리자 이력(ApplicationContactLog)과
 *   관리자 알림(벨·웹푸시 — 기존 체험 신청 알림과 같은 notifyAdmins, 문자 틀 없음)을 남긴다.
 * - 학부모에게 문자를 보내지 않는다.
 */

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { toKstYmd } from "@/lib/datetime/kst";
import { ensureTrialLeadTable } from "@/app/actions/admin";
import { getAvailableTrialSlots } from "@/app/actions/public";
import { ensureApplicationContactLogInfrastructure } from "@/lib/application-contact-logs";
import { notifyAdmins } from "@/lib/notification";
import { takePublicRateLimit } from "@/lib/seasonal/public-rate-limit";
import { trialScheduleError, trialSlotPeriod } from "@/app/apply/trial/trialScheduleSelection";
import {
    TRIAL_SELF_SERVICE_ACTIVE_STATUSES,
    TRIAL_SELF_SERVICE_BLOCK_MESSAGE,
    normalizeTrialLookupInput,
    sameTrialSchedule,
    trialScheduleText,
    trialSelfCancelNote,
    trialSelfChangeNote,
    trialSelfServiceCancelBlock,
    trialSelfServiceChangeBlock,
    trialSelfServiceStatusLabel,
    type TrialScheduleSnapshot,
    type TrialSelfServiceLead,
} from "@/lib/trial-self-service/rules";

export type MyTrialApplication = {
    id: string;
    trialDate: string | null;
    trialDay: string | null;
    trialPeriod: string | null;
    scheduleText: string;
    statusLabel: string;
    /** 학원이 확정한 체험 일시(확정 전이면 null) */
    confirmedText: string | null;
    receivedText: string;
    canChange: boolean;
    canCancel: boolean;
    changeBlockedMessage: string | null;
    cancelBlockedMessage: string | null;
};

export type TrialLookupResult = { ok: true; items: MyTrialApplication[] } | { ok: false; message: string };
export type TrialMutationResult = { ok: true; item: MyTrialApplication | null; message: string } | { ok: false; message: string };

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITED = "조회 시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요.";
const INVALID_INPUT = "아이 이름과 신청할 때 적은 휴대폰 번호를 정확히 입력해 주세요.";
const NOT_FOUND = "입력한 정보와 일치하는 진행 중인 체험 신청이 없어요. 아이 이름과 번호를 다시 확인해 주세요.";
const SAVE_FAILED = "처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
const ACTIVE_STATUS_SQL = TRIAL_SELF_SERVICE_ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ");
const LEAD_COLUMNS = `id, status, "childName", "trialDate", "preferredDay", "preferredPeriod", "preferredSlotKey",
    "scheduledDate", "attendedDate", "convertedDate", "convertedStudentId", "enrollApplicationId",
    "enrollApplicationReceivedAt", "trialFeeConfirmed", "trialFeePaymentStatus", "createdAt"`;
const MATCH_SQL = `LOWER(TRIM("childName")) = LOWER($1)
    AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $2
    AND status IN (${ACTIVE_STATUS_SQL})`;

type LeadRow = Record<string, unknown>;

function pick<T = unknown>(row: LeadRow, key: string): T | null {
    return (row[key] ?? row[key.toLowerCase()] ?? null) as T | null;
}

/** 저장된 희망일(날짜만 '2026-11-20'::timestamptz 로 저장)을 KST 달력 날짜로 */
function ymdOf(value: unknown): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : toKstYmd(date);
}

function kstText(value: unknown, withTime: boolean): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "long",
        day: "numeric",
        weekday: "short",
        ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    }).format(date);
}

function leadOf(row: LeadRow): TrialSelfServiceLead {
    return {
        status: pick<string>(row, "status"),
        scheduledDate: pick<Date>(row, "scheduledDate"),
        attendedDate: pick<Date>(row, "attendedDate"),
        convertedDate: pick<Date>(row, "convertedDate"),
        convertedStudentId: pick<string>(row, "convertedStudentId"),
        enrollApplicationId: pick<string>(row, "enrollApplicationId"),
        enrollApplicationReceivedAt: pick<Date>(row, "enrollApplicationReceivedAt"),
        trialFeeConfirmed: Boolean(pick(row, "trialFeeConfirmed")),
        trialFeePaymentStatus: pick<string>(row, "trialFeePaymentStatus"),
    };
}

function scheduleOf(row: LeadRow): TrialScheduleSnapshot {
    return {
        trialDate: ymdOf(pick(row, "trialDate")),
        trialDay: pick<string>(row, "preferredDay"),
        trialPeriod: pick<string>(row, "preferredPeriod"),
    };
}

function toPublicItem(row: LeadRow, nowMs = Date.now()): MyTrialApplication {
    const lead = leadOf(row);
    const schedule = scheduleOf(row);
    const changeBlock = trialSelfServiceChangeBlock(lead, nowMs);
    const cancelBlock = trialSelfServiceCancelBlock(lead, nowMs);
    return {
        id: String(pick(row, "id")),
        ...schedule,
        scheduleText: trialScheduleText(schedule),
        statusLabel: trialSelfServiceStatusLabel(lead.status),
        confirmedText: lead.status === "SCHEDULED" ? kstText(lead.scheduledDate, true) : null,
        receivedText: kstText(pick(row, "createdAt"), false) ?? "",
        canChange: !changeBlock,
        canCancel: !cancelBlock,
        changeBlockedMessage: changeBlock ? TRIAL_SELF_SERVICE_BLOCK_MESSAGE[changeBlock] : null,
        cancelBlockedMessage: cancelBlock ? TRIAL_SELF_SERVICE_BLOCK_MESSAGE[cancelBlock] : null,
    };
}

function sha(value: string) {
    return createHash("sha256").update(value).digest("base64url");
}

async function clientIpKey(): Promise<string> {
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown";
    return sha(`trial-self:${ip}`);
}

/** 접속 주소별 20회, (이름+번호)별 8회 / 15분. 서버 인스턴스별 메모리 장부(최소 제한). */
async function allowAttempt(key: { childName: string; phoneDigits: string }): Promise<boolean> {
    const ip = await clientIpKey();
    const byIp = takePublicRateLimit(`trial-self:ip:${ip}`, { limit: 20, windowMs: RATE_WINDOW_MS });
    if (!byIp.allowed) return false;
    const byKey = takePublicRateLimit(`trial-self:key:${sha(`${key.childName.toLowerCase()}|${key.phoneDigits}`)}`, { limit: 8, windowMs: RATE_WINDOW_MS });
    return byKey.allowed;
}

function revalidateAdminTrialPages() {
    revalidatePath("/admin");
    revalidatePath("/admin/apply");
    revalidatePath("/admin/trial");
}

function notifyAdminsLater(title: string, message: string, eventId: string) {
    after(async () => {
        try {
            // 기존 체험 신청 알림과 같은 경로(벨·웹푸시). 문자 틀은 넘기지 않는다 → 문자 발송 없음.
            await notifyAdmins("TRIAL_APPLICATION", title, message, "/admin/trial", { notifyCoaches: false, eventId });
        } catch (error) {
            console.warn("[trial-self-service] admin notify failed:", (error as Error).message);
        }
    });
}

/** 아이 이름 + 휴대폰으로 진행 중인 체험 신청을 불러온다 */
export async function lookupMyTrialApplications(input: { childName?: string; parentPhone?: string }): Promise<TrialLookupResult> {
    const key = normalizeTrialLookupInput(input ?? {});
    if (!key) return { ok: false, message: INVALID_INPUT };
    if (!(await allowAttempt(key))) return { ok: false, message: RATE_LIMITED };
    try {
        await ensureTrialLeadTable();
        const rows = await prisma.$queryRawUnsafe<LeadRow[]>(
            `SELECT ${LEAD_COLUMNS} FROM "TrialLead" WHERE ${MATCH_SQL} ORDER BY "createdAt" DESC LIMIT 5`,
            key.childName,
            key.phoneDigits,
        );
        if (rows.length === 0) return { ok: false, message: NOT_FOUND };
        const nowMs = Date.now();
        return { ok: true, items: rows.map((row) => toPublicItem(row, nowMs)) };
    } catch (error) {
        console.error("[trial-self-service] lookup failed:", error);
        return { ok: false, message: SAVE_FAILED };
    }
}

class SelfServiceRejection extends Error {}

/** 체험 희망 날짜·교시 변경 */
export async function changeMyTrialApplication(input: {
    id?: string;
    childName?: string;
    parentPhone?: string;
    trialDate?: string;
    trialDay?: string;
    trialPeriod?: string;
}): Promise<TrialMutationResult> {
    const key = normalizeTrialLookupInput(input ?? {});
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!key || !id) return { ok: false, message: INVALID_INPUT };
    if (!(await allowAttempt(key))) return { ok: false, message: RATE_LIMITED };

    const next: TrialScheduleSnapshot = {
        trialDate: String(input.trialDate ?? ""),
        trialDay: String(input.trialDay ?? ""),
        trialPeriod: String(input.trialPeriod ?? ""),
    };
    const slots = await getAvailableTrialSlots();
    const scheduleError = trialScheduleError(
        { trialDate: next.trialDate ?? "", trialDay: next.trialDay ?? "", trialPeriod: next.trialPeriod ?? "" },
        slots,
    );
    if (scheduleError) return { ok: false, message: scheduleError };
    const slot = slots.find((item) => item.dayLabel === next.trialDay && trialSlotPeriod(item.slotKey) === next.trialPeriod);
    if (!slot) return { ok: false, message: "선택한 교시가 현재 시간표에 없습니다. 교시를 다시 선택해주세요." };

    try {
        await ensureTrialLeadTable();
        await ensureApplicationContactLogInfrastructure();
        const result = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRawUnsafe<LeadRow[]>(
                `SELECT ${LEAD_COLUMNS} FROM "TrialLead" WHERE id = $3 AND ${MATCH_SQL} LIMIT 1 FOR UPDATE`,
                key.childName,
                key.phoneDigits,
                id,
            );
            const row = rows[0];
            if (!row) throw new SelfServiceRejection(NOT_FOUND);
            const block = trialSelfServiceChangeBlock(leadOf(row));
            if (block) throw new SelfServiceRejection(TRIAL_SELF_SERVICE_BLOCK_MESSAGE[block]);
            const before = scheduleOf(row);
            if (sameTrialSchedule(before, next)) throw new SelfServiceRejection("바뀐 일정이 없어요. 새 날짜나 교시를 골라 주세요.");

            // 학원이 확정했던 일정은 더는 맞지 않으므로 풀고 «상담 진행 중»으로 돌린다 → 관리자가 다시 확정한다.
            const releasedSchedule = pick(row, "status") === "SCHEDULED";
            const updated = await tx.$queryRawUnsafe<LeadRow[]>(
                `UPDATE "TrialLead" SET
                    "trialDate" = $1::timestamptz,
                    "preferredDay" = $2,
                    "preferredDays" = $2,
                    "preferredPeriod" = $3,
                    "preferredSlotKey" = $4,
                    status = CASE WHEN status = 'SCHEDULED' THEN 'CONTACTED' ELSE status END,
                    "scheduledDate" = CASE WHEN status = 'SCHEDULED' THEN NULL ELSE "scheduledDate" END,
                    "scheduledClassId" = CASE WHEN status = 'SCHEDULED' THEN NULL ELSE "scheduledClassId" END,
                    "updatedAt" = NOW()
                  WHERE id = $5
                  RETURNING ${LEAD_COLUMNS}`,
                next.trialDate,
                next.trialDay,
                next.trialPeriod,
                slot.slotKey,
                id,
            );
            const note = trialSelfChangeNote(before, next, releasedSchedule);
            await tx.$executeRawUnsafe(
                `INSERT INTO "ApplicationContactLog" (id, "targetType", "trialLeadId", action, note, "createdByName", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, 'TRIAL', $1, 'SCHEDULED', $2, '학부모(온라인)', NOW(), NOW())`,
                id,
                note,
            );
            return { row: updated[0], childName: String(pick(row, "childName") ?? key.childName), note, releasedSchedule };
        });

        revalidateAdminTrialPages();
        notifyAdminsLater(
            result.releasedSchedule ? "체험 확정 일정 변경 요청(학부모)" : "체험 신청 일정 변경(학부모)",
            `${result.childName} — ${result.note.replace(/^학부모 온라인 일정 변경: /, "")}`,
            id,
        );
        return {
            ok: true,
            item: result.row ? toPublicItem(result.row) : null,
            message: result.releasedSchedule
                ? "일정 변경을 접수했어요. 학원에서 새 일정을 확인한 뒤 다시 안내해 드릴게요."
                : "체험 희망 일정을 바꿨어요. 학원에서 확인 후 연락드릴게요.",
        };
    } catch (error) {
        if (error instanceof SelfServiceRejection) return { ok: false, message: error.message };
        console.error("[trial-self-service] change failed:", error);
        return { ok: false, message: SAVE_FAILED };
    }
}

/** 체험 신청 취소 */
export async function cancelMyTrialApplication(input: {
    id?: string;
    childName?: string;
    parentPhone?: string;
    reason?: string;
}): Promise<TrialMutationResult> {
    const key = normalizeTrialLookupInput(input ?? {});
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!key || !id) return { ok: false, message: INVALID_INPUT };
    if (!(await allowAttempt(key))) return { ok: false, message: RATE_LIMITED };

    try {
        await ensureTrialLeadTable();
        await ensureApplicationContactLogInfrastructure();
        const result = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRawUnsafe<LeadRow[]>(
                `SELECT ${LEAD_COLUMNS} FROM "TrialLead" WHERE id = $3 AND ${MATCH_SQL} LIMIT 1 FOR UPDATE`,
                key.childName,
                key.phoneDigits,
                id,
            );
            const row = rows[0];
            if (!row) throw new SelfServiceRejection(NOT_FOUND);
            const block = trialSelfServiceCancelBlock(leadOf(row));
            if (block) throw new SelfServiceRejection(TRIAL_SELF_SERVICE_BLOCK_MESSAGE[block]);

            const note = trialSelfCancelNote(input.reason);
            await tx.$executeRawUnsafe(
                `UPDATE "TrialLead" SET status = 'CANCELLED', "lostReason" = $1, "updatedAt" = NOW() WHERE id = $2`,
                note,
                id,
            );
            await tx.$executeRawUnsafe(
                `INSERT INTO "ApplicationContactLog" (id, "targetType", "trialLeadId", action, note, "createdByName", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, 'TRIAL', $1, 'CANCELLED', $2, '학부모(온라인)', NOW(), NOW())`,
                id,
                note,
            );
            return {
                childName: String(pick(row, "childName") ?? key.childName),
                scheduleText: trialScheduleText(scheduleOf(row)),
                wasScheduled: pick(row, "status") === "SCHEDULED",
                note,
            };
        });

        revalidateAdminTrialPages();
        notifyAdminsLater(
            result.wasScheduled ? "확정된 체험 취소(학부모)" : "체험 신청 취소(학부모)",
            `${result.childName} — ${result.scheduleText}${result.note !== "학부모 온라인 취소" ? ` · ${result.note.replace(/^학부모 온라인 취소: /, "")}` : ""}`,
            id,
        );
        return { ok: true, item: null, message: "체험 신청을 취소했어요. 다음에 다시 신청해 주세요." };
    } catch (error) {
        if (error instanceof SelfServiceRejection) return { ok: false, message: error.message };
        console.error("[trial-self-service] cancel failed:", error);
        return { ok: false, message: SAVE_FAILED };
    }
}
