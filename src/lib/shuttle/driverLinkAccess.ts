import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";

/**
 * 기사님 운행 링크(문자로 보내는 /driver/[token] 주소) 사용 스위치 + 링크 새로 만들기.
 *
 * 왜 필요한가: 운행 링크는 학원 공용 하나라, 퇴사한 기사님도 그 주소로 원생 명단·연락처를 계속 볼 수 있었다.
 * 원장 결정(2026-11-13): 기사님이 앱 계정으로 권한을 받으면 문자 링크를 끈다. 그 뒤엔 권한 있는 계정만 운행표를 본다.
 *
 * - 스위치 값은 AcademySettings."driverRunLinkEnabled"(기본 true = 지금처럼 링크로 열림).
 * - 끄면 토큰 주소 화면과 토큰으로 인증하는 API 가 전부 거부한다. 단, 로그인한 기사님·관리자(셔틀 권한)는
 *   계정 화면(/staff/run)이 같은 열쇠로 API 를 부르므로 그대로 통과시킨다 — 계정이 곧 열쇠다.
 * - 판정은 전부 서버에서 한다(화면에서 숨기는 것만으로는 주소를 아는 사람을 못 막는다).
 * - ⚠️ 토큰 값은 절대 로그에 남기지 않는다.
 * - PgBouncer 트랜잭션 모드 → $queryRawUnsafe / $executeRawUnsafe 만 쓴다.
 */

export const DRIVER_LINK_DISABLED_CODE = "DRIVER_LINK_DISABLED";
export const DRIVER_LINK_DISABLED_MESSAGE = "이 주소는 더 이상 쓰지 않습니다. 앱에서 로그인해 주세요.";

type RawDb = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;

// 마이그레이션이 아직 운영 DB 에 적용되기 전(칸이 없을 때)인지 — 그때는 지금 동작(켜짐)을 유지한다.
function isMissingColumnError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  return /driverRunLinkEnabled/.test(message) && /does not exist|42703/.test(message);
}

/**
 * 운행 링크 스위치가 켜져 있는지. 매번 DB 에서 바로 읽는다(캐시 없음 — 원장이 끄면 즉시 막혀야 한다).
 * - 설정 행이 없거나 칸이 아직 없으면 true(기존 동작 유지).
 * - 그 밖의 조회 실패는 false(닫힌 쪽). 이때는 토큰 확인 조회도 같이 실패하므로 운영상 차이가 없다.
 */
export async function isDriverRunLinkEnabled(db: RawDb = prisma): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe<{ enabled: boolean | null }[]>(
      `SELECT "driverRunLinkEnabled" AS enabled FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    );
    if (!rows.length) return true;
    return rows[0].enabled !== false;
  } catch (error) {
    if (isMissingColumnError(error)) return true;
    console.error("[driver-link] 운행 링크 스위치 조회 실패");
    return false;
  }
}

/** 로그인한 사람이 셔틀 권한(관리자·승인된 기사님)을 가졌는지. 로그인 안 했거나 권한 없으면 false. */
export async function hasLoggedInShuttleAccess(): Promise<boolean> {
  try {
    const staff = await requireStaff();
    return shuttleScope(staff.roles) !== "NONE";
  } catch {
    return false;
  }
}

/**
 * 토큰 API 문지기 — 토큰 확인을 통과한 «다음에» 부른다.
 * true 면 막아야 한다(스위치가 꺼졌고, 셔틀 권한 있는 로그인 사용자도 아님).
 * 스위치가 켜져 있으면 로그인 조회를 하지 않는다(지금 동작·속도 그대로).
 */
export async function driverLinkBlocked(): Promise<boolean> {
  if (await isDriverRunLinkEnabled()) return false;
  return !(await hasLoggedInShuttleAccess());
}

/** 링크가 꺼졌을 때의 API 응답 — 410(이 주소는 이제 없음). 화면은 code 를 보고 안내할 수 있다. */
export function driverLinkDisabledResponse() {
  return NextResponse.json(
    { error: DRIVER_LINK_DISABLED_MESSAGE, code: DRIVER_LINK_DISABLED_CODE },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

/** 관리자: 스위치 켜기/끄기. */
export async function setDriverRunLinkEnabled(enabled: boolean, db: RawDb = prisma): Promise<{ enabled: boolean }> {
  await requireAdmin();
  const changed = Number(await db.$executeRawUnsafe(
    `UPDATE "AcademySettings" SET "driverRunLinkEnabled" = $1, "updatedAt" = now() WHERE id = 'singleton'`,
    enabled,
  )) || 0;
  if (changed !== 1) throw new Error("학원 설정을 찾지 못했습니다.");
  return { enabled };
}

/**
 * 관리자: 운행 링크 새로 만들기 — 모든 운행 링크(정규 고정·특강 고정·특강 날짜별)의 열쇠를 새것으로 바꾼다.
 * 바꾸는 순간 이전 주소는 전부 «유효하지 않은 링크»가 된다(기사님 기기에 기억된 주소 포함).
 *
 * 순서가 중요하다(한 트랜잭션):
 *  1) 앱 위치 전송 세션을 지운다 — 세션 표가 열쇠를 참조(외래키, ON UPDATE 없음)라 먼저 지워야 열쇠를 바꿀 수 있고,
 *     옛 열쇠로 시작한 위치 전송도 함께 끊긴다.
 *  2) 옛 열쇠의 마지막 위치를 «공유 중 아님»으로 — 옛 위치가 지금 위치처럼 보이지 않게.
 *  3) 열쇠 교체 — gen_random_uuid()(DB 의 암호학적 난수, 122비트)를 32자 16진수로. 기존 형식 검사(/^[a-f0-9]{16,64}$/) 통과.
 * 날짜·방향·만든 사람은 그대로라 관리자 «링크 복사» 버튼은 새 주소를 돌려준다.
 */
export async function rotateDriverRunLinks(): Promise<{ rotated: number }> {
  await requireAdmin();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ token: string }[]>(`SELECT token FROM "ShuttleRunLink" FOR UPDATE`);
    if (!rows.length) return { rotated: 0 };
    const oldTokens = rows.map((row) => String(row.token));
    const ready = await tx.$queryRawUnsafe<{ ready: boolean }[]>(
      `SELECT to_regclass('public."DriverMobileTrackingSession"') IS NOT NULL AS ready`,
    );
    if (ready[0]?.ready) {
      await tx.$executeRawUnsafe(`DELETE FROM "DriverMobileTrackingSession" WHERE token = ANY($1::text[])`, oldTokens);
    }
    await tx.$executeRawUnsafe(`UPDATE "DriverLocation" SET sharing = false WHERE token = ANY($1::text[])`, oldTokens);
    const rotated = Number(await tx.$executeRawUnsafe(
      `UPDATE "ShuttleRunLink" SET token = replace(gen_random_uuid()::text, '-', ''), "createdAt" = now()`,
    )) || 0;
    return { rotated };
  });
}
