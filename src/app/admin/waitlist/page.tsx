import { requireAdmin } from "@/lib/auth-guard";
import WaitlistClient from "./WaitlistClient";
import { getCachedAdminWaitlistPayload } from "@/lib/adminReadPayloads";

// 30초 ISR — Server Action 호출 시 revalidatePath로 즉시 무효화
export const revalidate = 30;

export default async function AdminWaitlistPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const { waitlist, capacityInfo, classes } = await getCachedAdminWaitlistPayload();

    return (
        <WaitlistClient
            waitlist={waitlist}
            capacityInfo={capacityInfo}
            classes={classes}
        />
    );
}
