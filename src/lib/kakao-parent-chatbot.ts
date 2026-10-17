import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  buildKakaoReconfirmationPayload,
  kakaoReconfirmationPayloadHash,
  type KakaoReconfirmationClassSnapshot,
} from "@/lib/kakao-parent-reconfirmation";
import {
  buildKakaoSkillResponse,
  classifyParentUtterance,
  type ParentRequestKind,
} from "@/lib/kakao-chatbot-contract";
import { notifyAdminsOfKakaoIntake } from "@/lib/kakao-intake-admin-alert";
import { LINKED_ESCALATE_LEAD, isLinkedPolicyCandidate, parsePolicyIntakeShortcut, type KakaoReply } from "@/lib/kakao-policy-qa";
import { handleMakeupConversation } from "@/lib/kakao-makeup-flow";

export { classifyParentUtterance, getKakaoUserKey } from "@/lib/kakao-chatbot-contract";
export type { KakaoSkillPayload, ParentRequestKind } from "@/lib/kakao-chatbot-contract";

const LINK_TTL_MS = 15 * 60_000;
const RECONFIRM_LINK_TTL_MS = 24 * 60 * 60_000;
const CONFIRM_WORDS = /^(접수|접수할게요|확인|네|예|맞아요|진행)$/;
const CANCEL_WORDS = /^(취소|아니요|다시|접수 취소)$/;

const DIRECT_REQUEST_LINKS: Record<string, { label: string; path: string; description: string }> = {
  "정규수업 결석": { label: "결석 날짜 선택하기", path: "/mypage/regular-absence", description: "다가오는 실제 수업일과 반을 선택하면 결석과 해당일 셔틀 제외가 함께 접수돼요." },
  "방학특강 결석": { label: "특강 결석 접수하기", path: "/mypage/seasonal", description: "신청한 특강 회차를 선택해 결석을 알려주세요." },
  "보강 예약": { label: "보강 예약하기", path: "/mypage/makeup", description: "사용 가능한 보강권과 정원이 맞는 수업을 확인해 예약할 수 있어요." },
  "오늘 셔틀 안 타요": { label: "오늘 셔틀 변경하기", path: "/mypage/shuttle", description: "수업은 참석하고 셔틀만 이용하지 않는 경우에 선택해주세요. 기사님 운행 화면에 바로 표시돼요." },
  "오늘 다른 곳에서 타요": { label: "탑승 장소 변경하기", path: "/mypage/shuttle", description: "날짜·등하원 방향·오늘 탈 장소를 확인해 기사님 운행 화면에 바로 전달해요." },
  "입금했어요": { label: "입금 알리기", path: "/mypage/payments", description: "해당 청구서와 입금일을 선택하면 원장님 확인함에 접수돼요." },
  "영수증 요청": { label: "영수증 요청하기", path: "/mypage/payments", description: "납부 완료된 청구서를 선택해 영수증을 요청할 수 있어요." },
};

const DIRECT_KIND_LINKS: Partial<Record<ParentRequestKind, { label: string; path: string; description: string }>> = {
  REGULAR_ABSENCE: DIRECT_REQUEST_LINKS["정규수업 결석"],
  SEASONAL_ABSENCE: DIRECT_REQUEST_LINKS["방학특강 결석"],
  SHUTTLE_SKIP: DIRECT_REQUEST_LINKS["오늘 셔틀 안 타요"],
  SHUTTLE_LOCATION: DIRECT_REQUEST_LINKS["오늘 다른 곳에서 타요"],
  PAYMENT_CONFIRM: DIRECT_REQUEST_LINKS["입금했어요"],
  RECEIPT: DIRECT_REQUEST_LINKS["영수증 요청"],
  CLASS_CHANGE: { label: "수강 변경 신청하기", path: "/mypage/enrollment-change", description: "현재 등록 반과 실제 개설 반을 확인해 변경을 신청할 수 있어요. 원장님 승인 후 반영됩니다." },
  PAUSE: { label: "휴원 신청하기", path: "/mypage/enrollment-change", description: "현재 수강 정보를 확인해 휴원을 신청할 수 있어요. 원장님 승인 후 반영됩니다." },
  WITHDRAW: { label: "퇴원 신청하기", path: "/mypage/enrollment-change", description: "현재 수강 정보를 확인해 퇴원을 신청할 수 있어요. 원장님 승인 후 반영됩니다." },
};

function siteUrl(path: string): string {
  const origin = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.stiz-dasan.kr").replace(/\/+$/, "");
  return `${origin}${path}`;
}

type IdentityRow = { id: string; parentUserId: string | null; status: string };
type ChildRow = { id: string; name: string; grade: string | null };
type IntakeRow = { id: string; kind: ParentRequestKind; sourceText: string; studentId: string | null; status: string };

function secret(): string {
  const value = process.env.KAKAO_CHATBOT_IDENTITY_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("KAKAO_CHATBOT_IDENTITY_SECRET_MISSING");
  return value;
}

function digest(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ReconfirmationCandidate = {
  intakeId: string;
  requestId: string;
  commandId: string;
  studentId: string;
  studentName: string;
  kind: string;
  afterJson: Record<string, unknown> | null;
  createdByUserId: string;
  fromClassId: string | null;
  fromProgramName: string | null;
  fromClassName: string | null;
  fromDayOfWeek: string | null;
  fromStartTime: string | null;
  fromEndTime: string | null;
  toClassId: string | null;
  toProgramName: string | null;
  toClassName: string | null;
  toDayOfWeek: string | null;
  toStartTime: string | null;
  toEndTime: string | null;
};

function classSnapshot(row: ReconfirmationCandidate, side: "from" | "to"): KakaoReconfirmationClassSnapshot | null {
  const id = side === "from" ? row.fromClassId : row.toClassId;
  const programName = side === "from" ? row.fromProgramName : row.toProgramName;
  const className = side === "from" ? row.fromClassName : row.toClassName;
  const dayOfWeek = side === "from" ? row.fromDayOfWeek : row.toDayOfWeek;
  const startTime = side === "from" ? row.fromStartTime : row.toStartTime;
  const endTime = side === "from" ? row.fromEndTime : row.toEndTime;
  return id && programName && className && dayOfWeek && startTime && endTime
    ? { id, programName, className, dayOfWeek, startTime, endTime } : null;
}

export async function issuePendingReconfirmationLink(identity: IdentityRow, intakeId: string | null = null, preparedByAdminId: string | null = null) {
  if (!identity.parentUserId || identity.status !== "ACTIVE") return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `kakao-reconfirm:${identity.id}`);
    const rows = await tx.$queryRawUnsafe<ReconfirmationCandidate[]>(
      `SELECT i.id AS "intakeId",r.id AS "requestId",c.id AS "commandId",c."studentId",s.name AS "studentName",
              c.kind,c."afterJson",r."requestedByUserId" AS "createdByUserId",
              fc.id AS "fromClassId",fp.name AS "fromProgramName",fc.name AS "fromClassName",fc."dayOfWeek" AS "fromDayOfWeek",fc."startTime" AS "fromStartTime",fc."endTime" AS "fromEndTime",
              tc.id AS "toClassId",tp.name AS "toProgramName",tc.name AS "toClassName",tc."dayOfWeek" AS "toDayOfWeek",tc."startTime" AS "toStartTime",tc."endTime" AS "toEndTime"
         FROM "KakaoParentIntake" i
         JOIN "KakaoParentIdentity" ki ON ki.id=i."identityId" AND ki.status='ACTIVE' AND ki."parentUserId"=$2
         JOIN "OperationsRequest" r ON r.id=i."operationsRequestId"
         JOIN "OperationsCommand" c ON c."requestId"=r.id AND c."studentId"=i."studentId"
         JOIN "Student" s ON s.id=c."studentId" AND s."parentId"=$2 AND s."mergedIntoStudentId" IS NULL
         LEFT JOIN "Class" fc ON fc.id=c."afterJson"->>'fromClassId'
         LEFT JOIN "Program" fp ON fp.id=fc."programId"
         LEFT JOIN "Class" tc ON tc.id=c."afterJson"->>'toClassId'
         LEFT JOIN "Program" tp ON tp.id=tc."programId"
        WHERE i."identityId"=$1 AND i.status='APPROVED'
          AND ($3::text IS NULL OR i.id=$3)
          AND r.status IN ('DRAFT','HELD') AND c.status IN ('PENDING','HELD')
          AND c."afterJson"->>'parentReconfirmationRequired'='true'
          AND COALESCE(c."afterJson"->>'parentConfirmed','false')<>'true'
        ORDER BY i."decidedAt" ASC,c."createdAt" ASC LIMIT 1 FOR UPDATE OF c`,
      identity.id, identity.parentUserId, intakeId,
    );
    const candidate = rows[0];
    if (!candidate) return null;
    // 발송 예약/접수된 유효 링크를 대화의 다음 발화가 회수하지 않도록 보호한다.
    const protectedLinks = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT l.id FROM "ParentOperationsRequestLink" l
       JOIN "OperationsAuditLog" a ON a."linkId"=l.id AND a.action='KAKAO_RECONFIRMATION_LINK_ISSUED'
       JOIN "NotificationDelivery" d ON d."stableEventKey"=l.id AND d."eventType"='KAKAO_RECONFIRMATION'
       WHERE a."detailsJson"->>'commandId'=$1 AND l."revokedAt" IS NULL AND l."lastUsedAt" IS NULL
         AND l."expiresAt">now() AND d.status IN ('PENDING','SENDING','SENT','FAILED') LIMIT 1`, candidate.commandId,
    );
    if (protectedLinks.length) return null;
    const payload = buildKakaoReconfirmationPayload({
      ...candidate, fromClass: classSnapshot(candidate, "from"), toClass: classSnapshot(candidate, "to"),
    });
    if (!payload) return null;

    const token = randomBytes(32).toString("base64url");
    const linkId = randomUUID();
    const expiresAt = new Date(Date.now() + RECONFIRM_LINK_TTL_MS);
    const payloadHash = kakaoReconfirmationPayloadHash(payload);
    // 같은 명령에 발급된 과거 미사용 링크는 새 링크를 만들 때 회수한다.
    await tx.$executeRawUnsafe(
      `UPDATE "ParentOperationsRequestLink" l SET "revokedAt"=now(),"updatedAt"=now()
        WHERE l."revokedAt" IS NULL AND EXISTS (
          SELECT 1 FROM "OperationsAuditLog" a
           WHERE a."linkId"=l.id AND a.action='KAKAO_RECONFIRMATION_LINK_ISSUED'
             AND a."detailsJson"->>'commandId'=$1
        )`, candidate.commandId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "ParentOperationsRequestLink" (id,"studentId","tokenHash",purpose,"expiresAt","createdByUserId")
       VALUES ($1,$2,$3,'KAKAO_RECONFIRMATION',$4,$5)`,
      linkId, candidate.studentId, tokenDigest(token), expiresAt, candidate.createdByUserId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId","linkId",action,"actorType","detailsJson")
       VALUES ($1,$2,$3,'KAKAO_RECONFIRMATION_LINK_ISSUED','SYSTEM',$4::jsonb)`,
      randomUUID(), candidate.requestId, linkId,
      JSON.stringify({ intakeId: candidate.intakeId, commandId: candidate.commandId, payloadHash, expiresAt: expiresAt.toISOString(), preparedByAdminId, deliveryStatus: "HELD" }),
    );
    return {
      studentName: candidate.studentName,
      studentId: candidate.studentId,
      intakeId: candidate.intakeId,
      expiresAt: expiresAt.toISOString(),
      url: siteUrl(`/request/reconfirm/${encodeURIComponent(token)}`),
    };
  });
}

export function verifySkillSecret(received: string | null): boolean {
  const expected = process.env.KAKAO_CHATBOT_SKILL_SECRET?.trim();
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

const KIND_LABEL: Record<ParentRequestKind, string> = {
  REGULAR_ABSENCE: "정규수업 결석", SEASONAL_ABSENCE: "방학특강 결석", MAKEUP: "보강 예약", EARLY_LEAVE: "조퇴 상담",
  SHUTTLE_SKIP: "당일 셔틀 미탑승", SHUTTLE_LOCATION: "당일 다른 장소 탑승", SHUTTLE_START_STOP: "정규 셔틀 신청·중단",
  SHUTTLE_CHANGE: "셔틀 장소·시간 변경", SHUTTLE_FEE: "셔틀비 문의·면제", PAYMENT_CONFIRM: "입금 확인", BILLING_CORRECTION: "청구 금액 확인",
  RECEIPT: "영수증 요청", REFUND: "환불·결제 취소", CLASS_CHANGE: "반·요일·시간 변경", CLASS_ADD: "수업 추가", PAUSE: "휴원",
  RESUME: "복귀", WITHDRAW: "퇴원", CONTACT_CHANGE: "연락처 변경", CONSULTATION: "기타 상담", HUMAN: "상담원 연결", UNKNOWN: "내용 확인 필요",
};

export function kakaoText(text: string, quickReplies: string[] = [], webLink?: { label: string; url: string }) {
  // 버튼이 있으면 textCard 로 나간다(thumbnail 없는 basicCard 는 오픈빌더가 미발송 처리한다).
  return buildKakaoSkillResponse({
    text,
    quickReplies,
    buttons: webLink ? [{ action: "webLink", label: webLink.label, webLinkUrl: webLink.url }] : [],
  });
}

export async function resolveIdentity(botId: string, userKey: string): Promise<IdentityRow | null> {
  const rows = await prisma.$queryRawUnsafe<IdentityRow[]>(
    `UPDATE "KakaoParentIdentity" SET "lastSeenAt"=now(),"updatedAt"=now()
      WHERE "botId"=$1 AND "userKeyHash"=$2
      RETURNING id,"parentUserId",status`, botId, digest(userKey),
  );
  return rows[0] ?? null;
}

// 남은 시간이 이보다 짧으면 같은 링크를 다시 보여주지 않고 새로 만든다(열자마자 만료되는 걸 막는다).
const LINK_REUSE_MIN_REMAINING_MS = 3 * 60_000;

/**
 * 인증 링크 토큰을 (봇·사용자키 해시·만료 시각)에서 서버 비밀키로 만들어 낸다.
 * 토큰 원문은 DB 에 저장하지 않는다(해시만 저장). 대신 같은 재료로 다시 계산할 수 있어서,
 * 학부모가 '인증'을 다시 눌러도 아직 유효한 같은 링크를 다시 보여줄 수 있다.
 * 비밀키(KAKAO_CHATBOT_IDENTITY_SECRET)가 없으면 만들 수 없으므로 밖에서 추측할 수 없다.
 */
function connectLinkToken(botId: string, userKeyHash: string, expiresMs: number): string {
  return createHmac("sha256", secret()).update(`kakao-connect-link:v1:${botId}:${userKeyHash}:${expiresMs}`).digest("base64url");
}

function connectLinkUrl(token: string, siteOrigin: string): string {
  return new URL(`/mypage/kakao-connect?token=${encodeURIComponent(token)}`, siteOrigin).toString();
}

/** 카카오 연결 화면이 링크를 먼저 확인할 때 쓴다(읽기만 함). */
export async function isKakaoConnectTokenUsable(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
    `SELECT 1 AS one FROM "KakaoParentIdentity"
      WHERE "linkTokenHash"=$1 AND "linkExpiresAt">now() AND status<>'REVOKED' LIMIT 1`,
    tokenDigest(token),
  );
  return rows.length > 0;
}

export async function issueLink(botId: string, userKey: string, siteOrigin: string) {
  const userKeyHash = digest(userKey);
  // 1) 아직 유효한 링크가 있으면 새로 덮어쓰지 않고 같은 링크를 다시 보여준다.
  //    linkExpiresAt 은 timestamptz 라 밀리초 값이 그대로 돌아온다(시간대 변환 없음).
  const live = (await prisma.$queryRawUnsafe<Array<{ linkTokenHash: string; expiresMs: string }>>(
    `SELECT "linkTokenHash", (EXTRACT(EPOCH FROM "linkExpiresAt") * 1000)::bigint::text AS "expiresMs"
       FROM "KakaoParentIdentity"
      WHERE "botId"=$1 AND "userKeyHash"=$2 AND "linkTokenHash" IS NOT NULL AND "linkExpiresAt">now()
      LIMIT 1`,
    botId, userKeyHash,
  ))[0];
  if (live) {
    const expiresMs = Number(live.expiresMs);
    const remaining = expiresMs - Date.now();
    const sameToken = connectLinkToken(botId, userKeyHash, expiresMs);
    // 해시가 맞을 때만 재사용한다(이 방식 이전에 무작위로 만든 링크는 다시 계산할 수 없다).
    if (remaining >= LINK_REUSE_MIN_REMAINING_MS && tokenDigest(sameToken) === live.linkTokenHash) {
      return { url: connectLinkUrl(sameToken, siteOrigin), reused: true, replacedPrevious: false, minutesLeft: Math.floor(remaining / 60_000) };
    }
  }

  // 2) 없거나 곧 만료되면 새 링크를 만든다. 이때 이전 링크는 무효가 되므로 안내 문구에 알린다.
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  const token = connectLinkToken(botId, userKeyHash, expiresAt.getTime());
  const rows = await prisma.$queryRawUnsafe<IdentityRow[]>(
    `INSERT INTO "KakaoParentIdentity"
       ("botId","userKeyHash","linkTokenHash","linkExpiresAt","lastSeenAt","updatedAt")
     VALUES ($1,$2,$3,$4,now(),now())
     ON CONFLICT ("botId","userKeyHash") DO UPDATE SET
       "linkTokenHash"=EXCLUDED."linkTokenHash", "linkExpiresAt"=EXCLUDED."linkExpiresAt",
       "lastSeenAt"=now(), "updatedAt"=now()
     RETURNING id,"parentUserId",status`,
    botId, userKeyHash, tokenDigest(token), expiresAt,
  );
  return {
    identity: rows[0],
    url: connectLinkUrl(token, siteOrigin),
    reused: false,
    replacedPrevious: Boolean(live),
    minutesLeft: Math.floor(LINK_TTL_MS / 60_000),
  };
}

export async function bindIdentity(token: string, parentUserId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "KakaoParentIdentity" SET
       "parentUserId"=$2,status='ACTIVE',"linkedAt"=now(),"linkTokenHash"=NULL,"linkExpiresAt"=NULL,"updatedAt"=now()
     WHERE "linkTokenHash"=$1 AND "linkExpiresAt">now() AND status<>'REVOKED'
     RETURNING id`, tokenDigest(token), parentUserId,
  );
  if (!rows[0]) throw new Error("INVALID_OR_EXPIRED_LINK");
  return rows[0];
}

async function childrenOf(parentUserId: string): Promise<ChildRow[]> {
  return prisma.$queryRawUnsafe<ChildRow[]>(
    `SELECT id,name,grade FROM "Student"
      WHERE "parentId"=$1 AND "mergedIntoStudentId" IS NULL ORDER BY name`, parentUserId,
  );
}

/** 보호자 실명·전화번호 없이, 인증 계정에 실제 연결된 자녀 이름만으로 부르는 이름을 만든다. */
export function formatKakaoParentDisplayName(children: Array<Pick<ChildRow, "name">>): string {
  const names = [...new Set(children.map((child) => child.name.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (names.length === 0) return "학부모님";
  if (names.length === 1) return `${names[0]} 학생 학부모님`;
  return `${names.join("·")} 학생 보호자`;
}

function selectChild(children: ChildRow[], text: string): ChildRow | null {
  if (children.length === 1) return children[0];
  const matches = children.filter((child) => text.includes(child.name));
  return matches.length === 1 ? matches[0] : null;
}

async function latestDraft(identityId: string): Promise<IntakeRow | null> {
  const rows = await prisma.$queryRawUnsafe<IntakeRow[]>(
    `SELECT id,kind,"sourceText","studentId",status FROM "KakaoParentIntake"
      WHERE "identityId"=$1 AND status IN ('DRAFT','NEEDS_DETAILS')
        AND "createdAt">now()-interval '30 minutes'
      ORDER BY "createdAt" DESC LIMIT 1`, identityId,
  );
  return rows[0] ?? null;
}

function draftResponse(draft: IntakeRow, studentName?: string | null) {
  if (draft.status === "SUBMITTED") return kakaoText("이미 접수된 요청이에요.");
  if (!draft.studentId || !studentName) return null;
  return kakaoText(
    `${studentName} 학생의 ‘${KIND_LABEL[draft.kind]}’ 요청으로 이해했어요.\n\n“${draft.sourceText}”\n\n이 내용으로 접수할까요?`,
    ["접수할게요", "다시 말할게요", "취소"],
  );
}

export async function handleLinkedMessage(
  identity: IdentityRow,
  utterance: string,
  providerRequestId?: string | null,
  // 정책 답변 연결점(없거나 null 을 주면 기존 동작 그대로)
  policy?: LinkedPolicyHook | null,
) {
  const text = utterance.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!identity.parentUserId) throw new Error("IDENTITY_NOT_LINKED");
  const children = await childrenOf(identity.parentUserId);
  if (children.length === 0) return kakaoText("연결된 수강생을 찾지 못했어요. 학원으로 문의해 주세요.", ["상담원 연결"]);
  const parentDisplayName = formatKakaoParentDisplayName(children);

  const reconfirmation = await issuePendingReconfirmationLink(identity);
  if (reconfirmation) {
    return kakaoText(
      `${reconfirmation.studentName} 학생 요청에서 원장님이 날짜·수업·셔틀 정보를 보완했어요. 변경된 내용을 확인해 주세요. 확인만으로 시트·랠리즈·사이트 반영이나 알림 발송이 실행되지는 않아요.`,
      ["메뉴", "상담원 연결"],
      { label: "보완된 요청 확인하기", url: reconfirmation.url },
    );
  }

  // 보강 신청·취소는 화면 링크 대신 대화 안에서 끝낸다(사이트 오픈 전 마이페이지 대체).
  // 보강과 무관한 말이면 null → 아래 기존 흐름 그대로. 마이페이지 보강 화면은 보조 버튼으로 남긴다.
  const makeupLink = DIRECT_REQUEST_LINKS["보강 예약"];
  const makeup = await handleMakeupConversation({
    identityId: identity.id,
    parentUserId: identity.parentUserId,
    children,
    text,
    webLink: { label: makeupLink.label, url: siteUrl(makeupLink.path) },
  });
  if (makeup) return makeup;

  const draft = await latestDraft(identity.id);
  if (draft && (CANCEL_WORDS.test(text) || text === "다시 말할게요")) {
    await prisma.$executeRawUnsafe(`UPDATE "KakaoParentIntake" SET status='CANCELED',"updatedAt"=now() WHERE id=$1 AND status IN ('DRAFT','NEEDS_DETAILS')`, draft.id);
    return kakaoText("작성 중인 요청을 취소했어요. 새로 말씀해 주세요.", ["결석·보강", "셔틀", "청구·영수증", "수강 변경", "정보·상담"]);
  }
  if (draft && CONFIRM_WORDS.test(text)) {
    if (!draft.studentId) {
      return kakaoText("접수 전에 자녀를 먼저 선택해 주세요.", children.slice(0, 10).map((item) => item.name));
    }
    const changed = Number(await prisma.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake" SET status='SUBMITTED',"confirmedAt"=now(),"updatedAt"=now()
        WHERE id=$1 AND "studentId" IS NOT NULL AND status IN ('DRAFT','NEEDS_DETAILS')`, draft.id,
    ));
    if (changed === 0) return kakaoText("이미 접수된 요청이에요.");
    // 학부모가 '접수'를 확정한 순간 = 원장님이 볼 새 접수가 생긴 순간. 관리자 앱 알림센터로 알린다
    // (원장 결정: 메일 아님). 알림이 실패해도 학부모 답장은 그대로 나간다.
    await notifyAdminsOfKakaoIntake({
      intakeId: draft.id,
      kindLabel: KIND_LABEL[draft.kind],
      studentName: children.find((item) => item.id === draft.studentId)?.name ?? null,
      sourceText: draft.sourceText,
    }).catch(() => undefined);
    return kakaoText(`${KIND_LABEL[draft.kind]} 요청을 접수했어요. 원장님이 확인한 뒤 필요한 경우 카카오톡이나 전화로 연락드릴게요.`);
  }
  if (!draft && CONFIRM_WORDS.test(text)) {
    return kakaoText("이미 접수됐거나 현재 확인할 요청이 없어요. 새 요청은 내용을 문장으로 말씀해 주세요.", ["결석·보강", "셔틀", "청구·영수증", "수강 변경", "정보·상담"]);
  }

  if (draft && !draft.studentId) {
    const selected = selectChild(children, text);
    if (!selected) return kakaoText("자녀 이름을 한 번만 더 선택해 주세요.", children.slice(0, 10).map((item) => item.name));
    await prisma.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake" SET "studentId"=$2,status='DRAFT',
        "structuredJson"=$3::jsonb,"updatedAt"=now() WHERE id=$1 AND status IN ('DRAFT','NEEDS_DETAILS')`,
      draft.id, selected.id, JSON.stringify({ studentId: selected.id, studentName: selected.name, kind: draft.kind }),
    );
    return kakaoText(
      `${selected.name} 학생의 ‘${KIND_LABEL[draft.kind]}’ 요청으로 이해했어요.\n\n“${draft.sourceText}”\n\n이 내용으로 접수할까요?`,
      ["접수할게요", "다시 말할게요", "취소"],
    );
  }

  const submenu: Record<string, string[]> = {
    "결석·보강": ["정규수업 결석", "방학특강 결석", "보강 신청", "보강 취소", "조퇴 상담"],
    "셔틀": ["오늘 셔틀 안 타요", "오늘 다른 곳에서 타요", "정규 셔틀 신청·중단", "탑승 장소·시간 변경", "셔틀비 문의"],
    "청구·영수증": ["입금했어요", "청구 금액 확인", "영수증 요청", "환불·결제 취소 상담"],
    "수강 변경": ["반·요일·시간 변경", "수업 추가", "휴원", "복귀", "퇴원"],
    "정보·상담": ["연락처 변경", "기타 상담", "상담원 연결"],
  };
  if (submenu[text]) return kakaoText("원하시는 업무를 골라주세요. 직접 문장으로 말씀하셔도 돼요.", submenu[text]);

  const direct = DIRECT_REQUEST_LINKS[text];
  if (direct) {
    return kakaoText(
      `${direct.description}\n\n최초 인증 때 연결한 학부모 계정으로 안전하게 확인합니다.`,
      ["메뉴", "상담원 연결"],
      { label: direct.label, url: siteUrl(direct.path) },
    );
  }

  // 정책 답변 아래 「원장님께 접수할까요?」를 누른 경우: 원래 질문 그대로 기존 접수 흐름으로 바로 간다.
  // (「원장님께 문의: …」는 '원장님'으로 상담원 연결(HUMAN)로 분류되어 원문 그대로 접수된다 — 따로 처리할 것 없음)
  const intakeShortcut = parsePolicyIntakeShortcut(text);
  if (intakeShortcut) {
    return createIntakeReply(identity, children, intakeShortcut.question, intakeShortcut.kind, providerRequestId);
  }

  const kind = classifyParentUtterance(text);
  if (kind === "UNKNOWN" && /^(메뉴|처음|시작)$/.test(text)) {
    return kakaoText(`${parentDisplayName}, 무엇을 도와드릴까요? 평소처럼 문장으로 말씀하셔도 알아들을게요.`, ["결석·보강", "셔틀", "청구·영수증", "수강 변경", "정보·상담"]);
  }
  const directKind = DIRECT_KIND_LINKS[kind];
  if (directKind) {
    return kakaoText(
      `${directKind.description}\n\n“${text}” 요청을 정확한 정보로 접수하려면 아래 버튼을 눌러 확인해주세요.`,
      ["메뉴", "상담원 연결"],
      { label: directKind.label, url: siteUrl(directKind.path) },
    );
  }
  // 정책 질문(요금·환불·셔틀 규정 등): 인증·메뉴·바로가기 업무·작성 중 접수를 모두 지난 "질문"만 온다.
  // policy 가 null 을 주면(꺼짐) 아래 기존 접수 흐름을 그대로 탄다. 답을 못 하면 같은 접수 흐름으로 넘긴다.
  if (policy && isLinkedPolicyCandidate(kind, text, Boolean(draft))) {
    const handled = await policy(text, () =>
      createIntakeReply(identity, children, text, kind, providerRequestId, LINKED_ESCALATE_LEAD), kind);
    if (handled) return handled;
  }
  return createIntakeReply(identity, children, text, kind, providerRequestId);
}

/**
 * 정책 답변 연결점. null 을 돌려주면 기존 흐름을 그대로 진행한다.
 * escalate 는 기존 접수 흐름(원장 확인 대기)이고, kind 는 답 아래 바로가기(청구·환불이면 「원장님께 접수할까요?」)를 고르는 데 쓴다.
 */
export type LinkedPolicyHook = (
  question: string,
  escalate: () => Promise<KakaoReply>,
  kind: ParentRequestKind,
) => Promise<KakaoReply | null>;

/** 새 접수 초안을 만들고 "접수할까요?"를 묻는다(기존 흐름 그대로). lead 가 있으면 첫 줄에 붙인다. */
async function createIntakeReply(
  identity: IdentityRow,
  children: ChildRow[],
  text: string,
  kind: ParentRequestKind,
  providerRequestId: string | null | undefined,
  lead?: string,
) {
  const say = (message: string) => (lead ? `${lead}\n\n${message}` : message);
  const child = selectChild(children, text);
  const intakeId = randomUUID();
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, identity.id);
    if (providerRequestId) {
      const existing = await tx.$queryRawUnsafe<Array<IntakeRow & { studentName: string | null }>>(
        `SELECT r.id,r.kind,r."sourceText",r."studentId",r.status,s.name AS "studentName"
           FROM "KakaoParentIntake" r LEFT JOIN "Student" s ON s.id=r."studentId"
          WHERE r."identityId"=$1 AND r."providerRequestId"=$2 LIMIT 1`, identity.id, providerRequestId,
      );
      if (existing[0]) return { duplicate: existing[0] };
    }
    await tx.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake" SET status='CANCELED',"updatedAt"=now()
        WHERE "identityId"=$1 AND status IN ('DRAFT','NEEDS_DETAILS')`, identity.id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "KakaoParentIntake"
        (id,"identityId","studentId",kind,"sourceText","structuredJson",status,"idempotencyKey","providerRequestId")
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      intakeId, identity.id, child?.id ?? null, kind, text,
      JSON.stringify(child ? { studentId: child.id, studentName: child.name, kind } : { kind }),
      child ? "DRAFT" : "NEEDS_DETAILS", `kakao:intake:${intakeId}`, providerRequestId ?? null,
    );
    return { duplicate: null };
  });
  if (created.duplicate) {
    const repeated = draftResponse(created.duplicate, created.duplicate.studentName);
    return repeated ?? kakaoText("이미 같은 요청을 확인하고 있어요. 자녀를 선택해 주세요.", children.slice(0, 10).map((item) => item.name));
  }
  if (!child) {
    return kakaoText(say("어느 자녀의 요청인지 알려주세요."), children.slice(0, 10).map((item) => item.name));
  }
  return kakaoText(
    say(`${child.name} 학생의 ‘${KIND_LABEL[kind]}’ 요청으로 이해했어요.\n\n“${text}”\n\n이 내용으로 접수할까요?`),
    ["접수할게요", "다시 말할게요", "취소"],
  );
}
