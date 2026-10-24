import { requireAdmin } from "@/lib/auth-guard";
import OperationalDeliveryClient from "./OperationalDeliveryClient";

export const dynamic = "force-dynamic";

export default async function OperationalDeliveriesPage() {
  await requireAdmin();
  return <OperationalDeliveryClient />;
}
