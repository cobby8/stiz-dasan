import StudentManagementClient from "./StudentManagementClient";
import { getCachedAdminStudentsPayload } from "@/lib/adminReadPayloads";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

export const revalidate = 30;

export default async function AdminStudentsPage() {
    const { students, classes, partial } = await getCachedAdminStudentsPayload(50);

    return (
        <StudentManagementClient
            students={students}
            classes={classes}
            partial={partial}
            // 시트 원장 은퇴(2026-10~) 면 시트 정합성 점검·재연결 「점검 도구」를 숨긴다("0" 이면 옛 화면)
            sheetRetired={isSheetSyncRetired(process.env)}
        />
    );
}
