import { getRoleGrantsForAdmin } from "@/app/actions/role-requests-admin";
import RoleRequestsClient from "./RoleRequestsClient";

export const dynamic = "force-dynamic";

export default async function RoleRequestsPage() {
  // 권한 확인은 getRoleGrantsForAdmin 안의 requireAdmin 이 맡는다.
  const data = await getRoleGrantsForAdmin();
  return <RoleRequestsClient pending={data.pending} active={data.active} canDecide={data.canDecide} />;
}
