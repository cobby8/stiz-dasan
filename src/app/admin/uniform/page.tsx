import { requireAdmin } from "@/lib/auth-guard";
import { getUniformOrdersForAdmin, type UniformOrderWithItems } from "@/lib/uniform-order-service";
import UniformOrdersClient from "./UniformOrdersClient";

export const dynamic = "force-dynamic";

export type UniformOrderAdminView = {
  id: string;
  partnerRequestId: string;
  parentName: string;
  parentPhone: string;
  customerMemo: string | null;
  orderStatus: string;
  stizSyncStatus: string;
  stizOrderNumber: string | null;
  stizDuplicate: boolean;
  stizMessage: string | null;
  sendAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: Array<{
    id: string;
    studentName: string;
    design: string | null;
    initials: string | null;
    backNumber: string | null;
    topSize: string | null;
    bottomSize: string | null;
    quantity: number;
  }>;
};

function serializeOrder(order: UniformOrderWithItems): UniformOrderAdminView {
  return {
    id: order.id,
    partnerRequestId: order.partnerRequestId,
    parentName: order.parentName,
    parentPhone: order.parentPhone,
    customerMemo: order.customerMemo,
    orderStatus: order.orderStatus,
    stizSyncStatus: order.stizSyncStatus,
    stizOrderNumber: order.stizOrderNumber,
    stizDuplicate: order.stizDuplicate,
    stizMessage: order.stizMessage,
    sendAttempts: order.sendAttempts,
    nextRetryAt: order.nextRetryAt?.toISOString() ?? null,
    lastError: order.lastError,
    lastSentAt: order.lastSentAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      studentName: item.studentName,
      design: item.design,
      initials: item.initials,
      backNumber: item.backNumber,
      topSize: item.topSize,
      bottomSize: item.bottomSize,
      quantity: item.quantity,
    })),
  };
}

export default async function UniformOrdersPage() {
  await requireAdmin();

  let rows: UniformOrderAdminView[] = [];
  let loadError = "";
  try {
    rows = (await getUniformOrdersForAdmin()).map(serializeOrder);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "유니폼 주문 목록을 불러오지 못했습니다.";
  }

  return <UniformOrdersClient initialOrders={rows} loadError={loadError} />;
}
