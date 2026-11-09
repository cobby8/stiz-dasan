import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import BundleDoneClient from "./BundleDoneClient";

export const dynamic = "force-dynamic";

// 학부모 «한 번에 결제» 결과 화면 — 토스가 successUrl 로 paymentKey·orderId·amount 를 붙여 보낸다.
// 설치 앱 범위(/mypage) 안이라 결제 후에도 아래 탭·헤더가 그대로 남는다.
// 승인·조회는 화면이 /api/mypage/payments/confirm 을 부른다(주문 소유권은 서버가 확인).
export default async function BundleDonePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    const params = await searchParams;
    const pick = (key: string) => {
        const value = params[key];
        return typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? "" : "";
    };
    return <BundleDoneClient paymentKey={pick("paymentKey")} orderId={pick("orderId")} amount={Number(pick("amount")) || 0} />;
}
