// DB 접속 주소의 «동시 연결 수» 항목만 바꿔 끼우는 순수 함수(2026-11-16 원장 지시 «DB 동시 연결 수 올리기 진행해»).
//
// 왜: 서버 한 대가 DB 에 동시에 여는 연결 수는 접속 주소 끝의 `connection_limit=` 로 정해진다(예전 값 5).
//   학부모 홈처럼 한 화면이 조회를 10개 넘게 동시에 내면 5줄로 줄을 서서 느려졌고, 11-14 에는 대기 초과(P2024)도 났다.
//   접속 주소는 비밀 값이라 운영 설정을 직접 고치는 대신, 코드에서 그 항목 «하나»만 바꿔 Prisma 에 넘긴다.
//
// 지키는 것
//   - 주소의 나머지(계정·비밀번호·호스트·다른 항목)는 한 글자도 건드리지 않는다 — 물음표 뒤의 항목 목록만 다룬다.
//   - 이 파일은 주소를 기록(log)하지 않는다. 테스트가 그대로 실행한다(prisma·next import 금지).
//
// 여유 확인(2026-11-16): DB 최대 60, 연결 풀러가 쥔 실제 연결 15. 서버 한 대 10 은 그 안쪽이다.
//   여러 서버가 동시에 떠도 풀러가 줄을 세우므로 DB 한도를 넘지 않는다.

/** 서버 한 대의 기본 동시 연결 수 */
export const DEFAULT_CONNECTION_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 30;

/** 환경변수(PRISMA_CONNECTION_LIMIT)로 덮어쓸 때의 값 — 1~30 정수가 아니면 기본값 */
export function resolveConnectionLimit(raw: string | undefined | null): number {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) return DEFAULT_CONNECTION_LIMIT;
  const value = Number(text);
  return value >= MIN_LIMIT && value <= MAX_LIMIT ? value : DEFAULT_CONNECTION_LIMIT;
}

/**
 * 접속 주소의 connection_limit 항목을 limit 으로 바꾼다(없으면 붙인다). 그 밖의 글자는 그대로.
 * 주소가 비었으면 그대로 돌려준다(호출부가 기본 설정으로 연다).
 */
export function withConnectionLimit(url: string | undefined | null, limit: number): string {
  const source = String(url ?? "");
  if (!source) return source;
  const hashAt = source.indexOf("#");
  const body = hashAt >= 0 ? source.slice(0, hashAt) : source;
  const hash = hashAt >= 0 ? source.slice(hashAt) : "";
  const queryAt = body.indexOf("?");
  const base = queryAt >= 0 ? body.slice(0, queryAt) : body;
  const query = queryAt >= 0 ? body.slice(queryAt + 1) : "";
  const kept = query.split("&").filter((part) => part !== "" && !/^connection_limit=/i.test(part));
  kept.push(`connection_limit=${limit}`);
  return `${base}?${kept.join("&")}${hash}`;
}
