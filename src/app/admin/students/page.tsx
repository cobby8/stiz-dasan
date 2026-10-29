import StudentManagementClient from "./StudentManagementClient";
import { getCachedAdminStudentsPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function AdminStudentsPage() {
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
