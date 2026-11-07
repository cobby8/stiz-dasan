"use client";

import { useState } from "react";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { issuePosPluginTokenAction, loadPosPluginTokens, revokePosPluginTokenAction } from "@/app/actions/pos-charge";
import type { PosPluginTokenRow } from "@/lib/pos/pluginAuth";

/**
 * POS 연결 코드 목록 · 새로 만들기(= 교체) · 끊기.
 * 새로 만들면 «방금 쓰던 코드 1개»는 그대로 두고 그보다 오래된 것은 끊는다 → POS 설정을 바꾸는 동안 끊기지 않는다.
 * 새 코드는 이 화면에서 **한 번만** 보인다(사이트에는 원문이 남지 않는다).
 */
export default function PosPluginTokensClient({ initialTokens }: { initialTokens: PosPluginTokenRow[] }) {
    const { confirm, confirmDialog } = useAdminConfirm();
    const [tokens, setTokens] = useState(initialTokens);
    const [label, setLabel] = useState("다산 카운터 POS");
    const [newToken, setNewToken] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    async function reload() {
        const result = await loadPosPluginTokens();
        if (result.ok) setTokens(result.tokens);
        else setMessage(result.message);
    }

    async function handleIssue() {
        const activeCount = tokens.filter((t) => t.active).length;
        const ok = await confirm({
            title: "새 POS 연결 코드 만들기",
            description:
                activeCount > 0
                    ? "새 코드를 만들면 지금 쓰는 코드 1개만 남기고 더 오래된 코드는 끊깁니다. POS 설정에 새 코드를 넣은 뒤 옛 코드를 끊어 주세요."
                    : "만든 코드는 이 화면에서 한 번만 보입니다. 바로 POS 플러그인 설정에 붙여 넣어 주세요.",
            confirmLabel: "코드 만들기",
            tone: "primary",
        });
        if (!ok) return;
        setBusy(true);
        setMessage("");
        const result = await issuePosPluginTokenAction(label);
        setBusy(false);
        if (!result.ok) {
            setMessage(result.message);
            return;
        }
        setNewToken(result.token);
        setCopied(false);
        await reload();
    }

    async function handleRevoke(token: PosPluginTokenRow) {
        const ok = await confirm({
            title: `«${token.label}» 연결 끊기`,
            description: "이 코드를 쓰는 POS 는 바로 요청을 못 가져갑니다. 되돌릴 수 없어 새 코드를 만들어야 합니다.",
            confirmLabel: "연결 끊기",
            tone: "danger",
        });
        if (!ok) return;
        setBusy(true);
        const result = await revokePosPluginTokenAction(token.id);
        setBusy(false);
        if (!result.ok) setMessage(result.message);
        await reload();
    }

    async function handleCopy() {
        if (!newToken) return;
        try {
            await navigator.clipboard.writeText(newToken);
            setCopied(true);
        } catch {
            setMessage("복사하지 못했습니다. 코드를 길게 눌러 직접 복사해 주세요.");
        }
    }

    return (
        <div className="space-y-4">
            {newToken && (
                // 주인공: 방금 만든 코드(한 번만 보임)
                <section className="rounded-lg border border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)] p-4">
                    <p className="text-sm font-bold text-[var(--color-academy-ink)]">새 연결 코드 — 이 화면을 닫으면 다시 볼 수 없습니다</p>
                    <p className="mt-2 break-all rounded-md bg-[var(--color-academy-surface)] p-3 font-mono text-sm text-[var(--color-academy-ink)]">{newToken}</p>
                    <div className="mt-3 flex items-center gap-2">
                        <button type="button" onClick={() => void handleCopy()} className="academy-button-primary">
                            {copied ? "복사됨" : "코드 복사"}
                        </button>
                        <button type="button" onClick={() => setNewToken(null)} className="academy-button-text ml-auto">
                            POS 에 넣었어요 · 닫기
                        </button>
                    </div>
                </section>
            )}

            <section className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4">
                <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1 text-sm font-bold text-[var(--color-academy-ink)]">
                        이름(어느 POS 인지)
                        <input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            maxLength={60}
                            className="mt-1 block min-h-11 w-full rounded-md border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-normal text-[var(--color-academy-ink)]"
                        />
                    </label>
                    <button type="button" onClick={() => void handleIssue()} disabled={busy || !label.trim()} className="academy-button-primary">
                        {busy ? "처리 중…" : "새 연결 코드 만들기"}
                    </button>
                </div>
                {message && (
                    <p role="alert" className="mt-2 text-sm font-semibold text-[var(--color-academy-danger)]">
                        {message}
                    </p>
                )}
            </section>

            <section className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                <h2 className="border-b border-[var(--color-academy-line)] px-4 py-2 text-sm font-extrabold text-[var(--color-academy-ink)]">
                    연결 코드 {tokens.filter((t) => t.active).length}개 사용 중
                </h2>
                {tokens.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-[var(--color-academy-muted)]">아직 만든 코드가 없습니다.</p>
                ) : (
                    <ul>
                        {tokens.map((t) => (
                            // 한 줄 행: 이름 · 앞글자 · 만든/마지막 사용 시각 · 끊기
                            <li key={t.id} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-academy-line)] px-4 py-2 last:border-b-0">
                                <span className="text-sm font-bold text-[var(--color-academy-ink)]">{t.label}</span>
                                <span className="font-mono text-xs text-[var(--color-academy-muted)]">{t.tokenPrefix}…</span>
                                <span className="text-xs text-[var(--color-academy-muted)]">
                                    만든 시각 {t.createdKst} · 마지막 사용 {t.lastUsedKst ?? "없음"}
                                    {t.revokedKst ? ` · 끊음 ${t.revokedKst}` : ""}
                                </span>
                                {t.active ? (
                                    <button type="button" onClick={() => void handleRevoke(t)} disabled={busy} className="academy-button-danger ml-auto">
                                        연결 끊기
                                    </button>
                                ) : (
                                    <span className="ml-auto text-xs font-bold text-[var(--color-academy-muted)]">끊김</span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {confirmDialog}
        </div>
    );
}
