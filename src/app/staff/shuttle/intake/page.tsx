import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { isServiceMonth, koreaServiceMonth } from "@/lib/regular/serviceMonth";
import ShuttleIntakeClient from "@/components/shuttle/intake/ShuttleIntakeClient";

export const dynamic = "force-dynamic";

export default async function StaffShuttleIntakePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const staff = await requireStaff();
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");
  const { month } = await searchParams;
  const initialMonth = month && isServiceMonth(month) ? month : koreaServiceMonth();
  return <ShuttleIntakeClient mode="driver" initialMonth={initialMonth} />;
}
