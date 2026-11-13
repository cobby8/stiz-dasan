"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateMyName, changeMyPassword, saveMyPushPrefs, saveMyPreferredPaymentMethod } from "@/app/actions/parent-settings";
import { PAYMENT_METHOD_OPTIONS, type PreferredPaymentMethod } from "@/lib/payments/preferredMethod";
import { createParentRequest } from "@/app/actions/admin";
import { usePushSubscription } from "@/lib/push/usePushSubscription";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";
import {
    FONT_SCALE_COOKIE,
    FONT_SCALES,
    PUSH_CATEGORIES,
    type FontScaleKey,
    type PushCategory,
    type PushPrefs,
} from "@/lib/mypage/parentSettings";

// 학부모 설정 화면의 «누르면 바뀌는» 줄들 (2026-11-10 원장 결정 k7).
// 화면 틀(섹션·링크 줄)은 서버(page.tsx)가 그리고, 입력·저장이 있는 줄만 여기 둔다.

// 한 줄 행 공통 모양 — 높이 44px 이상, 왼쪽 아이콘·이름, 오른쪽 값/버튼
const ROW = "flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-left text-sm";

function RowIcon({ name }: { name: string }) {
    return (
        <span className="material-symbols-outlined shrink-0 leading-none text-[var(--color-academy-muted)]" style={{ fontSize: "20px" }} aria-hidden="true">
            {name}
        </span>
    );
}

function Message({ text, tone }: { text: string; tone: "ok" | "error" }) {
    if (!text) return null;
    return (
        <p role={tone === "error" ? "alert" : "status"} className={`px-4 pb-2 text-xs font-semibold ${tone === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-success)]"}`}>
            {text}
        </p>
    );
}

// ── 내 정보: 이름(고치기) ──────────────────────────────────────────────────
export function NameRow({ name }: { name: string }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(name);
    const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" }>({ text: "", tone: "ok" });
    const [isPending, startTransition] = useTransition();

    function save() {
        startTransition(async () => {
            // 통신이 끊겨도 화면 전체가 오류로 바뀌지 않게 그 자리 안내(d1) — 입력값은 그대로
            const res = await updateMyName(value).catch(() => ({ ok: false as const, error: "보내지 못했습니다. 다시 시도해 주세요." }));
            if (res.ok) {
                setEditing(false);
                setMsg({ text: "저장했어요.", tone: "ok" });
            } else setMsg({ text: res.error, tone: "error" });
        });
    }

    return (
        <li>
            <div className={ROW}>
                <RowIcon name="person" />
                <span className="w-16 shrink-0 font-bold text-[var(--color-academy-ink)]">이름</span>
                {editing ? (
                    <>
                        <input
                            aria-label="이름"
                            value={value}
                            maxLength={30}
                            onChange={(e) => setValue(e.target.value)}
                            className="academy-input min-h-11 min-w-0 flex-1"
                            autoFocus
                        />
                        <button type="button" onClick={save} disabled={isPending || !value.trim()} className="academy-button-primary shrink-0">
                            {isPending ? "저장 중" : "저장"}
                        </button>
                    </>
                ) : (
                    <>
                        <span className="min-w-0 flex-1 truncate text-[var(--color-academy-muted)]">{value}</span>
                        <button type="button" onClick={() => { setEditing(true); setMsg({ text: "", tone: "ok" }); }} className="academy-button-text shrink-0">
                            바꾸기
                        </button>
                    </>
                )}
            </div>
            <Message {...msg} />
        </li>
    );
}

// ── 결제: 자주 쓰는 결제 방법(2026-11-13) ─────────────────────────────────
// 고르면 결제 화면 맨 위 큰 버튼이 그 방법이 된다. 결제가 승인되면 그때 쓴 방법으로 자동으로 바뀐다.
// 고르기는 기본 선택 상자(select) 하나 — 7가지를 버튼으로 펼치면 한 줄 행이 세 줄이 된다(컴팩트 규칙).
export function PaymentMethodRow({ current }: { current: PreferredPaymentMethod | null }) {
    const [value, setValue] = useState<string>(current ?? "");
    const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" }>({ text: "", tone: "ok" });
    const [isPending, startTransition] = useTransition();

    function choose(next: string) {
        const before = value;
        setValue(next);
        startTransition(async () => {
            const res = await saveMyPreferredPaymentMethod(next).catch(() => ({ ok: false as const, error: "보내지 못했습니다. 다시 시도해 주세요." }));
            if (res.ok) setMsg({ text: "저장했어요.", tone: "ok" });
            else {
                setValue(before); // 저장 실패면 원래 값으로 되돌린다
                setMsg({ text: res.error, tone: "error" });
            }
        });
    }

    return (
        <li>
            <div className={ROW}>
                <RowIcon name="payments" />
                <label htmlFor="preferred-payment-method" className="flex-1 font-bold text-[var(--color-academy-ink)]">자주 쓰는 결제 방법</label>
                <select
                    id="preferred-payment-method"
                    value={value}
                    disabled={isPending}
                    onChange={(e) => choose(e.target.value)}
                    className="academy-input min-h-11 w-32 shrink-0 text-sm"
                >
                    <option value="">정하지 않음</option>
                    {PAYMENT_METHOD_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
            </div>
            <Message {...msg} />
        </li>
    );
}

// ── 로그인: 비밀번호 바꾸기(펼침) ──────────────────────────────────────────
export function PasswordRow() {
    const [open, setOpen] = useState(false);
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirm, setConfirm] = useState("");
    const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" }>({ text: "", tone: "ok" });
    const [isPending, startTransition] = useTransition();

    function submit() {
        startTransition(async () => {
            // 통신 실패 시 그 자리 안내(d1) — 입력한 비밀번호 칸은 지우지 않는다
            const res = await changeMyPassword(current, next, confirm).catch(() => ({ ok: false as const, error: "보내지 못했습니다. 다시 시도해 주세요." }));
            if (res.ok) {
                setCurrent(""); setNext(""); setConfirm("");
                setOpen(false);
                setMsg({ text: "비밀번호를 바꿨어요.", tone: "ok" });
            } else setMsg({ text: res.error, tone: "error" });
        });
    }

    return (
        <li>
            <button type="button" aria-expanded={open} onClick={() => { setOpen((v) => !v); setMsg({ text: "", tone: "ok" }); }} className={`${ROW} hover:bg-[var(--color-academy-soft)]`}>
                <RowIcon name="lock" />
                <span className="flex-1 font-bold text-[var(--color-academy-ink)]">비밀번호 바꾸기</span>
                <RowIcon name={open ? "expand_less" : "expand_more"} />
            </button>
            {open && (
                <div className="grid gap-2 px-4 pb-3">
                    <input type="password" autoComplete="current-password" aria-label="지금 비밀번호" placeholder="지금 비밀번호" value={current} onChange={(e) => setCurrent(e.target.value)} className="academy-input min-h-11" />
                    <input type="password" autoComplete="new-password" aria-label="새 비밀번호" placeholder="새 비밀번호(8자 이상)" value={next} onChange={(e) => setNext(e.target.value)} className="academy-input min-h-11" />
                    <input type="password" autoComplete="new-password" aria-label="새 비밀번호 확인" placeholder="새 비밀번호 확인" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="academy-input min-h-11" />
                    <button type="button" onClick={submit} disabled={isPending || !current || !next || !confirm} className="academy-button-primary w-full">
                        {isPending ? "바꾸는 중..." : "비밀번호 바꾸기"}
                    </button>
                </div>
            )}
            <Message {...msg} />
        </li>
    );
}

// ── 알림 설정: 휴대폰 알림 켜기 + 종류별 받기 ───────────────────────────────
export function NotificationRows({ initialPrefs, prefsAvailable }: { initialPrefs: PushPrefs; prefsAvailable: boolean }) {
    const { pushSupported, pushEnabled, pushLoading, checked, togglePush } = usePushSubscription();
    // 판정은 @/lib/storeApp 한 곳 — 앱 새 버전이 caps=push 를 보내면 자동으로 원래 스위치가 돌아온다
    const appLacksPush = useStoreAppLacks("push");
    const [prefs, setPrefs] = useState<PushPrefs>(initialPrefs);
    const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" }>({ text: "", tone: "ok" });
    const [isPending, startTransition] = useTransition();

    // 종류 하나를 켜고 끄면 바로 저장(실패하면 되돌림)
    function toggleCategory(key: PushCategory) {
        const before = prefs;
        const after = { ...prefs, [key]: !prefs[key] };
        setPrefs(after);
        setMsg({ text: "", tone: "ok" });
        startTransition(async () => {
            // 통신 실패도 «저장 실패»와 같이 되돌리고 안내(d1)
            const res = await saveMyPushPrefs(after).catch(() => ({ ok: false as const, error: "보내지 못했습니다. 다시 시도해 주세요." }));
            if (!res.ok) {
                setPrefs(before);
                setMsg({ text: res.error, tone: "error" });
            }
        });
    }

    return (
        <>
            <li>
                <div className={ROW}>
                    <RowIcon name={pushEnabled ? "notifications_active" : "notifications_off"} />
                    <span className="flex-1 font-bold text-[var(--color-academy-ink)]">휴대폰 알림</span>
                    {appLacksPush ? null : !checked ? null : pushSupported ? (
                        <Switch on={pushEnabled} busy={pushLoading} label="휴대폰 알림" onToggle={togglePush} />
                    ) : (
                        // 이 브라우저는 웹푸시를 못 받는다(아이폰 사파리에서 홈 화면 추가 전 등)
                        <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">앱에서 켤 수 있어요</span>
                    )}
                </div>
                {/* 스토어 앱(현재 버전)은 앱 알림을 못 받는다 — 안 되는 켜기 버튼 대신 안내(d2) */}
                {appLacksPush && (
                    <p className="px-4 pb-2 text-xs text-[var(--color-academy-muted)]">앱 알림은 준비 중이에요. 중요한 안내는 문자·카카오톡으로 보내드려요.</p>
                )}
            </li>
            {/* 종류별 받기 — 저장 표가 준비된 뒤에만 보인다. 끄는 건 휴대폰 울림만(종 목록에는 그대로 쌓임) */}
            {/* 앱 알림을 못 받는 스토어 앱에서는 종류별 스위치도 숨긴다(d2) */}
            {prefsAvailable && !appLacksPush && PUSH_CATEGORIES.map((c) => (
                <li key={c.key}>
                    <div className={`${ROW} pl-12`}>
                        <span className="flex-1 text-[var(--color-academy-ink)]">{c.label} 알림</span>
                        <Switch on={prefs[c.key]} busy={isPending} label={`${c.label} 알림`} onToggle={() => toggleCategory(c.key)} />
                    </div>
                </li>
            ))}
            {msg.text && <li><Message {...msg} /></li>}
        </>
    );
}

// 켜기·끄기 스위치 — 누르는 영역 44px, 상태는 aria-checked 로 읽힌다
function Switch({ on, busy, label, onToggle }: { on: boolean; busy: boolean; label: string; onToggle: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            disabled={busy}
            onClick={onToggle}
            className="inline-flex min-h-11 shrink-0 items-center px-1 disabled:opacity-60"
        >
            <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? "bg-[var(--color-academy-primary)]" : "bg-[var(--color-academy-line-input)]"}`}>
                <span className={`inline-block size-5 rounded-full bg-[var(--color-academy-surface)] shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
            </span>
        </button>
    );
}

// ── 화면: 글자 크기 ────────────────────────────────────────────────────────
export function FontScaleRow({ current }: { current: FontScaleKey }) {
    const [value, setValue] = useState<FontScaleKey>(current);
    const router = useRouter();

    // 쿠키에 1년 저장 → 서버가 머리줄(layout)에서 html 글자 배율을 다시 그린다(깜빡임 없이 다음 화면부터 같은 크기)
    function choose(key: FontScaleKey) {
        setValue(key);
        document.cookie = `${FONT_SCALE_COOKIE}=${key}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
    }

    return (
        <li>
            <div className={`${ROW} flex-wrap`}>
                <RowIcon name="format_size" />
                <span className="flex-1 font-bold text-[var(--color-academy-ink)]">글자 크기</span>
                <div role="group" aria-label="글자 크기" className="flex shrink-0 gap-1">
                    {FONT_SCALES.map((s) => (
                        <button
                            key={s.key}
                            type="button"
                            aria-pressed={value === s.key}
                            onClick={() => choose(s.key)}
                            className="academy-choice min-h-11 px-2.5 text-sm"
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>
        </li>
    );
}

// ── 도움: 문제 신고·문의(펼침) — 학원에 보내는 메시지(ParentRequest, 홈 «문의»와 같은 경로) ──
type ChildLite = { id: string; name: string };
const FEEDBACK_KINDS = [
    { key: "question", label: "문의" },
    { key: "problem", label: "불편 신고" },
] as const;

export function FeedbackRow({ childList }: { childList: ChildLite[] }) {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<(typeof FEEDBACK_KINDS)[number]["key"]>("problem");
    const [childId, setChildId] = useState(childList[0]?.id ?? "");
    const [content, setContent] = useState("");
    const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" }>({ text: "", tone: "ok" });
    const [isPending, startTransition] = useTransition();

    function send() {
        const child = childList.find((c) => c.id === childId);
        if (!child) return;
        const label = FEEDBACK_KINDS.find((k) => k.key === kind)!.label;
        startTransition(async () => {
            try {
                // 서버는 로그인한 본인·본인 자녀만 받는다(createParentRequest 가 확인). 종류는 자유 메시지(OTHER) 그대로.
                await createParentRequest({ userId: "", studentId: child.id, type: "OTHER", title: `${child.name} ${label}`, content });
                setContent("");
                setOpen(false);
                setMsg({ text: "학원에 보냈어요. 답변은 홈 «보낸 메시지»에서 볼 수 있어요.", tone: "ok" });
            } catch {
                setMsg({ text: "보내지 못했습니다. 잠시 후 다시 시도해 주세요.", tone: "error" });
            }
        });
    }

    return (
        <li>
            <button type="button" aria-expanded={open} onClick={() => { setOpen((v) => !v); setMsg({ text: "", tone: "ok" }); }} className={`${ROW} hover:bg-[var(--color-academy-soft)]`}>
                <RowIcon name="support_agent" />
                <span className="flex-1 font-bold text-[var(--color-academy-ink)]">문제 신고·문의</span>
                <RowIcon name={open ? "expand_less" : "expand_more"} />
            </button>
            {open && (
                childList.length === 0 ? (
                    <p className="px-4 pb-3 text-sm text-[var(--color-academy-muted)]">
                        자녀를 연결한 뒤 보낼 수 있어요. <Link href="/mypage/children" className="font-bold underline">자녀 연결</Link>
                    </p>
                ) : (
                    <div className="grid gap-2 px-4 pb-3">
                        <div role="group" aria-label="종류" className="flex gap-1">
                            {FEEDBACK_KINDS.map((k) => (
                                <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => setKind(k.key)} className="academy-choice min-h-11 px-3 text-sm">
                                    {k.label}
                                </button>
                            ))}
                        </div>
                        {childList.length > 1 && (
                            <select aria-label="자녀" value={childId} onChange={(e) => setChildId(e.target.value)} className="academy-input min-h-11">
                                {childList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                        )}
                        <textarea
                            aria-label="내용"
                            value={content}
                            maxLength={2000}
                            rows={4}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder={kind === "problem" ? "어떤 화면에서 무엇이 불편했는지 적어 주세요" : "궁금한 점을 적어 주세요"}
                            className="academy-input resize-none py-2"
                        />
                        <button type="button" onClick={send} disabled={isPending || !content.trim() || !childId} className="academy-button-primary w-full">
                            {isPending ? "보내는 중..." : "보내기"}
                        </button>
                    </div>
                )
            )}
            <Message {...msg} />
        </li>
    );
}
