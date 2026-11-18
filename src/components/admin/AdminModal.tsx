"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useBackToClose } from "@/components/common/useBackToClose";

const FOCUSABLE_SELECTOR = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 창 안 부품이 «창을 닫은 뒤 이어서 할 일»을 맡길 때 쓴다(기록 칸을 먼저 되돌리고 실행). 창 밖이면 바로 실행 */
const AdminModalCloseThenContext = createContext<(next: () => void) => void>((next) => next());
export function useAdminModalCloseThen() {
    return useContext(AdminModalCloseThenContext);
}

interface AdminModalProps {
    children: ReactNode;
    onClose: () => void;
    titleId: string;
    panelClassName?: string;
    closeOnBackdrop?: boolean;
    /** "center"(기본) = 가운데 모달 · "side" = 데스크톱 오른쪽 패널 / 모바일 아래 시트 (목록 상세용) */
    layout?: "center" | "side";
    /**
     * 휴대폰·브라우저 «뒤로» = 이 창만 닫기(2026-11-18 원장 결정 ① — 규칙: overlayHistory). 기본 켜짐.
     * 기록 칸을 스스로 관리하는 창(청구 시트 sheetHistory, 닫으며 결과를 돌려주는 확인 창)만 false 로 끈다 — 두 번 넣지 않게.
     */
    backToClose?: boolean;
    /** 저장·처리 중 — 그동안은 «뒤로»를 눌러도 창이 닫히지 않는다(2026-11-18 원장 결정 ②) */
    busy?: boolean;
}

/** 관리자 모달의 키보드 포커스와 모바일 스크롤을 일관되게 관리합니다. */
export default function AdminModal({
    children,
    onClose,
    titleId,
    panelClassName = "max-w-lg",
    closeOnBackdrop = true,
    layout = "center",
    backToClose = true,
    busy = false,
}: AdminModalProps) {
    // 이 창은 열려 있는 동안에만 그려진다 — 그려진 동안 = 열림
    const { captureLinks, closeThen } = useBackToClose(backToClose, onClose, { blocked: busy });
    const router = useRouter();
    const panelRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        const panel = panelRef.current;
        const initialFocus = panel?.querySelector<HTMLElement>("[data-admin-modal-initial-focus]")
            ?? panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
            ?? panel;
        initialFocus?.focus();

        function handleKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== "Tab" || !panel) return;

            const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
                .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
            if (focusable.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }

        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = previousOverflow;
            // 창을 연 버튼이 그새 사라졌으면(⚡ 메뉴가 닫히며 지워진 항목 등) 없는 요소에 포커스를 주지 않는다 — 브라우저 기본 위치에 맡긴다
            const previous = previousFocusRef.current;
            if (previous?.isConnected) previous.focus();
        };
    }, []);

    return (
        <div
            className={layout === "side"
                // 패널형: 모바일은 아래에서 올라오는 시트, md 이상은 화면 오른쪽에 붙는 패널
                ? "fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-stretch md:justify-end"
                : "fixed inset-0 z-50 flex items-end justify-center overflow-y-auto overscroll-contain bg-black/50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4"}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(event) => {
                if (closeOnBackdrop && event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={panelRef}
                tabIndex={-1}
                className={layout === "side"
                    // 시트 높이는 화면의 85%까지, 패널은 화면 전체 높이 · 폭 420px
                    ? `flex max-h-[85dvh] w-full flex-col overflow-y-auto overscroll-contain rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl outline-none md:h-dvh md:max-h-none md:w-[420px] md:rounded-none md:rounded-l-2xl md:pb-0 ${panelClassName}`
                    : `flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-y-auto overscroll-contain rounded-2xl bg-white shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)] ${panelClassName}`}
                onMouseDown={(event) => event.stopPropagation()}
                // 창 안 같은 사이트 링크는 넣어 둔 기록 칸을 먼저 되돌린 뒤 이동한다(안 하면 뒤로가 한 번 헛돈다).
                // backToClose 를 끈 창에서는 captureLinks 가 아무 일도 하지 않는다
                onClickCapture={captureLinks((to) => router.push(to))}
            >
                <AdminModalCloseThenContext.Provider value={closeThen}>{children}</AdminModalCloseThenContext.Provider>
            </div>
        </div>
    );
}
