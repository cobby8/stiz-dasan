"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useState, useTransition, type FormEvent } from "react";
import { inviteStaff } from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";

function formatPhone(raw: string): string {
    const digits = raw.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

// 초대 결과는 두 가지다(다중 역할, 2026-10-25).
//   링크 발송 — 새 직원 계정을 만들 사람에게 개인 가입 링크를 보냈다.
//   기존 계정에 부여 — 이 번호의 학부모 계정이 이미 있어 그 계정에 역할을 붙였다(링크 없음).
type InvitationResult =
    | { grantedExisting: false; accountName: null; inviteUrl: string; smsSent: boolean; smsError?: string }
    | { grantedExisting: true; accountName: string; inviteUrl: null; smsSent: false; smsError?: string };

function absoluteInviteUrl(inviteUrl: string): string {
    if (typeof window === "undefined") return inviteUrl;
    return new URL(inviteUrl, window.location.origin).toString();
}

export default function InviteStaffModal({
    onClose,
    onSuccess,
    onError,
}: {
    onClose: () => void;
    onSuccess: () => void;
    onError: (message: string) => void;
}) {
    const [form, setForm] = useState<{ name: string; phone: string; role: "INSTRUCTOR" | "DRIVER" }>({
        name: "",
        phone: "",
        role: "INSTRUCTOR",
    });
    const [result, setResult] = useState<InvitationResult | null>(null);
    const [copyMessage, setCopyMessage] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();
    const phoneComplete = form.phone.replace(/-/g, "").length >= 10;

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!form.name.trim() || !phoneComplete) return;

        startTransition(async () => {
            try {
                const invitation = await inviteStaff({
                    name: form.name.trim(),
                    phone: form.phone.trim(),
                    role: form.role,
                });
                setResult(invitation);
                onSuccess();
            } catch (error) {
                onError(adminErrorText(error, "스태프 초대를 만들지 못했습니다."));
            }
        });
    }

    async function copyInviteUrl() {
        if (!result || result.grantedExisting) return;
        try {
            await navigator.clipboard.writeText(absoluteInviteUrl(result.inviteUrl));
            setCopyMessage("개인 가입 링크를 복사했습니다.");
        } catch {
            window.prompt("아래 개인 가입 링크를 길게 눌러 복사해 주세요.", absoluteInviteUrl(result.inviteUrl));
            setCopyMessage("복사창에 개인 가입 링크를 표시했습니다.");
        }
    }

    async function shareInviteUrl() {
        if (!result || result.grantedExisting || !navigator.share) return;
        try {
            await navigator.share({
                title: "STIZ 스태프 가입 초대",
                text: `${form.name.trim()}님, 아래 링크에서 가입을 완료해 주세요.`,
                url: absoluteInviteUrl(result.inviteUrl),
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            setCopyMessage("공유하지 못했습니다. 링크 복사를 이용해 주세요.");
        }
    }

    return (
        <AdminModal onClose={onClose} titleId="invite-staff-modal-title" panelClassName="max-w-md" closeOnBackdrop={!result}>
                <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
                    <h2 id="invite-staff-modal-title" className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                        <span className="material-symbols-outlined text-[20px]">person_add</span>
                        새 스태프 초대·가입
                    </h2>
                    <button type="button" onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700" aria-label="닫기">
                        <span className="material-symbols-outlined">close</span>
                    </button>
                </div>

                {result?.grantedExisting ? (
                    // 기존 학부모 계정에 역할을 붙인 경우 — 보낼 링크가 없다. 링크 복사 버튼을 두면 빈 값을 복사한다.
                    <div className="space-y-4 p-6">
                        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-green-800">
                            <p className="font-bold">기존 계정에 {form.role === "DRIVER" ? "기사님" : "선생님"} 역할을 추가했습니다.</p>
                            <p className="mt-1 text-sm">
                                이 번호로 이미 가입된 학부모 계정({result.accountName})이 있어 새 계정을 만들지 않았습니다.
                                그 계정으로 로그인하면 화면 전환에서 바로 쓸 수 있습니다. 「직원 역할 신청」 화면에서 회수할 수 있습니다.
                            </p>
                        </div>
                        <div className="flex justify-end">
                            <button type="button" onClick={onClose} className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-100">완료</button>
                        </div>
                    </div>
                ) : result ? (
                    <div className="space-y-4 p-6">
                        <div className={`rounded-xl border p-4 ${result.smsSent ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                            <p className="font-bold">초대 링크가 만들어졌습니다.</p>
                            <p className="mt-1 text-sm">
                                {result.smsSent
                                    ? "가입 안내 문자를 발송했습니다. 아래 링크를 카카오톡으로도 전달할 수 있습니다."
                                    : "문자는 발송되지 않았습니다. 초대는 정상적으로 만들어졌으니 아래 링크를 복사해 전달해 주세요."}
                            </p>
                            {!result.smsSent && result.smsError && <p className="mt-2 text-xs opacity-80">발송 사유: {result.smsError}</p>}
                        </div>

                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">{form.name.trim()}님 개인 가입 링크</label>
                            <div className="break-all rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200">
                                {absoluteInviteUrl(result.inviteUrl)}
                            </div>
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">이 링크는 해당 선생님만 사용해야 하며 7일 동안 유효합니다.</p>
                        </div>

                        {copyMessage && <p role="status" aria-live="polite" className="text-sm font-medium text-blue-700 dark:text-blue-300">{copyMessage}</p>}

                        <div className="flex flex-wrap justify-end gap-2">
                            <button type="button" onClick={() => void copyInviteUrl()} className="flex items-center gap-1 rounded-lg border border-brand-navy-200 px-4 py-2.5 text-sm font-bold text-brand-navy-900 dark:border-brand-navy-600 dark:text-white">
                                <span className="material-symbols-outlined text-[18px]">content_copy</span>
                                가입 링크 복사
                            </button>
                            {typeof navigator !== "undefined" && "share" in navigator && (
                                <button type="button" onClick={() => void shareInviteUrl()} className="flex items-center gap-1 rounded-lg bg-brand-navy-900 px-4 py-2.5 text-sm font-bold text-white">
                                    <span className="material-symbols-outlined text-[18px]">share</span>
                                    공유하기
                                </button>
                            )}
                            <button type="button" onClick={onClose} className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-100">완료</button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-4 p-6">
                        <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-700">
                            선생님 또는 기사 전용 개인 가입 링크를 만들고 입력한 전화번호로 안내 문자를 보냅니다.
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">이름 *</label>
                            <input data-admin-modal-initial-focus type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required placeholder="홍길동" className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-brand-navy-500 focus:ring-2 focus:ring-brand-navy-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">전화번호 *</label>
                            <input type="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: formatPhone(event.target.value) })} required inputMode="numeric" autoComplete="tel" pattern="010-[0-9]{4}-[0-9]{4}" title="010-0000-0000 형식으로 입력해 주세요." placeholder="010-1234-5678" className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-brand-navy-500 focus:ring-2 focus:ring-brand-navy-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                            {/* 안내문구 제거: placeholder + input title 속성과 삼중 중복 */}
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">초대 역할 *</label>
                            <select
                                value={form.role}
                                onChange={(event) => setForm({ ...form, role: event.target.value as "INSTRUCTOR" | "DRIVER" })}
                                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-bold focus:border-brand-navy-500 focus:ring-2 focus:ring-brand-navy-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                            >
                                <option value="INSTRUCTOR">코치/강사</option>
                                <option value="DRIVER">셔틀 기사</option>
                            </select>
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                선생님은 수업 앱으로, 기사는 셔틀 운행 화면으로 이동합니다.
                            </p>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-100">취소</button>
                            <button type="submit" disabled={isPending || !form.name.trim() || !phoneComplete} className="rounded-lg bg-brand-navy-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
                                {isPending ? "가입 링크 만드는 중…" : "개인 가입 링크 만들기"}
                            </button>
                        </div>
                    </form>
                )}
        </AdminModal>
    );
}
