import { prisma } from "@/lib/prisma";
import { isDriverRunInProgress } from "@/lib/staff-session-rules";

/**
 * 오늘 운행이 «진행 중»인가 — 기사님 첫 화면(/staff/driver)이 «명단으로 보낼지·운행 화면으로 바로 넘길지» 정할 때만 쓴다(2026-11-18 F 보완).
 *
 * 근거: 고정 운행 링크(ShuttleRunLink 의 serviceDate='ROLLING' — src/lib/shuttle/regularRun.ts 와 같은 조건)에 딸린
 *       위치 기록(DriverLocation) 한 줄. 운행 화면이 위치를 보낼 때마다 updatedAt 이 now() 로 갱신되고, 운행을 끝내면 sharing=false 가 된다.
 *
 * - 열쇠(token)는 읽어 오지 않는다 — 이어 붙이는 데만 쓰고 «공유 여부·몇 초 전»만 꺼낸다
 *   (열쇠를 돌려주는 함수는 운행표 화면 두 곳에서만 부른다는 약속 — tests/staff-run-login.test.mjs — 을 건드리지 않는다. 그 함수 이름도 여기 적지 않는다: 그 테스트가 이름으로 찾는다)
 * - 경과 시간은 DB 시계로 잰다(now() - "updatedAt", updatedAt 은 timestamptz) — 서버(UTC)·기기 시계를 쓰지 않는다
 * - 위치 기록은 학원 공용 고정 링크에 한 줄이라 «어느 기사님»인지는 가르지 못한다. 다른 기사님이 운행 중이어도 진행 중으로 본다
 *   (그 경우 예전처럼 운행 화면이 먼저 열릴 뿐이고, «←» 로 명단에 갈 수 있다)
 * - 조회가 실패하면 false(= 명단으로) — 첫 화면을 막지 않는다
 * 부르는 쪽이 requireStaff + 셔틀 권한을 먼저 확인한다.
 */
export async function hasDriverRunInProgress(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ sharing: boolean; secondsAgo: number }[]>(
      `SELECT l.sharing AS "sharing",
              EXTRACT(EPOCH FROM (now() - l."updatedAt"))::int AS "secondsAgo"
         FROM "DriverLocation" l
         JOIN "ShuttleRunLink" r ON r.token = l.token
        WHERE r."serviceDate" = 'ROLLING' AND r."direction" IN ('REGULAR', 'ALL')
        ORDER BY l."updatedAt" DESC
        LIMIT 1`,
    );
    return isDriverRunInProgress(rows[0]);
  } catch {
    return false;
  }
}
