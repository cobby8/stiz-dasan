"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { enqueueManualSmsBatch, getCoachPhones } from "@/app/actions/admin";
import SmsTemplateClient from "./templates/SmsTemplateClient";
import { PARENT_MESSAGE_PREFIX } from "@/lib/messaging/parent-alimtalk-templates";
// 고객 안내 문자(대관 안내 등) — 미리보기 → 원장 승인 → 1건 발송 공용 부품
import CustomerNoticeSender from "@/components/admin/CustomerNoticeSender";
// 학부모 가입 안내 — 같은 미리보기·승인 절차, 발송은 기존 대량 발송 큐
import ParentSignupGuideSender from "@/components/admin/ParentSignupGuideSender";
// 학부모 공지(카톡 틀 3종·자유 공지) — 같은 미리보기·승인 절차, 받는 사람은 서버가 재원생 학부모로 계산
import ParentNoticeSender from "@/components/admin/ParentNoticeSender";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

interface CoachPhone {
    id: string;
    name: string;
    role: string;
    phone: string;
}

type CenterTab = "automation" | "templates" | "history" | "manual";
type Audience = "INTERNAL" | "EXTERNAL" | "SECURITY";
// BMS = 카카오 브랜드 메시지(학부모 자유 공지, 2026-11-09) — 발송 이력에만 나온다
type Channel = "ALIMTALK" | "SMS" | "LMS" | "RCS" | "BMS";

interface AutomationRule {
    id: string;
    name: string;
    description: string;
    audience: Audience;
    isActive: boolean;
    locked: boolean;
    primaryChannel: Channel;
    fallbackChannel: "SMS" | "LMS" | "NONE";
    configured: boolean;
    estimatedUnitCost: number;
}

interface DeliveryHistory {
    id: string;
    sentAt: string;
    name: string;
    audience: Audience;
    channel: Channel;
    requestedChannel?: Channel;
    provider?: string | null;
    source?: "AUTO" | "MANUAL" | "SECURITY";
    fallbackUsed?: boolean;
    unitCost?: number | null;
    currency?: string;
    errorCode?: string | null;
    status: "SENT" | "FAILED" | "PENDING" | "SENDING" | "UNCERTAIN" | "SKIPPED";
    recipient: string;
}

interface ManualBatchStatus {
    batchId: string;
    total: number;
    pending: number;
    processing: number;
    /** 공급자가 묶음 요청을 받았지만 최종 발송 결과는 아직 확인되지 않은 건수 */
    accepted?: number;
    success: number;
    failed: number;
    uncertain: number;
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "NEEDS_REVIEW";
    recipients?: Array<{
        id: string;
        recipient: string;
        status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "UNCERTAIN";
        providerStatus?: string | null;
        reason?: string | null;
    }>;
}

const TABS: Array<{ id: CenterTab; label: string; icon: string }> = [
    { id: "automation", label: "자동 발송", icon: "automation" },
    { id: "templates", label: "템플릿", icon: "edit_note" },
    { id: "history", label: "발송 이력", icon: "history" },
    { id: "manual", label: "수동 발송", icon: "send" },
];

const AUDIENCE_META: Record<Audience, { label: string; icon: string; className: string }> = {
    INTERNAL: { label: "학원 내부", icon: "badge", className: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
    EXTERNAL: { label: "학원 외부", icon: "family_restroom", className: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
    SECURITY: { label: "인증·보안", icon: "shield_lock", className: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
};

const CHANNEL_LABELS: Record<Channel, string> = {
    ALIMTALK: "카카오 알림톡",
    SMS: "SMS",
    LMS: "LMS",
    RCS: "RCS",
    BMS: "카카오 브랜드 메시지",
};

const SMS_ERROR_LABEL: Record<string, string> = {
    FAILED_DELIVERY_UNCERTAIN: "수신 여부 불확실 — 솔라피 이력 확인 필요",
    TEMPLATE_DISABLED_OR_MISSING: "템플릿 비활성화 — 솔라피 설정 확인 필요",
    INVALID_RECIPIENT: "수신 번호 오류",
    INSUFFICIENT_BALANCE: "솔라피 잔액 부족",
    BLOCKED_NUMBER: "수신 거부 번호",
};

export default function SmsClient({ coaches: initialCoaches }: { coaches?: CoachPhone[] }) {
    const [activeTab, setActiveTab] = useState<CenterTab>("automation");

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {/* 영문 장식문구·설명문구 제거: 아래 4개 탭이 그대로 설명 역할 */}
            <AdminPageHeader title="메시지 관리" actions={<ChannelReadiness />} />

            <nav className="grid grid-cols-2 gap-2 rounded-2xl border border-[var(--color-academy-line)] bg-white p-2 shadow-sm sm:grid-cols-4" aria-label="메시지 관리 메뉴">
                {TABS.map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        aria-current={activeTab === tab.id ? "page" : undefined}
                        className={`academy-choice is-tab ${activeTab === tab.id ? "is-selected" : ""}`}
                    >
                        {tab.label}
                    </button>
                ))}
            </nav>

            {activeTab === "automation" && <AutomationPanel />}
            {activeTab === "templates" && <SmsTemplateClient />}
            {activeTab === "history" && <HistoryPanel />}
            {activeTab === "manual" && (
                <>
                    {/* 재원생 미가입 학부모에게 가입 안내(받는 사람은 서버가 계산) */}
                    <ParentSignupGuidePanel />
                    {/* 재원생 학부모 전체에게 공지(카톡 틀 = 알림톡, 자유 공지 = 브랜드 메시지 또는 문자) */}
                    <ParentNoticePanel />
                    {/* 외부 고객용 정해진 안내(대관) — 직원 대량 발송과 분리해 위에 둔다 */}
                    <CustomerGuidePanel />
                    <ManualSendPanel initialCoaches={initialCoaches} />
                </>
            )}
        </div>
    );
}

function ChannelReadiness() {
    const [channels, setChannels] = useState({ SMS: false, ALIMTALK: false, RCS: false });
    useEffect(() => {
        let ignore = false;
        fetch("/api/admin/sms/channels", { cache: "no-store" })
            .then(response => {
                if (!response.ok) throw new Error("load-failed");
                return response.json() as Promise<{ channels: typeof channels }>;
            })
            .then(data => {
                if (!ignore) setChannels(data.channels);
            })
            .catch(() => undefined);
        return () => {
            ignore = true;
        };
    }, []);

    const badge = (label: string, ready: boolean) => (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 ${
            ready
                ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
        }`}>
            <span className={`size-2 rounded-full ${ready ? "bg-[var(--color-academy-success)]" : "bg-[var(--color-academy-line-input)]"}`} />
            {label} {ready ? "연결됨" : "준비 필요"}
        </span>
    );
    return (
        <div className="flex flex-wrap gap-2 text-xs">
            {badge("SMS", channels.SMS)}
            {badge("알림톡", channels.ALIMTALK)}
            {badge("RCS", channels.RCS)}
        </div>
    );
}

function AutomationPanel() {
    const [rules, setRules] = useState<AutomationRule[]>([]);
    const [filter, setFilter] = useState<Audience>("INTERNAL");
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState<string | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    const loadRules = useCallback(() => {
        let ignore = false;
        setLoading(true);
        setLoadFailed(false);
        setNotice(null);
        fetch("/api/admin/sms/automations", { cache: "no-store" })
            .then(response => {
                if (!response.ok) throw new Error("not-ready");
                return response.json() as Promise<{ rules: AutomationRule[] }>;
            })
            .then(data => {
                if (ignore) return;
                setRules(data.rules ?? []);
                if (!data.rules?.length) {
                    setLoadFailed(true);
                    setNotice("저장된 자동 발송 설정이 없습니다. 설정이 준비되기 전에는 자동 발송이 실행되지 않습니다.");
                }
            })
            .catch(() => {
                if (!ignore) {
                    setRules([]);
                    setLoadFailed(true);
                    setNotice("자동 발송 설정을 불러오지 못했습니다. 안전을 위해 설정을 임의로 표시하거나 발송하지 않습니다.");
                }
            })
            .finally(() => {
                if (!ignore) setLoading(false);
            });
        return () => {
            ignore = true;
        };
    }, []);

    useEffect(() => {
        return loadRules();
    }, [loadRules]);

    const updateRule = useCallback(async (id: string, patch: Partial<AutomationRule>) => {
        const previous = rules;
        setRules(current => current.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)));
        setNotice("설정을 저장하는 중입니다.");
        try {
            const response = await fetch(`/api/admin/sms/automations/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            if (!response.ok) throw new Error("save-failed");
            setNotice("자동 발송 설정을 저장했습니다.");
        } catch {
            setRules(previous);
            setNotice("아직 설정 저장 기능이 연결되지 않았습니다. 기존 발송 설정은 변경되지 않았습니다.");
        }
    }, [rules]);

    const filteredRules = rules.filter(rule => rule.audience === filter);
    return (
        <section className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
                {(Object.keys(AUDIENCE_META) as Audience[]).map(audience => {
                    const meta = AUDIENCE_META[audience];
                    const count = rules.filter(rule => rule.audience === audience).length;
                    return (
                        <button
                            key={audience}
                            type="button"
                            onClick={() => setFilter(audience)}
                            aria-pressed={filter === audience}
                            className={`rounded-2xl border p-4 text-left transition ${
                                filter === audience
                                    ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)]"
                                    : "border-[var(--color-academy-line)] bg-white hover:border-[var(--color-academy-line-input)]"
                            }`}
                        >
                            <strong className="block font-semibold text-[var(--color-academy-ink)]">{meta.label}</strong>
                            <span className="text-xs text-[var(--color-academy-muted)]">자동 발송 {count}개</span>
                        </button>
                    );
                })}
            </div>

            {notice && <p className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-muted)]">{notice}</p>}

            <div className="space-y-3">
                {loading && <p className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-8 text-center text-sm text-[var(--color-academy-muted)]">자동 발송 설정을 불러오는 중입니다.</p>}
                {!loading && loadFailed && (
                    <div className="rounded-2xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-5 text-center">
                        <p className="text-sm font-semibold text-[var(--color-academy-danger)]">실제 설정을 확인할 수 없습니다.</p>
                        <button type="button" onClick={loadRules} className="academy-button-secondary mt-3">
                            다시 불러오기
                        </button>
                    </div>
                )}
                {filteredRules.map(rule => (
                    <AutomationCard key={rule.id} rule={rule} disabled={loading} onUpdate={patch => void updateRule(rule.id, patch)} />
                ))}
            </div>
        </section>
    );
}

function AutomationCard({ rule, disabled, onUpdate }: { rule: AutomationRule; disabled: boolean; onUpdate: (patch: Partial<AutomationRule>) => void }) {
    const meta = AUDIENCE_META[rule.audience];
    return (
        <article className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>{meta.label}</span>
                        {rule.locked && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-academy-muted)]">필수 발송</span>}
                        {!rule.configured && <span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-academy-warning)]">채널 연결 필요</span>}
                    </div>
                    <h2 className="academy-section-title mt-2">{rule.name}</h2>
                    <p className="mt-1 text-sm text-[var(--color-academy-muted)]">{rule.description}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 xl:w-[520px]">
                    <label className="text-xs font-medium text-[var(--color-academy-muted)]">
                        우선 채널
                        <select
                            value={rule.primaryChannel}
                            disabled={disabled || rule.locked}
                            onChange={event => onUpdate({ primaryChannel: event.target.value as Channel })}
                            className="academy-input mt-1 block"
                        >
                            <option value="ALIMTALK">카카오 알림톡 · 13원</option>
                            <option value="SMS">SMS · 18원</option>
                            <option value="LMS">LMS · 45원</option>
                            <option value="RCS">RCS · 13원~</option>
                        </select>
                    </label>
                    <label className="text-xs font-medium text-[var(--color-academy-muted)]">
                        실패 시 대체
                        <select
                            value={rule.fallbackChannel}
                            disabled={disabled || rule.locked}
                            onChange={event => onUpdate({ fallbackChannel: event.target.value as AutomationRule["fallbackChannel"] })}
                            className="academy-input mt-1 block"
                        >
                            <option value="NONE">대체 안 함</option>
                            <option value="SMS">SMS</option>
                            <option value="LMS">LMS</option>
                        </select>
                    </label>
                    <div className="flex items-end justify-between gap-3">
                        <div className="pb-1">
                            <span className="block text-xs font-medium text-[var(--color-academy-muted)]">예상 단가</span>
                            <strong className="text-base text-[var(--color-academy-ink)]">{rule.estimatedUnitCost}원~/건</strong>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={rule.isActive}
                            aria-label={`${rule.name} 자동 발송`}
                            title={rule.locked ? "인증·보안 알림은 끌 수 없습니다." : undefined}
                            disabled={disabled || rule.locked}
                            onClick={() => onUpdate({ isActive: !rule.isActive })}
                            className={`relative mb-1 h-7 w-12 rounded-full transition disabled:cursor-not-allowed disabled:opacity-70 ${rule.isActive ? "bg-[var(--color-academy-secondary-strong)]" : "bg-[var(--color-academy-line-input)]"}`}
                        >
                            <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition ${rule.isActive ? "left-6" : "left-1"}`} />
                        </button>
                    </div>
                </div>
            </div>
        </article>
    );
}

function HistoryPanel() {
    const [items, setItems] = useState<DeliveryHistory[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const loadHistory = useCallback(() => {
        setLoading(true);
        fetch("/api/admin/sms/history?limit=50", { cache: "no-store" })
            .then(response => {
                if (!response.ok) throw new Error("load-failed");
                return response.json() as Promise<{ deliveries: DeliveryHistory[] }>;
            })
            .then(data => {
                setItems(data.deliveries ?? []);
                setLoaded(true);
            })
            .catch(() => setItems([]))
            .finally(() => setLoading(false));
    }, []);

    return (
        <section className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white shadow-sm">
            <div className="border-b border-[var(--color-academy-line)] p-5">
                <h2 className="academy-section-title">최근 발송 이력</h2>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">전화번호는 개인정보 보호를 위해 일부만 표시합니다.</p>
            </div>
            {!loaded && !loading ? (
                <div className="p-12 text-center">
                    <p className="font-medium text-[var(--color-academy-muted)]">발송 이력은 필요할 때만 불러옵니다.</p>
                    <button type="button" onClick={loadHistory} className="academy-button-primary mt-4">
                        최근 50건 불러오기
                    </button>
                </div>
            ) : loading ? (
                <p className="p-10 text-center text-sm text-[var(--color-academy-muted)]">발송 이력을 불러오는 중입니다.</p>
            ) : items.length === 0 ? (
                <div className="p-12 text-center">
                    <p className="font-medium text-[var(--color-academy-muted)]">표시할 발송 이력이 없습니다.</p>
                    {/* 실제로는 조회가 정상 동작하고 단순히 0건인 상태이므로 사실에 맞게 표기 */}
                    <p className="mt-1 text-sm text-[var(--color-academy-muted)]">문자를 발송하면 성공·실패 결과가 여기에 표시됩니다.</p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[980px] text-left text-sm">
                        <thead className="bg-[var(--color-academy-soft)] text-xs text-[var(--color-academy-muted)]">
                            <tr><th className="px-5 py-3">발송 시각</th><th className="px-5 py-3">알림</th><th className="px-5 py-3">출처</th><th className="px-5 py-3">구분</th><th className="px-5 py-3">실제 채널</th><th className="px-5 py-3">수신자</th><th className="px-5 py-3">결과·사유</th></tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-academy-line)]">
                            {items.map(item => (
                                <tr key={item.id}>
                                    <td className="px-5 py-4 text-[var(--color-academy-muted)]">{item.sentAt}</td>
                                    <td className="px-5 py-4 font-semibold text-[var(--color-academy-ink)]">{item.name}</td>
                                    <td className="px-5 py-4">{item.source === "MANUAL" ? "수동" : item.source === "SECURITY" ? "보안" : "자동"}</td>
                                    <td className="px-5 py-4">{AUDIENCE_META[item.audience]?.label ?? item.audience}</td>
                                    <td className="px-5 py-4">
                                        <span>{CHANNEL_LABELS[item.channel] ?? item.channel}</span>
                                        {item.requestedChannel && item.requestedChannel !== item.channel && (
                                            <span className="mt-1 block text-xs text-[var(--color-academy-faint)]">
                                                요청 {CHANNEL_LABELS[item.requestedChannel] ?? item.requestedChannel}
                                            </span>
                                        )}
                                        {item.fallbackUsed && <span className="ml-1 rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-academy-warning)]">대체 발송</span>}
                                        {item.provider && <span className="mt-1 block text-xs text-[var(--color-academy-faint)]">{item.provider}</span>}
                                        {item.unitCost !== null && item.unitCost !== undefined && (
                                            <span className="mt-1 block text-xs text-[var(--color-academy-faint)]">
                                                {item.unitCost.toLocaleString("ko-KR")} {item.currency === "KRW" ? "원" : item.currency}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-5 py-4">{item.recipient}</td>
                                    <td className="px-5 py-4">
                                        <DeliveryBadge status={item.status} />
                                        {item.errorCode && <span className="mt-1 block text-xs text-[var(--color-academy-danger)]">{SMS_ERROR_LABEL[item.errorCode] ?? "발송 오류 — 솔라피 이력 확인 필요"}</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function DeliveryBadge({ status }: { status: DeliveryHistory["status"] }) {
    const labels = { SENT: "발송 완료", FAILED: "실패", PENDING: "대기", SENDING: "발송 중", UNCERTAIN: "확인 필요", SKIPPED: "미발송" };
    const colors = {
        SENT: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
        FAILED: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
        PENDING: "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]",
        SENDING: "bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)]",
        UNCERTAIN: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
        SKIPPED: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
    };
    return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${colors[status]}`}>{labels[status]}</span>;
}

function ManualSendPanel({ initialCoaches }: { initialCoaches?: CoachPhone[] }) {
    const hasInitialCoaches = initialCoaches !== undefined;
    const [pending, startTransition] = useTransition();
    const [coaches, setCoaches] = useState(initialCoaches ?? []);
    const [mode, setMode] = useState<"all" | "select" | "manual">("all");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [manualNumbers, setManualNumbers] = useState("");
    const [message, setMessage] = useState("");
    const [batch, setBatch] = useState<ManualBatchStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    // 응답을 잃어버린 재시도에는 같은 번호표를 써서 중복 발송을 막습니다.
    const requestIdRef = useRef<string | null>(null);
    const requestPayloadRef = useRef<string | null>(null);

    useEffect(() => {
        if (hasInitialCoaches) return;
        getCoachPhones().then(setCoaches).catch(() => setError("직원 연락처를 불러오지 못했습니다."));
    }, [hasInitialCoaches]);

    const recipients = useMemo(() => {
        if (mode === "all") return coaches.map(coach => coach.phone);
        if (mode === "select") return coaches.filter(coach => selectedIds.has(coach.id)).map(coach => coach.phone);
        return manualNumbers.split(/[,;\n]+/).map(value => value.trim().replace(/\D/g, "")).filter(value => value.length >= 10);
    }, [coaches, manualNumbers, mode, selectedIds]);
    // 발송부(sendManualSms·enqueueManualSmsBatch)가 붙이는 머리말과 같은 글자로 길이를 잰다
    const bytes = new TextEncoder().encode(`${PARENT_MESSAGE_PREFIX} ${message}`).length;
    const acceptedCount = batch?.accepted ?? batch?.recipients?.filter(item => item.providerStatus === "ACCEPTED").length ?? 0;
    const batchIsActive = batch?.status === "PENDING" || batch?.status === "PROCESSING" || Boolean(batch?.pending) || Boolean(batch?.processing) || acceptedCount > 0;

    const loadBatch = useCallback(async (batchId: string) => {
        const response = await fetch(`/api/admin/sms/batches/${batchId}`, { cache: "no-store" });
        if (!response.ok) throw new Error("대량 발송 진행 상태를 불러오지 못했습니다.");
        const data = await response.json() as { batch?: ManualBatchStatus } & ManualBatchStatus;
        setBatch(data.batch ?? data);
    }, []);

    useEffect(() => {
        if (!batch?.batchId || !batchIsActive) return;
        const timer = window.setInterval(() => {
            void loadBatch(batch.batchId).catch(() => setError("진행 상태를 확인하지 못했습니다. 잠시 후 자동으로 다시 확인합니다."));
        }, 2500);
        return () => window.clearInterval(timer);
    }, [batch?.batchId, batchIsActive, loadBatch]);

    useEffect(() => {
        if (!batchIsActive) return;
        const warnBeforeLeave = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warnBeforeLeave);
        return () => window.removeEventListener("beforeunload", warnBeforeLeave);
    }, [batchIsActive]);

    const resetRequest = useCallback(() => {
        requestIdRef.current = null;
        requestPayloadRef.current = null;
        setBatch(null);
        setError(null);
    }, []);

    function send() {
        const targetRecipients = recipients;
        if (!targetRecipients.length || !message.trim()) {
            setError("수신자와 메시지를 모두 입력해주세요.");
            return;
        }
        if (!confirm(`${targetRecipients.length}명을 대량 발송 대기열에 접수할까요?`)) return;
        void enqueue();
    }

    async function enqueue() {
        const targetRecipients = recipients;
        const payloadKey = JSON.stringify([targetRecipients, message.trim()]);
        if (requestPayloadRef.current !== payloadKey || !requestIdRef.current) {
            requestIdRef.current = crypto.randomUUID();
            requestPayloadRef.current = payloadKey;
        }
        const requestId = requestIdRef.current;

        setError(null);
        startTransition(async () => {
            try {
                const response = await enqueueManualSmsBatch(targetRecipients, message.trim(), { requestId });
                setBatch({ batchId: response.batchId, status: "PENDING", total: response.total, pending: response.total, processing: 0, accepted: 0, success: 0, failed: 0, uncertain: 0 });
                void loadBatch(response.batchId).catch(() => undefined);
                requestIdRef.current = null;
                requestPayloadRef.current = null;
            } catch (caught) {
                setError(adminErrorText(caught, "문자 대량 발송을 접수하지 못했습니다."));
            }
        });
    }

    return (
        <section className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
            <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
                <h2 className="academy-section-title">수신자 선택</h2>
                <div className="mt-4 grid grid-cols-3 gap-2">
                    {[
                        { id: "all" as const, label: "전체 직원" },
                        { id: "select" as const, label: "직원 선택" },
                        { id: "manual" as const, label: "직접 입력" },
                    ].map(option => (
                        <button key={option.id} type="button" disabled={batchIsActive} onClick={() => { setMode(option.id); resetRequest(); }} aria-pressed={mode === option.id} className="academy-choice disabled:opacity-40">{option.label}</button>
                    ))}
                </div>
                {mode === "all" && <p className="mt-4 rounded-xl bg-[var(--color-academy-soft)] p-4 text-sm text-[var(--color-academy-muted)]">연락처가 등록된 직원 <strong>{coaches.length}명</strong>에게 발송합니다.</p>}
                {mode === "select" && (
                    <div className="mt-4 max-h-72 space-y-1 overflow-auto">
                        {coaches.map(coach => (
                            <label key={coach.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 hover:bg-[var(--color-academy-soft)]">
                                <input
                                    type="checkbox"
                                    disabled={batchIsActive}
                                    checked={selectedIds.has(coach.id)}
                                    onChange={() => setSelectedIds(current => {
                                        resetRequest();
                                        const next = new Set(current);
                                        if (next.has(coach.id)) next.delete(coach.id); else next.add(coach.id);
                                        return next;
                                    })}
                                    className="size-4"
                                />
                                <span className="font-medium text-[var(--color-academy-ink)]">{coach.name}</span>
                                <span className="ml-auto text-xs text-[var(--color-academy-muted)]">{coach.role}</span>
                            </label>
                        ))}
                    </div>
                )}
                {mode === "manual" && <textarea disabled={batchIsActive} value={manualNumbers} onChange={event => { setManualNumbers(event.target.value); resetRequest(); }} rows={7} placeholder={"010-1234-5678\n010-9876-5432"} className="academy-input mt-4 resize-none" />}
            </div>

            <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
                <h2 className="academy-section-title">메시지 작성</h2>
                <textarea disabled={batchIsActive} value={message} onChange={event => { setMessage(event.target.value); resetRequest(); }} rows={9} maxLength={1000} placeholder="보낼 메시지를 입력하세요." className="academy-input mt-4 resize-none" />
                <div className="mt-2 flex justify-between text-xs text-[var(--color-academy-muted)]">
                    <span>발송할 때 {PARENT_MESSAGE_PREFIX}가 자동으로 붙습니다.</span>
                    <strong>{bytes}바이트 · {bytes > 90 ? "LMS" : "SMS"}</strong>
                </div>
                {batch && (
                    <div className="mt-4 space-y-3">
                        <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
                            <p className="text-sm font-semibold text-[var(--color-academy-ink)]">대량 발송 진행 상황</p>
                            <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs sm:grid-cols-7">
                                {[["전체", batch.total], ["대기", batch.pending], ["전송 요청 중", batch.processing], ["솔라피 접수", acceptedCount], ["최종 성공", batch.success], ["실패", batch.failed], ["확인 필요", batch.uncertain]].map(([label, value]) => (
                                    <span key={label} className="rounded-lg bg-white p-2"><strong className="block text-base font-semibold tabular-nums text-[var(--color-academy-ink)]">{value}</strong>{label}</span>
                                ))}
                            </div>
                            {acceptedCount > 0 && <p className="mt-2 text-xs text-[var(--color-academy-muted)]">솔라피 접수는 솔라피가 요청을 받은 단계이며, 학부모 휴대폰의 최종 발송 성공과는 다릅니다. 최종 결과를 확인하고 있습니다.</p>}
                            {batchIsActive && <p className="mt-2 text-xs font-medium text-[var(--color-academy-muted)]">화면을 닫지 마세요. 2.5초마다 진행 상황을 확인하고 있습니다.</p>}
                        </div>
                        {batch.uncertain > 0 && (
                            <p role="alert" className="flex gap-2 rounded-xl border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-3 text-sm font-medium text-[var(--color-academy-warning)]">
                                발송 여부를 확인할 수 없는 {batch.uncertain}건과 처리 중인 문자는 재발송할 수 없습니다. 발송 이력에서 먼저 확인해 주세요.
                            </p>
                        )}
                        {batch.recipients && batch.recipients.length > 0 && (
                            <ul className="max-h-40 space-y-1 overflow-auto rounded-xl border border-[var(--color-academy-line)] p-2 text-xs">
                                {batch.recipients.map(item => (
                                    <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                                        <span className="text-[var(--color-academy-muted)]">수신자 {item.recipient}</span>
                                        <strong className={item.status === "FAILED" ? "text-[var(--color-academy-danger)]" : item.status === "UNCERTAIN" || item.status === "SENDING" ? "text-[var(--color-academy-warning)]" : item.status === "SENT" ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-muted)]"}>
                                            {item.status === "SENT" ? "최종 성공" : item.status === "FAILED" ? "실패" : item.status === "UNCERTAIN" ? "확인 필요" : item.providerStatus === "ACCEPTED" ? "솔라피 접수" : item.status === "SENDING" ? "전송 요청 중" : "대기"}
                                        </strong>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {batch.failed > 0 && !batchIsActive && <p className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">실패 {batch.failed}건은 발송 이력에서 대상을 확인한 뒤 새 배치로만 재접수할 수 있습니다.</p>}
                    </div>
                )}
                {error && <p className="mt-4 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                <button type="button" onClick={() => send()} disabled={pending || batchIsActive || !recipients.length || !message.trim()} className="academy-button-primary mt-5 w-full">
                    {pending ? "대량 발송 접수 중..." : batchIsActive ? "대량 발송 처리 중" : `${recipients.length}명 대량 발송 접수`}
                </button>
            </div>
        </section>
    );
}

/** 학부모 공지 보내기 — 카톡 틀(휴무·행사·월 안내)은 변수 칸만, 자유 공지는 본문만 쓴다 */
function ParentNoticePanel() {
    return (
        <section className="mb-4 rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
            <h2 className="academy-section-title">학부모 공지 보내기</h2>
            <div className="mt-3 max-w-2xl">
                <ParentNoticeSender />
            </div>
        </section>
    );
}

/**
 * 학부모 가입 안내 보내기 — 재원생 학부모 중 계정이 없는 분께 가입 링크를 한 번에.
 * 받는 사람은 서버가 계산하고, 미리보기(받는 사람 N명·처음 몇 명) → 원장 확인 뒤에만 접수된다.
 */
function ParentSignupGuidePanel() {
    return (
        <section className="mb-4 rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
            <h2 className="academy-section-title">학부모 가입 안내 보내기</h2>
            <div className="mt-3 max-w-md">
                <ParentSignupGuideSender />
            </div>
        </section>
    );
}

/**
 * 고객 안내 보내기 — 번호를 넣고 정해진 안내 문구를 미리본 뒤 1건만 보낸다.
 * 대관 관리 화면이 생기면 같은 부품(CustomerNoticeSender kind="RENTAL_GUIDE")에 신청자 번호를 넣어 그대로 쓴다.
 */
function CustomerGuidePanel() {
    return (
        <section className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
            <h2 className="academy-section-title">대관 안내 보내기</h2>
            <div className="mt-3 max-w-md">
                <CustomerNoticeSender
                    kind="RENTAL_GUIDE"
                    hint="요금·실내 운동화·주차·신청 링크가 담긴 안내를 문의하신 분께 보냅니다. 계좌는 넣지 않아요."
                />
            </div>
        </section>
    );
}
