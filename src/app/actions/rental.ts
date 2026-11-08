"use server";

/**
 * 체육관 대관 서버 액션.
 *  - 공개(로그인 없음): 날짜별 가능 시간 조회 · 신청 접수
 *  - 관리자(requireAdmin): 목록 · 상태 변경(승인/거절/입금 확인/사용 완료/환불/취소)
 *
 * 공개 액션은 개인 정보(다른 사람의 이름·번호)를 절대 돌려주지 않는다 — 가능 시간은 «칸 상태»만.
 * 금액은 서버가 다시 계산한다(gym-rental-service.createRentalRequest).
 */
import { createHash } from "node:crypto";
import { after } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getVerifiedParentState, requireAdmin, requireAuth } from "@/lib/auth-guard";
import { childAccessSql } from "@/lib/account/child-access";
import { todayKst } from "@/lib/datetime/kst";
import { isBookableDate, isRentalAction, rentalBankCopyText, type RentalAction, type RentalDay, type RentalStatus } from "@/lib/rental/gym-rental-rules";
import {
  createRentalRequest,
  isRentalOverlapViolation,
  listRentalMemberStudents,
  listRentalRequests,
  loadRentalDay,
  saveRentalSmsStatus,
  transitionRentalInTx,
  type RentalApplyInput,
  type RentalMemberStudent,
  type RentalMemberViewer,
  type RentalRecord,
} from "@/lib/rental/gym-rental-service";
import {
  loadRentalApplicantSmsSwitches,
  notifyAdminsOfRentalRequest,
  rentalBankAccount,
  sendRentalApplicantSms,
  type RentalApplicantSmsKind,
  type RentalSmsOutcome,
} from "@/lib/rental/gym-rental-notify";

// ── 공개 ─────────────────────────────────────────────────────────────────
/**
 * 접속 주소(IP) 지문 — x-forwarded-for 의 첫 값(Vercel 이 채우는 실제 손님 주소)을 sha256 으로.
 * 원문 IP 는 저장하지 않는다. 주소를 모르면 null(연락처 한도·전체 한도는 그대로 걸린다).
 */
async function clientIpHash(): Promise<string | null> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "";
  if (!ip) return null;
  return createHash("sha256").update(`gym-rental:${ip}`).digest("hex");
}

// ── 로그인 계정(재원생 무료) ──────────────────────────────────────────────
// 공개 페이지는 정적(ISR) 그대로 두고, 로그인 여부는 손님 기기에서 이 액션으로 묻는다(쿠키를 읽는 건 액션뿐).

type RentalAccount = { appUserId: string; role: string; name: string; phone: string | null };

/** 로그인한 앱 계정(없으면 null) — 탈퇴 계정 제외 */
async function currentRentalAccount(): Promise<RentalAccount | null> {
  let authUserId: string;
  try {
    authUserId = (await requireAuth()).id;
  } catch {
    return null;
  }
  const rows = await prisma.$queryRawUnsafe<RentalAccount[]>(
    `SELECT id AS "appUserId", role::text AS role, name, phone FROM "User"
      WHERE ("authUserId" = $1 OR ("authUserId" IS NULL AND id = $1)) AND "withdrawnAt" IS NULL
      LIMIT 1`,
    authUserId,
  );
  return rows[0] ?? null;
}

/**
 * 재원생 무료 판정에 쓰는 계정 — 학부모 화면과 같은 기준(getVerifiedParentState: 휴대폰 인증 등)을 통과하고,
 * 실제 역할이 PARENT 인 계정만. 직원 계정(원장 자녀가 있어도)은 무료 적용 안 됨(원장 지시).
 * 학생 범위는 마이페이지 «내 자녀»와 같은 childAccessSql(가족 공유 연결 포함).
 */
async function rentalMemberViewer(account: RentalAccount | null): Promise<RentalMemberViewer | null> {
  if (!account || account.role !== "PARENT") return null;
  const state = await getVerifiedParentState();
  if (state.status !== "OK" || state.parent.appUserId !== account.appUserId) return null;
  return { appUserId: account.appUserId, role: account.role, accessSql: await childAccessSql("s", "$1") };
}

export type RentalMemberContext = {
  signedIn: boolean;
  name: string; // 신청자 칸 미리 채우기(수정 가능)
  phone: string;
  students: RentalMemberStudent[]; // 무료 대관 가능한 연결 재원생(없으면 빈 목록 → 화면에 체크칸 없음)
};

export async function getRentalMemberContext(): Promise<RentalMemberContext> {
  try {
    const account = await currentRentalAccount();
    if (!account) return { signedIn: false, name: "", phone: "", students: [] };
    const viewer = await rentalMemberViewer(account);
    const students = await listRentalMemberStudents(prisma, viewer);
    return { signedIn: true, name: account.name ?? "", phone: account.phone ?? "", students };
  } catch (error) {
    console.error("[rental] member context failed:", (error as Error).message);
    return { signedIn: false, name: "", phone: "", students: [] };
  }
}

// 그날 시작 후보(10분 간격)·막힌 구간 — 다른 사람의 이름·번호는 담지 않는다
export type RentalSlotsResult = { ok: true; date: string; day: RentalDay } | { ok: false; message: string };

export async function getRentalSlots(date: string): Promise<RentalSlotsResult> {
  const nowMs = Date.now();
  if (!isBookableDate(String(date ?? ""), todayKst(nowMs))) return { ok: false, message: "신청할 수 없는 날짜입니다." };
  try {
    const day = await loadRentalDay(prisma, date, nowMs);
    if (!day) return { ok: false, message: "신청할 수 없는 날짜입니다." };
    return { ok: true, date, day };
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
        startMinute: number; // 그날 KST 0시부터 분
        endMinute: number;
        headcount: number;
        useAircon: boolean;
        usageFee: number;
        deposit: number;
        totalAmount: number;
        memberFree: boolean; // 재원생 무료(서버 확인 완료)
        bankAccount: string; // 신청 완료 화면에서만 보여 준다
        bankCopyText: string; // 간편송금 붙여넣기용 «은행명 계좌번호»(예금주 제외)
      };
    }
  | { ok: false; message: string };

export async function submitRentalRequest(input: RentalApplyInput & { honeypot?: string }): Promise<RentalSubmitResult> {
  // 스팸 방지: 숨김 칸에 값이 있으면 자동 입력으로 보고 저장하지 않는다(기존 공개 폼과 같은 방식)
  if (input?.honeypot) return { ok: false, message: "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  try {
    const ipHash = await clientIpHash();
    // 로그인 계정 — 재원생 무료 확인과 «신청한 계정» 기록용(비로그인이면 null)
    const account = await currentRentalAccount();
    const viewer = account ? (await rentalMemberViewer(account)) ?? { appUserId: account.appUserId, role: account.role, accessSql: "" } : null;
    // 한도 확인과 저장을 한 트랜잭션에서(서비스 안의 advisory lock 으로 줄 세움)
    const result = await prisma.$transaction((tx) => createRentalRequest(tx, input, Date.now(), ipHash, viewer));
    if (!result.ok) return result;
    const r = result.request;
    if (!result.duplicate) {
      // 응답을 먼저 돌려주고 알림은 뒤에서 — 문자 공급자가 느려도 손님 화면이 멈추지 않게
      after(async () => {
        await notifyAdminsOfRentalRequest(r);
        await sendRentalApplicantSms("received", r); // 접수 문자는 전용 스위치로 꺼 둠(변경 금지)
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
        startMinute: r.startMinute,
        endMinute: r.endMinute,
        headcount: r.headcount,
        useAircon: r.useAircon,
        usageFee: r.usageFee,
        deposit: r.deposit,
        totalAmount: r.totalAmount,
        memberFree: r.memberFree === true,
        bankAccount: rentalBankAccount(),
        bankCopyText: rentalBankCopyText(rentalBankAccount()),
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

// 환불 계좌는 돈을 돌려줄 수 있는 단계에서만 화면으로 보낸다(개인정보 최소화)
//  - PAID: 확정 뒤 취소 창에서 돌려줄 계좌가 필요 · COMPLETED/REFUNDED: 보증금 환불 · CANCELLED: 취소 환불 확인
// 보증금 0원(재원생 무료) 건은 처음부터 계좌를 받지 않아 비어 있다.
const REFUND_ACCOUNT_VISIBLE: readonly RentalStatus[] = ["PAID", "COMPLETED", "REFUNDED", "CANCELLED"];

function toAdminRow(r: RentalRecord): AdminRentalRow {
  const showRefund = REFUND_ACCOUNT_VISIBLE.includes(r.status as RentalStatus);
  return {
    ...r,
    memberFree: r.memberFree === true,
    memberStudentName: r.memberStudentName ?? null,
    refundBank: showRefund ? r.refundBank : null,
    refundAccount: showRefund ? r.refundAccount : null,
    refundHolder: showRefund ? r.refundHolder : null,
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

/** 관리자 확인창의 문자 미리보기용 — 입금 계좌와 신청자 문자 켜짐 여부(관리자만) */
export async function getAdminRentalSmsContext(): Promise<{ bankAccount: string; smsOn: Record<"approved" | "rejected" | "confirmed", boolean> }> {
  await requireAdmin();
  return { bankAccount: rentalBankAccount(), smsOn: await loadRentalApplicantSmsSwitches() };
}

// 버튼 → 신청자 문자 종류(사용 완료·환불·취소는 문자 없음)
const SMS_KIND_BY_ACTION: Partial<Record<RentalAction, RentalApplicantSmsKind>> = {
  approve: "approved",
  reject: "rejected",
  confirmPayment: "confirmed",
};

export type RentalStatusOptions = { memo?: string; depositRefunded?: number | null; cancelRefund?: number | null; rejectReason?: string };
export type RentalStatusResult = { ok: true; sms: RentalSmsOutcome | null } | { ok: false; error: string };

export async function updateRentalStatus(id: string, action: string, options: RentalStatusOptions = {}): Promise<RentalStatusResult> {
  const admin = await requireAdmin();
  if (!isRentalAction(action)) return { ok: false, error: "알 수 없는 작업입니다." };
  try {
    const result = await prisma.$transaction((tx) => transitionRentalInTx(tx, id, action, admin.appUserId, {
      memo: options.memo,
      depositRefunded: options.depositRefunded,
      cancelRefund: options.cancelRefund,
      rejectReason: options.rejectReason,
    }));
    if (!result.ok) return { ok: false, error: result.message };
    const r = result.request;
    // 신청자 안내 — 상태는 이미 저장됐다. 문자가 실패해도 되돌리지 않고 결과만 기록해 화면에 «문자 실패»로 보인다.
    // 원장님이 바로 결과를 보도록 기다렸다가 보낸다(스위치가 꺼져 있으면 즉시 OFF).
    const kind = SMS_KIND_BY_ACTION[action];
    let sms: RentalSmsOutcome | null = null;
    if (kind) {
      sms = await sendRentalApplicantSms(kind, r);
      try {
        await saveRentalSmsStatus(prisma, r.id, `${sms}:${kind}`);
      } catch (error) {
        console.error("[rental] sms status save failed:", (error as Error).message);
      }
    }
    revalidatePath("/admin/rental");
    return { ok: true, sms };
  } catch (error) {
    if (isRentalOverlapViolation(error)) {
      return { ok: false, error: "이미 승인된 다른 대관과 시간이 겹칩니다. 거절하거나 시간을 조정해 주세요." };
    }
    console.error("[rental] status update failed:", (error as Error).message);
    return { ok: false, error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
