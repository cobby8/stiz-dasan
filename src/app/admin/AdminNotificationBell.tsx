"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

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

function typeIcon(type: string) {
    switch (type) {
        case "TRIAL_APPLICATION":
            return "person_add" as const;
        case "ENROLL_APPLICATION":
            return "how_to_reg" as const;
        case "REQUEST":
            return "mail" as const;
        case "ATTENDANCE":
            return "check_circle" as const;
        case "PAYMENT":
            return "payments" as const;
        case "NOTICE":
            return "campaign" as const;
        default:
            return "notifications";
    }
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
                className="relative rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:bg-gray-800 dark:text-gray-200"
                title="알림"
            >
                <FontFreeIcon name="notifications" size={22} />
                {unreadCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 top-full z-50 mt-2 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:w-96">
                    <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">알림</h3>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={handleMarkAllRead}
                                disabled={loading}
                                className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                            >
                                모두 읽음
                            </button>
                        )}
                    </div>

                    <div className="max-h-[400px] overflow-y-auto">
                        {items.length === 0 ? (
                            <div className="py-12 text-center text-sm text-gray-400">
                                <FontFreeIcon name="notifications_off" size={40} className="mx-auto mb-2" />
                                알림이 없습니다
                            </div>
                        ) : (
                            items.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => void handleClick(item)}
                                    className={`flex w-full gap-3 border-b border-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-50 dark:bg-gray-900 ${
                                        !item.isRead ? "bg-blue-50/50" : ""
                                    }`}
                                >
                                    <div
                                        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                                            !item.isRead
                                                ? "bg-blue-100 text-blue-600"
                                                : "bg-gray-100 text-gray-400 dark:bg-gray-800"
                                        }`}
                                    >
                                        <FontFreeIcon name={typeIcon(item.type)} size={18} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p
                                            className={`truncate text-sm ${
                                                !item.isRead
                                                    ? "font-semibold text-gray-900 dark:text-white"
                                                    : "text-gray-600 dark:text-gray-300"
                                            }`}
                                        >
                                            {item.title}
                                        </p>
                                        <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                                            {item.message}
                                        </p>
                                        <p className="mt-1 text-xs text-gray-400">{timeAgo(item.createdAt)}</p>
                                    </div>
                                    {!item.isRead && <div className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-blue-500" />}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
