import { getAdminRentalRequests } from "@/app/actions/rental";
import RentalAdminClient from "./RentalAdminClient";

export const dynamic = "force-dynamic";

export default async function AdminRentalPage() {
  // 권한 확인은 getAdminRentalRequests 안의 requireAdmin 이 맡는다.
  const rows = await getAdminRentalRequests();
  return <RentalAdminClient rows={rows} />;
}
