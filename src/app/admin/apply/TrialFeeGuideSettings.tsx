"use client";

// 신청 안내 설정 탭 안의 «체험비 결제 · 자동 안내» 카드(2026-11-10).
// - 체험비 금액·온라인 결제 켜기: 원장만 저장(서버가 다시 확인)
// - 체험 확정 안내·등록 안내: 원장 문구 승인 전이라 자동 발송은 «꺼짐» 표시만, 실제 데이터로 «미리보기»만 된다(발송 버튼 없음)

import { useEffect, useState } from "react";
import {
    getTrialFeeAdminState,
    previewTrialGuides,
    updateTrialFeePaymentSettings,
    type GuidePreviewSet,
    type TrialFeeAdminState,
} from "@/app/actions/trial-fee";
import { adminErrorText } from "@/components/admin/adminDisplayText";

const INPUT = "w-full rounded-lg border border-[var(--color-academy-line-input)] bg-[var(--color-academy-soft)] px-3 py-2.5 text-sm focus:bg-white focus:ring-2 focus:ring-[var(--color-academy-primary)]";

export default function TrialFeeGuideSettings() {
    const [state, setState] = useState<TrialFeeAdminState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [amount, setAmount] = useState("");
    const [online, setOnline] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [leadId, setLeadId] = useState("");
    const [studentId, setStudentId] = useState("");
    const [preview, setPreview] = useState<GuidePreviewSet | null>(null);
    const [previewing, setPreviewing] = useState(false);

    useEffect(() => {
        getTrialFeeAdminState()
            .then((next) => {
                setState(next);
                setAmount(String(next.amount));
                setOnline(next.onlinePaymentEnabled);
                setLeadId(next.recentLeads[0]?.id ?? "");
                setStudentId(next.recentStudents[0]?.id ?? "");
            })
            .catch((error) => setLoadError(adminErrorText(error, "체험비 설정을 불러오지 못했습니다.")));
    }, []);

    async function save() {
        setSaving(true);
        setMessage(null);
        try {
            await updateTrialFeePaymentSettings({ amount: Number(amount.replace(/[^0-9]/g, "")), onlinePaymentEnabled: online });
            setMessage("저장했습니다.");
        } catch (error) {
            setMessage(adminErrorText(error, "저장하지 못했습니다."));
        } finally {
            setSaving(false);
        }
    }

    async function runPreview() {
        setPreviewing(true);
        try {
            setPreview(await previewTrialGuides({ trialLeadId: leadId || null, studentId: studentId || null }));
        } catch (error) {
            setMessage(adminErrorText(error, "미리보기를 만들지 못했습니다."));
        } finally {
            setPreviewing(false);
        }
    }

    if (loadError) return <p className="rounded-xl border border-[var(--color-academy-line)] bg-white p-4 text-sm text-[var(--color-academy-danger)]">{loadError}</p>;
    if (!state) return <p className="rounded-xl border border-[var(--color-academy-line)] bg-white p-4 text-sm text-[var(--color-academy-muted)]">체험비 설정을 불러오는 중...</p>;

    return (
        <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-[var(--color-academy-line)] px-6 py-4">
                <span className="rounded-full border border-[var(--color-academy-line)] bg-[var(--color-academy-neutral-soft)] px-2.5 py-1 text-xs font-bold text-[var(--color-academy-neutral)]">체험비</span>
                <h2 className="text-base font-bold text-[var(--color-academy-ink)]">체험비 결제 · 자동 안내</h2>
            </div>
            <div className="space-y-5 p-6">
                {/* ① 체험비 결제 — 금액(설정값) + 온라인 결제 켜기 */}
                <div className="grid gap-3 sm:grid-cols-[160px_1fr] sm:items-end">
                    <label className="block">
                        <span className="mb-1 block text-xs font-bold text-[var(--color-academy-muted)]">체험비(원)</span>
                        <input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} className={INPUT} />
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold text-[var(--color-academy-ink)]">
                        <input type="checkbox" checked={online} onChange={(event) => setOnline(event.target.checked)} className="h-5 w-5" />
                        신청 후 바로 온라인 결제(카드·계좌이체·무통장입금)
                    </label>
                </div>
                <p className="text-xs text-[var(--color-academy-muted)]">
                    {state.providerReady
                        ? "결제 키 준비됨. 끄면 신청 완료 화면에 예전 계좌 안내가 보여요. 결제가 확인되면 체험 목록에 «결제»로 표시돼요."
                        : "토스 결제 키가 아직 준비되지 않아, 켜도 계좌 안내로 보여요."}
                </p>
                <div className="flex items-center justify-end gap-3">
                    {message && <span className="text-sm font-bold text-[var(--color-academy-muted)]">{message}</span>}
                    <button type="button" onClick={() => void save()} disabled={saving} className="min-h-11 rounded-xl bg-[var(--color-academy-primary)] px-6 text-sm font-bold text-white hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-40">
                        {saving ? "저장 중..." : "체험비 저장"}
                    </button>
                </div>

                {/* ② 자동 안내 — 원장 문구 승인 전: 꺼짐 표시 + 미리보기만 */}
                <div className="space-y-3 border-t border-[var(--color-academy-line)] pt-5">
                    <div className="flex flex-wrap gap-2 text-xs font-bold">
                        <span className="rounded-full bg-[var(--color-academy-soft)] px-2.5 py-1 text-[var(--color-academy-muted)]">체험 확정 안내 자동 발송: {state.trialGuideAutoSend ? "켜짐" : "꺼짐"}</span>
                        <span className="rounded-full bg-[var(--color-academy-soft)] px-2.5 py-1 text-[var(--color-academy-muted)]">등록 안내 자동 발송: {state.enrollGuideAutoSend ? "켜짐" : "꺼짐"}</span>
                    </div>
                    <p className="text-xs text-[var(--color-academy-muted)]">원장님 문구 확인 전이라 보내지 않아요. 실제 신청·원생 데이터로 문구만 미리 볼 수 있어요(코치·기사님 연락처 자동).</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                        <select value={leadId} onChange={(event) => setLeadId(event.target.value)} aria-label="미리보기 체험 신청" className={INPUT}>
                            <option value="">체험 신청 선택 안 함</option>
                            {state.recentLeads.map((lead) => <option key={lead.id} value={lead.id}>{lead.label}</option>)}
                        </select>
                        <select value={studentId} onChange={(event) => setStudentId(event.target.value)} aria-label="미리보기 원생" className={INPUT}>
                            <option value="">원생 선택 안 함</option>
                            {state.recentStudents.map((student) => <option key={student.id} value={student.id}>{student.label}</option>)}
                        </select>
                    </div>
                    <button type="button" onClick={() => void runPreview()} disabled={previewing} className="min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] text-sm font-bold text-[var(--color-academy-ink)] disabled:opacity-40">
                        {previewing ? "만드는 중..." : "안내 미리보기"}
                    </button>
                    {preview && (
                        <div className="grid gap-3 lg:grid-cols-3">
                            <PreviewBox title="(a) 체험 확정 안내 — 결제 완료 시" preview={preview.trial} />
                            <PreviewBox title="(b) 등록 안내 — 체험 완료 후" preview={preview.enrollFromTrial} />
                            <PreviewBox title="(b) 등록 안내 — 수강 등록 시" preview={preview.enrollFromStudent} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function PreviewBox({ title, preview }: { title: string; preview: GuidePreviewSet["trial"] }) {
    return (
        <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
            <p className="text-xs font-bold text-[var(--color-academy-muted)]">{title}</p>
            {preview ? (
                <>
                    <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{preview.subject} · 받는 번호 {preview.recipientMasked}</p>
                    <pre className="mt-2 whitespace-pre-wrap break-keep font-sans text-xs leading-relaxed text-[var(--color-academy-ink)]">{preview.body}</pre>
                </>
            ) : (
                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">대상을 고르면 보여요.</p>
            )}
        </div>
    );
}
