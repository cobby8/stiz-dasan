"use client";

/**
 * SMS 템플릿 관리 클라이언트 컴포넌트
 *
 * 주요 기능:
 * 1. 탭(관리자/코치 | 학부모) 분류
 * 2. 카드별: 이름 + ON/OFF 토글 + 수신 대상 배지
 * 3. textarea 메시지 편집 + 변수 삽입 바 (커서 위치에 삽입)
 * 4. "자동 변환" 버튼 — 한글 키워드를 {{변수}}로 치환
 * 5. "미리보기" — 샘플 데이터로 치환한 실제 메시지 표시
 * 6. 저장 / 초기화 버튼
 */

import { useState, useRef, useCallback, useEffect, useTransition } from "react";
import {
    updateSmsTemplate,
    previewSmsTemplate,
    autoConvertSmsKeywords,
    resetSmsTemplate,
} from "@/app/actions/admin";

// ── 타입 정의 ────────────────────────────────────────────────────────────────
interface SmsTemplate {
    id: string;
    trigger: string;
    name: string;
    target: string;
    body: string;
    isActive: boolean;
    description: string | null;
    variables: string | null;
    createdAt: string;
    updatedAt: string;
}

// ── 변수 목록 (삽입 바에서 사용) ─────────────────────────────────────────────
const ALL_VARIABLES = [
    { key: "childName", label: "아이이름" },
    { key: "childGrade", label: "학년" },
    { key: "parentName", label: "학부모이름" },
    { key: "parentPhone", label: "학부모연락처" },
    { key: "className", label: "반이름" },
    { key: "scheduledDate", label: "체험일시" },
    { key: "amount", label: "금액" },
    { key: "month", label: "월" },
    { key: "dueDate", label: "납부기한" },
    { key: "academyPhone", label: "학원전화" },
    { key: "preferredSlot", label: "희망시간" },
    { key: "unpaidCount", label: "미납건수" },
    { key: "totalAmount", label: "총금액" },
];

// 수신 대상 배지 색상 매핑
const TARGET_COLORS: Record<string, string> = {
    ADMIN: "bg-blue-100 text-blue-700",
    COACH: "bg-green-100 text-green-700",
    PARENT: "bg-orange-100 text-orange-700",
};
const TARGET_LABELS: Record<string, string> = {
    ADMIN: "관리자",
    COACH: "코치",
    PARENT: "학부모",
};

function SmsTemplatesLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="flex w-fit gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
                <div className="h-9 w-36 animate-pulse rounded-md bg-white dark:bg-gray-700" />
                <div className="h-9 w-28 animate-pulse rounded-md bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {Array.from({ length: 6 }).map((_, index) => (
                    <div
                        key={index}
                        className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
                            <div className="flex min-w-0 items-center gap-2.5">
                                <div className="h-5 w-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                <div className="h-5 w-14 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                            </div>
                            <div className="h-6 w-11 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                        </div>
                        <div className="px-5 pt-3">
                            <div className="h-4 w-64 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                        </div>
                        <div className="px-5 py-3">
                            <div className="h-28 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                            <div className="mt-3 flex flex-wrap gap-2">
                                {Array.from({ length: 5 }).map((_, chipIndex) => (
                                    <div key={chipIndex} className="h-7 w-20 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                ))}
                            </div>
                            <div className="mt-4 flex justify-end gap-2">
                                <div className="h-9 w-20 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                <div className="h-9 w-20 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SmsTemplatesErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">SMS 템플릿을 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="academy-button-secondary mt-4"
            >
                다시 불러오기
            </button>
        </div>
    );
}

export default function SmsTemplateClient({ templates }: { templates?: SmsTemplate[] }) {
    // 탭 목록은 페이지 진입 후 API로 채운다. 저장/초기화 후에도 같은 API만 다시 호출한다.
    const hasInitialData = templates !== undefined;
    const [items, setItems] = useState<SmsTemplate[]>(templates ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    // 탭: "staff" = 관리자/코치, "parent" = 학부모
    const [activeTab, setActiveTab] = useState<"staff" | "parent">("staff");

    const loadTemplates = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/sms/templates", { cache: "no-store" });
            if (!response.ok) throw new Error("Failed to load SMS templates.");
            const data = (await response.json()) as { templates: SmsTemplate[] };
            setItems(data.templates);
        } catch (error) {
            console.error("Failed to load SMS templates:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadTemplates();
    }, [hasInitialData, loadTemplates]);

    if (loading && items.length === 0) {
        return <SmsTemplatesLoadingFallback />;
    }

    if (loadError && items.length === 0) {
        return <SmsTemplatesErrorState onRetry={loadTemplates} />;
    }

    // 탭별 필터링
    const staffTemplates = items.filter(t => t.target === "ADMIN" || t.target === "COACH");
    const parentTemplates = items.filter(t => t.target === "PARENT");
    const filtered = activeTab === "staff" ? staffTemplates : parentTemplates;

    return (
        <div className="space-y-6">
            {/* 탭 전환 */}
            <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg w-fit">
                <button
                    onClick={() => setActiveTab("staff")}
                    className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${
                        activeTab === "staff"
                            ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm"
                            : "text-gray-500 hover:text-gray-700 dark:text-gray-200"
                    }`}
                >
                    <span className="material-symbols-outlined text-[16px] align-middle mr-1">admin_panel_settings</span>
                    관리자/코치 ({staffTemplates.length})
                </button>
                <button
                    onClick={() => setActiveTab("parent")}
                    className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${
                        activeTab === "parent"
                            ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm"
                            : "text-gray-500 hover:text-gray-700 dark:text-gray-200"
                    }`}
                >
                    <span className="material-symbols-outlined text-[16px] align-middle mr-1">family_restroom</span>
                    학부모 ({parentTemplates.length})
                </button>
            </div>

            {/* 카드 그리드 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {filtered.map(tpl => (
                    <TemplateCard key={tpl.id} template={tpl} onReload={loadTemplates} />
                ))}
            </div>

            {filtered.length === 0 && (
                <div className="text-center py-16 text-gray-400">
                    <span className="material-symbols-outlined text-5xl block mb-3">sms</span>
                    <p>등록된 템플릿이 없습니다</p>
                </div>
            )}
        </div>
    );
}

// ── 개별 템플릿 카드 컴포넌트 ──────────────────────────────────────────────────
function TemplateCard({ template, onReload }: { template: SmsTemplate; onReload: () => Promise<void> | void }) {
    const [body, setBody] = useState(template.body);
    const [isActive, setIsActive] = useState(template.isActive);
    const [preview, setPreview] = useState<string | null>(null);
    const [convertMsg, setConvertMsg] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [isPending, startTransition] = useTransition();
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        setBody(template.body);
        setIsActive(template.isActive);
        setPreview(null);
    }, [template.id, template.body, template.isActive]);

    // 이 템플릿에서 사용 가능한 변수 목록 파싱
    const availableVars = (() => {
        try {
            const parsed = JSON.parse(template.variables || "[]");
            return ALL_VARIABLES.filter(v => parsed.includes(v.key));
        } catch {
            return ALL_VARIABLES;
        }
    })();

    // 변수 삽입: 커서 위치에 {{변수}}를 삽입
    const insertVariable = useCallback((varKey: string) => {
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const text = `{{${varKey}}}`;
        const newBody = body.slice(0, start) + text + body.slice(end);
        setBody(newBody);
        // 커서를 삽입한 변수 뒤로 이동
        requestAnimationFrame(() => {
            ta.focus();
            ta.setSelectionRange(start + text.length, start + text.length);
        });
    }, [body]);

    // ON/OFF 토글 — 즉시 서버에 저장
    const handleToggle = useCallback(() => {
        const newActive = !isActive;
        setIsActive(newActive);
        startTransition(async () => {
            try {
                await updateSmsTemplate(template.id, { isActive: newActive });
            } catch {
                setIsActive(!newActive); // 실패 시 롤백
            }
        });
    }, [isActive, template.id]);

    // 저장 버튼
    const handleSave = async () => {
        setSaving(true);
        setSaved(false);
        try {
            await updateSmsTemplate(template.id, { body, isActive });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (e) {
            alert("저장 실패: " + (e as Error).message);
        }
        setSaving(false);
    };

    // 미리보기 토글
    const handlePreview = async () => {
        if (preview !== null) {
            setPreview(null);
            return;
        }
        try {
            const result = await previewSmsTemplate(body);
            setPreview(result);
        } catch {
            setPreview("[미리보기 오류]");
        }
    };

    // 자동 변환
    const handleAutoConvert = async () => {
        setConvertMsg(null);
        try {
            const { converted, changes } = await autoConvertSmsKeywords(body);
            if (changes.length === 0) {
                setConvertMsg("변환할 키워드가 없습니다.");
            } else {
                setBody(converted);
                setConvertMsg(`${changes.length}건 변환: ${changes.join(", ")}`);
            }
            setTimeout(() => setConvertMsg(null), 4000);
        } catch {
            setConvertMsg("변환 실패");
        }
    };

    // 초기화
    const handleReset = async () => {
        if (!confirm("기본 템플릿으로 초기화하시겠습니까?\n현재 수정한 내용이 사라집니다.")) return;
        try {
            await resetSmsTemplate(template.id);
            await onReload();
        } catch (e) {
            alert("초기화 실패: " + (e as Error).message);
        }
    };

    // 본문이 수정되었는지 확인
    const isModified = body !== template.body || isActive !== template.isActive;

    return (
        <div className={`bg-white dark:bg-gray-800 rounded-xl border ${isActive ? "border-gray-200 dark:border-gray-700" : "border-gray-200 dark:border-gray-700 opacity-60"} shadow-sm overflow-hidden`}>
            {/* 카드 상단: 이름 + 배지 + 토글 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2.5 min-w-0">
                    <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate">{template.name}</h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${TARGET_COLORS[template.target] || "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"}`}>
                        {TARGET_LABELS[template.target] || template.target}
                    </span>
                </div>
                {/* ON/OFF 토글 스위치 */}
                <button
                    onClick={handleToggle}
                    disabled={isPending}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                        isActive ? "bg-green-500" : "bg-gray-300"
                    }`}
                    title={isActive ? "발송 중 (클릭하면 OFF)" : "발송 중지 (클릭하면 ON)"}
                >
                    <span
                        className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-gray-800 transition-transform shadow-sm ${
                            isActive ? "translate-x-6" : "translate-x-1"
                        }`}
                    />
                </button>
            </div>

            {/* 설명 */}
            {template.description && (
                <p className="px-5 pt-3 text-xs text-gray-500 dark:text-gray-400">
                    <span className="material-symbols-outlined text-[14px] align-middle mr-0.5">info</span>
                    {template.description}
                </p>
            )}

            {/* 메시지 편집 textarea */}
            <div className="px-5 py-3">
                <textarea
                    ref={textareaRef}
                    value={body}
                    onChange={e => { setBody(e.target.value); setPreview(null); }}
                    rows={4}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 font-mono leading-relaxed"
                    placeholder="메시지를 입력하세요..."
                />

                {/* 변수 삽입 바 */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {availableVars.map(v => (
                        <button
                            key={v.key}
                            onClick={() => insertVariable(v.key)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors"
                            title={`커서 위치에 {{${v.key}}} 삽입`}
                        >
                            <span className="material-symbols-outlined text-[12px]">add</span>
                            {v.label}
                        </button>
                    ))}
                </div>

                {/* 자동 변환 메시지 */}
                {convertMsg && (
                    <p className="mt-2 text-xs text-green-600 bg-green-50 px-2 py-1 rounded">
                        {convertMsg}
                    </p>
                )}
            </div>

            {/* 미리보기 영역 */}
            {preview !== null && (
                <div className="mx-5 mb-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                    <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                        <span className="material-symbols-outlined text-[12px] align-middle mr-0.5">visibility</span>
                        미리보기 (샘플 데이터)
                    </p>
                    <p className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-line font-mono">{preview}</p>
                </div>
            )}

            {/* 하단 버튼 바 */}
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
                <div className="flex gap-2">
                    <button
                        onClick={handlePreview}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:bg-gray-900 transition-colors"
                    >
                        <span className="material-symbols-outlined text-[14px]">visibility</span>
                        {preview !== null ? "닫기" : "미리보기"}
                    </button>
                    <button
                        onClick={handleAutoConvert}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-purple-600 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 transition-colors"
                        title="한글 키워드를 자동으로 변수로 변환"
                    >
                        <span className="material-symbols-outlined text-[14px]">auto_fix_high</span>
                        자동 변환
                    </button>
                    <button
                        onClick={handleReset}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:bg-gray-900 transition-colors"
                        title="기본 템플릿으로 초기화"
                    >
                        <span className="material-symbols-outlined text-[14px]">restart_alt</span>
                        초기화
                    </button>
                </div>
                <button
                    onClick={handleSave}
                    disabled={saving || !isModified}
                    className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                        saved
                            ? "bg-green-500 text-white"
                            : isModified
                                ? "bg-blue-600 text-white hover:bg-blue-700"
                                : "bg-gray-200 text-gray-400 cursor-not-allowed"
                    }`}
                >
                    <span className="material-symbols-outlined text-[14px]">
                        {saved ? "check" : "save"}
                    </span>
                    {saving ? "저장 중..." : saved ? "저장됨" : "저장"}
                </button>
            </div>
        </div>
    );
}
