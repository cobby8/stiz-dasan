/**
 * 공지사항 본문/첨부 렌더링 유틸
 *
 * - toNoticeHtml: 순수 텍스트 공지 본문을 "안전한 HTML"로 변환한다.
 *   · 모든 텍스트를 HTML 이스케이프하여 XSS를 차단
 *   · http(s):// 또는 www. 로 시작하는 URL을 클릭 가능한 <a> 링크로 변환
 *   · 줄바꿈은 렌더링 쪽의 `whitespace-pre-wrap` CSS로 그대로 유지
 *   · 출력은 이 함수 안에서 이미 완전히 이스케이프되므로 별도 sanitize 불필요
 * - isImageAttachment: 첨부가 이미지인지 판별 (본문 아래 인라인 노출용)
 *
 * 업로드 API(`/api/upload`)는 이미지 타입만 허용하므로 대부분의 첨부는 이미지다.
 * 다만 과거 데이터/예외를 대비해 확장자로 방어적으로 판별한다.
 */

export type NoticeAttachment = { url: string; filename: string; size?: number };

/** 첨부파일이 이미지인지 판별 (url 또는 filename의 확장자 기준) */
export function isImageAttachment(a: { url?: string; filename?: string } | null | undefined): boolean {
    if (!a) return false;
    const s = `${a.url || ""} ${a.filename || ""}`;
    return /\.(jpe?g|png|webp|gif|bmp|svg|avif)(\?|#|$)/i.test(s);
}

/** HTML 특수문자 이스케이프 — 사용자 텍스트가 태그로 해석되지 않도록 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * 순수 텍스트 공지 본문 → 안전한 HTML (URL 자동 링크 포함)
 * 렌더링 시 반드시 `whitespace-pre-wrap` 컨테이너에 dangerouslySetInnerHTML로 넣어
 * 줄바꿈이 유지되도록 한다.
 */
export function toNoticeHtml(text: string | null | undefined): string {
    if (!text) return "";
    // http(s):// 또는 www. 로 시작하고 공백/꺾쇠 전까지
    const urlRe = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) {
        // URL 이전 일반 텍스트
        out += escapeHtml(text.slice(last, m.index));

        let url = m[0];
        let trail = "";
        // 문장 끝 구두점은 링크에서 제외 (예: "사이트: https://a.com." → 마침표 제외)
        const tp = url.match(/[),.!?;:]+$/);
        if (tp) {
            trail = tp[0];
            url = url.slice(0, -trail.length);
        }
        const href = url.startsWith("www.") ? `https://${url}` : url;
        out +=
            // data-outside-link: 스토어 앱에서는 바깥 주소를 «복사 + 안내»로 바꾼다(d2, @/lib/outsideLink)
            `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-outside-link ` +
            `class="text-brand-orange-600 dark:text-brand-neon-lime underline underline-offset-2 break-all hover:opacity-80">` +
            `${escapeHtml(url)}</a>`;
        out += escapeHtml(trail);
        last = m.index + m[0].length;
    }
    // 마지막 URL 이후 남은 텍스트
    out += escapeHtml(text.slice(last));

    // 이 함수는 모든 사용자 텍스트를 escapeHtml로 이스케이프하고,
    // 화이트리스트 <a> 태그(href/표시문구 모두 escape)만 직접 삽입하므로
    // 출력이 이미 안전하다. (별도 sanitize 라이브러리 불필요 → jsdom 의존 제거)
    return out;
}

/**
 * 순수 텍스트에 URL이 포함돼 있는지 (목록 미리보기에서 "링크 포함" 표시 등 용도)
 */
export function hasUrl(text: string | null | undefined): boolean {
    if (!text) return false;
    return /(https?:\/\/|www\.)\S+/i.test(text);
}

/**
 * content가 리치 에디터(HTML)로 저장된 새 공지인지, 옛 순수 텍스트 공지인지 판별한다.
 * - 블록/인라인 HTML 태그가 하나라도 있으면 HTML로 간주 → 상세 페이지에서 sanitizeHtml 경로로 렌더.
 * - 태그가 전혀 없으면 옛 순수 텍스트 공지 → 기존 toNoticeHtml 경로(줄바꿈 유지 + URL 자동 링크).
 * ⚠️ 오탐(순수 텍스트를 HTML로 판정)이 나더라도, HTML 경로는 반드시 sanitizeHtml을 거치므로 무해하다.
 *    안전을 위해 "태그가 보이면 HTML" 쪽으로 넓게 판별한다.
 */
export function isHtmlContent(content: string | null | undefined): boolean {
    if (!content) return false;
    // 리치 에디터가 만들어내는 대표 여는 태그를 하나라도 포함하면 HTML로 본다.
    return /<(?:p|div|br|img|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|blockquote|iframe|figure|hr|strong|em|u|s|del|ins|mark|sub|sup|pre|code|span|a|colgroup|col)\b[^>]*>/i.test(
        content,
    );
}

/**
 * 목록 미리보기용: 공지 본문에서 HTML 태그를 제거해 "순수 텍스트"만 남긴다.
 * - 6단계에서 새 공지 본문이 HTML(<p>...</p><ul>...)로 저장되면서, 목록 미리보기가
 *   그 원문을 그대로 출력해 raw 태그 문자열이 사용자에게 노출되는 회귀를 막는다.
 * - 옛 순수 텍스트 공지(태그 없음)는 태그 제거의 영향을 받지 않고 원문이 그대로 유지된다(하위호환).
 * - 상세 렌더가 아니라 미리보기 전용이다. (line-clamp/글자수 제한 등 기존 자르기 로직은 호출부에서 유지)
 */
export function stripHtmlForPreview(content: string | null | undefined): string {
    if (!content) return "";
    // 옛 순수 텍스트 공지는 태그가 없으므로 태그 제거를 건너뛴다.
    // (예: "3 < 5" 같은 부등호가 <...>로 오인돼 지워지는 손실 방지 → 원문 그대로 유지)
    if (!isHtmlContent(content)) {
        // plain 공지의 줄바꿈만 한 칸으로 정리해 한 줄 미리보기로 만든다(엔티티 디코드는 불필요 — 순수 텍스트라 원문 그대로).
        return content.replace(/\s+/g, " ").trim();
    }
    return (
        content
            // 1) 모든 HTML 태그 제거 → 자리에 공백을 넣어 단어가 붙지 않게 한다(예: "<p>가</p><p>나</p>" → "가 나")
            .replace(/<[^>]*>/g, " ")
            // 2) 자주 쓰는 HTML 엔티티만 최소한으로 디코드(태그 제거로 남은 &amp; 등을 원문자로)
            .replace(/&nbsp;/gi, " ")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, "&") // &amp;는 다른 엔티티 복원 이후 마지막에 처리(이중 이스케이프 방지)
            // 3) 태그 제거로 생긴 연속 공백/줄바꿈을 한 칸으로 정리하고 양끝 공백 제거
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * 옛 순수 텍스트 공지를 리치 에디터의 초기값(HTML)으로 변환한다.
 * - 수정 화면에서 옛 공지를 열 때, 줄바꿈이 사라지지 않도록 각 줄을 <br>로 이어 붙인다.
 *   (에디터가 문자열을 HTML로 파싱하면 \n 같은 공백을 접어버려 줄바꿈이 사라지기 때문)
 * - 사용자가 입력했던 <, > 등은 escapeHtml로 이스케이프해 태그로 오해되지 않게 한다.
 */
export function plainToEditorHtml(text: string | null | undefined): string {
    if (!text) return "";
    // 각 줄을 이스케이프한 뒤 <br>로 이어 하나의 문단으로 감싼다(기존 whitespace-pre-wrap 표시와 동일한 줄바꿈).
    const lines = text.split(/\r?\n/).map(escapeHtml);
    return `<p>${lines.join("<br>")}</p>`;
}
