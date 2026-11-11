"use server";

import { revalidatePath } from "next/cache";
import { getPendingWithdrawalRequests } from "@/app/actions/account-withdrawal-admin";
import { requireAdmin } from "@/lib/auth-guard";
import { processMediaRevocationQueue } from "@/lib/mediaRevocationQueue";
import { prisma } from "@/lib/prisma";
import { createMakeup, decideMakeup, getMakeupOptions } from "@/lib/seasonal/makeup";
import { loadKakaoRequests } from "../kakao-requests/kakaoRequestData";

function selectedId(id: string) {
  if (typeof id !== "string" || !id.trim() || id.length > 100) throw new Error("INVALID_INBOX_ID");
  return id.trim();
}

export async function readInboxKakaoRequest(id: string) {
  return loadKakaoRequests("ALL", selectedId(id));
}

export async function readInboxWithdrawal(id: string) {
  const [row] = await getPendingWithdrawalRequests(selectedId(id));
  return row ? {
    administrativeHold: row.administrativeHold,
    reviewMessage: row.reviewMessage,
    activeEnrollments: row.activeEnrollments,
  } : null;
}

export async function readInboxSeasonalAbsence(id: string) {
  await requireAdmin();
  return prisma.specialProgramAbsence.findUnique({
    where: { id: selectedId(id) },
    select: { status: true, resolution: true },
  });
}

export async function readInboxSeasonalMakeupOptions(absenceId: string) {
  await requireAdmin();
  const absence = await prisma.specialProgramAbsence.findUnique({
    where: { id: selectedId(absenceId) },
    select: { enrollmentDateId: true, status: true, resolution: true },
  });
  if (absence?.status !== "CONFIRMED" || absence.resolution !== "MAKEUP") return null;
  return getMakeupOptions(absence.enrollmentDateId);
}

type MakeupTarget =
  | { targetType: "SEASONAL"; targetSessionDateId: string }
  | { targetType: "REGULAR"; targetClassId: string; targetDate: string | null };

export async function assignInboxSeasonalMakeup(absenceId: string, enrollmentDateId: string, target: MakeupTarget) {
  const admin = await requireAdmin();
  const assignment = target?.targetType === "SEASONAL"
    ? { targetType: target.targetType, targetSessionDateId: selectedId(target.targetSessionDateId) }
    : target?.targetType === "REGULAR" && target.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(target.targetDate)
      ? { targetType: target.targetType, targetClassId: selectedId(target.targetClassId), targetDate: target.targetDate }
      : null;
  if (!assignment) throw new Error("INVALID_INBOX_MAKEUP_TARGET");
  try {
    const result = await createMakeup({
      ...assignment,
      enrollmentDateId: selectedId(enrollmentDateId),
      sourceAbsenceId: selectedId(absenceId),
      requestedBy: "ADMIN",
      userId: admin.appUserId,
    });
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/seasonal/attendance");
    return { ok: true, ...result } as const;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === "MAKEUP_SOURCE_CONFLICT") return { ok: false, reason: "SOURCE" } as const;
    if (error.message === "MAKEUP_ALREADY_EXISTS") return { ok: false, reason: "ASSIGNED" } as const;
    if (["TARGET_FULL", "TARGET_ALREADY_ENROLLED", "TARGET_NOT_IN_OFFERING"].includes(error.message)) {
      return { ok: false, reason: "TARGET" } as const;
    }
    throw error;
  }
}

export async function readInboxSeasonalMakeup(id: string) {
  await requireAdmin();
  return prisma.specialProgramMakeup.findUnique({
    where: { id: selectedId(id) },
    select: { status: true },
  });
}

type MakeupDecision = Parameters<typeof decideMakeup>[1];

const decisionsByStatus: Readonly<Record<string, readonly MakeupDecision[]>> = {
  REQUESTED: ["APPROVE", "REJECT"],
  APPROVED: ["CANCEL"],
  SCHEDULED: ["ATTENDED", "NO_SHOW", "CANCEL"],
  ATTENDED: ["CANCEL"],
  NO_SHOW: ["CANCEL"],
};

export async function decideInboxSeasonalMakeup(id: string, expectedStatus: string, decision: MakeupDecision) {
  const admin = await requireAdmin();
  if (!Object.hasOwn(decisionsByStatus, expectedStatus) || !decisionsByStatus[expectedStatus].includes(decision)) {
    return { ok: false, reason: "STATUS" } as const;
  }
  try {
    await decideMakeup(selectedId(id), decision, admin.appUserId, expectedStatus);
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/seasonal/attendance");
    return { ok: true } as const;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (["MAKEUP_STATUS_CONFLICT", "MAKEUP_NOT_FOUND"].includes(error.message)) return { ok: false, reason: "STATUS" } as const;
    if (error.message === "TARGET_ALREADY_ENROLLED") return { ok: false, reason: "SEAT" } as const;
    throw error;
  }
}

export async function readInboxMediaRevocation(id: string) {
  await requireAdmin();
  return prisma.mediaRevocationJob.findUnique({
    where: { id: selectedId(id) },
    select: { status: true, channel: true, resourceUrl: true },
  });
}

export async function retryInboxMediaRevocation(id: string) {
  await requireAdmin();
  const result = await processMediaRevocationQueue(1, selectedId(id));
  revalidatePath("/admin/inbox");
  revalidatePath("/admin/media-revocations");
  revalidatePath("/admin/gallery");
  revalidatePath("/gallery");
  revalidatePath("/");
  return result;
}
