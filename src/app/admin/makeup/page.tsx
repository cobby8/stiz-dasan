import { requireAdmin } from "@/lib/auth-guard";
import MakeupClient from "./MakeupClient";
import CreditPanel from "./CreditPanel";
import { getCachedAdminMakeupPayload } from "@/lib/adminReadPayloads";
import { getMakeupCreditOverview } from "@/lib/makeup/admin-credits";

// 30초 ISR — Server Action 호출 시 revalidatePath로 즉시 무효화
export const revalidate = 30;

export default async function AdminMakeupPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    // 보강권 현황과 예약 목록은 서로 독립이라 동시에 읽는다.
    const [{ sessions, classes }, credits] = await Promise.all([
        getCachedAdminMakeupPayload(),
        getMakeupCreditOverview(),
    ]);

    return (
        <>
            <CreditPanel data={JSON.parse(JSON.stringify(credits))} />
            <MakeupClient sessions={sessions} classes={classes} />
        </>
    );
}
