import { requireAdmin } from "@/lib/auth-guard";
import { getRoleGrantsForAdmin } from "@/app/actions/role-requests-admin";
import RoleRequestsClient from "./RoleRequestsClient";

export const dynamic = "force-dynamic";

export default async function RoleRequestsPage() {
  // 권한 확인은 getRoleGrantsForAdmin 안의 requireAdmin 도 하지만, 화면에서도 먼저 확인한다(d3 — 함수가 바뀌어도 새지 않게).
  await requireAdmin();
  const data = await getRoleGrantsForAdmin();
  return <RoleRequestsClient pending={data.pending} active={data.active} canDecide={data.canDecide} />;
}
