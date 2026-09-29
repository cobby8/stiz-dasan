import { runPosReconcileNow } from "@/app/actions/pos-reconcile";
import { requireAdmin } from "@/lib/auth-guard";
import {
    getPosReconcileReport,
    listPosReconcileRuns,
    type PosReconcileRunRow,
} from "@/lib/pos/reconcileService";
import ReconcileNowButton from "./ReconcileNowButton";

export const dynamic = "force-dynamic";

/**
 * POS 결제 대사 화면.
 *
 * 원장이 보는 것은 딱 하나다 — "토스 단말기에서 받은 돈"과 "사이트에 적힌 돈"이 맞는가.
 * 매일 새벽 크론이 자동으로 맞춰 보고, 그 결과를 여기서 읽는다.
 * 이 화면은 **읽기 전용**이다. 여기서 결제나 청구서가 바뀌는 일은 없다.
 */

const STATUS_LABEL: Record<string, string> = {
    OK: "정상 완료",
    FAILED: "실패",
};

const SOURCE_LABEL: Record<string, string> = {
    CRON: "자동(매일 새벽)",
    MANUAL: "직접 실행",
};

/** BIGINT 는 문자열로 받아 온다. 숫자로 바꾸지 않고 천 단위만 끊어 표시한다. */
function formatWonText(value: string | null | undefined): string {
    const raw = String(value ?? "0").trim();
    if (!/^-?\d+$/.test(raw)) return "₩0";
    const negative = raw.startsWith("-");
    const digits = (negative ? raw.slice(1) : raw).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "-" : ""}₩${digits}`;
}

export default async function PosReconcilePage() {
    await requireAdmin();

    const runs = await listPosReconcileRuns(12);
    const latest: PosReconcileRunRow | undefined = runs[0];
    const report = latest ? await getPosReconcileReport(latest.id) : null;

    return (
        <main className="space-y-5 p-4 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-black text-gray-900 dark:text-white">POS 결제 대사</h1>
                    <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
                        토스 단말기(POS)에서 승인된 카드결제와 사이트에 기록된 결제를 매일 새벽 자동으로 맞춰 봅니다.
                        맞지 않는 건만 추려서 아래에 보여 줍니다. 이 화면은 보기만 하며, 결제·청구서를 바꾸지 않습니다.
                    </p>
                </div>
                {/* 서버 액션 안에서 관리자 권한을 한 번 더 확인한다(화면을 가리는 것만으로는 막히지 않는다). */}
                <form action={runPosReconcileNow}>
                    <ReconcileNowButton />
                </form>
            </div>

            {!latest && (
                <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    아직 대조한 기록이 없습니다. 오른쪽 위 “지금 대조하기”를 누르면 이번 달을 바로 맞춰 봅니다.
                </div>
            )}

            {latest && (
                <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 md:p-5 dark:border-gray-700 dark:bg-gray-900">
                    <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-lg font-black text-gray-900 dark:text-white">
                            {latest.targetMonth} 대조 결과
                        </h2>
                        <span
                            className={
                                latest.status === "OK"
                                    ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100"
                                    : "rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800 dark:bg-red-900 dark:text-red-100"
                            }
                        >
                            {STATUS_LABEL[latest.status] ?? latest.status}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                            실행 시각 {latest.startedAtKst ?? "-"} (한국시간) · {SOURCE_LABEL[latest.source] ?? latest.source}
                        </span>
                    </div>

                    {latest.error && (
                        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
                            {latest.error}
                        </p>
                    )}

                    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                        <table className="w-full min-w-[640px] text-left text-sm">
                            <thead className="bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                                <tr>
                                    <th className="p-3">구분</th>
                                    <th className="p-3 text-right">건수</th>
                                    <th className="p-3 text-right">금액</th>
                                    <th className="p-3">설명</th>
                                </tr>
                            </thead>
                            <tbody className="text-gray-800 dark:text-gray-100">
                                <tr className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3 font-bold">토스 단말기(POS)</td>
                                    <td className="p-3 text-right tabular-nums">{latest.posCount}건</td>
                                    <td className="p-3 text-right font-bold tabular-nums">{formatWonText(latest.posAmount)}</td>
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">단말기에서 승인된 카드결제</td>
                                </tr>
                                <tr className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3 font-bold">사이트 기록</td>
                                    <td className="p-3 text-right tabular-nums">{latest.siteCount}건</td>
                                    <td className="p-3 text-right font-bold tabular-nums">{formatWonText(latest.siteAmount)}</td>
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">사이트에 결제완료로 적힌 카드결제</td>
                                </tr>
                                <tr className="border-t border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800">
                                    <td className="p-3 font-black">차이 (POS − 사이트)</td>
                                    <td className="p-3" />
                                    <td className="p-3 text-right font-black tabular-nums">{formatWonText(latest.diffAmount)}</td>
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">0원이면 두 쪽이 완전히 맞은 것입니다</td>
                                </tr>
                                <tr className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3">자동으로 맞춰진 결제</td>
                                    <td className="p-3 text-right tabular-nums">{latest.matchedCount}건</td>
                                    <td className="p-3" />
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">POS 기준. 주문번호·메모 이름·날짜+금액이 맞은 건</td>
                                </tr>
                                <tr className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3">확인 필요</td>
                                    <td className="p-3 text-right tabular-nums">{latest.heldCount}건</td>
                                    <td className="p-3" />
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">비슷하지만 확실하지 않아 사람이 봐야 하는 건</td>
                                </tr>
                                <tr className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3">토스POS에만 있음</td>
                                    <td className="p-3 text-right tabular-nums">{latest.posOnlyCount}건</td>
                                    <td className="p-3" />
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">단말기로 받았는데 사이트에 기록이 없는 결제</td>
                                </tr>
                                <tr className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3">사이트에만 있음</td>
                                    <td className="p-3 text-right tabular-nums">{latest.siteOnlyCount}건</td>
                                    <td className="p-3" />
                                    <td className="p-3 text-xs text-gray-500 dark:text-gray-400">사이트에 적혔는데 단말기 승인 내역이 없는 결제</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    {report ? (
                        <details open className="rounded-lg border border-gray-200 dark:border-gray-700">
                            <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-gray-800 dark:text-gray-100">
                                대조표 전문 (어떤 결제가 왜 안 맞는지)
                            </summary>
                            {/* 리포트는 이미 사람이 읽는 표 형태로 만들어져 있다. 화면에서 다시 계산하지 않는다. */}
                            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border-t border-gray-200 bg-gray-50 p-4 text-xs leading-relaxed text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200">
                                {report}
                            </pre>
                        </details>
                    ) : (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            대조표가 없습니다. 실행이 실패했거나 아직 저장되지 않았습니다.
                        </p>
                    )}
                </section>
            )}

            {runs.length > 0 && (
                <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
                    <h2 className="px-4 pt-4 text-sm font-black text-gray-900 dark:text-white">최근 실행 기록</h2>
                    <table className="mt-2 w-full min-w-[760px] text-left text-sm">
                        <thead className="bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            <tr>
                                <th className="p-3">대상 월</th>
                                <th className="p-3">실행 시각(한국시간)</th>
                                <th className="p-3">방식</th>
                                <th className="p-3">상태</th>
                                <th className="p-3 text-right">POS</th>
                                <th className="p-3 text-right">사이트</th>
                                <th className="p-3 text-right">차이</th>
                                <th className="p-3 text-right">확인 필요</th>
                            </tr>
                        </thead>
                        <tbody className="text-gray-800 dark:text-gray-100">
                            {runs.map((run) => (
                                <tr key={run.id} className="border-t border-gray-100 dark:border-gray-800">
                                    <td className="p-3 font-bold">{run.targetMonth}</td>
                                    <td className="p-3">{run.startedAtKst ?? "-"}</td>
                                    <td className="p-3 text-xs">{SOURCE_LABEL[run.source] ?? run.source}</td>
                                    <td className="p-3 text-xs font-bold">{STATUS_LABEL[run.status] ?? run.status}</td>
                                    <td className="p-3 text-right tabular-nums">
                                        {run.posCount}건 · {formatWonText(run.posAmount)}
                                    </td>
                                    <td className="p-3 text-right tabular-nums">
                                        {run.siteCount}건 · {formatWonText(run.siteAmount)}
                                    </td>
                                    <td className="p-3 text-right font-bold tabular-nums">{formatWonText(run.diffAmount)}</td>
                                    <td className="p-3 text-right tabular-nums">{run.heldCount}건</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </main>
    );
}
