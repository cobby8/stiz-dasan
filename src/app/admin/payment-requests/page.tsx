import { requireAdmin } from "@/lib/auth-guard";
import { getPaymentParentRequests } from "@/lib/payments/admin-payment-request";
import PaymentRequestsClient from "./PaymentRequestsClient";

export const dynamic = "force-dynamic";

export default async function PaymentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  const params = await searchParams;
  const status =
    params?.status === "ALL" || params?.status === "DONE" || params?.status === "REJECTED"
      ? params.status
      : "PENDING";
  const rows = await getPaymentParentRequests(status);
  return <PaymentRequestsClient rows={rows} status={status} />;
}
