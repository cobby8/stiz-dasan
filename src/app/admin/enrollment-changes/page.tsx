import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { maskEnrollmentChangeRowForRole } from "@/lib/payments/financeRoleMask";
import { countEnrollmentChangesNeedingCheck, countOpenPauseSettlements, getEnrollmentCancelRequests, getEnrollmentChangeRequests } from "@/lib/enrollment/admin-change-request";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import { isRallyzSyncRetired } from "@/lib/operations-sync/rallyzRetirement";
import EnrollmentChangesClient from "./EnrollmentChangesClient";

export const dynamic = "force-dynamic";

export default async function EnrollmentChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  const admin = await requireAdmin();
  const params = await searchParams;
  // NEEDS_CHECK = 사이트에는 자동 반영됐지만 확인이 남은 건(랠리즈 은퇴 2026-11-14 뒤에는 옛 시트 대기·보류 건만)
  const status = params?.status === "ALL" || params?.status === "APPROVED" || params?.status === "REJECTED"
    || params?.status === "NEEDS_CHECK"
    ? params.status
    : "PENDING";
  const [rows, needsCheckCount, cancelRequests, openSettlementCount] = await Promise.all([
    getEnrollmentChangeRequests(status),
    countEnrollmentChangesNeedingCheck(),
    // 학부모 «취소 요청»(d8). 마이그레이션 전(칸 없음)이면 빈 목록 — 화면은 그대로 열린다.
    getEnrollmentCancelRequests().catch((error) => {
      console.error("[admin/enrollment-changes] 취소 요청 조회 실패", error instanceof Error ? error.name : "");
      return [];
    }),
    // 휴원 수강료 처리 남은 일(마이그레이션 20261110180000 전이면 0)
    countOpenPauseSettlements(),
  ]);
  // 시트 원장 은퇴 여부는 서버 환경변수로만 정해진다 → 화면에 그대로 넘겨 문구·버튼을 맞춘다.
  // 랠리즈 은퇴(2026-11-14 원장 결정)도 같다 — 기본 은퇴, STIZ_RALLYZ_SYNC_RETIRED 가 "0" 일 때만 옛 화면.
  const rallyzRetired = isRallyzSyncRetired(process.env);
  // 부원장: 차액·휴원 수강료 처리 금액을 빼고, «수강료 처리 남은 일» 건수도 숨긴다(2026-11-14 원장 결정)
  const owner = canSeeAllMoney(admin.appUserRole);
  const visibleRows = rows.map((row) => maskEnrollmentChangeRowForRole(row, admin.appUserRole));
  return <EnrollmentChangesClient rows={visibleRows} status={status} needsCheckCount={needsCheckCount} sheetRetired={isSheetSyncRetired(process.env)} rallyzRetired={rallyzRetired} cancelRequests={cancelRequests} openSettlementCount={owner ? openSettlementCount : 0} />;
}
