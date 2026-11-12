import { requireAdmin } from "@/lib/auth-guard";
import ScheduleAdminClient from "./ScheduleAdminClient";
import { getCachedAdminSchedulePayload } from "@/lib/adminReadPayloads";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

export const revalidate = 30;

export default async function AdminSchedulePage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const payload = await getCachedAdminSchedulePayload();

    // 시트 원장 은퇴(2026-10~) 면 「구글시트 연동·지금 동기화」 버튼을 숨긴다.
    // 환경변수 STIZ_SHEET_SYNC_RETIRED="0" 이면 옛 화면 그대로(되돌리기용).
    return <ScheduleAdminClient {...payload} sheetRetired={isSheetSyncRetired(process.env)} />;
}
