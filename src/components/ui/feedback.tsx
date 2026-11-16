"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import AdminModal from "@/components/admin/AdminModal";

/**
 * 화면 안 알림·확인창 — 브라우저 기본 alert()/confirm()/prompt() 대신 쓴다. (2026-11-16)
 *
 * 왜: 휴대폰 앱(웹뷰)에서는 기본 경고창이 어설프게 뜨거나 아예 막힌다.
 * 그래서 «함수 하나로 부르면 화면 안에 창이 뜨는» 공용 부품을 둔다.
 * 훅이 아니라 보통 함수라서 어느 클라이언트 코드(이벤트 처리기·라이브러리 함수)에서도 바로 부를 수 있다.
 * 창을 그리는 <FeedbackHost /> 는 최상위 레이아웃(src/app/layout.tsx)에 한 번만 걸려 있다.
 *
 *   showNotice("저장 실패");                         // alert 자리 — 닫기를 누를 때까지 남는 알림 카드
 *   if (!(await askConfirm("삭제할까요?"))) return;  // confirm 자리 — 확인 true / 그만·Esc false
 *   await showCopyText("링크를 복사해 주세요.", url); // prompt(문구, 링크) 자리 — 복사용 창
 */

type ConfirmItem = { kind: "confirm"; id: number; message: string; tone: "danger" | "primary"; resolve: (ok: boolean) => void };
type CopyItem = { kind: "copy"; id: number; message: string; text: string; resolve: () => void };
type DialogItem = ConfirmItem | CopyItem;
type NoticeItem = { id: number; message: string; resolve: () => void };

type FeedbackState = { dialogs: DialogItem[]; notices: NoticeItem[] };

// 알림 카드는 최대 3장까지만 쌓는다(오래된 것부터 닫힘) — 화면을 덮지 않게
const MAX_NOTICES = 3;
// 위험한 일을 묻는 문구면 확정 버튼을 빨강으로 — 나머지는 주 색(네이비)
// 2026-11-16 검수: 명단에서 빼기·거절·반려·정리·«되돌리기 어렵» 문구도 위험으로 본다
const DANGER_WORDS = /(삭제|지울|지우고|지우시|환불|해제|버리|초기화|취소|뺄|빼고|빼기|거절|반려|정리|되돌리기 어렵|되돌릴 수 없)/;

let state: FeedbackState = { dialogs: [], notices: [] };
let seq = 0;
let hostCount = 0; // 화면에 창을 그릴 FeedbackHost 가 붙어 있는지
const listeners = new Set<() => void>();
const EMPTY: FeedbackState = { dialogs: [], notices: [] };

function setState(next: FeedbackState) {
    state = next;
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function toText(message: unknown): string {
    if (typeof message === "string") return message;
    if (message == null) return "";
    return String(message);
}

/** alert 자리 — 문구를 화면 아래 알림 카드로 띄운다. 닫기를 누르면 Promise 가 끝난다(다음 일을 그 뒤에 하려면 await). */
export function showNotice(message: unknown): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    return new Promise<void>((resolve) => {
        const item: NoticeItem = { id: ++seq, message: toText(message), resolve };
        const notices = [...state.notices, item];
        // 넘친 오래된 카드는 닫힌 것으로 끝낸다
        while (notices.length > MAX_NOTICES) notices.shift()?.resolve();
        setState({ ...state, notices });
        // 그릴 곳이 없으면(레이아웃 밖 특수 상황) 기다리게 두지 않는다
        if (hostCount === 0) {
            console.warn("[feedback] FeedbackHost 없음:", item.message);
            resolve();
        }
    });
}

/** confirm 자리 — 화면 안 확인창. 확인 = true, 그만·Esc = false. 확인 전에는 아무것도 하지 않게 꼭 await 한다. */
export function askConfirm(message: unknown, options?: { tone?: "danger" | "primary" }): Promise<boolean> {
    if (typeof window === "undefined") return Promise.resolve(false);
    // 그릴 곳이 없으면 «안 함»이 안전하다
    if (hostCount === 0) return Promise.resolve(false);
    const text = toText(message);
    return new Promise<boolean>((resolve) => {
        const tone = options?.tone ?? (DANGER_WORDS.test(text) ? "danger" : "primary");
        const item: ConfirmItem = { kind: "confirm", id: ++seq, message: text, tone, resolve };
        // 이미 떠 있는 창이 있으면 차례를 기다린다(앞 질문을 닫은 뒤 뜬다)
        setState({ ...state, dialogs: [...state.dialogs, item] });
    });
}

/** prompt(문구, 링크) 자리 — 링크를 보여 주고 «복사» 버튼을 준다. 닫으면 Promise 가 끝난다. */
export function showCopyText(message: unknown, text: string): Promise<void> {
    if (typeof window === "undefined" || hostCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const item: CopyItem = { kind: "copy", id: ++seq, message: toText(message), text, resolve };
        setState({ ...state, dialogs: [...state.dialogs, item] });
    });
}

function closeDialog(id: number) {
    setState({ ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== id) });
}

function closeNotice(id: number) {
    const target = state.notices.find((notice) => notice.id === id);
    setState({ ...state, notices: state.notices.filter((notice) => notice.id !== id) });
    target?.resolve();
}

/** 확인창 — AdminModal(포커스 가두기·Esc)을 그대로 쓴다. 왼쪽 «그만» · 오른쪽 끝 확정 버튼 */
function ConfirmDialog({ item }: { item: ConfirmItem }) {
    const titleId = useId();
    const settle = (ok: boolean) => {
        closeDialog(item.id);
        item.resolve(ok);
    };
    return (
        <AdminModal titleId={titleId} onClose={() => settle(false)} closeOnBackdrop={false} panelClassName="max-w-md p-5">
            <p id={titleId} className="whitespace-pre-line break-keep text-base text-[var(--color-academy-ink)]">{item.message}</p>
            <div className="mt-5 flex items-center gap-3">
                <button type="button" onClick={() => settle(false)} className="academy-button-text min-h-11 rounded-lg px-4">그만</button>
                <button
                    type="button"
                    data-admin-modal-initial-focus
                    onClick={() => settle(true)}
                    className={`ml-auto min-h-11 rounded-lg px-5 ${item.tone === "danger" ? "academy-button-danger-solid" : "academy-button-primary"}`}
                >
                    확인
                </button>
            </div>
        </AdminModal>
    );
}

/** 복사용 창 — 옛 prompt(문구, 링크) 대신. 칸을 누르면 전체 선택, «복사»는 클립보드에 넣는다 */
function CopyDialog({ item }: { item: CopyItem }) {
    const titleId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [copied, setCopied] = useState(false);
    const close = () => {
        closeDialog(item.id);
        item.resolve();
    };
    async function copy() {
        try {
            await navigator.clipboard.writeText(item.text);
            setCopied(true);
        } catch {
            // 클립보드를 못 쓰는 웹뷰 — 칸을 선택해 길게 눌러 복사하게 둔다
            inputRef.current?.select();
        }
    }
    return (
        <AdminModal titleId={titleId} onClose={close} panelClassName="max-w-md p-5">
            <p id={titleId} className="whitespace-pre-line break-keep text-base text-[var(--color-academy-ink)]">{item.message}</p>
            <input
                ref={inputRef}
                readOnly
                value={item.text}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-3 min-h-11 w-full rounded-lg border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]"
            />
            <div className="mt-5 flex items-center gap-3">
                <button type="button" onClick={close} className="academy-button-text min-h-11 rounded-lg px-4">닫기</button>
                <button type="button" data-admin-modal-initial-focus onClick={() => void copy()} className="academy-button-primary ml-auto min-h-11 rounded-lg px-5">
                    {copied ? "복사됨" : "복사"}
                </button>
            </div>
        </AdminModal>
    );
}

/**
 * 화면(주소)이 바뀌면 떠 있던 창·알림을 모두 닫는다(2026-11-16 검수 권장).
 * 휴대폰 뒤로가기로 화면을 떠났는데 «삭제할까요?» 창이 남아 «확인»을 누르면 떠난 화면의 일이 실행될 수 있었다.
 * 브라우저 기본 확인창이 뒤로가기에 «취소»로 닫히던 것과 같게 — 확인창은 false, 나머지는 그냥 끝낸다.
 */
function dismissAll() {
    if (!state.dialogs.length && !state.notices.length) return;
    const { dialogs, notices } = state;
    setState({ dialogs: [], notices: [] });
    for (const dialog of dialogs) {
        if (dialog.kind === "confirm") dialog.resolve(false);
        else dialog.resolve();
    }
    for (const notice of notices) notice.resolve();
}

/** 창을 그리는 곳 — 최상위 레이아웃에 한 번만 건다. 학원 앱 색(academy-app)을 입혀 어느 화면에서도 같은 모양 */
export default function FeedbackHost() {
    const current = useSyncExternalStore(subscribe, () => state, () => EMPTY);
    const pathname = usePathname();
    const lastPath = useRef(pathname);

    // 주소가 바뀐 «뒤»에만 닫는다(처음 그릴 때는 닫지 않는다)
    useEffect(() => {
        if (lastPath.current === pathname) return;
        lastPath.current = pathname;
        dismissAll();
    }, [pathname]);

    useEffect(() => {
        hostCount += 1;
        return () => {
            hostCount -= 1;
        };
    }, []);

    // 한 번에 창 하나 — 줄 서 있는 다음 질문은 앞 창이 닫히면 뜬다
    const dialog = current.dialogs[0];

    // Esc 는 «맨 위 확인창만» 닫는다 — 뒤에 깔린 다른 모달의 Esc 처리까지 같이 돌면
    // (예: 모달 닫기 → 다시 확인창) 질문이 또 뜨므로, 가장 먼저(capture) 받아 여기서 끝낸다.
    useEffect(() => {
        if (!dialog) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            closeDialog(dialog.id);
            if (dialog.kind === "confirm") dialog.resolve(false);
            else dialog.resolve();
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [dialog]);

    return (
        // z-[100] — 다른 모달(z-50) 위에 뜨게
        <div className="academy-app relative z-[100]">
            {dialog?.kind === "confirm" && <ConfirmDialog key={dialog.id} item={dialog} />}
            {dialog?.kind === "copy" && <CopyDialog key={dialog.id} item={dialog} />}
            {current.notices.length > 0 && (
                <div
                    className="pointer-events-none fixed inset-x-0 bottom-0 z-[110] flex flex-col items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
                    aria-live="polite"
                >
                    {current.notices.map((notice) => (
                        <div
                            key={notice.id}
                            role="status"
                            className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] py-2 pl-4 pr-2 shadow-lg"
                        >
                            <p className="flex-1 whitespace-pre-line break-keep py-2 text-sm text-[var(--color-academy-ink)]">{notice.message}</p>
                            <button type="button" onClick={() => closeNotice(notice.id)} className="academy-button-text min-h-11 shrink-0 rounded-lg px-3">
                                닫기
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
