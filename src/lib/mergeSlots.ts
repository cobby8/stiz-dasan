/**
 * MergedSlot 조합 로직 공통 함수
 *
 * schedule/page.tsx와 simulator/page.tsx에서 완전히 동일한 로직이 중복되어 있어서
 * 유지보수성을 위해 하나의 함수로 추출함.
 *
 * Google Sheets 슬롯 + 관리자 오버라이드 + 커스텀 슬롯을 병합하여
 * 최종 MergedSlot 배열을 반환한다.
 */

import type { SheetClassSlot } from "@/lib/googleSheetsSchedule";
import type { MergedSlot, PublicScheduleSlot } from "@/app/schedule/ScheduleClient";
import { seatLevelFromCounts } from "@/lib/seats/seatLevel";

// 요일 키(Mon, Tue...) → 한글 라벨 변환 (커스텀 슬롯에서 사용)
export const DAY_KEY_TO_LABEL: Record<string, string> = {
    Mon: "월요일", Tue: "화요일", Wed: "수요일", Thu: "목요일",
    Fri: "금요일", Sat: "토요일", Sun: "일요일",
};

/**
 * 시트 슬롯 + 오버라이드 + 커스텀 슬롯을 병합하여 MergedSlot[] 반환
 *
 * @param rawSlots - Google Sheets에서 파싱된 원본 슬롯
 * @param overridesList - 관리자가 수정한 오버라이드 목록
 * @param customSlotsList - 관리자가 직접 추가한 커스텀 슬롯 목록
 */
export function buildMergedSlots(
    rawSlots: SheetClassSlot[],
    overridesList: any[],
    customSlotsList: any[],
): MergedSlot[] {
    // 오버라이드를 slotKey 기준으로 빠르게 찾기 위한 맵
    const overrideMap = Object.fromEntries(
        overridesList.map((o: any) => [o.slotKey, o])
    );

    // Google Sheets 슬롯과 오버라이드를 병합 (숨김 처리된 슬롯은 제외)
    const sheetMerged: MergedSlot[] = rawSlots
        .filter((s: SheetClassSlot) => !(overrideMap[s.slotKey]?.isHidden))
        .map((s: SheetClassSlot) => {
            const ov = overrideMap[s.slotKey];
            const capacity: number = ov?.capacity ?? 12;
            return {
                slotKey: s.slotKey,
                dayKey: s.dayKey,
                dayLabel: s.dayLabel,
                startTime: ov?.startTimeOverride || s.startTime,
                endTime: ov?.endTimeOverride || s.endTime,
                gradeRange: s.gradeRange,
                enrolled: s.enrolled,
                displayLabel: ov?.label || `${s.dayLabel} ${s.period}교시`,
                note: ov?.note || null,
                capacity,
                isFull: s.enrolled >= capacity,
                coach: ov?.coach ?? null,
                programId: ov?.programId ?? null,
            };
        });

    // 관리자가 직접 추가한 커스텀 슬롯 병합 (숨김 제외)
    const customMerged: MergedSlot[] = (customSlotsList as any[])
        .filter((cs) => !cs.isHidden)
        .map((cs) => ({
            slotKey: `custom-${cs.id}`,
            dayKey: cs.dayKey,
            dayLabel: DAY_KEY_TO_LABEL[cs.dayKey] || cs.dayKey,
            startTime: cs.startTime,
            endTime: cs.endTime,
            gradeRange: cs.gradeRange || "",
            enrolled: cs.enrolled,
            displayLabel: cs.label,
            note: cs.note || null,
            capacity: cs.capacity,
            isFull: cs.enrolled >= cs.capacity,
            coach: cs.coach ?? null,
            programId: cs.programId ?? null,
        }));

    // 시트 슬롯 + 커스텀 슬롯을 하나의 배열로 합침
    return [...sheetMerged, ...customMerged];
}

/**
 * 공개 화면(시간표·수업 찾기)으로 넘길 슬롯 — 정원·등록 인원 숫자를 빼고 3단계(여유/임박/마감)만 남긴다.
 * 서버 컴포넌트에서 클라이언트로 넘기는 값은 페이지 응답(RSC 데이터)에 그대로 실리므로
 * 화면에 안 그려도 숫자가 새어 나간다 → 넘기기 전에 여기서 걸러 낸다(재원생 수 비공개 · 2026-11-13 f9).
 * 필드를 하나씩 골라 담는다(펼치기 ...rest 를 쓰면 나중에 MergedSlot 에 숫자 칸이 늘 때 같이 새어 나간다).
 */
export function toPublicScheduleSlots(slots: MergedSlot[]): PublicScheduleSlot[] {
    return slots.map((slot) => {
        const level = seatLevelFromCounts(slot.capacity, slot.enrolled);
        return {
            slotKey: slot.slotKey,
            dayKey: slot.dayKey,
            dayLabel: slot.dayLabel,
            startTime: slot.startTime,
            endTime: slot.endTime,
            gradeRange: slot.gradeRange,
            displayLabel: slot.displayLabel,
            note: slot.note,
            isFull: level === "FULL",
            seatLevel: level,
            coach: slot.coach ? { name: slot.coach.name, role: slot.coach.role, imageUrl: slot.coach.imageUrl } : null,
            programId: slot.programId,
        };
    });
}
