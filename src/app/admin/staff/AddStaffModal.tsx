"use client";
import { adminErrorText, adminMessageText } from "@/components/admin/adminDisplayText";

import { useState, useTransition, type FormEvent } from "react";
import { createStaffUser } from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";

function formatPhone(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    const trimmed = digits.slice(0, 11);
    if (trimmed.length <= 3) return trimmed;
    if (trimmed.length <= 7) return `${trimmed.slice(0, 3)}-${trimmed.slice(3)}`;
    return `${trimmed.slice(0, 3)}-${trimmed.slice(3, 7)}-${trimmed.slice(7)}`;
}

export default function AddStaffModal({
    onClose,
    onSuccess,
    onError,
}: {
    onClose: () => void;
    onSuccess: () => void;
    onError: (msg: string) => void;
}) {
    const [form, setForm] = useState({
        name: "",
        phone: "",
        role: "INSTRUCTOR" as "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER",
    });
    const [verifyStep, setVerifyStep] = useState<"input" | "sent" | "verified">("input");
    const [verifyCode, setVerifyCode] = useState("");
    const [verificationProof, setVerificationProof] = useState("");
    const [verifyMsg, setVerifyMsg] = useState<{ text: string; ok: boolean } | null>(null);
    const [verifyLoading, setVerifyLoading] = useState(false);
    const [isPending, startTransition] = useTransition();

    function handlePhoneChange(raw: string) {
        const formatted = formatPhone(raw);
        setForm({ ...form, phone: formatted });
        if (verifyStep !== "input") {
            setVerifyStep("input");
            setVerifyCode("");
            setVerificationProof("");
            setVerifyMsg(null);
        }
    }

    async function handleSendCode() {
        const digits = form.phone.replace(/-/g, "");
        if (digits.length < 10) {
            setVerifyMsg({ text: "올바른 전화번호를 입력해주세요.", ok: false });
            return;
        }
        setVerifyLoading(true);
        setVerifyMsg(null);
        try {
            const res = await fetch("/api/admin/verify-phone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: digits }),
            });
            const data = await res.json();
            if (res.ok) {
                setVerifyStep("sent");
                setVerifyMsg({ text: "인증번호가 발송되었습니다. (5분 내 입력)", ok: true });
            } else {
                setVerifyMsg({ text: adminMessageText(data.error, "발송 실패"), ok: false });
            }
        } catch {
            setVerifyMsg({ text: "인증번호 발송 중 오류가 발생했습니다.", ok: false });
        } finally {
            setVerifyLoading(false);
        }
    }

    async function handleVerifyCode() {
        if (!verifyCode.trim()) return;
        const digits = form.phone.replace(/-/g, "");
        setVerifyLoading(true);
        setVerifyMsg(null);
        try {
            const res = await fetch("/api/admin/verify-phone", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: digits, code: verifyCode.trim() }),
            });
            const data = await res.json();
            if (res.ok && data.verified) {
                setVerificationProof(data.proof || "");
                setVerifyStep("verified");
                setVerifyMsg({ text: "전화번호가 인증되었습니다.", ok: true });
            } else {
                setVerifyMsg({ text: adminMessageText(data.error, "인증 실패"), ok: false });
            }
        } catch {
            setVerifyMsg({ text: "인증번호 확인 중 오류가 발생했습니다.", ok: false });
        } finally {
            setVerifyLoading(false);
        }
    }

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        if (verifyStep !== "verified") return;
        if (!form.name) return;
        startTransition(async () => {
            try {
                await createStaffUser({
                    name: form.name.trim(),
                    phone: form.phone.trim(),
                    role: form.role,
                    verificationProof,
                });
                onSuccess();
            } catch (error) {
                onError(adminErrorText(error, "스태프 추가 실패"));
            }
        });
    }

    const phoneComplete = form.phone.replace(/-/g, "").length >= 10;

    return (
        <AdminModal onClose={onClose} titleId="add-staff-title" panelClassName="max-w-md">
                <span id="add-staff-title" className="sr-only">직접 스태프 추가</span>
                <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-academy-line)]">
                    <h2 className="text-lg font-bold text-[var(--color-academy-ink)]">직접 스태프 추가</h2>
                    <button onClick={onClose} className="p-1 text-[var(--color-academy-faint)] hover:text-[var(--color-academy-muted)] rounded-lg hover:bg-[var(--color-academy-line)]">
                        <span className="material-symbols-outlined">close</span>
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">이름 *</label>
                        <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="홍길동" className="w-full px-4 py-2.5 border border-[var(--color-academy-line-input)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-academy-primary)] focus:border-[var(--color-academy-primary)]" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">전화번호 *</label>
                        <div className="flex gap-2">
                            <input type="tel" value={form.phone} onChange={(e) => handlePhoneChange(e.target.value)} placeholder="숫자만 입력 (자동 변환: 010-1234-5678)" required disabled={verifyStep === "verified"} className={`flex-1 px-4 py-2.5 border rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-academy-primary)] focus:border-[var(--color-academy-primary)] ${verifyStep === "verified" ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "border-[var(--color-academy-line-input)]"}`} />
                            {verifyStep === "verified" ? (
                                <span className="flex items-center gap-1 px-3 py-2.5 text-sm font-medium text-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] rounded-lg">
                                    <span className="material-symbols-outlined text-[18px]">check_circle</span>
                                    인증됨
                                </span>
                            ) : (
                                <button type="button" onClick={handleSendCode} disabled={!phoneComplete || verifyLoading} className="px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-academy-primary-hover)] rounded-lg hover:bg-[var(--color-academy-primary-hover)] transition-colors disabled:opacity-50 whitespace-nowrap">
                                    {verifyLoading && verifyStep === "input" ? "발송 중..." : verifyStep === "sent" ? "재발송" : "인증번호 발송"}
                                </button>
                            )}
                        </div>
                        {/* 안내문구 제거: 같은 입력칸 placeholder와 중복 */}
                    </div>
                    {verifyStep === "sent" && (
                        <div>
                            <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">인증번호</label>
                            <div className="flex gap-2">
                                <input type="text" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6자리 숫자" maxLength={6} className="flex-1 px-4 py-2.5 border border-[var(--color-academy-line-input)] rounded-lg text-sm text-center tracking-[0.3em] font-mono focus:ring-2 focus:ring-[var(--color-academy-primary)] focus:border-[var(--color-academy-primary)]" />
                                <button type="button" onClick={handleVerifyCode} disabled={verifyCode.length < 6 || verifyLoading} className="px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-academy-success)] rounded-lg hover:bg-[var(--color-academy-success)] transition-colors disabled:opacity-50 whitespace-nowrap">
                                    {verifyLoading ? "확인 중..." : "확인"}
                                </button>
                            </div>
                        </div>
                    )}
                    {verifyMsg && (
                        <div className={`px-3 py-2 rounded-lg text-xs font-medium ${verifyMsg.ok ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] border border-[var(--color-academy-success)]" : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] border border-[var(--color-academy-danger)]"}`}>
                            {verifyMsg.text}
                        </div>
                    )}
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">역할 *</label>
                        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })} className="w-full px-4 py-2.5 border border-[var(--color-academy-line-input)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-academy-primary)] focus:border-[var(--color-academy-primary)]">
                            <option value="INSTRUCTOR">코치/강사</option>
                            <option value="DRIVER">셔틀 기사</option>
                            <option value="VICE_ADMIN">부원장</option>
                            <option value="ADMIN">원장</option>
                        </select>
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-[var(--color-academy-muted)] bg-[var(--color-academy-soft)] rounded-lg hover:bg-[var(--color-academy-line)] transition-colors">취소</button>
                        <button type="submit" disabled={isPending || verifyStep !== "verified" || !form.name} className="px-4 py-2.5 text-sm font-medium text-white bg-[var(--color-academy-primary-hover)] rounded-lg hover:bg-[var(--color-academy-primary-hover)] transition-colors disabled:opacity-50">
                            {isPending ? "추가 중..." : "추가"}
                        </button>
                    </div>
                </form>
        </AdminModal>
    );
}
