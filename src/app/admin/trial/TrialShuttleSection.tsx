"use client";

/**
 * 관리자 체험 상세의 «셔틀» 구역 (2026-11-19 원장 결정).
 *
 * 하는 일
 *  - 요청 내용 보기(방향·위치명·주소)와 상태 글자 배지
 *  - «셔틀 요청 넣기/고치기» — 전화로 받았거나 신청 뒤에 생긴 요청을 관리자가 직접 넣는다.
 *    입력 부품은 학부모 체험 신청서와 같은 것(TrialShuttleRequestFields)이라 검사 규칙도 같다.
 *  - «셔틀 필요 없음으로 바꾸기» — 확인 뒤 요청을 비운다(이미 배정했다면 배정도 풀린다).
 *  - 요청이 있는 건에만 배정 부품(TrialShuttleAssignPanel)을 끼운다.
 *
 * 상세 패널(AdminModal) 안에서 펼쳐 쓴다 — 창을 또 띄우지 않는다(지도 창만 예외: 그 창은 스스로 «뒤로 = 닫기»를 한다).
 */
import { useState } from "react";
import TrialShuttleRequestFields from "@/components/trial/TrialShuttleRequestFields";
import TrialShuttleAssignPanel from "@/app/admin/trial/TrialShuttleAssignPanel";
import { updateTrialLeadShuttleRequest } from "@/app/actions/admin";
import { askConfirm } from "@/components/ui/feedback";
import { statusBadgeClass } from "@/lib/ui/statusTones";
import { trialShuttleStatusLabel, trialShuttleStatusTone } from "@/lib/shuttle/trialShuttleRules";
import {
    trialShuttleColumnsFromRow,
    trialShuttleFormErrors,
    trialShuttleFormFromColumns,
    trialShuttleSummaryLines,
    type TrialShuttleErrors,
    type TrialShuttleFormValue,
} from "@/lib/trial/trialShuttleRequest";
import type { TrialLead } from "./TrialCrmClient";

/** 취소·이탈·등록 전환된 신청에는 셔틀 요청을 새로 넣거나 고치지 않는다 */
const CLOSED_STATUSES = new Set(["CANCELLED", "LOST", "CONVERTED"]);

export default function TrialShuttleSection({
    lead,
    onChanged,
    onFeedback,
}: {
    lead: TrialLead;
    /** 저장·배정 뒤 목록을 새로 읽는다(열려 있는 상세의 셔틀 칸도 그때 맞춰진다) */
    onChanged: () => Promise<boolean> | boolean;
    onFeedback: (type: "success" | "error" | "info", message: string) => void;
}) {
    const columns = trialShuttleColumnsFromRow(lead);
    const closed = CLOSED_STATUSES.has(lead.status);
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState<TrialShuttleFormValue>(() => trialShuttleFormFromColumns(columns));
    const [errors, setErrors] = useState<TrialShuttleErrors>({});
    const [saving, setSaving] = useState(false);

    // 끝난 신청인데 요청도 없으면 보여 줄 것이 없다
    if (closed && !columns.shuttleNeeded) return null;

    const summary = trialShuttleSummaryLines(columns);

    function openEditor() {
        // 열 때마다 지금 저장된 값에서 시작한다(전에 고치다 만 값이 남지 않게)
        setForm(trialShuttleFormFromColumns(columns));
        setErrors({});
        setEditing(true);
    }

    async function save(input: TrialShuttleFormValue | { needed: false }, doneText: string) {
        setSaving(true);
        try {
            const result = await updateTrialLeadShuttleRequest(lead.id, input);
            if (!result.ok) {
                onFeedback("error", result.error);
                return;
            }
            await onChanged();
            setEditing(false);
            if (result.releaseFailed) {
                onFeedback("error", `${doneText} 다만 셔틀 배정을 풀지 못했습니다. 셔틀 배정을 확인해 주세요.`);
            } else {
                onFeedback("success", result.changed ? doneText : "바뀐 내용이 없습니다.");
            }
        } catch {
            onFeedback("error", "셔틀 요청 저장 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
        } finally {
            setSaving(false);
        }
    }

    function handleSave() {
        // 화면에서도 같은 규칙으로 먼저 본다 — 위치(좌표)·위치명이 비면 그 칸 아래에 안내
        const nextErrors = trialShuttleFormErrors(form);
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;
        void save(form, columns.shuttleNeeded ? `${lead.childName} 셔틀 요청을 고쳤습니다.` : `${lead.childName} 셔틀 요청을 넣었습니다.`);
    }

    async function handleRemove() {
        const confirmed = await askConfirm(
            `"${lead.childName}" 셔틀을 «필요 없음»으로 바꿀까요?\n적어 둔 위치가 지워지고, 이미 배정했다면 배정도 풀립니다.`,
            { tone: "danger" },
        );
        if (!confirmed) return;
        void save({ needed: false }, `${lead.childName} 셔틀을 «필요 없음»으로 바꿨습니다.`);
    }

    return (
        <section aria-label="셔틀" className="mt-5 rounded-lg border border-[var(--color-academy-line)] px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">셔틀</h3>
                {columns.shuttleNeeded && closed ? (
                    // 끝난 신청: «배정 대기» 같은 진행 상태 대신 회색으로 사실만 적는다
                    <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass("neutral")}`}>
                        셔틀 요청 있었음
                    </span>
                ) : columns.shuttleNeeded ? (
                    <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(trialShuttleStatusTone(lead.shuttleStatus))}`}>
                        {trialShuttleStatusLabel(lead.shuttleStatus)}
                    </span>
                ) : (
                    <span className="text-xs text-[var(--color-academy-muted)]">요청 없음</span>
                )}
                {!editing && !closed && (
                    <div className="ml-auto flex flex-wrap gap-2">
                        <button type="button" onClick={openEditor} disabled={saving} className="academy-button-secondary academy-button-sm">
                            {columns.shuttleNeeded ? "셔틀 요청 고치기" : "셔틀 요청 넣기"}
                        </button>
                        {columns.shuttleNeeded && (
                            <button type="button" onClick={() => void handleRemove()} disabled={saving} className="academy-button-text academy-button-sm">
                                셔틀 필요 없음으로 바꾸기
                            </button>
                        )}
                    </div>
                )}
            </div>

            {!editing && summary.length > 0 && (
                <dl className="mt-2 space-y-1 text-sm">
                    {summary.map((line) => (
                        <div key={line.label} className="flex gap-2">
                            <dt className="w-20 shrink-0 text-[var(--color-academy-muted)]">{line.label}</dt>
                            <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">{line.value}</dd>
                        </div>
                    ))}
                    {lead.shuttleAdminNote && (
                        <div className="flex gap-2">
                            <dt className="w-20 shrink-0 text-[var(--color-academy-muted)]">메모</dt>
                            <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">{lead.shuttleAdminNote}</dd>
                        </div>
                    )}
                </dl>
            )}

            {editing && (
                <div className="mt-3 space-y-3">
                    <TrialShuttleRequestFields
                        value={form}
                        errors={errors}
                        hideQuestion
                        disabled={saving}
                        onChange={(next) => { setForm(next); setErrors({}); }}
                    />
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setEditing(false)} disabled={saving} className="academy-button-text academy-button-sm">
                            취소
                        </button>
                        <button type="button" onClick={handleSave} disabled={saving} aria-busy={saving} className="academy-button-primary academy-button-sm">
                            {saving ? "저장 중..." : "셔틀 요청 저장"}
                        </button>
                    </div>
                </div>
            )}

            {/* 배정 — 셔틀 요청이 있는 건에만. 고치는 중에는 숨긴다(저장하면 다시 «대기»로 돌아가므로) */}
            {columns.shuttleNeeded && !editing && (
                <div className="mt-3">
                    <TrialShuttleAssignPanel leadId={lead.id} onChanged={() => { void onChanged(); }} />
                </div>
            )}
        </section>
    );
}
