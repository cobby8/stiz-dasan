import { requireAdmin } from "@/lib/auth-guard";
import MonthlyRegisterClient from "./MonthlyRegisterClient";

export const dynamic = "force-dynamic";

export default async function MonthlyRegisterPage({ searchParams }: {
  searchParams: Promise<{ studentId?: string; month?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  return <MonthlyRegisterClient initialStudentId={params.studentId ?? ""} initialMonth={params.month ?? ""} />;
}
