import { randomUUID } from "node:crypto";
import type { UniformOrder, UniformOrderItem } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildStizUniformOrderPayload,
  normalizeUniformOrderInput,
  postStizUniformOrder,
  StizUniformPartnerError,
  type NormalizedUniformOrderItem,
  type UniformOrderFormInput,
} from "@/lib/uniform-partner";

export type UniformOrderWithItems = UniformOrder & {
  items: UniformOrderItem[];
};

export type UniformOrderSubmitResult = {
  success: true;
  id: string;
  mode: "created" | "existing";
  syncStatus: string;
  orderNumber: string | null;
  message: string;
};

export type UniformDispatchResult = {
  id: string;
  syncStatus: string;
  orderNumber: string | null;
  message: string;
};

const DUPLICATE_WINDOW_MS = 10 * 60_000;
const RETRY_DELAY_MINUTES = [1, 5, 30];

function nextRetryAt(attempts: number) {
  const minutes = RETRY_DELAY_MINUTES[Math.min(Math.max(attempts - 1, 0), RETRY_DELAY_MINUTES.length - 1)];
  return new Date(Date.now() + minutes * 60_000);
}

function clip(value: string | null | undefined, limit = 500) {
  if (!value) return null;
  return value.length > limit ? value.slice(0, limit) : value;
}

function buildPartnerRequestId(id: string) {
  return `dasan-uniform-${id}`;
}

function toResult(order: Pick<UniformOrder, "id" | "stizSyncStatus" | "stizOrderNumber" | "stizMessage">): UniformDispatchResult {
  return {
    id: order.id,
    syncStatus: order.stizSyncStatus,
    orderNumber: order.stizOrderNumber,
    message: order.stizMessage || "",
  };
}

export async function createUniformOrderSubmission(input: UniformOrderFormInput): Promise<UniformOrderSubmitResult> {
  if (input.honeypot) {
    return {
      success: true,
      id: "ok",
      mode: "created",
      syncStatus: "PENDING",
      orderNumber: null,
      message: "접수되었습니다.",
    };
  }

  const normalized = normalizeUniformOrderInput(input);
  const duplicateCutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const existing = await prisma.uniformOrder.findFirst({
    where: {
      parentPhoneDigits: normalized.parentPhoneDigits,
      itemSignature: normalized.itemSignature,
      orderStatus: "RECEIVED",
      createdAt: { gte: duplicateCutoff },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return {
      success: true,
      id: existing.id,
      mode: "existing",
      syncStatus: existing.stizSyncStatus,
      orderNumber: existing.stizOrderNumber,
      message: "이미 같은 신청이 접수되어 있습니다.",
    };
  }

  const id = randomUUID();
  const order = await prisma.uniformOrder.create({
    data: {
      id,
      partnerRequestId: buildPartnerRequestId(id),
      parentName: normalized.parentName,
      parentPhone: normalized.parentPhone,
      parentPhoneDigits: normalized.parentPhoneDigits,
      customerMemo: normalized.memo,
      itemSignature: normalized.itemSignature,
      items: {
        create: normalized.students.map((student) => ({
          studentName: student.studentName,
          design: student.design,
          initials: student.initials,
          backNumber: student.backNumber,
          topSize: student.topSize,
          bottomSize: student.bottomSize,
          quantity: student.quantity,
        })),
      },
    },
  });

  const dispatch = await dispatchUniformOrderById(order.id);
  return {
    success: true,
    id: order.id,
    mode: "created",
    syncStatus: dispatch.syncStatus,
    orderNumber: dispatch.orderNumber,
    message: dispatch.message,
  };
}

export async function dispatchUniformOrderById(orderId: string): Promise<UniformDispatchResult> {
  const order = await prisma.uniformOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("유니폼 신청을 찾지 못했습니다.");
  }
  if (order.stizSyncStatus === "SENT" || order.stizSyncStatus === "DUPLICATE") {
    return toResult(order);
  }

  if (!process.env.STIZ_PARTNER_SECRET?.trim()) {
    const updated = await prisma.uniformOrder.update({
      where: { id: order.id },
      data: {
        stizSyncStatus: "SETUP_REQUIRED",
        lastError: "STIZ_PARTNER_SECRET 설정 필요",
        updatedAt: new Date(),
      },
    });
    return toResult(updated);
  }

  const attempts = order.sendAttempts + 1;
  await prisma.uniformOrder.update({
    where: { id: order.id },
    data: {
      stizSyncStatus: "SENDING",
      sendAttempts: { increment: 1 },
      nextRetryAt: null,
      lastError: null,
      updatedAt: new Date(),
    },
  });

  const payload = buildStizUniformOrderPayload({
    partnerRequestId: order.partnerRequestId,
    parentName: order.parentName,
    parentPhone: order.parentPhone,
    memo: order.customerMemo,
    students: order.items.map(toNormalizedItem),
  });

  try {
    const response = await postStizUniformOrder(payload);
    const updated = await prisma.uniformOrder.update({
      where: { id: order.id },
      data: {
        stizSyncStatus: response.duplicate ? "DUPLICATE" : "SENT",
        stizOrderNumber: response.orderNumber || order.stizOrderNumber,
        stizDuplicate: Boolean(response.duplicate),
        stizMessage: response.message || "본사 접수 완료",
        lastSentAt: new Date(),
        lastError: null,
        nextRetryAt: null,
        updatedAt: new Date(),
      },
    });
    return toResult(updated);
  } catch (error) {
    const partnerError = error instanceof StizUniformPartnerError ? error : null;
    const status = partnerError?.retryable || !partnerError ? "RETRY_WAIT" : "NEEDS_REVIEW";
    const updated = await prisma.uniformOrder.update({
      where: { id: order.id },
      data: {
        stizSyncStatus: status,
        lastError: clip(error instanceof Error ? error.message : "본사 접수 중 문제가 발생했습니다."),
        nextRetryAt: status === "RETRY_WAIT" ? nextRetryAt(attempts) : null,
        updatedAt: new Date(),
      },
    });
    return toResult(updated);
  }
}

export async function dispatchDueUniformOrders(limit = 5) {
  const orders = await prisma.uniformOrder.findMany({
    where: {
      orderStatus: "RECEIVED",
      stizSyncStatus: { in: ["PENDING", "RETRY_WAIT"] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const results: UniformDispatchResult[] = [];
  for (const order of orders) {
    results.push(await dispatchUniformOrderById(order.id));
  }
  return {
    processed: results.length,
    sent: results.filter((result) => result.syncStatus === "SENT" || result.syncStatus === "DUPLICATE").length,
    review: results.filter((result) => result.syncStatus === "NEEDS_REVIEW" || result.syncStatus === "SETUP_REQUIRED").length,
    retry: results.filter((result) => result.syncStatus === "RETRY_WAIT").length,
    results,
  };
}

export async function getUniformOrdersForAdmin(limit = 150): Promise<UniformOrderWithItems[]> {
  return prisma.uniformOrder.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}

function toNormalizedItem(item: UniformOrderItem): NormalizedUniformOrderItem {
  return {
    studentName: item.studentName,
    design: item.design,
    initials: item.initials,
    backNumber: item.backNumber,
    topSize: item.topSize,
    bottomSize: item.bottomSize,
    quantity: item.quantity,
  };
}
