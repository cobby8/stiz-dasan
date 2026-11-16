import { requireStaff, requireVerifiedParent } from "@/lib/auth-guard";
import { pickLinkActor, type LinkActor } from "@/lib/account/login-methods-rules";

/**
 * 지금 로그인한 사람이 «간편로그인 연결»을 할 수 있는 누구인지 서버에서 정한다(2026-11-17).
 * 순서: 학부모 확인(기존 동작) → 아니면 직원 확인. 둘 다 아니면 null.
 * 판정은 앱 DB 의 계정으로만 한다(두 문지기 모두 그렇다) — 주소 파라미터·OAuth 메타데이터를 보지 않는다.
 * 연결 시작 라우트와 콜백이 함께 쓴다 → «누가 연결할 수 있나»와 «어느 화면으로 돌아가나»가 어긋나지 않는다.
 */
export async function resolveLinkActor(): Promise<LinkActor | null> {
  const parent = await requireVerifiedParent().then(() => true).catch(() => false);
  // 학부모 확인을 통과하면 직원 확인은 하지 않는다(조회를 아끼고, 기존 학부모 흐름을 그대로 둔다)
  const staff = parent ? false : await requireStaff().then(() => true).catch(() => false);
  return pickLinkActor({ parent, staff });
}
