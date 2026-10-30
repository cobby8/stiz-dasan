"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useState, type FormEvent } from "react";
import { createClass, updateClass } from "@/app/actions/admin";
import type { ClassItem, Program } from "./ClassManagementClient";

const DAYS = [
    { value: "Mon", label: "월요일" },
    { value: "Tue", label: "화요일" },
    { value: "Wed", label: "수요일" },
    { value: "Thu", label: "목요일" },
    { value: "Fri", label: "금요일" },
    { value: "Sat", label: "토요일" },
    { value: "Sun", label: "일요일" },
] as const;

export default function ClassFormPanel({
    programs,
    classItem,
    onClose,
    onSaved,
}: {
    programs: Program[];
    classItem: ClassItem | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [programId, setProgramId] = useState(classItem?.programId || "");
    const [name, setName] = useState(classItem?.name || "");
    const [dayOfWeek, setDayOfWeek] = useState(classItem?.dayOfWeek || "");
    const [startTime, setStartTime] = useState(classItem?.startTime || "");
    const [endTime, setEndTime] = useState(classItem?.endTime || "");
    const [location, setLocation] = useState(classItem?.location || "");
    const [capacity, setCapacity] = useState(classItem?.capacity || 10);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        if (!programId || !name.trim() || !dayOfWeek) return;
        setBusy(true);
        try {
            const payload = {
                programId,
                name: name.trim(),
                dayOfWeek,
                startTime,
                endTime,
                location: location.trim() || undefined,
                capacity,
            };
            if (classItem) await updateClass(classItem.id, payload);
            else await createClass(payload);
            onSaved();
        } catch (error) {
            alert(adminErrorText(error, "저장 실패"));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 shadow-sm space-y-4">
            <h3 className="font-bold text-lg text-gray-900 dark:text-white">{classItem ? "반 수정" : "새 반 개설"}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">소속 프로그램 *</label>
                    <select
                        value={programId}
                        onChange={(e) => setProgramId(e.target.value)}
                        required
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime bg-white dark:bg-gray-800"
                    >
                        <option value="">선택하세요</option>
                        {programs.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">반 이름 *</label>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        placeholder="예: 초등 저학년 A반"
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">요일 *</label>
                    <select
                        value={dayOfWeek}
                        onChange={(e) => setDayOfWeek(e.target.value)}
                        required
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime bg-white dark:bg-gray-800"
                    >
                        <option value="">선택하세요</option>
                        {DAYS.map((d) => (
                            <option key={d.value} value={d.value}>{d.label}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">시작 시간</label>
                    <input
                        type="time"
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">종료 시간</label>
                    <input
                        type="time"
                        value={endTime}
                        onChange={(e) => setEndTime(e.target.value)}
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">정원 (명) *</label>
                    <input
                        type="number"
                        value={capacity}
                        onChange={(e) => setCapacity(parseInt(e.target.value) || 0)}
                        required
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime"
                    />
                </div>
                <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">장소(코트)</label>
                    <input
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        placeholder="예: A코트, 메인구장"
                        className="w-full border border-gray-300 rounded-md p-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime"
                    />
                </div>
                <div className="flex items-end justify-end">
                    <div className="flex gap-2">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-white dark:hover:text-white">
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            className="bg-brand-navy-900 text-white px-4 py-2 rounded-md font-bold hover:bg-gray-800 transition shadow-sm disabled:opacity-50"
                        >
                            {busy ? "저장 중..." : classItem ? "수정" : "개설하기"}
                        </button>
                    </div>
                </div>
            </div>
        </form>
    );
}
