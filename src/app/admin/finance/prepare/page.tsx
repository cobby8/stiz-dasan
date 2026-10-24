import { requireAdmin } from "@/lib/auth-guard";
import BillingWorkbench from "./BillingWorkbench";

export default async function BillingPreparationPage() {
    await requireAdmin();
    return <BillingWorkbench />;
}
