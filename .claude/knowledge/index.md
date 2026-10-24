# 프로젝트 지식 목차

## 파일별 요약
| 파일 | 항목 수 | 최종 업데이트 |
|------|--------|------------|
| architecture.md | 9 | 2026-08-08 |
| errors.md | 9 | 2026-10-24 |
| conventions.md | 24 | 2026-08-12 |
| decisions.md | 19 | 2026-08-09 |
| lessons.md | 4 | 2026-07-26 |

## ⚠️ 재발 다발 함정 (작업 전 반드시 확인)
- **날짜·시간** → 달력 값은 `@/lib/datetime/kst` 에서만. `toISOString().slice(0,10)`(새벽에 어제) ·
  `T00:00+09:00`+`getUTC*`(요일 하루 밀림, **T12:00 은 우연히 맞아서 더 위험**) · 서버의 `getDay()` 금지.
  강제: `tests/kst-datetime-guard.test.mjs` — ALLOW 목록은 갚아야 할 빚이라 **늘리면 깨진다**. → conventions
- **관리자 화면 신설** → 사이드바 NavItem + 탭 경로 2곳 등록을 테스트로 못박기(빠져도 아무 신호 없음) → conventions
- **DB 접근** → `$queryRawUnsafe`/`$executeRawUnsafe` 만(PgBouncer). ORM 기본 메서드 금지 → CLAUDE.md
- **schema.prisma 는 DB 의 사본** → 스프레드로 넘기면 tsc 가 못 잡고 운영에서만 죽는다 → errors
- **같은 규칙의 경로가 둘이면 양쪽을 같은 커밋에서** (학부모/관리자, 읽기/쓰기) — 한쪽만 고치면 DB 제약이
  UPDATE 를 통째로 거부하거나 조용히 무시된다. **사고 2회째.** 제약이 묶은 컬럼은 코드도 상수로 묶고
  제약과 같은 집합인지 테스트로 비교 → errors
- **apiSuccess snake_case 자동변환** · **IDOR** · **`prisma db push` 금지** → errors / decisions

## 최근 추가된 지식 (최근 5건)
1. [error] 같은 규칙의 두 입력 경로 중 한쪽만 고쳐 DB 제약이 UPDATE 를 거부 — 관리자가 셔틀 취소 불가였던 막힌 길
2. [convention] 날짜·시간은 `@/lib/datetime/kst` 한 곳에서만 — 금지 패턴 4종을 가드 테스트로 강제
3. [convention] 관리자 화면 신설 시 사이드바 등록을 테스트로 못박는다(화면만 남고 길이 사라진 사고 2회)
4. [error] start_url 끝 슬래시 하나로 PWA 가 시작하자마자 영역을 벗어난다 — start_url 은 리다이렉트까지 열어보고 확인
5. [error] scope 없는 manifest 하나가 같은 도메인의 다른 PWA 설치를 전부 막는다 — 빠진 필드는 "없음"이 아니라 기본값
