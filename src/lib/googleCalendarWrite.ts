/**
 * 구글 캘린더 쓰기 모듈 (Service Account 인증)
 *
 * 기존 googleCalendar.ts는 "읽기 전용" (API Key / ICS)이고,
 * 이 파일은 "쓰기 전용" (Service Account)으로 분리한다.
 *
 * 환경변수:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Service Account JSON 전체를 문자열로 저장
 *   GOOGLE_CALENDAR_ID — 쓰기 대상 캘린더 ID (예: xxxx@group.calendar.google.com)
 *
 * 두 환경변수 중 하나라도 없으면 모든 함수가 조용히 건너뛴다 (DB만 저장).
 */

import { google } from "googleapis";
import { parseGoogleServiceAccount } from "@/lib/googleServiceAccount";

// ── 인증 헬퍼 ───────────────────────────────────────────────────────────────

/** Service Account 인증 객체를 생성하여 반환 (환경변수 없으면 null) */
function getCalendarClient() {
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const calendarId = process.env.GOOGLE_CALENDAR_ID;

    // 환경변수가 없으면 구글 동기화 건너뛰기
    if (!keyJson || !calendarId) {
        return null;
    }

    try {
        const credentials = parseGoogleServiceAccount(keyJson);

        // Service Account JWT 인증 — 캘린더 쓰기 권한 스코프
        const auth = new google.auth.JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ["https://www.googleapis.com/auth/calendar"],
        });

        const calendar = google.calendar({ version: "v3", auth });
        return { calendar, calendarId };
    } catch (e) {
        console.error("[googleCalendarWrite] Service Account 인증 실패:", e);
        return null;
    }
}

// ── 날짜 포맷 헬퍼 ──────────────────────────────────────────────────────────

/**
 * DB의 날짜 문자열(YYYY-MM-DD 또는 ISO)을 구글 캘린더 종일 이벤트 형식으로 변환
 * 구글 종일 이벤트는 { date: "YYYY-MM-DD" } 형식을 사용한다.
 */
function toGoogleDate(dateStr: string): string {
    // ISO 문자열이든 YYYY-MM-DD든 앞 10자리만 추출
    return dateStr.slice(0, 10);
}

/**
 * 종일 이벤트의 endDate를 구글 형식으로 변환
 * 구글 캘린더에서 종일 이벤트의 end.date는 exclusive (다음날)이므로 +1일 처리
 */
function toGoogleEndDate(dateStr: string): string {
    const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1); // exclusive end → 다음날
    return d.toISOString().slice(0, 10);
}

// ── 공개 함수 3개 ────────────────────────────────────────────────────────────

/**
 * 구글 캘린더에 이벤트 생성
 * @returns 생성된 구글 이벤트 ID (실패 또는 미설정 시 null)
 */
export async function createCalendarEvent(event: {
    title: string;
    date: string;
    endDate?: string | null;
    description?: string | null;
}): Promise<string | null> {
    const client = getCalendarClient();
    if (!client) {
        // 환경변수 미설정 — 구글 동기화 건너뛰기 (정상 동작)
        console.warn("[googleCalendarWrite] 환경변수 미설정, 구글 동기화 건너뜀");
        return null;
    }

    try {
        // 종일 이벤트로 생성 (시간 지정 없이 date만 사용)
        const endDate = event.endDate || event.date; // 종료일 없으면 시작일과 동일
        const res = await client.calendar.events.insert({
            calendarId: client.calendarId,
            requestBody: {
                summary: event.title,
                description: event.description || undefined,
                start: { date: toGoogleDate(event.date) },
                end: { date: toGoogleEndDate(endDate) }, // exclusive end
            },
        });

        const googleEventId = res.data.id || null;
        console.log("[googleCalendarWrite] 이벤트 생성 성공:", googleEventId);
        return googleEventId;
    } catch (e) {
        // 구글 API 실패해도 DB는 정상 진행 (best-effort)
        console.error("[googleCalendarWrite] 이벤트 생성 실패:", e);
        return null;
    }
}

/**
 * 구글 캘린더 이벤트 수정
 * googleEventId가 없거나 실패하면 조용히 건너뛴다
 */
export async function updateCalendarEvent(
    googleEventId: string,
    event: {
        title: string;
        date: string;
        endDate?: string | null;
        description?: string | null;
    },
): Promise<void> {
    const client = getCalendarClient();
    if (!client) return;

    try {
        const endDate = event.endDate || event.date;
        await client.calendar.events.update({
            calendarId: client.calendarId,
            eventId: googleEventId,
            requestBody: {
                summary: event.title,
                description: event.description || undefined,
                start: { date: toGoogleDate(event.date) },
                end: { date: toGoogleEndDate(endDate) },
            },
        });
        console.log("[googleCalendarWrite] 이벤트 수정 성공:", googleEventId);
    } catch (e) {
        // 실패해도 DB 수정은 이미 완료됨
        console.error("[googleCalendarWrite] 이벤트 수정 실패:", e);
    }
}

/**
 * 구글 캘린더 이벤트 삭제
 * googleEventId가 없거나 실패하면 조용히 건너뛴다
 */
export async function deleteCalendarEvent(
    googleEventId: string,
): Promise<void> {
    const client = getCalendarClient();
    if (!client) return;

    try {
        await client.calendar.events.delete({
            calendarId: client.calendarId,
            eventId: googleEventId,
        });
        console.log("[googleCalendarWrite] 이벤트 삭제 성공:", googleEventId);
    } catch (e) {
        // 실패해도 DB 삭제는 이미 완료됨
        console.error("[googleCalendarWrite] 이벤트 삭제 실패:", e);
    }
}
