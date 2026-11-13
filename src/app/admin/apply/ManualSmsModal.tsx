"use client";

import { useState, type FormEvent } from "react";
import AdminModal from "@/components/admin/AdminModal";

type ManualSmsModalProps = {
    title: string;
    recipientLabel: string;
    recipientPhone: string;
    defaultMessage: string;
    busy: boolean;
    onClose: () => void;
    onSubmit: (message: string) => Promise<void> | void;
};

export default function ManualSmsModal({
    title,
    recipientLabel,
    recipientPhone,
    defaultMessage,
    busy,
    onClose,
    onSubmit,
}: ManualSmsModalProps) {
    const [message, setMessage] = useState(defaultMessage);
    const [formError, setFormError] = useState("");
    const canSend = Boolean(recipientPhone.replace(/\D/g, ""));

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!canSend) {
            setFormError("문자를 보낼 연락처가 없습니다.");
            return;
        }
        if (!message.trim()) {
            setFormError("문자 내용을 입력해 주세요.");
            return;
        }
        setFormError("");
        void onSubmit(message.trim());
    }

    return (
        <AdminModal onClose={busy ? () => undefined : onClose} titleId="manual-sms-modal-title" panelClassName="max-w-md" closeOnBackdrop={!busy}>
            <form onSubmit={handleSubmit} className="w-full p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                <h2 id="manual-sms-modal-title" className="text-lg font-bold text-[var(--color-academy-ink)]">
                    {title}
                </h2>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                    {recipientLabel} · {recipientPhone || "연락처 없음"}
                </p>

                <label className="mt-5 block text-sm font-medium text-[var(--color-academy-muted)]">
                    문자 내용
                    <textarea
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        rows={6}
                        disabled={busy}
                        className="academy-input mt-1 resize-none"
                        placeholder="보호자에게 보낼 내용을 입력해 주세요"
                    />
                </label>
                <p className="mt-2 text-right text-xs tabular-nums text-[var(--color-academy-faint)]">
                    {message.trim().length}자
                </p>

                {formError && (
                    <p className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">
                        {formError}
                    </p>
                )}

                {/* 버튼 등급은 그대로(닫기 = 글자, 문자 발송 = 주 버튼) — 테마 클래스로만 옮겼다(2026-11-13 UI 통일) */}
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="academy-button-text"
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        disabled={busy || !canSend}
                        className="academy-button-primary"
                    >
                        {busy ? "발송 중..." : "문자 발송"}
                    </button>
                </div>
            </form>
        </AdminModal>
    );
}
