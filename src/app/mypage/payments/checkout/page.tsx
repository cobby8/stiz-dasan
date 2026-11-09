import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getBundleCheckoutCandidates, getPaymentProviderConfig } from "@/lib/payment-ledger";
import { academyBankAccount } from "@/lib/payments/academy-bank-account";
import { tossFailMessage } from "@/lib/payments/tossFailMessage";
import BundleCheckoutClient from "./BundleCheckoutClient";

export const dynamic = "force-dynamic";

// 학부모 «한 번에 결제»(묶음 결제, 2026-11-09 원장 결정 D2·D3·D4·D5).
// 왜 /mypage 아래인가: 설치 앱 범위(manifest scope=/mypage) 안이라 주소창이 뜨지 않고 아래 탭이 남는다.
// 후보 목록은 서버에서 바로 읽어 넘긴다(GET /api/mypage/payments/checkout 과 같은 함수) — 첫 화면에 빈 목록이 깜빡이지 않게.
// 결제 시작·검사는 POST /api/mypage/payments/checkout 이 서버에서 다시 한다(화면이 보낸 값은 믿지 않는다).
export default async function BundleCheckoutPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const parent = await requireVerifiedParent().catch(() => null);
    // bounced=1 로 목적지를 지운다(청구 탭과 같은 규칙 — 되돌려보내면 무한 반복)
    if (!parent) redirect("/mypage/continue?bounced=1");

    const params = await searchParams;
    const pick = (key: string) => {
        const value = params[key];
        return typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? "" : "";
    };
    // 토스 결제창에서 실패·취소하면 failUrl(?result=fail)에 code·message 를 붙여 돌아온다.
    // 주소의 message 는 그대로 비추지 않고(누구나 바꿔 보낼 수 있다) 코드별로 정해 둔 문장만 쓴다
    const failed = pick("result") === "fail";
    const failMessage = failed ? tossFailMessage(pick("code")) : "";

    const candidates = await getBundleCheckoutCandidates(parent.appUserId).catch((error) => {
        console.error("[mypage/payments/checkout] candidates failed:", error);
        return null;
    });
    const config = getPaymentProviderConfig();

    return (
        <BundleCheckoutClient
            items={candidates?.items ?? []}
            loadFailed={!candidates}
            maxItems={candidates?.maxItems ?? 10}
            maxTotal={candidates?.maxTotal ?? 1_000_000}
            // 묶음 결제는 토스에서만 된다(카페24 방식엔 «여러 건 한 주문»이 없다) — 참/거짓만 넘긴다(비밀키 X)
            onlineReady={config.providerReady && config.provider === "TOSS"}
            bankAccount={academyBankAccount()}
            failed={failed}
            failMessage={failMessage}
        />
    );
}
