import StaffClient from "./StaffClient";
import { requireAdmin } from "@/lib/auth-guard";
import { getCachedAdminStaffPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function StaffPage() {
    // 보는 사람이 원장인지 — 역할 변경·초대·직접 추가·복구는 원장 전용(서버 작업도 requireOwner 로 막는다).
    // 부원장에게는 바꿀 수 없는 선택칸 대신 «보기 전용»으로 보여 준다(누르면 오류만 나던 것을 없앤다).
    const admin = await requireAdmin();
    const { staffUsers, coaches, invitations } = await getCachedAdminStaffPayload();

    // «중단된 초대 복구» 링크는 머리줄 ⋯ 더보기 안으로 옮겼다(예전엔 표 위 별도 줄 → 제목 위 큰 빈 공간).
    return (
        <StaffClient
            staffUsers={staffUsers}
            coaches={coaches}
            invitations={invitations}
            canManage={admin.appUserRole === "ADMIN"}
        />
    );
}
