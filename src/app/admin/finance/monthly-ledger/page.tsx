import { requireAdmin } from "@/lib/auth-guard";
import MonthlyLedgerClient from "./MonthlyLedgerClient";
import { toKstYmd } from "@/lib/datetime/kst";

export const dynamic = "force-dynamic";

export default async function MonthlyLedgerPage() {
  await requireAdmin();
  const initialMonth = toKstYmd(new Date()).slice(0, 7);
  return <MonthlyLedgerClient initialMonth={initialMonth} />;
}
