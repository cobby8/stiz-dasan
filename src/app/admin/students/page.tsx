import { requireAdmin } from "@/lib/auth-guard";
import StudentManagementClient from "./StudentManagementClient";
import { getCachedAdminStudentsPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function AdminStudentsPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    // 처음부터 전체 명단을 준다(2026-11-14 속도 개선). 예전엔 50명만 주고 0.7초 뒤 브라우저가 전체 명단을
    // 다시 받아(서버 왕복 1번 추가) 첫 화면 뒤에 한 번 더 기다렸다. 지금 전체 명단 쿼리는 평균 0.01초 수준이고,
    // /api/admin/students 와 같은 캐시(«all»)를 함께 쓴다. partial 은 false 가 되어 화면의 추가 호출이 멈춘다.
    const { students, classes, partial } = await getCachedAdminStudentsPayload();

    // 구글 시트 원장 은퇴(2026-10~)로 「원생 자료 점검」 도구를 화면에서 뺐다 — 시트 은퇴 여부를 넘길 필요가 없다.
    return (
        <StudentManagementClient
            students={students}
            classes={classes}
            partial={partial}
        />
    );
}
