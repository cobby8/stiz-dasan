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
                <h2 id="manual-sms-modal-title" className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-white">
                    <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">sms</span>
                    {title}
                </h2>
                <p className="mt-1 text-sm font-bold text-gray-500 dark:text-gray-400">
                    {recipientLabel} · {recipientPhone || "연락처 없음"}
                </p>

                <label className="mt-5 block text-sm font-bold text-gray-700 dark:text-gray-200">
                    문자 내용
                    <textarea
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        rows={6}
                        disabled={busy}
                        className="mt-1 w-full resize-none rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand-orange-500 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:focus:border-brand-neon-lime"
                        placeholder="보호자에게 보낼 내용을 입력해 주세요"
                    />
                </label>
                <p className="mt-2 text-right text-xs font-bold text-gray-400">
                    {message.trim().length}자
                </p>

                {formError && (
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:bg-red-950/40 dark:text-red-200">
                        {formError}
                    </p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-900"
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        disabled={busy || !canSend}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand-orange-500 px-5 text-sm font-black text-white transition hover:bg-brand-orange-600 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-400"
                    >
                        <span className={`material-symbols-outlined text-base ${busy ? "animate-spin" : ""}`}>
                            {busy ? "progress_activity" : "send"}
                        </span>
                        {busy ? "발송 중..." : "문자 발송"}
                    </button>
                </div>
            </form>
        </AdminModal>
    );
}
