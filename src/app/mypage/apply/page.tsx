import Link from "next/link";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { PARENT_APPLY_ITEMS } from "@/lib/mypage/parentApplyMenu";

export const dynamic = "force-dynamic";
export const metadata = { title: "신청 | 스티즈 농구교실" };

// «신청» 메뉴 (2026-11-14 원장 결정표 c9) — 유니폼 신청·체육관 대관·방학특강 신청으로 가는 길을 한 칸에 모았다.
// 예전엔 이 세 가지가 공개 홈페이지에만 있어, 설치된 학부모 앱에서는 갈 길이 없었다.
// 한 줄 행 3개. 앱 안 화면은 /mypage 아래 주소로, 본사 쇼핑몰(유니폼)만 바깥 링크로 연다.

const ROW = "flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-academy-soft)]";

export default async function ParentApplyMenuPage() {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    return (
        <div className="mx-auto grid max-w-2xl gap-3">
            <div className="flex items-center gap-2">
                <Link href="/mypage" aria-label="홈으로" className="academy-back-link">
                    <span aria-hidden="true">←</span>
                </Link>
                <h1 className="academy-heading">신청</h1>
            </div>
            <ul className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
                {PARENT_APPLY_ITEMS.map((item) => {
                    const inner = (
                        <>
                            <span className="min-w-0 flex-1 font-medium text-[var(--color-academy-ink)]">{item.label}</span>
                            {item.hint && <span className="shrink-0 text-[var(--color-academy-muted)]">{item.hint}</span>}
                            <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                        </>
                    );
                    return (
                        <li key={item.key}>
                            {item.outside ? (
                                // 바깥 주소 — 새 창으로 연다. 스토어 앱이 못 여는 버전이면 공용 규칙(data-outside-link)이 주소를 복사해 안내한다
                                <a href={item.href} target="_blank" rel="noopener noreferrer" data-outside-link className={ROW}>{inner}</a>
                            ) : (
                                <Link href={item.href} className={ROW}>{inner}</Link>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
