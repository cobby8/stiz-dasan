"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { enqueueManualSmsBatch, getCoachPhones } from "@/app/actions/admin";
import SmsTemplateClient from "./templates/SmsTemplateClient";

interface CoachPhone {
    id: string;
    name: string;
    role: string;
    phone: string;
}

type CenterTab = "automation" | "templates" | "history" | "manual";
type Audience = "INTERNAL" | "EXTERNAL" | "SECURITY";
type Channel = "ALIMTALK" | "SMS" | "LMS" | "RCS";

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
    INTERNAL: { label: "학원 내부", icon: "badge", className: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200" },
    EXTERNAL: { label: "학원 외부", icon: "family_restroom", className: "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-200" },
    SECURITY: { label: "인증·보안", icon: "shield_lock", className: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200" },
};

const CHANNEL_LABELS: Record<Channel, string> = {
    ALIMTALK: "카카오 알림톡",
    SMS: "SMS",
    LMS: "LMS",
    RCS: "RCS",
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
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    {/* 영문 장식문구·설명문구 제거: 아래 4개 탭이 그대로 설명 역할 */}
                    <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">메시지 관리</h1>
                </div>
                <ChannelReadiness />
            </header>

            <nav className="grid grid-cols-2 gap-2 rounded-2xl border border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:grid-cols-4" aria-label="메시지 관리 메뉴">
                {TABS.map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        aria-current={activeTab === tab.id ? "page" : undefined}
                        className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold transition ${
                            activeTab === tab.id
                                ? "bg-brand-navy-900 text-white shadow-sm"
                                : "text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                        }`}
                    >
                        <span className="material-symbols-outlined text-[19px]">{tab.icon}</span>
                        {tab.label}
                    </button>
                ))}
            </nav>

            {activeTab === "automation" && <AutomationPanel />}
            {activeTab === "templates" && <SmsTemplateClient />}
            {activeTab === "history" && <HistoryPanel />}
            {activeTab === "manual" && <ManualSendPanel initialCoaches={initialCoaches} />}
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
                ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-200"
                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
        }`}>
            <span className={`size-2 rounded-full ${ready ? "bg-green-500" : "bg-gray-400"}`} />
            {label} {ready ? "연결됨" : "준비 필요"}
        </span>
    );
    return (
        <div className="flex flex-wrap gap-2 text-xs font-bold">
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
                            className={`rounded-2xl border p-4 text-left transition ${
                                filter === audience
                                    ? "border-brand-orange-500 bg-white shadow-sm dark:border-brand-neon-lime dark:bg-gray-800"
                                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800"
                            }`}
                        >
                            <span className={`material-symbols-outlined rounded-xl p-2 ${meta.className}`}>{meta.icon}</span>
                            <strong className="mt-3 block text-gray-900 dark:text-white">{meta.label}</strong>
                            <span className="text-xs text-gray-500 dark:text-gray-400">자동 발송 {count}개</span>
                        </button>
                    );
                })}
            </div>

            {notice && <p className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">{notice}</p>}

            <div className="space-y-3">
                {loading && <p className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800">자동 발송 설정을 불러오는 중입니다.</p>}
                {!loading && loadFailed && (
                    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-center dark:border-red-900 dark:bg-red-950/30">
                        <span className="material-symbols-outlined text-3xl text-red-500">error</span>
                        <p className="mt-2 text-sm font-bold text-red-700 dark:text-red-200">실제 설정을 확인할 수 없습니다.</p>
                        <button type="button" onClick={loadRules} className="mt-3 min-h-11 rounded-xl bg-brand-navy-900 px-5 text-sm font-bold text-white">
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
        <article className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.className}`}>{meta.label}</span>
                        {rule.locked && <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-600 dark:bg-gray-700 dark:text-gray-200"><span className="material-symbols-outlined text-[14px]">lock</span>필수 발송</span>}
                        {!rule.configured && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700 dark:bg-amber-950/30 dark:text-amber-200">채널 연결 필요</span>}
                    </div>
                    <h2 className="mt-2 font-extrabold text-gray-900 dark:text-white">{rule.name}</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{rule.description}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 xl:w-[520px]">
                    <label className="text-xs font-bold text-gray-500 dark:text-gray-400">
                        우선 채널
                        <select
                            value={rule.primaryChannel}
                            disabled={disabled || rule.locked}
                            onChange={event => onUpdate({ primaryChannel: event.target.value as Channel })}
                            className="mt-1 block min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                        >
                            <option value="ALIMTALK">카카오 알림톡 · 13원</option>
                            <option value="SMS">SMS · 18원</option>
                            <option value="LMS">LMS · 45원</option>
                            <option value="RCS">RCS · 13원~</option>
                        </select>
                    </label>
                    <label className="text-xs font-bold text-gray-500 dark:text-gray-400">
                        실패 시 대체
                        <select
                            value={rule.fallbackChannel}
                            disabled={disabled || rule.locked}
                            onChange={event => onUpdate({ fallbackChannel: event.target.value as AutomationRule["fallbackChannel"] })}
                            className="mt-1 block min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                        >
                            <option value="NONE">대체 안 함</option>
                            <option value="SMS">SMS</option>
                            <option value="LMS">LMS</option>
                        </select>
                    </label>
                    <div className="flex items-end justify-between gap-3">
                        <div className="pb-1">
                            <span className="block text-xs font-bold text-gray-500 dark:text-gray-400">예상 단가</span>
                            <strong className="text-base text-gray-900 dark:text-white">{rule.estimatedUnitCost}원~/건</strong>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={rule.isActive}
                            aria-label={`${rule.name} 자동 발송`}
                            title={rule.locked ? "인증·보안 알림은 끌 수 없습니다." : undefined}
                            disabled={disabled || rule.locked}
                            onClick={() => onUpdate({ isActive: !rule.isActive })}
                            className={`relative mb-1 h-7 w-12 rounded-full transition disabled:cursor-not-allowed disabled:opacity-70 ${rule.isActive ? "bg-brand-orange-500 dark:bg-brand-neon-lime" : "bg-gray-300 dark:bg-gray-600"}`}
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
        <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="border-b border-gray-200 p-5 dark:border-gray-700">
                <h2 className="font-extrabold text-gray-900 dark:text-white">최근 발송 이력</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">전화번호는 개인정보 보호를 위해 일부만 표시합니다.</p>
            </div>
            {!loaded && !loading ? (
                <div className="p-12 text-center">
                    <span className="material-symbols-outlined text-4xl text-gray-300">history</span>
                    <p className="mt-2 font-bold text-gray-700 dark:text-gray-200">발송 이력은 필요할 때만 불러옵니다.</p>
                    <button type="button" onClick={loadHistory} className="mt-4 min-h-11 rounded-xl bg-brand-navy-900 px-5 text-sm font-bold text-white">
                        최근 50건 불러오기
                    </button>
                </div>
            ) : loading ? (
                <p className="p-10 text-center text-sm text-gray-500">발송 이력을 불러오는 중입니다.</p>
            ) : items.length === 0 ? (
                <div className="p-12 text-center">
                    <span className="material-symbols-outlined text-4xl text-gray-300">history</span>
                    <p className="mt-2 font-bold text-gray-700 dark:text-gray-200">표시할 발송 이력이 없습니다.</p>
                    {/* 실제로는 조회가 정상 동작하고 단순히 0건인 상태이므로 사실에 맞게 표기 */}
                    <p className="mt-1 text-sm text-gray-500">문자를 발송하면 성공·실패 결과가 여기에 표시됩니다.</p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[980px] text-left text-sm">
                        <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                            <tr><th className="px-5 py-3">발송 시각</th><th className="px-5 py-3">알림</th><th className="px-5 py-3">출처</th><th className="px-5 py-3">구분</th><th className="px-5 py-3">실제 채널</th><th className="px-5 py-3">수신자</th><th className="px-5 py-3">결과·사유</th></tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                            {items.map(item => (
                                <tr key={item.id}>
                                    <td className="px-5 py-4 text-gray-500">{item.sentAt}</td>
                                    <td className="px-5 py-4 font-bold text-gray-900 dark:text-white">{item.name}</td>
                                    <td className="px-5 py-4">{item.source === "MANUAL" ? "수동" : item.source === "SECURITY" ? "보안" : "자동"}</td>
                                    <td className="px-5 py-4">{AUDIENCE_META[item.audience]?.label ?? item.audience}</td>
                                    <td className="px-5 py-4">
                                        <span>{CHANNEL_LABELS[item.channel] ?? item.channel}</span>
                                        {item.requestedChannel && item.requestedChannel !== item.channel && (
                                            <span className="mt-1 block text-xs text-gray-400">
                                                요청 {CHANNEL_LABELS[item.requestedChannel] ?? item.requestedChannel}
                                            </span>
                                        )}
                                        {item.fallbackUsed && <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-700">대체 발송</span>}
                                        {item.provider && <span className="mt-1 block text-xs text-gray-400">{item.provider}</span>}
                                        {item.unitCost !== null && item.unitCost !== undefined && (
                                            <span className="mt-1 block text-xs text-gray-400">
                                                {item.unitCost.toLocaleString("ko-KR")} {item.currency === "KRW" ? "원" : item.currency}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-5 py-4">{item.recipient}</td>
                                    <td className="px-5 py-4">
                                        <DeliveryBadge status={item.status} />
                                        {item.errorCode && <span className="mt-1 block text-xs text-red-600">{SMS_ERROR_LABEL[item.errorCode] ?? "발송 오류 — 솔라피 이력 확인 필요"}</span>}
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
        SENT: "bg-green-50 text-green-700",
        FAILED: "bg-red-50 text-red-700",
        PENDING: "bg-blue-50 text-blue-700",
        SENDING: "bg-amber-50 text-amber-700",
        UNCERTAIN: "bg-amber-50 text-amber-700",
        SKIPPED: "bg-gray-100 text-gray-600",
    };
    return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${colors[status]}`}>{labels[status]}</span>;
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
    const bytes = new TextEncoder().encode(`[STIZ] ${message}`).length;
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
                setError(caught instanceof Error ? caught.message : "문자 대량 발송을 접수하지 못했습니다.");
            }
        });
    }

    return (
        <section className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <h2 className="font-extrabold text-gray-900 dark:text-white">수신자 선택</h2>
                <div className="mt-4 grid grid-cols-3 gap-2">
                    {[
                        { id: "all" as const, label: "전체 직원" },
                        { id: "select" as const, label: "직원 선택" },
                        { id: "manual" as const, label: "직접 입력" },
                    ].map(option => (
                        <button key={option.id} type="button" disabled={batchIsActive} onClick={() => { setMode(option.id); resetRequest(); }} className={`min-h-11 rounded-xl px-2 text-sm font-bold disabled:opacity-40 ${mode === option.id ? "bg-brand-navy-900 text-white" : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-200"}`}>{option.label}</button>
                    ))}
                </div>
                {mode === "all" && <p className="mt-4 rounded-xl bg-blue-50 p-4 text-sm text-blue-700 dark:bg-blue-950/30 dark:text-blue-200">연락처가 등록된 직원 <strong>{coaches.length}명</strong>에게 발송합니다.</p>}
                {mode === "select" && (
                    <div className="mt-4 max-h-72 space-y-1 overflow-auto">
                        {coaches.map(coach => (
                            <label key={coach.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 hover:bg-gray-50 dark:hover:bg-gray-700">
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
                                <span className="font-bold text-gray-800 dark:text-gray-100">{coach.name}</span>
                                <span className="ml-auto text-xs text-gray-500">{coach.role}</span>
                            </label>
                        ))}
                    </div>
                )}
                {mode === "manual" && <textarea disabled={batchIsActive} value={manualNumbers} onChange={event => { setManualNumbers(event.target.value); resetRequest(); }} rows={7} placeholder={"010-1234-5678\n010-9876-5432"} className="mt-4 w-full resize-none rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />}
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <h2 className="font-extrabold text-gray-900 dark:text-white">메시지 작성</h2>
                <textarea disabled={batchIsActive} value={message} onChange={event => { setMessage(event.target.value); resetRequest(); }} rows={9} maxLength={1000} placeholder="보낼 메시지를 입력하세요." className="mt-4 w-full resize-none rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
                <div className="mt-2 flex justify-between text-xs text-gray-500">
                    <span>발송할 때 [STIZ]가 자동으로 붙습니다.</span>
                    <strong>{bytes}바이트 · {bytes > 90 ? "LMS" : "SMS"}</strong>
                </div>
                {batch && (
                    <div className="mt-4 space-y-3">
                        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
                            <p className="text-sm font-bold text-blue-800 dark:text-blue-200">배치 번호 {batch.batchId}</p>
                            <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs sm:grid-cols-7">
                                {[["전체", batch.total], ["대기", batch.pending], ["전송 요청 중", batch.processing], ["Solapi 접수", acceptedCount], ["최종 성공", batch.success], ["실패", batch.failed], ["확인 필요", batch.uncertain]].map(([label, value]) => (
                                    <span key={label} className="rounded-lg bg-white p-2 dark:bg-gray-900"><strong className="block text-base text-gray-900 dark:text-white">{value}</strong>{label}</span>
                                ))}
                            </div>
                            {acceptedCount > 0 && <p className="mt-2 text-xs text-blue-700 dark:text-blue-300">Solapi 접수는 솔라피가 요청을 받은 단계이며, 학부모 휴대폰의 최종 발송 성공과는 다릅니다. 최종 결과를 확인하고 있습니다.</p>}
                            {batchIsActive && <p className="mt-2 text-xs font-bold text-blue-700 dark:text-blue-300">화면을 닫지 마세요. 2.5초마다 진행 상황을 확인하고 있습니다.</p>}
                        </div>
                        {batch.uncertain > 0 && (
                            <p role="alert" className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                                <span className="material-symbols-outlined text-[19px]">warning</span>
                                발송 여부를 확인할 수 없는 {batch.uncertain}건과 처리 중인 문자는 재발송할 수 없습니다. 발송 이력에서 먼저 확인해 주세요.
                            </p>
                        )}
                        {batch.recipients && batch.recipients.length > 0 && (
                            <ul className="max-h-40 space-y-1 overflow-auto rounded-xl border border-gray-200 p-2 text-xs dark:border-gray-700">
                                {batch.recipients.map(item => (
                                    <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                                        <span className="text-gray-600 dark:text-gray-300">수신자 {item.recipient}</span>
                                        <strong className={item.status === "FAILED" ? "text-red-600" : item.status === "UNCERTAIN" || item.status === "SENDING" ? "text-amber-700 dark:text-amber-300" : item.status === "SENT" ? "text-green-700 dark:text-green-300" : "text-blue-700 dark:text-blue-300"}>
                                            {item.status === "SENT" ? "최종 성공" : item.status === "FAILED" ? "실패" : item.status === "UNCERTAIN" ? "확인 필요" : item.providerStatus === "ACCEPTED" ? "Solapi 접수" : item.status === "SENDING" ? "전송 요청 중" : "대기"}
                                        </strong>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {batch.failed > 0 && !batchIsActive && <p className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">실패 {batch.failed}건은 발송 이력에서 대상을 확인한 뒤 새 배치로만 재접수할 수 있습니다.</p>}
                    </div>
                )}
                {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
                <button type="button" onClick={() => send()} disabled={pending || batchIsActive || !recipients.length || !message.trim()} className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-navy-900 font-bold text-white disabled:opacity-40">
                    <span className="material-symbols-outlined text-[19px]">send</span>
                    {pending ? "대량 발송 접수 중..." : batchIsActive ? "대량 발송 처리 중" : `${recipients.length}명 대량 발송 접수`}
                </button>
            </div>
        </section>
    );
}
