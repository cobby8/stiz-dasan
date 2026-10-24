/**
 * 수강생 데이터 이관 페이지 — 서버 컴포넌트
 *
 * 구글 스프레드시트의 수강생 CSV 데이터를 DB로 이관한다.
 * 서버에서는 특별한 데이터 로딩이 필요 없고,
 * 모든 로직은 클라이언트(ImportClient)에서 API를 호출한다.
 */

import ImportClient from "./ImportClient";
import { getCachedAdminSettingsPayload } from "@/lib/adminReadPayloads";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

// ISR 30초 — 관리자 페이지 공통 설정
export const revalidate = 30;

export default async function ImportPage() {
  const { settings } = await getCachedAdminSettingsPayload();
  // 시트 원장 은퇴(2026-10~) 면 화면 맨 위에 "과거 자료 조회용" 안내만 붙인다.
  // 기능은 그대로 둔다(되돌리기·과거 자료 확인용). STIZ_SHEET_SYNC_RETIRED="0" 이면 안내도 없다.
  const sheetRetired = isSheetSyncRetired(process.env);
  return (
    <>
      {sheetRetired && (
        <div
          role="note"
          data-testid="sheet-retired-import-notice"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <p className="font-bold">시트 원장 종료(2026-10) — 과거 자료 조회용</p>
          <p className="mt-1">
            2026년 10월부터 구글 시트 원장을 쓰지 않습니다. 신규 등록·휴원·퇴원은 사이트에서 처리하고,
            이 화면은 9월까지의 과거 시트 자료를 확인할 때만 사용해 주세요.
          </p>
        </div>
      )}
      <ImportClient defaultSheetUrl={settings?.googleSheetsScheduleUrl ?? ""} />
    </>
  );
}
