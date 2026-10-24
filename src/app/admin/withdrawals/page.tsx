import { getPendingWithdrawalRequests } from "@/app/actions/account-withdrawal-admin";
import WithdrawalsClient from "./WithdrawalsClient";

export const dynamic = "force-dynamic";

export default async function WithdrawalsPage() {
  // 권한 확인은 getPendingWithdrawalRequests 안의 requireAdmin 이 맡는다.
  const rows = await getPendingWithdrawalRequests();
  return <WithdrawalsClient rows={rows} />;
}
