# 프로젝트 지식 목차

## 파일별 요약
| 파일 | 항목 수 | 최종 업데이트 |
|------|--------|------------|
| architecture.md | 14 | 2026-10-23 |
| errors.md | 9 | 2026-10-24 |
| conventions.md | 29 | 2026-10-25 |
| decisions.md | 20 | 2026-10-06 |
| lessons.md | 6 | 2026-10-02 |

## ⚠️ 재발 다발 함정 (작업 전 반드시 확인)
- **날짜·시간** → 달력 값은 `@/lib/datetime/kst` 에서만. `toISOString().slice(0,10)`(새벽에 어제) ·
  `T00:00+09:00`+`getUTC*`(요일 하루 밀림, **T12:00 은 우연히 맞아서 더 위험**) · 서버의 `getDay()` 금지.
  강제: `tests/kst-datetime-guard.test.mjs` — ALLOW 목록은 갚아야 할 빚이라 **늘리면 깨진다**. → conventions
- **관리자 화면 신설** → `AdminShellClient` 의 `EXTRA_GROUPS` 에 메뉴 등록 + 그 링크를 테스트로 못박기
  (빠져도 빌드·tsc·테스트가 통과해 아무 신호 없음. 사고 2회). 「경로 3회」는 폐기된 옛 기준 → conventions
- **DB 접근** → `$queryRawUnsafe`/`$executeRawUnsafe` 만(PgBouncer). ORM 기본 메서드 금지 → CLAUDE.md
- **schema.prisma 는 DB 의 사본** → 스프레드로 넘기면 tsc 가 못 잡고 운영에서만 죽는다 → errors
- **같은 규칙의 경로가 둘이면 양쪽을 같은 커밋에서** (학부모/관리자, 읽기/쓰기) — 한쪽만 고치면 DB 제약이
  UPDATE 를 통째로 거부하거나 조용히 무시된다. **사고 2회째.** 제약이 묶은 컬럼은 코드도 상수로 묶고
  제약과 같은 집합인지 테스트로 비교 → errors
- **apiSuccess snake_case 자동변환** · **IDOR** · **`prisma db push` 금지** → errors / decisions

## 최근 추가된 지식 (최근 5건)
1. [convention] 관리자 메뉴 등록 검사 기준 정정 — 셸이 EXTRA_GROUPS 로 통합돼 「경로 3회」 기준은 폐기 (2026-10-25)
2. [error] 같은 규칙의 두 입력 경로 중 한쪽만 고쳐 DB 제약이 UPDATE 를 거부 — 관리자가 셔틀 취소 불가였던 막힌 길 (2026-10-24)
3. [architecture] 체험↔수강신청 연결 = 순수 판정(trialLeadMatch)+연결부(trialLeadLinkService) 한 곳, 비교 시점 3곳 (2026-10-23)
4. [architecture] 카카오 보강 신청·취소 대화 = KakaoParentIntake(MAKEUP_FLOW) 상태 + parent-makeup 함수 그대로, 「결석·보강」 메뉴 제외 (2026-10-17)
5. [architecture] 카카오 정책 답변 = 순수 엔진(kakao-policy-qa)+연결부(service)+챗봇 hook, null 이면 기존 흐름 (2026-10-09)
