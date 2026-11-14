"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import UiIcon from "@/components/common/UiIcon";

const NOTIFICATION_CACHE_MS = 60_000;

interface NotificationItem {
    id: string;
    type: string;
    title: string;
    message: string;
    linkUrl: string | null;
    isRead: boolean;
    createdAt: string;
}

function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);

    if (mins < 1) return "방금";
    if (mins < 60) return `${mins}분 전`;

    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}시간 전`;

    return `${Math.floor(hours / 24)}일 전`;
}

export default function AdminNotificationBell() {
    const [open, setOpen] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const [items, setItems] = useState<NotificationItem[]>([]);
    const [loading, setLoading] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const lastLoadedAtRef = useRef(0);
    const router = useRouter();

    const fetchNotifications = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/notifications");
            if (!res.ok) return;

            const data = await res.json();
            setUnreadCount(data.unreadCount ?? 0);
            setItems(data.notifications ?? []);
            lastLoadedAtRef.current = Date.now();
        } catch {
            // 알림 실패는 관리자 본문 사용을 막지 않습니다.
        }
    }, []);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }

        if (open) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [open]);

    function handleToggle() {
        if (!open && Date.now() - lastLoadedAtRef.current > NOTIFICATION_CACHE_MS) void fetchNotifications();
        setOpen((current) => !current);
    }

    async function handleClick(item: NotificationItem) {
        if (!item.isRead) {
            fetch("/api/admin/notifications", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: item.id }),
            }).catch(() => {});

            setItems((prev) =>
                prev.map((notification) =>
                    notification.id === item.id ? { ...notification, isRead: true } : notification,
                ),
            );
            setUnreadCount((prev) => Math.max(0, prev - 1));
        }

        if (item.linkUrl) {
            router.push(item.linkUrl);
        }

        setOpen(false);
    }

    async function handleMarkAllRead() {
        setLoading(true);

        try {
            await fetch("/api/admin/notifications", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ markAllRead: true }),
            });
            setItems((prev) => prev.map((notification) => ({ ...notification, isRead: true })));
            setUnreadCount(0);
        } catch {
            // 읽음 처리 실패 시 다음 조회에서 서버 상태로 다시 맞춰집니다.
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                type="button"
                onClick={handleToggle}
                aria-expanded={open}
                // 종 아이콘 + 안 읽은 건수(2026-11-15 아이콘 예외: 알림 = 종). 글자가 없으니 이름은 aria-label, 누르는 영역 44×44
                className="academy-button-text academy-button-sm min-h-11! min-w-11! shrink-0 justify-center whitespace-nowrap"
                aria-label={unreadCount > 0 ? `알림, 안 읽은 알림 ${unreadCount}건` : "알림"}
                title="알림"
            >
                <UiIcon name="notifications" size={24} />
                {unreadCount > 0 && (
                    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-academy-danger)] px-1 text-xs font-semibold tabular-nums text-white">
                        {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 top-full z-50 mt-2 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white shadow-xl sm:w-96">
                    <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-4 py-3">
                        <h3 className="academy-section-title">알림</h3>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={handleMarkAllRead}
                                disabled={loading}
                                className="academy-button-text academy-button-sm"
                            >
                                모두 읽음
                            </button>
                        )}
                    </div>

                    <div className="max-h-[400px] overflow-y-auto">
                        {items.length === 0 ? (
                            <div className="py-12 text-center text-sm text-[var(--color-academy-faint)]">
                                알림이 없습니다
                            </div>
                        ) : (
                            items.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => void handleClick(item)}
                                    className={`flex w-full gap-3 border-b border-[var(--color-academy-line)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-academy-soft)] ${
                                        !item.isRead ? "bg-[var(--color-academy-soft)]/50" : ""
                                    }`}
                                >
                                    <div className="min-w-0 flex-1">
                                        <p
                                            className={`truncate text-sm ${
                                                !item.isRead
                                                    ? "font-semibold text-[var(--color-academy-ink)]"
                                                    : "text-[var(--color-academy-muted)]"
                                            }`}
                                        >
                                            {item.title}
                                        </p>
                                        <p className="mt-0.5 truncate text-xs text-[var(--color-academy-muted)]">
                                            {item.message}
                                        </p>
                                        <p className="mt-1 text-xs text-[var(--color-academy-faint)]">{timeAgo(item.createdAt)}</p>
                                    </div>
                                    {!item.isRead && <div className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-[var(--color-academy-secondary-strong)]" />}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
