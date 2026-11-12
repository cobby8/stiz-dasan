"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

/**
 * 학생 상세 좌측 레일의 「보호자」 카드 — 학생 상세에서 «전화번호»를 보여 주는 단 한 곳(2026-11-09 2차 정리).
 * - 한 사람 = 한 줄(관계·이름·배지 · 전화 · ⚡). 수정·주 보호자 지정·삭제는 ⚡ 메뉴, 추가·수정 입력은 창(AdminModal)에서.
 * - 학부모 로그인 계정 번호가 보호자 번호와 같으면 그 줄에 «로그인» 배지만 달고, 다르면 «로그인 계정» 줄을 따로 하나 둔다.
 * - 보호자 여러 명(엄마·할머니 등)의 관계·이름·전화를 보여주고 추가·수정·삭제·주 보호자 지정을 한다.
 * - 로그인 계정 전화(User.phone)는 읽기 전용으로만 보여준다 — 여기서 바꾸지 않는다(로그인·알림톡 대상).
 * - 저장은 Server Action(@/app/actions/guardians)이 하고, 응답으로 받은 최신 목록으로 카드만 갱신한다.
 */

import { useCallback, useEffect, useState, useTransition, type FormEvent } from "react";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import {
    addStudentGuardian,
    deleteStudentGuardian,
    listStudentGuardians,
    setPrimaryGuardian,
    updateStudentGuardian,
    type GuardianMutationResult,
    type StudentGuardian,
} from "@/app/actions/guardians";
import {
    canAddGuardian,
    deleteConfirmMessage,
    formatGuardianPhone,
    MAX_GUARDIANS_PER_STUDENT,
} from "@/lib/guardians/guardianLogic";

const CARD_CLASS = "rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm";
const INPUT_CLASS = "w-full rounded-lg border border-[var(--color-academy-line)] bg-white px-2.5 py-1.5 text-sm text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]";
const SMALL_BTN = "inline-flex items-center gap-1 rounded-lg border border-[var(--color-academy-line)] px-2 py-1 text-xs font-bold text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] disabled:opacity-50";

// 관계 빠른 입력 버튼(직접 입력도 가능)
const RELATION_PRESETS = ["모", "부", "조모", "조부", "외조모", "외조부"];

type FormState = { relation: string; name: string; phone: string; makePrimary: boolean };
const EMPTY_FORM: FormState = { relation: "", name: "", phone: "", makePrimary: false };

function Icon({ name, size = 14 }: { name: string; size?: number }) {
    return (
        <span aria-hidden="true" className="material-symbols-outlined leading-none" style={{ fontSize: size }}>
            {name}
        </span>
    );
}

export default function GuardianPanel({
    studentId,
    accountPhone,
    accountName = null,
}: {
    studentId: string;
    // 로그인 계정(Student.parentId → User) 전화 — 읽기 전용 표시용
    accountPhone: string | null;
    // 로그인 계정 이름 — 계정 번호가 어느 보호자와도 다를 때 «로그인 계정» 줄에 쓴다
    accountName?: string | null;
}) {
    const [guardians, setGuardians] = useState<StudentGuardian[]>([]);
    const [loaded, setLoaded] = useState(false);
    // editingId: null = 폼 닫힘 / "new" = 추가 폼 / 그 외 = 해당 보호자 수정 폼
    const [editingId, setEditingId] = useState<string | null>(null); // 관리 창(추가·수정 입력 창) 대상
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const refresh = useCallback(async () => {
        const list = await listStudentGuardians(studentId);
        setGuardians(list);
        setLoaded(true);
    }, [studentId]);

    useEffect(() => {
        void refresh().catch(() => {
            setLoaded(true);
            setError("보호자 목록을 불러오지 못했습니다.");
        });
    }, [refresh]);

    function openAdd() {
        setEditingId("new");
        setForm(EMPTY_FORM);
        setError(null);
        setMessage(null);
    }

    function openEdit(g: StudentGuardian) {
        setEditingId(g.id);
        // 이름이 관계와 같으면(엑셀 업로드 관례) 이름 칸은 비워서 보여준다
        setForm({ relation: g.relation, name: g.name === g.relation ? "" : g.name, phone: formatGuardianPhone(g.phone), makePrimary: false });
        setError(null);
        setMessage(null);
    }

    function closeForm() {
        setEditingId(null);
        setForm(EMPTY_FORM);
        setError(null);
    }

    // 서버 호출 공통 처리: 성공하면 응답 목록으로 교체, 실패하면 사유 표시
    function run(action: () => Promise<GuardianMutationResult>, successMessage: string, afterSuccess?: () => void) {
        setError(null);
        setMessage(null);
        startTransition(async () => {
            try {
                const result = await action();
                // 거절 사유는 값으로 온다(운영 빌드는 서버 액션의 throw 문구를 가린다).
                if ("error" in result) {
                    setError(result.error);
                    return;
                }
                setGuardians(result.guardians);
                setMessage(successMessage);
                afterSuccess?.();
            } catch (e) {
                setError(adminErrorText(e, "처리하지 못했습니다."));
            }
        });
    }

    function submitForm(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!editingId) return;
        const input = { relation: form.relation, name: form.name, phone: form.phone };
        if (editingId === "new") {
            run(() => addStudentGuardian(studentId, { ...input, makePrimary: form.makePrimary }), "보호자를 추가했습니다.", closeForm);
        } else {
            const id = editingId;
            run(() => updateStudentGuardian(studentId, id, input), "보호자 정보를 수정했습니다.", closeForm);
        }
    }

    function remove(g: StudentGuardian) {
        // 마지막 1명이면 확인창에 경고 문구가 붙는다
        if (!window.confirm(deleteConfirmMessage(g, guardians.length))) return;
        run(() => deleteStudentGuardian(studentId, g.id), "보호자를 삭제했습니다.", () => {
            if (editingId === g.id) closeForm();
        });
    }

    function makePrimary(g: StudentGuardian) {
        run(() => setPrimaryGuardian(studentId, g.id), "주 보호자를 바꿨습니다.");
    }

    const canAdd = canAddGuardian(guardians.length);

    // 로그인 계정 번호와 같은 보호자 찾기(숫자만 비교 — 보호자 번호는 숫자만 저장, 계정 번호는 하이픈이 있을 수 있다)
    const digits = (v: string | null | undefined) => (v ?? "").replace(/[^0-9]/g, "");
    const accountDigits = digits(accountPhone);
    const accountMatchesGuardian = accountDigits !== "" && guardians.some((g) => digits(g.phone) === accountDigits);
    const editingGuardian = editingId && editingId !== "new" ? guardians.find((g) => g.id === editingId) ?? null : null;

    // 추가·수정 공용 폼 — 창(AdminModal) 안에 그린다. 휴대폰에서는 아래에서 올라오는 시트
    const formView = (
        <form onSubmit={submitForm} className="space-y-3 px-5 py-4">
            <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">관계 *</span>
                <input type="text" value={form.relation} maxLength={20} placeholder="예: 모, 조모" onChange={(e) => setForm({ ...form, relation: e.target.value })} className={`${INPUT_CLASS} min-h-11`} data-admin-modal-initial-focus="true" />
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                    {RELATION_PRESETS.map((r) => (
                        <button key={r} type="button" onClick={() => setForm({ ...form, relation: r })} className="min-h-11 rounded-lg border border-[var(--color-academy-line)] px-3 text-xs text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            {r}
                        </button>
                    ))}
                </span>
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">이름 (선택)</span>
                <input type="text" value={form.name} maxLength={40} placeholder="비우면 관계로 표시" onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${INPUT_CLASS} min-h-11`} />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">전화번호 *</span>
                <input type="tel" inputMode="tel" value={form.phone} placeholder="010-1234-5678" onChange={(e) => setForm({ ...form, phone: e.target.value })} className={`${INPUT_CLASS} min-h-11`} />
            </label>
            {editingId === "new" && guardians.length > 0 && (
                <label className="flex min-h-11 items-center gap-2 text-[13px] text-[var(--color-academy-muted)]">
                    <input type="checkbox" checked={form.makePrimary} onChange={(e) => setForm({ ...form, makePrimary: e.target.checked })} />
                    주 보호자로 지정
                </label>
            )}
            {error && <p role="alert" className="text-xs font-semibold text-[var(--color-academy-danger)]">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={closeForm} disabled={isPending} className="academy-button-secondary">닫기</button>
                <button type="submit" disabled={isPending} className="academy-button-primary">
                    <Icon name="save" size={15} /> {isPending ? "저장 중…" : "저장"}
                </button>
            </div>
        </form>
    );

    return (
        <div className={CARD_CLASS}>
            <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-extrabold text-[var(--color-academy-ink)]">
                    <span className="text-[var(--color-academy-ink)]"><Icon name="family_restroom" size={17} /></span>
                    보호자
                    {loaded && <span className="text-xs font-bold text-[var(--color-academy-faint)]">{guardians.length}명</span>}
                </h3>
                <button type="button" onClick={openAdd} disabled={isPending || !canAdd} title={canAdd ? undefined : `최대 ${MAX_GUARDIANS_PER_STUDENT}명`} className={`${SMALL_BTN} min-h-11 lg:min-h-8`}>
                    <Icon name="add" size={13} /> 추가
                </button>
            </div>

            {!loaded ? (
                <p className="py-3 text-center text-xs text-[var(--color-academy-faint)]">불러오는 중…</p>
            ) : (
                <ul className="divide-y divide-[var(--color-academy-line)]">
                    {guardians.map((g) => {
                        const isAccount = accountDigits !== "" && digits(g.phone) === accountDigits;
                        return (
                            // 한 줄: [관계] 이름 (주)(로그인) … 전화 ⚡
                            <li key={g.id} className="flex min-h-11 items-center gap-2 py-1">
                                <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[13px] font-bold text-[var(--color-academy-ink)]">
                                    <span className="rounded-md bg-[var(--color-academy-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-muted)]">{g.relation}</span>
                                    {g.name && g.name !== g.relation && <span className="truncate">{g.name}</span>}
                                    {g.isPrimary && <span className="rounded px-1 text-xs font-bold text-[var(--color-academy-success)] ring-1 ring-[var(--color-academy-line)]">주</span>}
                                    {isAccount && (
                                        <span title="로그인 계정 전화와 같은 번호예요(로그인·알림톡 번호)" className="rounded px-1 text-xs font-bold text-[var(--color-academy-muted)] ring-1 ring-[var(--color-academy-line)]">로그인</span>
                                    )}
                                </p>
                                {g.phone ? (
                                    <a href={`tel:${g.phone.replace(/[^0-9]/g, "")}`} className="shrink-0 text-[13px] text-[var(--color-academy-ink)] hover:underline">
                                        {formatGuardianPhone(g.phone)}
                                    </a>
                                ) : (
                                    <span className="shrink-0 text-xs text-[var(--color-academy-faint)]">번호 없음</span>
                                )}
                                {/* 수정·주 보호자 지정·삭제는 ⚡ 메뉴(반 줄과 같은 부품 — 삭제는 맨 아래 구분선 밑) */}
                                <AdminQuickActionMenu
                                    label={`${g.relation} 보호자 작업`}
                                    actions={[
                                        { key: "edit", label: "수정", icon: "edit", disabled: isPending, onSelect: () => openEdit(g) },
                                        ...(g.isPrimary ? [] : [{ key: "primary", label: "주 보호자로", icon: "star", disabled: isPending, onSelect: () => makePrimary(g) }]),
                                        { key: "delete", label: "삭제", icon: "delete", tone: "danger" as const, disabled: isPending, onSelect: () => remove(g) },
                                    ]}
                                />
                            </li>
                        );
                    })}
                    {/* 로그인 계정 번호가 어느 보호자와도 다르면 한 줄로 따로 — 여기서는 안 바뀐다(«연락처 · 프로필» 연필에서 수정) */}
                    {accountDigits !== "" && !accountMatchesGuardian && (
                        <li className="flex min-h-11 items-center gap-2 py-1">
                            <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[13px] font-bold text-[var(--color-academy-ink)]">
                                <span className="rounded-md bg-[var(--color-academy-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-muted)]">로그인 계정</span>
                                {accountName && <span className="truncate">{accountName}</span>}
                                <span
                                    title="로그인 계정 전화는 여기서 바뀌지 않습니다 — «연락처 · 프로필»에서 수정"
                                    aria-label="로그인 계정 전화는 여기서 바뀌지 않습니다. 연락처 · 프로필에서 수정"
                                    role="img"
                                    className="inline-flex cursor-help text-[var(--color-academy-faint)]"
                                >
                                    <Icon name="info" size={14} />
                                </span>
                            </p>
                            <a href={`tel:${accountDigits}`} className="shrink-0 text-[13px] text-[var(--color-academy-ink)] hover:underline">
                                {formatGuardianPhone(accountPhone ?? "")}
                            </a>
                        </li>
                    )}
                    {guardians.length === 0 && accountDigits === "" && (
                        <li className="py-3 text-center text-sm text-[var(--color-academy-faint)]">등록된 보호자가 없습니다.</li>
                    )}
                </ul>
            )}

            {/* 창 밖 결과 안내(창을 닫은 뒤 «추가했습니다» 등). 입력 오류는 창 안에 */}
            {error && !editingId && <p className="mt-2 text-xs font-semibold text-[var(--color-academy-danger)]">{error}</p>}
            {message && !error && <p role="status" className="mt-2 text-xs font-medium text-[var(--color-academy-success)]">{message}</p>}

            {/* 추가·수정 입력 창 */}
            {editingId && (editingId === "new" || editingGuardian) && (
                <AdminModal titleId="guardian-form-title" panelClassName="max-w-md" onClose={() => { if (!isPending) closeForm(); }} closeOnBackdrop={!isPending}>
                    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-academy-line)] px-5 py-3">
                        <h2 id="guardian-form-title" className="text-base font-extrabold text-[var(--color-academy-ink)]">
                            {editingId === "new" ? "보호자 추가" : `보호자 수정 — ${editingGuardian?.relation ?? ""}`}
                        </h2>
                        <button type="button" onClick={closeForm} disabled={isPending} aria-label="닫기" className="grid h-11 w-11 place-items-center rounded-xl text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <Icon name="close" size={20} />
                        </button>
                    </div>
                    {formView}
                </AdminModal>
            )}
        </div>
    );
}
