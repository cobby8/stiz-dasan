"use client";

/**
 * 학생 상세 좌측 레일의 「보호자」 카드.
 * - 보호자 여러 명(엄마·할머니 등)의 관계·이름·전화를 보여주고 추가·수정·삭제·주 보호자 지정을 한다.
 * - 로그인 계정 전화(User.phone)는 읽기 전용으로만 보여준다 — 여기서 바꾸지 않는다(로그인·알림톡 대상).
 * - 저장은 Server Action(@/app/actions/guardians)이 하고, 응답으로 받은 최신 목록으로 카드만 갱신한다.
 */

import { useCallback, useEffect, useState, useTransition, type FormEvent } from "react";
import {
    addStudentGuardian,
    deleteStudentGuardian,
    listStudentGuardians,
    setPrimaryGuardian,
    updateStudentGuardian,
    type StudentGuardian,
} from "@/app/actions/guardians";
import {
    canAddGuardian,
    deleteConfirmMessage,
    formatGuardianPhone,
    MAX_GUARDIANS_PER_STUDENT,
} from "@/lib/guardians/guardianLogic";

const CARD_CLASS = "rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-800";
const INPUT_CLASS = "w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:focus:ring-brand-neon-lime";
const SMALL_BTN = "inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-bold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700";

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
}: {
    studentId: string;
    // 로그인 계정(Student.parentId → User) 전화 — 읽기 전용 표시용
    accountPhone: string | null;
}) {
    const [guardians, setGuardians] = useState<StudentGuardian[]>([]);
    const [loaded, setLoaded] = useState(false);
    // editingId: null = 폼 닫힘 / "new" = 추가 폼 / 그 외 = 해당 보호자 수정 폼
    const [editingId, setEditingId] = useState<string | null>(null);
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
    function run(action: () => Promise<StudentGuardian[]>, successMessage: string, afterSuccess?: () => void) {
        setError(null);
        setMessage(null);
        startTransition(async () => {
            try {
                const list = await action();
                setGuardians(list);
                setMessage(successMessage);
                afterSuccess?.();
            } catch (e) {
                setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
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

    // 추가·수정 공용 폼
    const formView = (
        <form onSubmit={submitForm} className="space-y-2 rounded-xl border border-brand-orange-200 bg-orange-50/40 p-3 dark:border-brand-neon-lime/30 dark:bg-gray-900/40">
            <p className="text-[12px] font-bold text-gray-800 dark:text-gray-100">{editingId === "new" ? "보호자 추가" : "보호자 수정"}</p>
            <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-gray-400">관계 *</span>
                <input type="text" value={form.relation} maxLength={20} placeholder="예: 모, 조모" onChange={(e) => setForm({ ...form, relation: e.target.value })} className={INPUT_CLASS} />
                <span className="mt-1 flex flex-wrap gap-1">
                    {RELATION_PRESETS.map((r) => (
                        <button key={r} type="button" onClick={() => setForm({ ...form, relation: r })} className="rounded-md border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-white dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
                            {r}
                        </button>
                    ))}
                </span>
            </label>
            <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-gray-400">이름 (선택)</span>
                <input type="text" value={form.name} maxLength={40} placeholder="비우면 관계로 표시" onChange={(e) => setForm({ ...form, name: e.target.value })} className={INPUT_CLASS} />
            </label>
            <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-gray-400">전화번호 *</span>
                <input type="tel" inputMode="tel" value={form.phone} placeholder="010-1234-5678" onChange={(e) => setForm({ ...form, phone: e.target.value })} className={INPUT_CLASS} />
            </label>
            {editingId === "new" && guardians.length > 0 && (
                <label className="flex items-center gap-2 text-[12px] text-gray-700 dark:text-gray-200">
                    <input type="checkbox" checked={form.makePrimary} onChange={(e) => setForm({ ...form, makePrimary: e.target.checked })} />
                    주 보호자로 지정
                </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={closeForm} disabled={isPending} className={SMALL_BTN}>취소</button>
                <button type="submit" disabled={isPending} className="inline-flex items-center gap-1 rounded-lg bg-brand-orange-500 px-3 py-1 text-[11px] font-bold text-white transition hover:bg-orange-600 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-200">
                    <Icon name="save" size={13} /> {isPending ? "저장 중…" : "저장"}
                </button>
            </div>
        </form>
    );

    return (
        <div className={CARD_CLASS}>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-extrabold text-gray-900 dark:text-white">
                    <span className="text-brand-orange-500 dark:text-brand-neon-lime"><Icon name="family_restroom" size={17} /></span>
                    보호자
                    {loaded && <span className="text-[11px] font-bold text-gray-400">{guardians.length}명</span>}
                </h3>
                {editingId === null && (
                    <button type="button" onClick={openAdd} disabled={isPending || !canAdd} title={canAdd ? undefined : `최대 ${MAX_GUARDIANS_PER_STUDENT}명`} className={SMALL_BTN}>
                        <Icon name="add" size={13} /> 보호자 추가
                    </button>
                )}
            </div>

            {/* 로그인 계정 전화 — 주 보호자와 다를 수 있어 혼동 방지용으로 읽기 전용 표시 */}
            <p className="mb-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                로그인 계정 전화: <span className="font-bold text-gray-700 dark:text-gray-200">{accountPhone ? formatGuardianPhone(accountPhone) : "없음"}</span>
                <span className="block text-[10px] text-gray-400">계정 전화는 여기서 바뀌지 않습니다(「연락처 · 프로필」에서 수정).</span>
            </p>

            {!loaded ? (
                <p className="py-3 text-center text-xs text-gray-400">불러오는 중…</p>
            ) : guardians.length === 0 && editingId !== "new" ? (
                <div className="rounded-xl border border-dashed border-gray-200 px-4 py-5 text-center text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
                    등록된 보호자가 없습니다.
                </div>
            ) : (
                <ul className="space-y-2">
                    {guardians.map((g) => (
                        <li key={g.id}>
                            {editingId === g.id ? formView : (
                                <div className="rounded-xl border border-gray-100 p-3 dark:border-gray-700">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold text-gray-900 dark:text-gray-100">
                                                <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-200">{g.relation}</span>
                                                {g.name && g.name !== g.relation && <span>{g.name}</span>}
                                                {g.isPrimary && (
                                                    <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200 dark:text-emerald-100 dark:ring-emerald-300/20">주 보호자</span>
                                                )}
                                            </p>
                                            {g.phone ? (
                                                <a href={`tel:${g.phone.replace(/[^0-9]/g, "")}`} className="mt-0.5 inline-block text-[13px] text-brand-orange-600 hover:underline dark:text-brand-neon-lime">
                                                    {formatGuardianPhone(g.phone)}
                                                </a>
                                            ) : (
                                                <p className="mt-0.5 text-[12px] text-gray-400">전화번호 없음</p>
                                            )}
                                        </div>
                                    </div>
                                    {editingId === null && (
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            <button type="button" onClick={() => openEdit(g)} disabled={isPending} className={SMALL_BTN}>
                                                <Icon name="edit" size={13} /> 수정
                                            </button>
                                            {!g.isPrimary && (
                                                <button type="button" onClick={() => makePrimary(g)} disabled={isPending} className={SMALL_BTN}>
                                                    <Icon name="star" size={13} /> 주 보호자로 지정
                                                </button>
                                            )}
                                            <button type="button" onClick={() => remove(g)} disabled={isPending} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-[11px] font-bold text-red-700 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950">
                                                <Icon name="delete" size={13} /> 삭제
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {editingId === "new" && <div className="mt-2">{formView}</div>}

            {error && <p className="mt-2 text-[11px] font-semibold text-red-600 dark:text-red-400">{error}</p>}
            {message && !error && <p role="status" className="mt-2 text-[11px] font-medium text-green-600 dark:text-lime-200">{message}</p>}
        </div>
    );
}
