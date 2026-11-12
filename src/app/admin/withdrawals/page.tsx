import { requireAdmin } from "@/lib/auth-guard";
import { getPendingWithdrawalRequests } from "@/app/actions/account-withdrawal-admin";
import WithdrawalsClient from "./WithdrawalsClient";

export const dynamic = "force-dynamic";

export default async function WithdrawalsPage() {
  // 권한 확인은 getPendingWithdrawalRequests 안의 requireAdmin 도 하지만, 화면에서도 먼저 확인한다(d3 — 함수가 바뀌어도 새지 않게).
  await requireAdmin();
  const rows = await getPendingWithdrawalRequests();
  return <WithdrawalsClient rows={rows} />;
}
