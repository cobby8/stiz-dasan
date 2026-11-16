"use client";

import { useFormStatus } from "react-dom";
import React from "react";
import { askConfirm } from "@/components/ui/feedback";

export default function ConfirmSubmitButton({
    children,
    confirmMessage,
    className,
    formAction
}: {
    children: React.ReactNode;
    confirmMessage: string;
    className?: string;
    formAction?: (payload: FormData) => void;
}) {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            formAction={formAction}
            disabled={pending}
            className={className}
            onClick={(e) => {
                // 화면 안 확인창은 기다려야 답이 나오므로 제출을 일단 막고, «확인»이면 같은 버튼으로 다시 제출한다
                // (requestSubmit(버튼) = 이 버튼의 formAction 그대로 · 클릭 이벤트가 다시 생기지 않아 두 번 묻지 않는다)
                e.preventDefault();
                const button = e.currentTarget;
                void askConfirm(confirmMessage).then((ok) => {
                    if (ok) button.form?.requestSubmit(button);
                });
            }}
        >
            {pending ? "처리 중..." : children}
        </button>
    );
}
