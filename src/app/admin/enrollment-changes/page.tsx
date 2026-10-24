import { countEnrollmentChangesNeedingCheck, getEnrollmentChangeRequests } from "@/lib/enrollment/admin-change-request";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import EnrollmentChangesClient from "./EnrollmentChangesClient";

export const dynamic = "force-dynamic";

export default async function EnrollmentChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  // NEEDS_CHECK = 사이트에는 자동 반영됐지만 시트·랠리즈 확인이 남은 건
  const status = params?.status === "ALL" || params?.status === "APPROVED" || params?.status === "REJECTED"
    || params?.status === "NEEDS_CHECK"
    ? params.status
    : "PENDING";
  const [rows, needsCheckCount] = await Promise.all([
    getEnrollmentChangeRequests(status),
    countEnrollmentChangesNeedingCheck(),
  ]);
  // 시트 원장 은퇴 여부는 서버 환경변수로만 정해진다 → 화면에 그대로 넘겨 문구·버튼을 맞춘다.
  return <EnrollmentChangesClient rows={rows} status={status} needsCheckCount={needsCheckCount} sheetRetired={isSheetSyncRetired(process.env)} />;
}
