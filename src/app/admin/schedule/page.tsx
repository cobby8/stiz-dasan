import ScheduleAdminClient from "./ScheduleAdminClient";
import { getCachedAdminSchedulePayload } from "@/lib/adminReadPayloads";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

export const revalidate = 30;

export default async function AdminSchedulePage() {
    const payload = await getCachedAdminSchedulePayload();

    // 시트 원장 은퇴(2026-10~) 면 「구글시트 연동·지금 동기화」 버튼을 숨긴다.
    // 환경변수 STIZ_SHEET_SYNC_RETIRED="0" 이면 옛 화면 그대로(되돌리기용).
    return <ScheduleAdminClient {...payload} sheetRetired={isSheetSyncRetired(process.env)} />;
}
