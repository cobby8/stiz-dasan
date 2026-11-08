import type { Metadata } from "next";
import { buildPublicMetadata, PUBLIC_SITE_NAME } from "@/lib/publicMetadata";
import { stripHtmlForPreview } from "@/lib/noticeContent";

// 공지 상세(/notices/[id]) 검색용 메타.
// 왜 필요한가: 상세 페이지가 루트 레이아웃의 메타(홈 제목·홈 canonical)를 그대로 물려받아,
// 검색엔진이 모든 공지를 «홈과 같은 페이지»로 보고 중복 처리했다.
// 공지마다 자기 제목·요약·주소를 달아 각각 따로 검색되게 한다.
// ⚠️ 순수 함수 — DB·next 런타임 의존 없음(테스트가 직접 실행한다).

/** 검색 결과에 보이는 설명 길이(한글 기준 대략 2줄) */
export const NOTICE_DESCRIPTION_MAX = 120;

const FALLBACK_DESCRIPTION = `${PUBLIC_SITE_NAME}의 공지사항입니다.`;

type NoticeForMetadata = { id: string; title?: string | null; content?: string | null; targetType?: string | null };

/** 본문(HTML 또는 옛 순수 텍스트)에서 태그를 빼고 앞부분만 잘라 설명으로 만든다. */
export function noticeDescription(content: string | null | undefined): string {
  // <script>·<style> 블록은 태그만 지우면 안의 코드 글자가 남으므로 먼저 통째로 뺀다(목록 미리보기 함수는 그대로 둔다).
  const withoutBlocks = (content ?? "").replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const plain = stripHtmlForPreview(withoutBlocks);
  if (!plain) return FALLBACK_DESCRIPTION;
  if (plain.length <= NOTICE_DESCRIPTION_MAX) return plain;
  // 잘린 표시(…)를 붙여 문장이 중간에 끊긴 걸 알 수 있게 한다.
  return `${plain.slice(0, NOTICE_DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/** 공지 상세 메타 — 공지가 없으면 검색에 안 잡히게(noindex) 한다. */
export function buildNoticeMetadata(notice: NoticeForMetadata | null | undefined): Metadata {
  if (!notice) {
    return {
      title: `공지를 찾을 수 없습니다 | ${PUBLIC_SITE_NAME}`,
      robots: { index: false, follow: true },
    };
  }

  const title = `${(notice.title ?? "").trim() || "공지사항"} | ${PUBLIC_SITE_NAME}`;
  const description = noticeDescription(notice.content);
  // 사이트 주소·OG 이미지·metadataBase 는 공용 헬퍼(buildPublicMetadata)를 그대로 쓴다.
  const base = buildPublicMetadata({
    title,
    description,
    path: `/notices/${encodeURIComponent(notice.id)}`,
  });

  // 특정 반에만 보낸 공지는 검색에 올리지 않는다(주소를 아는 사람만 보는 안내).
  const classOnly = Boolean(notice.targetType && notice.targetType !== "ALL");

  return {
    ...base,
    ...(classOnly ? { robots: { index: false, follow: true } } : {}),
    // 공지는 «글»이므로 OG 종류만 article 로 바꾼다(나머지 OG 값은 공용 헬퍼 값 유지).
    openGraph: { ...base.openGraph, type: "article" },
  };
}
