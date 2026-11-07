import { prisma } from "@/lib/prisma";
import { buildKakaoSkillResponse, KAKAO_TEXT_CARD_DESCRIPTION_MAX, type KakaoQuickReply } from "@/lib/kakao-chatbot-contract";
import { addDaysKst, isKstYmd } from "@/lib/datetime/kst";

// ── 카카오 대화 흐름(결석·셔틀) 공용 상태 저장소 ─────────────────────────────
//
// 왜 따로 두나: 결석 대화·셔틀 대화가 보강 대화(kakao-makeup-flow)와 똑같은 방식으로 상태를 들고 다닌다.
// 같은 SQL 을 파일마다 복사하면 한쪽만 고쳐지는 사고가 나므로 한 곳에 모았다.
//
// 저장 위치: 기존 접수 원장 KakaoParentIntake 한 행(status = 흐름 이름). 스키마 변경 없음(status 는 자유 TEXT).
//   - 마지막 갱신 후 30분이 지나면 무시된다(만료).
//   - 끝나면 'APPLIED'(관리자 화면 「자동 반영 완료」), 그만두면 'CANCELED'.
//   - 새 흐름을 열 때는 같은 연결의 작성 중 접수 초안과 «모든» 대화 흐름을 닫는다(동시에 두 흐름이 살아 있으면
//     「네」 한 마디가 엉뚱한 흐름을 확정한다).

/** 대화 흐름 상태 이름 전체 — 새 흐름을 열 때 이 목록을 모두 닫는다(보강 흐름도 같은 목록을 쓴다). */
export const KAKAO_FLOW_STATUSES = ["MAKEUP_FLOW", "ABSENCE_FLOW", "SHUTTLE_FLOW"] as const;
export type KakaoFlowStatus = (typeof KAKAO_FLOW_STATUSES)[number];
/** 새 흐름을 열 때 닫는 상태(SQL IN 목록). 코드에 적힌 값만 들어가므로 문자열로 이어 붙여도 안전하다. */
export const KAKAO_OPEN_FLOW_CLOSE_SQL = ["DRAFT", "NEEDS_DETAILS", ...KAKAO_FLOW_STATUSES].map((s) => `'${s}'`).join(",");
export const KAKAO_FLOW_TTL_MINUTES = 30;

export type Reply = ReturnType<typeof buildKakaoSkillResponse>;
export type WebLink = { label: string; url: string };
export type FlowChild = { id: string; name: string };

/** 모든 흐름 상태가 가지는 공통 칸 */
export type BaseFlowState = { v: 1; parentUserId: string; step: string; studentId: string | null };
export type FlowRow<S> = { id: string; state: S };

/** 버튼이 있으면 textCard(400자), 넘치면 버튼을 떼고 simpleText(1000자)로 — 목록이 잘리지 않게 한다. */
export function flowReply(text: string, quickReplies: KakaoQuickReply[] = [], webLink?: WebLink | null): Reply {
  const fitsCard = [...text].length <= KAKAO_TEXT_CARD_DESCRIPTION_MAX;
  return buildKakaoSkillResponse({
    text,
    quickReplies,
    buttons: webLink && fitsCard ? [{ action: "webLink", label: webLink.label, webLinkUrl: webLink.url }] : [],
  });
}

/** 끝의 문장부호·물결을 뗀 답(「네!」「넵~」→「네」「넵」) */
export const answerOf = (text: string) => text.replace(/[!.~?,\s]+$/u, "").trim();
export const YES = /^(네|넵|넹|예|응|확인|맞아요|좋아요|좋습니다|그래요|진행|진행해 ?주세요)$/;

/** "1번" → 1, "<prefix> 3번" → 3. 다른 단계의 버튼이면 null. */
export function parseNumberPick(text: string, prefix: string): number | null {
  const bare = /^(\d{1,2})\s*번?$/.exec(text);
  if (bare) return Number(bare[1]);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefixed = new RegExp(`^${escaped} (\\d{1,2})번$`).exec(text);
  return prefixed ? Number(prefixed[1]) : null;
}

export function numberQuickReplies(count: number, prefix: string): KakaoQuickReply[] {
  return Array.from({ length: count }, (_, index) => ({ label: `${index + 1}번`, messageText: `${prefix} ${index + 1}번` }));
}

export function clipText(value: string | null | undefined, max = 12): string {
  const chars = [...(value ?? "").replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** 흐름 하나(status·kind)에 대한 상태 읽기·열기·진행·닫기 */
export function createFlowStore<S extends BaseFlowState>(config: { status: KakaoFlowStatus; kind: string }) {
  const { status, kind } = config;

  function parseState(raw: unknown): S | null {
    try {
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      return value && typeof value === "object" && (value as S).v === 1 ? (value as S) : null;
    } catch {
      return null;
    }
  }

  return {
    /** 살아 있는 흐름(30분 이내). 다른 보호자로 다시 연결된 카카오라면 이전 상태를 쓰지 않는다. */
    async active(identityId: string, parentUserId: string): Promise<FlowRow<S> | null> {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; structuredJson: unknown }>>(
        `SELECT id,"structuredJson" FROM "KakaoParentIntake"
          WHERE "identityId"=$1 AND status='${status}'
            AND "updatedAt">now()-interval '${KAKAO_FLOW_TTL_MINUTES} minutes'
          ORDER BY "updatedAt" DESC LIMIT 1`,
        identityId,
      );
      const row = rows[0];
      const state = row ? parseState(row.structuredJson) : null;
      if (!row || !state || state.parentUserId !== parentUserId) return null;
      return { id: row.id, state };
    },

    /** 새 흐름을 연다(초안·다른 흐름은 닫는다). state 가 null 이면 닫기만 한다. 접수 초안 생성과 같은 잠금 키. */
    async open(identityId: string, sourceText: string, state: S | null): Promise<string | null> {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, identityId);
        await tx.$executeRawUnsafe(
          `UPDATE "KakaoParentIntake" SET status='CANCELED',"updatedAt"=now()
            WHERE "identityId"=$1 AND status IN (${KAKAO_OPEN_FLOW_CLOSE_SQL})`,
          identityId,
        );
        if (!state) return null;
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO "KakaoParentIntake" (id,"identityId","studentId",kind,"sourceText","structuredJson",status,"idempotencyKey")
           VALUES (gen_random_uuid()::text,$1,$2,'${kind}',$3,$4::jsonb,'${status}','kakao:flow:'||gen_random_uuid()::text)
           RETURNING id`,
          identityId, state.studentId, sourceText.slice(0, 1000), JSON.stringify(state),
        );
        return rows[0]?.id ?? null;
      });
    },

    /** 단계가 그대로일 때만 다음 단계로 넘긴다(같은 버튼을 두 번 눌러도 한 번만 진행 = 중복 방지 잠금). */
    async advance(flowId: string, fromStep: string, next: S): Promise<boolean> {
      const changed = await prisma.$executeRawUnsafe(
        `UPDATE "KakaoParentIntake" SET "structuredJson"=$3::jsonb,"studentId"=$4,"updatedAt"=now()
          WHERE id=$1 AND status='${status}' AND "structuredJson"->>'step'=$2`,
        flowId, fromStep, JSON.stringify(next), next.studentId,
      );
      return Number(changed) > 0;
    },

    async close(flowId: string, result: "APPLIED" | "CANCELED", state?: S): Promise<void> {
      await prisma.$executeRawUnsafe(
        result === "APPLIED"
          ? `UPDATE "KakaoParentIntake" SET status='APPLIED',"appliedAt"=now(),"confirmedAt"=now(),
               "structuredJson"=COALESCE($2::jsonb,"structuredJson"),"updatedAt"=now() WHERE id=$1`
          : `UPDATE "KakaoParentIntake" SET status='CANCELED',"structuredJson"=COALESCE($2::jsonb,"structuredJson"),"updatedAt"=now()
              WHERE id=$1 AND status='${status}'`,
        flowId, state ? JSON.stringify(state) : null,
      );
    },

    /**
     * 흐름 행을 그대로 「원장님 승인 접수」(SUBMITTED)로 바꾼다(정규 셔틀 변경용).
     * structuredJson 은 관리자 접수함이 읽는 형식(effectiveDate·shuttleIntent·details)으로 갈아 끼운다.
     * 흐름 상태일 때만 바뀌므로 같은 확정이 두 번 와도 접수는 한 건이다.
     */
    async submit(flowId: string, submittedKind: string, structured: Record<string, unknown>): Promise<boolean> {
      const changed = await prisma.$executeRawUnsafe(
        `UPDATE "KakaoParentIntake" SET status='SUBMITTED',kind=$2,"structuredJson"=$3::jsonb,"confirmedAt"=now(),"updatedAt"=now()
          WHERE id=$1 AND status='${status}'`,
        flowId, submittedKind, JSON.stringify(structured),
      );
      return Number(changed) > 0;
    },
  };
}

// 메뉴 버튼 문장 — 어느 흐름에도 붙잡히지 않고 그대로 메뉴를 열어야 한다.
export const FLOW_MENU_TEXT = /^(결석·보강|셔틀|청구·영수증|수강 변경|정보·상담|메뉴|처음|시작)$/;
export const MAIN_MENU = ["결석·보강", "셔틀", "청구·영수증", "수강 변경", "정보·상담"];

/**
 * 자녀 이름 고르기: 띄어쓰기로 나눈 말 중 이름과 정확히 같은 것을 먼저 보고, 없으면 포함된 이름 중 가장 긴 것.
 * (보강 흐름의 pickChildByName 과 같은 규칙)
 */
export function pickChild<T extends { name: string }>(children: T[], text: string): T | null {
  if (children.length === 1) return children[0];
  const words = new Set(text.split(/\s+/).filter(Boolean));
  const exact = children.filter((child) => words.has(child.name));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const hits = children.filter((child) => child.name && text.includes(child.name));
  if (hits.length === 0) return null;
  const longest = Math.max(...hits.map((child) => [...child.name].length));
  const top = hits.filter((child) => [...child.name].length === longest);
  return top.length === 1 ? top[0] : null;
}

/**
 * 학부모가 문장으로 말한 날짜를 KST 달력 날짜("YYYY-MM-DD")로 읽는다(순수 함수 — 테스트 대상).
 * 「오늘」「내일」「모레」「11월 20일」「11/20」「11.20」만 읽는다. 연도는 오늘 이후 가장 가까운 해.
 * 못 읽으면 null(번호 「1번」 같은 말은 날짜가 아니다).
 */
export function parseKoreanDateYmd(text: string, todayYmd: string): string | null {
  if (/내일\s*모레/.test(text)) return addDaysKst(todayYmd, 2);
  if (/오늘|당일/.test(text)) return todayYmd;
  if (/내일/.test(text)) return addDaysKst(todayYmd, 1);
  if (/모레/.test(text)) return addDaysKst(todayYmd, 2);
  const m = /(\d{1,2})\s*(?:월|\/|\.|-)\s*(\d{1,2})\s*일?/.exec(text);
  if (!m) return null;
  const year = Number(todayYmd.slice(0, 4));
  const mmdd = `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const thisYear = `${year}-${mmdd}`;
  if (!isKstYmd(thisYear)) return null;
  // 이미 지난 날짜면 내년으로 본다(12월에 「1/5」라고 말하는 경우)
  const ymd = thisYear >= todayYmd ? thisYear : `${year + 1}-${mmdd}`;
  return isKstYmd(ymd) ? ymd : null;
}
