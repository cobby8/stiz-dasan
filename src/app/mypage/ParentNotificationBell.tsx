"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
// 알림 읽음은 학부모 전용 동작(로그인 사용자 본인 알림만) — 관리자용(requireAdmin)을 부르면 학부모는 실패한다
import { markMyNotificationRead, markAllMyNotificationsRead } from "@/app/actions/parent-notifications";
import { safeInternalHref } from "@/lib/mypage/parentNav";
import { formatKstDate } from "@/lib/datetime/kst";
import { unreadBadgeText } from "@/lib/mypage/parentSettings";

// 학부모 머리줄 🔔 알림 (2026-11-10 원장 결정 k7).
// 예전엔 홈 «처리할 일» 맨 끝 줄에서 펼쳐 봤다 → 어느 화면에서든 머리줄 종을 눌러 바로 본다.
// 휴대폰 = 아래 탭 바로 위로 올라오는 시트(머리줄과 아래 탭이 같은 층이라 탭을 덮지 못한다 — 탭은 그대로 눌린다),
// PC = 종 아래 드롭다운. 읽음·모두 읽음·눌러 이동은 예전 그대로.

export type BellNotification = {
    id: string;
    type: string;
    title: string;
    message: string;
    linkUrl: string | null;
    isRead: boolean;
    createdAt: Date | string;
};

const SETTINGS_NOTIFICATION_HREF = "/mypage/settings#settings-notifications";

export default function ParentNotificationBell({ notifications, unreadCount }: { notifications: BellNotification[]; unreadCount: number }) {
    const [open, setOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const boxRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const pathname = usePathname();
    const badge = unreadBadgeText(unreadCount);

    // 다른 화면으로 옮겨 가면 닫는다(머리줄은 그대로 남아 저절로 안 닫힌다)
    useEffect(() => { setOpen(false); }, [pathname]);

    // 옛 주소 «/mypage#mypage-notifications»(예전 ⋯ 메뉴·외부 안내)로 오면 종 패널을 연다
    useEffect(() => {
        const reveal = () => { if (window.location.hash === "#mypage-notifications") setOpen(true); };
        reveal();
        window.addEventListener("hashchange", reveal);
        return () => window.removeEventListener("hashchange", reveal);
    }, []);

    // 바깥을 누르거나 Esc 를 누르면 닫는다
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    // 알림 열기 — 안 읽었으면 읽음 처리 후, 내부 주소가 있으면 그 화면으로 간다
    function openNotification(id: string, isRead: boolean, href: string | null) {
        startTransition(async () => {
            if (!isRead) await markMyNotificationRead(id);
            if (href) {
                setOpen(false);
                router.push(href);
            }
        });
    }

    return (
        <div ref={boxRef} className="relative">
            <button
                type="button"
                aria-label={badge ? `알림, 안 읽은 알림 ${unreadCount}건` : "알림"}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                // 누르는 영역 44×44(터치 최소 크기)
                className="relative inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
            >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "24px" }} aria-hidden="true">notifications</span>
                {/* 안 읽은 수 배지 — 10건 이상은 9+ */}
                {badge && (
                    <span
                        aria-hidden="true"
                        className="absolute right-0.5 top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-academy-danger-fill)] px-1 text-xs font-bold leading-none tabular-nums text-[var(--color-academy-on-primary)]"
                    >
                        {badge}
                    </span>
                )}
            </button>

            {open && (
                <>
                    {/* 휴대폰: 뒤를 어둡게 — 누르면 닫힌다 */}
                    <div aria-hidden="true" onClick={() => setOpen(false)} className="fixed inset-0 z-[60] bg-[var(--color-academy-ink)]/40 md:hidden" />
                    <div
                        role="dialog"
                        aria-label="알림"
                        className="fixed inset-x-0 bottom-16 z-[70] flex max-h-[75vh] flex-col overflow-hidden rounded-t-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-lg md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-12 md:max-h-[70vh] md:w-96 md:rounded-xl"
                    >
                        {/* 머리: 제목 + 모두 읽음 + 닫기 (한 줄 44px) */}
                        <div className="flex min-h-11 items-center gap-1 border-b border-[var(--color-academy-line)] pl-4 pr-1">
                            <span className="flex-1 text-sm font-bold text-[var(--color-academy-ink)]">알림</span>
                            {unreadCount > 0 && (
                                <button
                                    type="button"
                                    onClick={() => startTransition(async () => { await markAllMyNotificationsRead(); })}
                                    disabled={isPending}
                                    className="academy-button-text text-[var(--color-academy-primary)]"
                                >
                                    <span className="material-symbols-outlined leading-none" style={{ fontSize: "16px" }} aria-hidden="true">done_all</span> 모두 읽음
                                </button>
                            )}
                            <button
                                type="button"
                                aria-label="알림 닫기"
                                onClick={() => setOpen(false)}
                                className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined leading-none" style={{ fontSize: "20px" }} aria-hidden="true">close</span>
                            </button>
                        </div>

                        {/* 목록 */}
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            {notifications.length === 0 ? (
                                <p className="px-4 py-3 text-center text-sm text-[var(--color-academy-faint)]">알림이 없습니다</p>
                            ) : (
                                <ul className="divide-y divide-[var(--color-academy-line)]">
                                    {notifications.map((n) => {
                                        // 알림 줄 전체가 버튼 — 누르면 읽음 + 내부 주소면 그 화면으로(바깥 주소·빈 값은 읽음만)
                                        const href = safeInternalHref(n.linkUrl);
                                        return (
                                            <li key={n.id}>
                                                <button
                                                    type="button"
                                                    onClick={() => openNotification(n.id, n.isRead, href)}
                                                    disabled={isPending}
                                                    className={`flex w-full min-h-11 items-start gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-academy-soft)] ${!n.isRead ? "bg-[var(--color-academy-info-soft)]" : ""}`}
                                                >
                                                    <span className="material-symbols-outlined mt-0.5 shrink-0 leading-none text-[var(--color-academy-neutral)]" style={{ fontSize: "18px" }} aria-hidden="true">
                                                        {n.type === "ATTENDANCE" ? "event_available" : n.type.startsWith("PAYMENT") ? "credit_card" : n.type.startsWith("SHUTTLE") ? "airport_shuttle" : "notifications"}
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className={`block text-sm ${!n.isRead ? "font-bold text-[var(--color-academy-ink)]" : "text-[var(--color-academy-muted)]"}`}>{n.title}</span>
                                                        <span className="mt-0.5 block text-xs text-[var(--color-academy-muted)]">{n.message}</span>
                                                        <span className="mt-0.5 block text-xs text-[var(--color-academy-faint)]">
                                                            {formatKstDate(n.createdAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                                        </span>
                                                    </span>
                                                    {/* 끝 표시 — 이동할 화면이 있으면 화살표, 없고 안 읽었으면 체크(누르면 읽음) */}
                                                    {href ? (
                                                        <span className="material-symbols-outlined mt-0.5 shrink-0 leading-none text-[var(--color-academy-muted)]" style={{ fontSize: "18px" }} aria-hidden="true">chevron_right</span>
                                                    ) : !n.isRead ? (
                                                        <span className="material-symbols-outlined mt-0.5 shrink-0 leading-none text-[var(--color-academy-muted)]" style={{ fontSize: "18px" }} aria-hidden="true">check</span>
                                                    ) : null}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>

                        {/* 아래: 알림 설정으로(휴대폰 알림 켜기·종류별 받기) — 목록과 구분선으로 뗀다 */}
                        <Link
                            href={SETTINGS_NOTIFICATION_HREF}
                            onClick={() => setOpen(false)}
                            className="flex min-h-11 items-center gap-2 border-t border-[var(--color-academy-line)] px-4 text-sm font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                        >
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: "18px" }} aria-hidden="true">tune</span>
                            <span className="flex-1">알림 설정</span>
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: "18px" }} aria-hidden="true">chevron_right</span>
                        </Link>
                    </div>
                </>
            )}
        </div>
    );
}
