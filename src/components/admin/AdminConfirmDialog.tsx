"use client";

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import AdminModal from "@/components/admin/AdminModal";

/**
 * 관리자 공용 확인 창 — 브라우저 기본 confirm() 대신 쓴다.
 * 게슈탈트 «전경과 배경»: 뒤를 어둡게(딤) 깔고 확인 창만 떠 보이게,
 * «근접성»: 왼쪽 «그만»(글자 버튼) · 오른쪽 끝 위험색 확정 — 두 버튼을 떼어 둬 헷갈려 누르지 않게.
 */
export type AdminConfirmOptions = {
    /** 제목 — 대상 이름을 넣는다. 예: «"김민수" 원생 삭제» */
    title: string;
    /** 무슨 일이 일어나는지 한두 줄 */
    description?: ReactNode;
    /** 확정 버튼 글자. 기본 «확인» */
    confirmLabel?: string;
    /** 취소 버튼 글자. 기본 «그만» */
    cancelLabel?: string;
    /** danger(기본) = 꽉 찬 빨강 · primary = 꽉 찬 주황(되돌릴 수 있는 확정) */
    tone?: "danger" | "primary";
};

type AdminConfirmDialogProps = AdminConfirmOptions & {
    titleId: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** 처리 중이면 버튼을 막고 Esc·바깥 클릭으로 닫히지 않게 한다 */
    pending?: boolean;
    pendingLabel?: string;
    error?: string;
};

export default function AdminConfirmDialog({
    title,
    description,
    confirmLabel = "확인",
    cancelLabel = "그만",
    tone = "danger",
    titleId,
    onConfirm,
    onCancel,
    pending = false,
    pendingLabel = "처리 중...",
    error,
}: AdminConfirmDialogProps) {
    return (
        <AdminModal
            titleId={titleId}
            // 처리 중에는 Esc 로도 닫히지 않게 — 결과를 못 보고 창이 사라지면 두 번 누르게 된다
            onClose={() => { if (!pending) onCancel(); }}
            closeOnBackdrop={false}
            panelClassName="max-w-md p-5"
        >
            <h3 id={titleId} className="break-keep text-lg font-black text-[var(--color-academy-ink)]">{title}</h3>
            {description && (
                <div className="mt-2 whitespace-pre-line break-keep text-sm text-[var(--color-academy-muted)]">{description}</div>
            )}
            {error && (
                <p role="alert" className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>
            )}
            <div className="mt-5 flex items-center gap-3">
                <button type="button" onClick={onCancel} disabled={pending} className="academy-button-text">
                    {cancelLabel}
                </button>
                <button
                    type="button"
                    onClick={onConfirm}
                    disabled={pending}
                    className={`ml-auto ${tone === "danger" ? "academy-button-danger-solid" : "academy-button-primary"}`}
                >
                    {pending ? pendingLabel : confirmLabel}
                </button>
            </div>
        </AdminModal>
    );
}

/**
 * window.confirm 자리에 그대로 끼우는 훅.
 *   const { confirm, confirmDialog } = useAdminConfirm();
 *   if (await confirm({ title: ... })) void handleDelete(id);   // 기존 함수·인자 그대로
 *   ...JSX 맨 끝에 {confirmDialog}
 * 확정을 누르면 창이 닫히고 true, 그만·Esc 면 false.
 */
export function useAdminConfirm() {
    const [options, setOptions] = useState<AdminConfirmOptions | null>(null);
    const titleId = useId(); // 한 화면에 훅을 둘 써도 제목 id 가 겹치지 않게
    const resolverRef = useRef<((value: boolean) => void) | null>(null);

    const confirm = useCallback((next: AdminConfirmOptions) => {
        // 이미 떠 있는 질문이 있으면 «그만»으로 끝내고 새 질문을 띄운다
        resolverRef.current?.(false);
        setOptions(next);
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
        });
    }, []);

    const settle = useCallback((value: boolean) => {
        resolverRef.current?.(value);
        resolverRef.current = null;
        setOptions(null);
    }, []);

    const confirmDialog = options ? (
        <AdminConfirmDialog
            {...options}
            titleId={titleId}
            onConfirm={() => settle(true)}
            onCancel={() => settle(false)}
        />
    ) : null;

    return { confirm, confirmDialog };
}
