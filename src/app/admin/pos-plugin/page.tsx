import { requireAdmin } from "@/lib/auth-guard";
import { listPosPluginTokens } from "@/lib/pos/pluginAuth";
import PosPluginTokensClient from "./PosPluginTokensClient";

export const dynamic = "force-dynamic";

/**
 * POS 연결 — 토스 POS 플러그인이 우리 사이트에 접속할 때 쓰는 «POS 연결 코드»(매장 토큰)를 만들고 끊는다.
 * 원장(ADMIN)만. 코드는 만들 때 한 번만 보여 주고 사이트에는 해시만 남는다.
 */
export default async function PosPluginPage() {
    const admin = await requireAdmin();
    if (admin.appUserRole !== "ADMIN") {
        return (
            <main className="p-4 md:p-6">
                <h1 className="text-xl font-extrabold text-[var(--color-academy-ink)]">POS 연결</h1>
                <p className="mt-2 text-sm text-[var(--color-academy-muted)]">원장만 볼 수 있는 화면입니다.</p>
            </main>
        );
    }
    const tokens = await listPosPluginTokens();
    return (
        <main className="space-y-4 p-4 md:p-6">
            <div>
                <h1 className="text-xl font-extrabold text-[var(--color-academy-ink)]">POS 연결</h1>
                <p className="mt-1 max-w-3xl text-sm text-[var(--color-academy-muted)]">
                    토스 POS 의 학원 플러그인이 «현장 결제» 요청과 미납 목록을 가져갈 때 쓰는 POS 연결 코드입니다.
                    이 코드로는 납부 처리를 할 수 없고, 납부완료는 토스 결제 확인으로만 바뀝니다.
                </p>
                {/* 유출 대응 안내(검수 2026-11-07) — 코드가 새면 납부는 못 해도 미납 목록(가린 이름)은 볼 수 있다 */}
                <p className="mt-1 text-sm font-semibold text-[var(--color-academy-danger)]">
                    POS 연결 코드가 새면(다른 사람이 봤거나 POS 를 잃어버렸으면) 바로 아래에서 «연결 끊기»를 눌러 주세요.
                </p>
            </div>
            <PosPluginTokensClient initialTokens={tokens} />
        </main>
    );
}
