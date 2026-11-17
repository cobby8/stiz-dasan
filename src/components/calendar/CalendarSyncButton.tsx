"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
    createCalendarFeedLink,
    getCalendarSyncOptions,
    revokeCalendarFeedLinks,
    type CalendarFeedLinkResult,
    type CalendarSyncOption,
} from "@/app/actions/calendar-sync";
import { askConfirm } from "@/components/ui/feedback";
import { copyText } from "@/lib/outsideLink";
import { usePublicOverlayOpen } from "@/components/public-floating";

/**
 * «내 캘린더에 연동» 버튼 — 달력이 나오는 화면에 둔다(2026-11-16 원장 승인).
 *
 * 누르면 화면 안 창(휴대폰은 아래에서 올라오는 시트)이 뜨고,
 *  1) 자기 역할에 맞는 항목을 고른 뒤(학원 일정은 기본 체크)
 *  2) 구글 캘린더 / 아이폰·맥 캘린더에 넣거나 주소를 복사한다.
 * 한 번 넣어 두면 캘린더 앱이 알아서 새 일정을 받아 온다.
 *
 * theme: "public" = 공개 사이트 범위(.stiz-public-sport, --color-public-* 토큰)
 *        "academy" = 학원 앱 범위(.academy-app, --color-academy-* 토큰·academy-button-* 클래스)
 * 색은 토큰만 쓴다. 아이콘 없이 글자로만 말한다.
 */

type Theme = "public" | "academy";

// 테마별 클래스 — 두 범위의 토큰·버튼 등급을 한 곳에 모은다(화면 코드에는 색을 적지 않는다)
const THEME: Record<Theme, {
    trigger: string;
    scrim: string;
    panel: string;
    title: string;
    muted: string;
    option: string;
    optionOn: string;
    checkbox: string;
    primary: string;
    secondary: string;
    text: string;
    danger: string;
    notice: string;
    field: string;
}> = {
    public: {
        trigger: "public-btn-secondary inline-flex min-h-11 items-center justify-center whitespace-nowrap text-sm font-medium",
        scrim: "bg-[var(--color-public-hero-scrim)]",
        panel: "border border-[var(--color-public-line)] bg-[var(--color-public-paper)] text-[var(--color-public-ink)]",
        title: "text-lg font-bold text-[var(--color-public-ink)]",
        muted: "text-[var(--color-public-muted)]",
        option: "border-[var(--color-public-line)]",
        optionOn: "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-tint)]",
        checkbox: "accent-[var(--color-public-accent)]",
        primary: "public-btn-primary inline-flex min-h-11 w-full items-center justify-center text-sm",
        secondary: "public-btn-secondary inline-flex min-h-11 w-full items-center justify-center text-sm font-medium",
        text: "public-btn-text inline-flex min-h-11 items-center justify-center text-sm",
        danger: "public-btn-text inline-flex min-h-11 items-center justify-center text-sm",
        notice: "border border-[var(--color-public-line)] bg-[var(--color-public-tint)] text-[var(--color-public-ink)]",
        field: "border border-[var(--color-public-line)] bg-[var(--color-public-paper)] text-[var(--color-public-ink)]",
    },
    academy: {
        trigger: "academy-button-secondary whitespace-nowrap",
        scrim: "bg-[color-mix(in_srgb,var(--color-academy-ink)_45%,transparent)]",
        panel: "border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]",
        title: "text-lg font-bold text-[var(--color-academy-ink)]",
        muted: "text-[var(--color-academy-muted)]",
        option: "border-[var(--color-academy-line)]",
        optionOn: "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)]",
        checkbox: "accent-[var(--color-academy-primary)]",
        primary: "academy-button-primary w-full",
        secondary: "academy-button-secondary w-full",
        text: "academy-button-text",
        danger: "academy-button-danger",
        notice: "border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]",
        field: "border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]",
    },
};

type LinkOk = Extract<CalendarFeedLinkResult, { ok: true }>;

export default function CalendarSyncButton({ theme, className = "" }: { theme: Theme; className?: string }) {
    const t = THEME[theme];
    const titleId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const [open, setOpen] = useState(false);
    // 창이 열려 있는 동안 공개 사이트의 떠 있는 버튼(상담·둘러보기)을 숨긴다 — 창의 아래쪽 버튼을 덮지 않게(검수 2026-11-16)
    usePublicOverlayOpen(open, () => setOpen(false)); // 휴대폰 «뒤로» = 창 닫기
    // 고를 수 있는 항목(서버가 역할로 정해 준다). null = 아직 불러오는 중
    const [options, setOptions] = useState<CalendarSyncOption[] | null>(null);
    const [linkCount, setLinkCount] = useState(0);
    const [picked, setPicked] = useState<Set<string>>(new Set(["academy"]));
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState<LinkOk | null>(null);
    const [message, setMessage] = useState("");
    // 복사 상태: "done" = 복사됨, "show" = 복사가 막혀 주소를 글자로 보여 줌
    const [copyState, setCopyState] = useState<"idle" | "done" | "show">("idle");

    function close() {
        setOpen(false);
        setLink(null);
        setMessage("");
        setCopyState("idle");
        triggerRef.current?.focus();
    }

    // 창을 열 때마다 항목을 새로 받는다(그새 로그인·역할이 바뀌었을 수 있다)
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setOptions(null);
        getCalendarSyncOptions()
            .then((result) => {
                if (!alive) return;
                setOptions(result.options);
                setLinkCount(result.linkCount);
                // 학원 일정은 기본 체크. 고를 수 없게 된 항목은 체크에서 뺀다
                setPicked((prev) => {
                    const allowed = new Set(result.options.map((o) => o.kind as string));
                    const next = new Set([...prev].filter((kind) => allowed.has(kind)));
                    if (next.size === 0 && allowed.has("academy")) next.add("academy");
                    return next;
                });
            })
            .catch(() => {
                if (!alive) return;
                // 확인이 실패해도 학원 일정은 연동할 수 있게 둔다
                setOptions([{ kind: "academy", label: "학원 일정", hint: "개강·종강·휴무·행사", personal: false }]);
                setLinkCount(0);
            });
        return () => { alive = false; };
    }, [open]);

    // Esc 로 닫기 · 뒤 화면 스크롤 잠금 · 창에 포커스
    useEffect(() => {
        if (!open) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        panelRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") close();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = previousOverflow;
        };
        // close 는 상태만 바꾸는 함수라 다시 걸 필요가 없다
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    function toggle(kind: string) {
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
        });
        // 항목을 바꾸면 앞서 만든 주소는 맞지 않으므로 다시 만들게 한다
        setLink(null);
        setMessage("");
        setCopyState("idle");
    }

    async function makeLink() {
        if (busy) return;
        setBusy(true);
        setMessage("");
        setCopyState("idle");
        try {
            const result = await createCalendarFeedLink([...picked]);
            if (result.ok) {
                setLink(result);
                if (result.personal) setLinkCount((n) => n + 1);
            } else {
                setLink(null);
                setMessage(result.message);
            }
        } catch {
            setMessage("연동 주소를 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function copyLink() {
        if (!link) return;
        // 복사가 막힌 환경(일부 앱 안 화면)에서는 주소를 글자로 보여 준다
        setCopyState((await copyText(link.httpsUrl)) ? "done" : "show");
    }

    async function revoke() {
        if (busy) return;
        // 화면 안 확인창(브라우저 기본 확인창은 쓰지 않는다)
        const ok = await askConfirm(
            "캘린더 연동을 끊을까요?\n이미 넣어 둔 내 일정은 더 이상 새로 받아 오지 않아요. 학원 일정만 넣은 캘린더는 그대로예요.",
            { tone: "danger" },
        );
        if (!ok) return;
        setBusy(true);
        try {
            const result = await revokeCalendarFeedLinks();
            if (result.ok) {
                setLinkCount(0);
                setLink((current) => (current?.personal ? null : current));
                setMessage("연동을 끊었어요. 캘린더 앱에 남은 예전 일정은 캘린더 앱에서 지워 주세요.");
            } else {
                setMessage(result.message || "연동을 끊지 못했어요. 잠시 후 다시 시도해 주세요.");
            }
        } catch {
            setMessage("연동을 끊지 못했어요. 잠시 후 다시 시도해 주세요.");
        } finally {
            setBusy(false);
        }
    }

    const personalPicked = (options ?? []).some((o) => o.personal && picked.has(o.kind));

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
                className={`${t.trigger} ${className}`.trim()}
            >
                내 캘린더에 연동
            </button>

            {open && (
                // 휴대폰: 아래에서 올라오는 시트 · 넓은 화면: 가운데 창. 바깥(어두운 부분)을 누르면 닫힌다
                <div
                    // z-[60]: 학부모·공개 화면의 아래 탭·떠 있는 버튼(z-50)보다 위, 확인창(z-[100])보다 아래
                    className={`fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4 ${t.scrim}`}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
                >
                    <div
                        ref={panelRef}
                        tabIndex={-1}
                        className={`flex max-h-[85dvh] w-full flex-col gap-3 overflow-y-auto overscroll-contain rounded-t-2xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-left outline-none sm:max-w-md sm:rounded-2xl sm:pb-4 ${t.panel}`}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <h2 id={titleId} className={t.title}>내 캘린더에 연동</h2>
                            <button type="button" onClick={close} className={t.text}>닫기</button>
                        </div>
                        <p className={`break-keep text-sm ${t.muted}`}>
                            한 번 넣어 두면 휴대폰 캘린더가 새 일정을 알아서 받아 와요.
                        </p>

                        {/* 1) 항목 고르기 — 내 역할로 가능한 것만 */}
                        {options === null ? (
                            <p className={`py-3 text-sm ${t.muted}`} role="status">불러오는 중이에요</p>
                        ) : (
                            <fieldset className="grid gap-2">
                                <legend className="mb-2 text-sm font-semibold">넣을 일정</legend>
                                {options.map((option) => {
                                    const checked = picked.has(option.kind);
                                    return (
                                        <label
                                            key={option.kind}
                                            className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${checked ? t.optionOn : t.option}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggle(option.kind)}
                                                className={`size-5 shrink-0 ${t.checkbox}`}
                                            />
                                            <span className="min-w-0">
                                                <span className="block text-sm font-medium">{option.label}</span>
                                                <span className={`block text-xs ${t.muted}`}>{option.hint}</span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </fieldset>
                        )}

                        {personalPicked && (
                            <p className={`break-keep rounded-lg px-3 py-2 text-xs ${t.notice}`}>
                                이 주소를 아는 사람은 일정을 볼 수 있어요. 남에게 보내지 마세요.
                            </p>
                        )}

                        {/* 2) 주소를 만든 뒤에야 캘린더 버튼이 나온다(항목을 바꾸면 다시 만든다) */}
                        {!link ? (
                            <button
                                type="button"
                                onClick={() => void makeLink()}
                                disabled={busy || options === null || picked.size === 0}
                                className={t.primary}
                            >
                                {busy ? "준비하는 중이에요" : "고른 일정 연동하기"}
                            </button>
                        ) : (
                            <div className="grid gap-2">
                                <p className="text-sm font-semibold">어느 캘린더에 넣을까요?</p>
                                {/* 구글 캘린더는 바깥 주소 — 스토어 앱에서는 공용 규칙(data-outside-link)이 «복사 + 안내»로 바꾼다 */}
                                <a href={link.googleUrl} target="_blank" rel="noopener noreferrer" data-outside-link className={t.primary}>
                                    구글 캘린더에 추가
                                </a>
                                <a href={link.webcalUrl} className={t.secondary}>
                                    아이폰·맥 캘린더에 추가
                                </a>
                                <button type="button" onClick={() => void copyLink()} className={t.secondary}>
                                    {copyState === "done" ? "주소를 복사했어요" : "주소 복사"}
                                </button>
                                {copyState === "show" && (
                                    <input
                                        readOnly
                                        value={link.httpsUrl}
                                        aria-label="연동 주소"
                                        onFocus={(event) => event.currentTarget.select()}
                                        className={`min-h-11 w-full rounded-lg px-3 text-sm ${t.field}`}
                                    />
                                )}
                                <p className={`break-keep text-xs ${t.muted}`}>
                                    안 열리면 «주소 복사» 뒤 캘린더 앱의 «주소로 추가»에 붙여 넣어 주세요.
                                </p>
                            </div>
                        )}

                        {message && <p role="status" className={`break-keep rounded-lg px-3 py-2 text-sm ${t.notice}`}>{message}</p>}

                        {/* 이미 만든 내 일정 연동이 있을 때만 */}
                        {linkCount > 0 && (
                            <div className="flex items-center justify-between gap-2">
                                <span className={`text-xs ${t.muted}`}>내 일정을 연동해 둔 캘린더가 있어요</span>
                                <button type="button" onClick={() => void revoke()} disabled={busy} className={t.danger}>
                                    연동 끊기
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
