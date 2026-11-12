import { requireAdmin } from "@/lib/auth-guard";
import StudentManagementClient from "./StudentManagementClient";
import { getCachedAdminStudentsPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function AdminStudentsPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const { students, classes, partial } = await getCachedAdminStudentsPayload(50);

    // 구글 시트 원장 은퇴(2026-10~)로 「원생 자료 점검」 도구를 화면에서 뺐다 — 시트 은퇴 여부를 넘길 필요가 없다.
    return (
        <StudentManagementClient
            students={students}
            classes={classes}
            partial={partial}
        />
    );
}
