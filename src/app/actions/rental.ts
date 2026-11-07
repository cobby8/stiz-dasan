"use server";

/**
 * 체육관 대관 서버 액션.
 *  - 공개(로그인 없음): 날짜별 가능 시간 조회 · 신청 접수
 *  - 관리자(requireAdmin): 목록 · 상태 변경(승인/거절/입금 확인/사용 완료/환불/취소)
 *
 * 공개 액션은 개인 정보(다른 사람의 이름·번호)를 절대 돌려주지 않는다 — 가능 시간은 «칸 상태»만.
 * 금액은 서버가 다시 계산한다(gym-rental-service.createRentalRequest).
 */
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
import { isBookableDate, isRentalAction, type RentalSlot, type RentalStatus } from "@/lib/rental/gym-rental-rules";
import {
  createRentalRequest,
  isRentalOverlapViolation,
  listRentalRequests,
  loadRentalSlots,
  transitionRentalInTx,
  type RentalApplyInput,
  type RentalRecord,
} from "@/lib/rental/gym-rental-service";
import { notifyAdminsOfRentalRequest, rentalBankAccount, sendRentalApplicantSms } from "@/lib/rental/gym-rental-notify";

// ── 공개 ─────────────────────────────────────────────────────────────────
export type RentalSlotsResult = { ok: true; date: string; slots: RentalSlot[] } | { ok: false; message: string };

export async function getRentalSlots(date: string): Promise<RentalSlotsResult> {
  const nowMs = Date.now();
  if (!isBookableDate(String(date ?? ""), todayKst(nowMs))) return { ok: false, message: "신청할 수 없는 날짜입니다." };
  try {
    return { ok: true, date, slots: await loadRentalSlots(prisma, date, nowMs) };
  } catch (error) {
    console.error("[rental] slots failed:", (error as Error).message);
    return { ok: false, message: "가능한 시간을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}

export type RentalSubmitResult =
  | {
      ok: true;
      duplicate: boolean;
      receipt: {
        number: string; // 접수 번호(앞 8자리)
        rentalDate: string;
        startHour: number;
        endHour: number;
        headcount: number;
        useAircon: boolean;
        usageFee: number;
        deposit: number;
        totalAmount: number;
        bankAccount: string; // 신청 완료 화면에서만 보여 준다
      };
    }
  | { ok: false; message: string };

export async function submitRentalRequest(input: RentalApplyInput & { honeypot?: string }): Promise<RentalSubmitResult> {
  // 스팸 방지: 숨김 칸에 값이 있으면 자동 입력으로 보고 저장하지 않는다(기존 공개 폼과 같은 방식)
  if (input?.honeypot) return { ok: false, message: "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  try {
    const result = await createRentalRequest(prisma, input, Date.now());
    if (!result.ok) return result;
    const r = result.request;
    if (!result.duplicate) {
      // 응답을 먼저 돌려주고 알림은 뒤에서 — 문자 공급자가 느려도 손님 화면이 멈추지 않게
      after(async () => {
        await notifyAdminsOfRentalRequest(r);
        await sendRentalApplicantSms("received", r);
      });
      revalidatePath("/admin/rental");
    }
    return {
      ok: true,
      duplicate: result.duplicate,
      receipt: {
        number: r.id.slice(0, 8).toUpperCase(),
        rentalDate: r.rentalDate,
        startHour: r.startHour,
        endHour: r.endHour,
        headcount: r.headcount,
        useAircon: r.useAircon,
        usageFee: r.usageFee,
        deposit: r.deposit,
        totalAmount: r.totalAmount,
        bankAccount: rentalBankAccount(),
      },
    };
  } catch (error) {
    console.error("[rental] submit failed:", (error as Error).message);
    return { ok: false, message: "신청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}

// ── 관리자 ───────────────────────────────────────────────────────────────
export type AdminRentalRow = Omit<RentalRecord, "createdAt" | "approvedAt" | "paidAt" | "completedAt" | "refundedAt" | "closedAt"> & {
  createdAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;
  closedAt: string | null;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toAdminRow(r: RentalRecord): AdminRentalRow {
  return {
    ...r,
    status: r.status as RentalStatus,
    createdAt: iso(r.createdAt) ?? "",
    approvedAt: iso(r.approvedAt),
    paidAt: iso(r.paidAt),
    completedAt: iso(r.completedAt),
    refundedAt: iso(r.refundedAt),
    closedAt: iso(r.closedAt),
  };
}

export async function getAdminRentalRequests(): Promise<AdminRentalRow[]> {
  await requireAdmin();
  const rows = await listRentalRequests(prisma);
  return rows.map(toAdminRow);
}

export async function updateRentalStatus(
  id: string,
  action: string,
  options: { memo?: string; depositRefunded?: number | null } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await requireAdmin();
  if (!isRentalAction(action)) return { ok: false, error: "알 수 없는 작업입니다." };
  try {
    const result = await prisma.$transaction((tx) => transitionRentalInTx(tx, id, action, admin.appUserId, options));
    if (!result.ok) return { ok: false, error: result.message };
    const r = result.request;
    // 신청자 안내(스위치 꺼져 있으면 아무 일도 없음)
    if (action === "approve") after(() => sendRentalApplicantSms("approved", r));
    if (action === "confirmPayment") after(() => sendRentalApplicantSms("confirmed", r));
    revalidatePath("/admin/rental");
    return { ok: true };
  } catch (error) {
    if (isRentalOverlapViolation(error)) {
      return { ok: false, error: "이미 승인된 다른 대관과 시간이 겹칩니다. 거절하거나 시간을 조정해 주세요." };
    }
    console.error("[rental] status update failed:", (error as Error).message);
    return { ok: false, error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
