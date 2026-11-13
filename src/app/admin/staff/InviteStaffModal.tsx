"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useState, useTransition, type FormEvent } from "react";
import { inviteStaff, sendStaffPasswordReset } from "@/app/actions/admin";
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
    // previousRecordNotice: 같은 번호의 이전 직원 기록이 있지만 이름이 달라 연결하지 않았다는 안내(2026-11-12)
    | { grantedExisting: false; accountName: null; inviteUrl: string; smsSent: boolean; smsError?: string; previousRecordNotice?: string }
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
    // 이미 가입된 직원이면 초대 대신 비밀번호 재설정 링크를 보낼 수 있다(2026-11-12)
    const [rejection, setRejection] = useState<{ error: string; resetAvailable: boolean } | null>(null);
    const [resetMode, setResetMode] = useState(false);
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
                // 예상된 거절(이미 가입된 계정·대기 중 초대 등)은 이유를 그대로 보여 준다
                if ("rejected" in invitation) {
                    setRejection({ error: invitation.error, resetAvailable: invitation.resetAvailable });
                    return;
                }
                setRejection(null);
                setResult(invitation);
                onSuccess();
            } catch (error) {
                onError(adminErrorText(error, "스태프 초대를 만들지 못했습니다."));
            }
        });
    }

    function handlePasswordReset() {
        startTransition(async () => {
            try {
                const reset = await sendStaffPasswordReset({ phone: form.phone.trim() });
                if (reset.rejected) {
                    setRejection({ error: reset.error, resetAvailable: false });
                    return;
                }
                setRejection(null);
                setResetMode(true);
                setResult({ grantedExisting: false, accountName: null, inviteUrl: reset.inviteUrl, smsSent: reset.smsSent, smsError: reset.smsError });
                onSuccess();
            } catch (error) {
                onError(adminErrorText(error, "비밀번호 재설정 링크를 만들지 못했습니다."));
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
                <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-6 py-4">
                    <h2 id="invite-staff-modal-title" className="academy-section-title">
                        새 스태프 초대·가입
                    </h2>
                    <button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]" aria-label="닫기">
                        <span className="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </div>

                {result?.grantedExisting ? (
                    // 기존 학부모 계정에 역할을 붙인 경우 — 보낼 링크가 없다. 링크 복사 버튼을 두면 빈 값을 복사한다.
                    <div className="space-y-4 p-6">
                        <div className="rounded-xl border border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] p-4 text-[var(--color-academy-success)]">
                            <p className="font-semibold">기존 계정에 {form.role === "DRIVER" ? "기사님" : "선생님"} 역할을 추가했습니다.</p>
                            <p className="mt-1 text-sm">
                                이 번호로 이미 가입된 학부모 계정({result.accountName})이 있어 새 계정을 만들지 않았습니다.
                                그 계정으로 로그인하면 화면 전환에서 바로 쓸 수 있습니다. 「직원 역할 신청」 화면에서 회수할 수 있습니다.
                            </p>
                        </div>
                        <div className="flex justify-end">
                            <button type="button" onClick={onClose} className="academy-button-secondary">완료</button>
                        </div>
                    </div>
                ) : result ? (
                    <div className="space-y-4 p-6">
                        <div className={`rounded-xl border p-4 ${result.smsSent ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"}`}>
                            <p className="font-semibold">{resetMode ? "비밀번호 재설정 링크가 만들어졌습니다." : "초대 링크가 만들어졌습니다."}</p>
                            <p className="mt-1 text-sm">
                                {result.smsSent
                                    ? `${resetMode ? "재설정" : "가입"} 안내 문자를 발송했습니다. 아래 링크를 카카오톡으로도 전달할 수 있습니다.`
                                    : `문자는 발송되지 않았습니다. ${resetMode ? "재설정 링크" : "초대"}는 정상적으로 만들어졌으니 아래 링크를 복사해 전달해 주세요.`}
                            </p>
                            {!result.smsSent && result.smsError && <p className="mt-2 text-xs opacity-80">발송 사유: {result.smsError}</p>}
                        </div>
                        {result.previousRecordNotice && (
                            <p role="status" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">
                                {result.previousRecordNotice}
                            </p>
                        )}

                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">{form.name.trim()}님 {resetMode ? "비밀번호 재설정 링크" : "개인 가입 링크"}</label>
                            <div className="break-all rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-muted)]">
                                {absoluteInviteUrl(result.inviteUrl)}
                            </div>
                            <p className="mt-2 text-xs text-[var(--color-academy-muted)]">{resetMode ? "이 링크는 본인만 사용해야 하며 24시간 동안 유효합니다. 등록된 휴대폰 문자 인증 후 새 비밀번호를 정합니다." : "이 링크는 해당 선생님만 사용해야 하며 7일 동안 유효합니다."}</p>
                        </div>

                        {copyMessage && <p role="status" aria-live="polite" className="text-sm font-medium text-[var(--color-academy-muted)]">{copyMessage}</p>}

                        <div className="flex flex-wrap justify-end gap-2">
                            <button type="button" onClick={() => void copyInviteUrl()} className="academy-button-secondary">
                                가입 링크 복사
                            </button>
                            {typeof navigator !== "undefined" && "share" in navigator && (
                                <button type="button" onClick={() => void shareInviteUrl()} className="academy-button-primary">
                                    공유하기
                                </button>
                            )}
                            <button type="button" onClick={onClose} className="academy-button-secondary">완료</button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-4 p-6">
                        <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-4 py-3 text-xs text-[var(--color-academy-muted)]">
                            선생님 또는 기사 전용 개인 가입 링크를 만들고 입력한 전화번호로 안내 문자를 보냅니다.
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">이름 *</label>
                            <input data-admin-modal-initial-focus type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required placeholder="홍길동" className="academy-input" />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">전화번호 *</label>
                            <input type="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: formatPhone(event.target.value) })} required inputMode="numeric" autoComplete="tel" pattern="010-[0-9]{4}-[0-9]{4}" title="010-0000-0000 형식으로 입력해 주세요." placeholder="010-1234-5678" className="academy-input" />
                            {/* 안내문구 제거: placeholder + input title 속성과 삼중 중복 */}
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">초대 역할 *</label>
                            <select
                                value={form.role}
                                onChange={(event) => setForm({ ...form, role: event.target.value as "INSTRUCTOR" | "DRIVER" })}
                                className="academy-input"
                            >
                                <option value="INSTRUCTOR">코치/강사</option>
                                <option value="DRIVER">셔틀 기사</option>
                            </select>
                            <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                                선생님은 수업 앱으로, 기사는 셔틀 운행 화면으로 이동합니다.
                            </p>
                        </div>
                        {rejection && (
                            <div role="alert" className="rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm text-[var(--color-academy-danger)]">
                                <p className="font-semibold">{rejection.error}</p>
                                {rejection.resetAvailable && (
                                    <button type="button" onClick={handlePasswordReset} disabled={isPending} className="academy-button-secondary academy-button-sm mt-2">
                                        {isPending ? "보내는 중…" : "비밀번호 재설정 링크 보내기"}
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose} className="academy-button-secondary">취소</button>
                            <button type="submit" disabled={isPending || !form.name.trim() || !phoneComplete} className="academy-button-primary">
                                {isPending ? "가입 링크 만드는 중…" : "개인 가입 링크 만들기"}
                            </button>
                        </div>
                    </form>
                )}
        </AdminModal>
    );
}
