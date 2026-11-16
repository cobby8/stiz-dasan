/**
 * «내 캘린더에 연동» 서버 쪽 — 주소 속 확인 값(토큰) 관리와 일정 모으기.
 *
 * 왜 확인 값이 필요한가: 휴대폰 캘린더 앱은 로그인을 못 한다. 그래서 개인 일정 주소 안에 «추측할 수 없는 값»을 넣고
 * 그 값으로 본인을 찾는다. 원문은 저장하지 않고 sha256 해시만 저장한다(DB 가 새도 주소를 되살릴 수 없게).
 *
 * ⚠️ PgBouncer 트랜잭션 모드 → $queryRawUnsafe / $executeRawUnsafe 만 쓴다.
 * ⚠️ 표(CalendarFeedToken)가 아직 없는 환경(배포 순서 어긋남)에서도 죽지 않는다 — «없음»으로 본다.
 * ⚠️ 확인 값 원문·해시를 로그에 남기지 않는다.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { childAccessSql, hasGrantedChildren } from "@/lib/account/child-access";
import { effectiveRoles, type RoleGrantRow } from "@/lib/account/roles";
import { notMergedStudent } from "@/lib/studentVisibility";
import { getCoachLinkedClassesForUser } from "@/lib/staff-class-access";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { loadAnnualPageData } from "@/app/annual/annualData";
import { todayKst } from "@/lib/datetime/kst";
import type { IcsEvent } from "./ics";
import {
  academyEventsToIcs,
  allowedCalendarKinds,
  classDatesInRange,
  classSessionsToIcs,
  feedMonths,
  filterCalendarKinds,
  parseCalendarKinds,
  type CalendarKind,
  type FeedClass,
} from "./feedEvents";

/** 한 사람이 가질 수 있는 연동 주소 수 — 넘으면 가장 오래된 것부터 지운다 */
export const MAX_FEED_TOKENS_PER_USER = 10;

// crypto.randomBytes(32) 의 base64url = 43글자
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 표가 아직 없을 때의 오류인가(42P01) — 이 경우만 조용히 «없음»으로 본다 */
function isMissingFeedTable(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  const pg = e?.meta?.code ?? e?.code;
  return pg === "42P01" || /relation "?(public\.)?"?CalendarFeedToken"? does not exist/i.test(e?.message ?? "");
}

export function newFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 일정 고유값(UID)에 넣는 «알아볼 수 없는 번호» — 회원·학생 번호 원문이 캘린더 파일에 실려
 * 구글·애플 서버까지 나가지 않게 해시 앞 16자만 쓴다(보안 검수 2026-11-16). 같은 사람·같은 아이는 늘 같은 값이라 일정이 중복되지 않는다.
 */
function opaqueId(id: string): string {
  return createHash("sha256").update(`calendar-uid:${id}`, "utf8").digest("hex").slice(0, 16);
}

export type FeedTokenRow = { id: string; userId: string; kinds: CalendarKind[] };

/**
 * 주소 속 확인 값으로 연동 한 줄을 찾는다. 원문이 아니라 **해시(tokenHash)로만** 찾는다.
 * 모양이 틀렸거나 없거나 표가 없으면 모두 null — 이유를 가르지 않는다.
 */
export async function findFeedToken(token: string): Promise<FeedTokenRow | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; userId: string; kinds: string }>>(
      `SELECT id, "userId", kinds FROM "CalendarFeedToken" WHERE "tokenHash" = $1 LIMIT 1`,
      hashFeedToken(token),
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.userId, kinds: parseCalendarKinds(row.kinds) };
  } catch (error) {
    if (isMissingFeedTable(error)) return null;
    throw error;
  }
}

/** 마지막으로 받아 간 시각 — 캘린더 앱이 자주 받아 가므로 한 시간에 한 번만 적는다. 실패해도 일정은 나간다 */
export async function touchFeedToken(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "CalendarFeedToken" SET "lastUsedAt" = NOW()
      WHERE id = $1 AND ("lastUsedAt" IS NULL OR "lastUsedAt" < NOW() - INTERVAL '1 hour')`,
    id,
  ).catch(() => 0);
}

/** 내 연동 주소 수. 표가 없으면 0 */
export async function countFeedTokens(userId: string): Promise<number> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "CalendarFeedToken" WHERE "userId" = $1`,
      userId,
    );
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    if (isMissingFeedTable(error)) return 0;
    throw error;
  }
}

/**
 * 새 연동 주소의 확인 값을 만든다. 원문은 여기서 한 번만 돌려주고 DB 에는 해시만 남긴다.
 * 표가 없으면 null(부르는 쪽이 «지금은 연동할 수 없어요»로 안내).
 */
export async function createFeedToken(userId: string, kinds: readonly CalendarKind[]): Promise<string | null> {
  const token = newFeedToken();
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarFeedToken" (id, "userId", "tokenHash", kinds) VALUES ($1, $2, $3, $4)`,
      randomUUID(),
      userId,
      hashFeedToken(token),
      kinds.join(","),
    );
    // 한도를 넘은 오래된 주소를 지운다(방금 만든 것은 가장 새것이라 남는다)
    await prisma.$executeRawUnsafe(
      `DELETE FROM "CalendarFeedToken"
        WHERE "userId" = $1
          AND id NOT IN (
            SELECT id FROM "CalendarFeedToken" WHERE "userId" = $1
             ORDER BY "createdAt" DESC, id DESC LIMIT ${MAX_FEED_TOKENS_PER_USER}
          )`,
      userId,
    );
    return token;
  } catch (error) {
    if (isMissingFeedTable(error)) return null;
    throw error;
  }
}

/** 내 연동 주소를 모두 지운다(«연동 끊기»). 지운 수를 돌려준다. 표가 없으면 0 */
export async function revokeFeedTokens(userId: string): Promise<number> {
  try {
    return await prisma.$executeRawUnsafe(`DELETE FROM "CalendarFeedToken" WHERE "userId" = $1`, userId);
  } catch (error) {
    if (isMissingFeedTable(error)) return 0;
    throw error;
  }
}

export type FeedAccess = { teacher: boolean; parent: boolean };

/**
 * userId 만으로 «지금» 이 사람에게 열린 역할을 다시 본다 — 캘린더가 받아 갈 때마다 부른다.
 * 주소를 만든 뒤 선생님 역할이 회수되거나 탈퇴하면 그 항목은 바로 나가지 않는다.
 * 판정은 로그인 문지기(auth-guard)와 같은 재료를 쓴다: 주 역할 + 승인된(ACTIVE) 추가 역할 + 자녀 유무.
 * 탈퇴했거나 없는 계정은 null.
 */
export async function getFeedAccessForUser(userId: string): Promise<FeedAccess | null> {
  if (!userId) return null;
  const users = await prisma.$queryRawUnsafe<
    Array<{ id: string; role: string; username: string | null; phoneVerifiedAt: Date | null }>
  >(
    `SELECT id, role::text AS role, username, "phoneVerifiedAt"
       FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL LIMIT 1`,
    userId,
  );
  const user = users[0];
  if (!user) return null;

  // 추가 역할 조회가 실패하면 «없음» — 실패가 권한을 넓히는 쪽으로 흐르지 않게(auth-guard 와 같은 방침)
  const grants = await prisma.$queryRawUnsafe<RoleGrantRow[]>(
    `SELECT role, status FROM "UserRoleGrant" WHERE "userId" = $1 AND status = 'ACTIVE'`,
    userId,
  ).catch(() => [] as RoleGrantRow[]);
  const roles = effectiveRoles({ primaryRole: user.role, grants, hasStudents: false });

  // 학부모 항목 = 지금 연결된(병합되지 않은) 자녀가 있을 때만. 학부모 계정은 화면 문지기와 같은 인증 조건도 본다
  const children = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
    `SELECT 1 AS one FROM "Student" s WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")} LIMIT 1`,
    userId,
  );
  let parent = children.length > 0;
  if (parent && user.role === "PARENT") {
    const verified = Boolean(user.phoneVerifiedAt) || user.username === null || (await hasGrantedChildren(userId));
    if (!verified) parent = false;
  }
  return { teacher: roles.teacher, parent };
}

/** 학원 일정 — 공개 연간일정표(/annual)와 같은 원본 */
export async function loadAcademyIcsEvents(): Promise<IcsEvent[]> {
  const { allEvents } = await loadAnnualPageData();
  return academyEventsToIcs(allEvents);
}

type ChildClassRow = FeedClass & { studentId: string; studentName: string; startsOn: string | null };

/**
 * 개인 일정 모으기. kinds 는 **이미 지금 역할로 거른 값**이어야 한다(라우트가 거른 뒤 넘긴다).
 * 수업일 = 지난달~다다음달의 연간일정 기준 수업일(휴무 제외) × 반의 수업 시간(KST).
 */
export async function loadPersonalIcsEvents(userId: string, kinds: readonly CalendarKind[]): Promise<IcsEvent[]> {
  const out: IcsEvent[] = [];
  if (kinds.includes("academy")) out.push(...(await loadAcademyIcsEvents()));

  const wantsTeaching = kinds.includes("teaching");
  const wantsChildren = kinds.includes("children");
  if (!wantsTeaching && !wantsChildren) return out;

  // 연간일정은 한 번만 읽어 모든 반에 다시 쓴다
  const planEvents = await loadAnnualPlanEvents();
  const months = feedMonths(todayKst());
  const monthlyDates = (ym: string, dow: string) => getMonthlyClassDates(planEvents, ym, dow);

  if (wantsTeaching) {
    // 원장·부원장도 «전체 반»이 아니라 본인이 코치로 연결된 반만
    const classes = await getCoachLinkedClassesForUser(userId);
    for (const cls of classes) {
      const dates = classDatesInRange(months, cls.dayOfWeek, null, monthlyDates);
      out.push(...classSessionsToIcs({ cls, dates, title: cls.name, uidScope: `teach-${opaqueId(userId)}` }));
    }
  }

  if (wantsChildren) {
    // 그 학부모의 아이(병합된 학생 제외) × 수강 중(ACTIVE)인 반. startsOn 은 DATE 라 글자로 꺼낸다
    const rows = await prisma.$queryRawUnsafe<ChildClassRow[]>(
      `SELECT s.id AS "studentId", s.name AS "studentName",
              c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.location,
              to_char(e."startsOn", 'YYYY-MM-DD') AS "startsOn"
         FROM "Student" s
         JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
         JOIN "Class" c ON c.id = e."classId"
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        ORDER BY s."createdAt" ASC, c.id ASC`,
      userId,
    );
    for (const row of rows) {
      // 수강 시작일 이전 수업은 넣지 않는다
      const dates = classDatesInRange(months, row.dayOfWeek, row.startsOn, monthlyDates);
      out.push(...classSessionsToIcs({
        cls: row,
        dates,
        title: `${row.studentName} · ${row.name}`,
        uidScope: `child-${opaqueId(row.studentId)}`,
      }));
    }
  }
  return out;
}

/** 요청한 항목을 «지금 역할»로 거른다 — 라우트·서버 기능이 같은 함수를 쓴다 */
export function kindsAllowedNow(requested: readonly CalendarKind[], access: FeedAccess | null): CalendarKind[] {
  return filterCalendarKinds(requested, allowedCalendarKinds(access));
}
