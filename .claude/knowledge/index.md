# 프로젝트 지식 목차

## 파일별 요약
| 파일 | 항목 수 | 최종 업데이트 |
|------|--------|------------|
| architecture.md | 14 | 2026-10-23 |
| errors.md | 8 | 2026-08-09 |
| conventions.md | 29 | 2026-10-02 |
| decisions.md | 20 | 2026-10-06 |
| lessons.md | 6 | 2026-10-02 |

## ⚠️ 재발 다발 함정 (작업 전 반드시 확인)
- **날짜·시간** → 달력 값은 `@/lib/datetime/kst` 에서만. `toISOString().slice(0,10)`(새벽에 어제) ·
  `T00:00+09:00`+`getUTC*`(요일 하루 밀림, **T12:00 은 우연히 맞아서 더 위험**) · 서버의 `getDay()` 금지.
  강제: `tests/kst-datetime-guard.test.mjs` — ALLOW 목록은 갚아야 할 빚이라 **늘리면 깨진다**. → conventions
- **관리자 화면 신설** → 사이드바 NavItem + 탭 경로 2곳 등록을 테스트로 못박기(빠져도 아무 신호 없음) → conventions
- **DB 접근** → `$queryRawUnsafe`/`$executeRawUnsafe` 만(PgBouncer). ORM 기본 메서드 금지 → CLAUDE.md
- **schema.prisma 는 DB 의 사본** → 스프레드로 넘기면 tsc 가 못 잡고 운영에서만 죽는다 → errors
- **apiSuccess snake_case 자동변환** · **IDOR** · **`prisma db push` 금지** → errors / decisions

## 최근 추가된 지식 (최근 5건)
1. [architecture] 체험↔수강신청 연결 = 순수 판정(trialLeadMatch)+연결부(trialLeadLinkService) 한 곳, 비교 시점 3곳 (2026-10-23)
2. [architecture] 카카오 보강 신청·취소 대화 = KakaoParentIntake(MAKEUP_FLOW) 상태 + parent-makeup 함수 그대로, 「결석·보강」 메뉴 제외 (2026-10-17)
3. [architecture] 카카오 정책 답변 = 순수 엔진(kakao-policy-qa)+연결부(service)+챗봇 hook, null 이면 기존 흐름 (2026-10-09)
4. [decision] 청구 안내=랠리즈 전담(사이트 발송 기본 잠금)·시트 원장 은퇴(SHEET SKIPPED)·장부 원천=랠리즈 (2026-10-06)
5. [convention] CLI·웹앱이 같이 쓰는 계산은 `src/lib/**` 에 `.mjs` 한 벌 — 사본 0을 테스트로 고정
