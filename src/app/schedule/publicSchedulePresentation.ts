/** Only clearly visitor-facing notices may be shown; operational notes stay unchanged in storage. */
export function publicScheduleNotice(note: string | null | undefined): string | null {
    const text = note?.trim();
    if (!text || text.length > 240) return null;
    if (/운영자|확정\]|Program|기본가|적용대상|내부|관리자|DB|override|migration|payload|\[\d{4}-\d{2}-\d{2}/i.test(text)) return null;
    return /준비물|실내화|운동복|휴강|장소 변경|수업 장소|체험 가능|신청 가능|모집 중|대기 접수|상담 문의/.test(text) ? text : null;
}

/** Project visitor props before serialization; never mutate source records used by staff. */
export function publicScheduleSlots<T extends { note?: string | null }>(slots: readonly T[]): T[] {
    return slots.map((slot) => ({ ...slot, note: publicScheduleNotice(slot.note) }));
}
