# 학원 앱 라벤더·퍼플 적용 및 검증

2026-10-19 사용자 승인: 공식 로고를 보존하고, 라이트 라벤더·퍼플 시안을 실제 학원 업무 화면에 적용한다. 배포는 검증 결과 보고 후 별도로 결정한다.

## 적용 내용

| 영역 | 변경 경로 | 결과 |
|---|---|---|
| 공통 | `src/app/academy-theme.css`, `src/components/academy/AcademyTheme.tsx` | 배경 `#f7f4fb`, 주요 행동 `#7444a3`, 공통 글자·카드·버튼·포커스. 공식 로고는 원본 PNG와 비율 유지 |
| 테마 | `src/lib/academyTheme.ts`, `ThemeProvider`, `ThemeColorUpdater`, `ThemeToggle` | 학원 업무 경로만 라이트 고정. 공개 홈페이지의 기존 테마 선택은 복귀 시 복원 |
| 관리자 | `AdminShellClient`, `AdminDashboardClient`, `students/[id]/StudentDetailClient` | 밝은 메뉴·퍼플 활성 상태, 미처리 요청 우선, 상세 데이터 조회 후 오늘 수업 우선, 매출 추이 접기, 학생 상세 공통 표면 |
| 학부모 | `mypage/layout`, `MyPageClient`, `MyPageBottomNav` | 자녀 선택 버튼, 간결한 출결 요약, 수업·셔틀 요약과 요청 바로가기, 밝은 헤더·하단 메뉴 |
| 선생님 | `staff/layout`, `StaffHomeLink`, `StaffHomeClient`, `StaffBottomNav`, 수업 진행·셔틀 화면 | 공식 로고, 현재·다음 수업 카드 압축, 출결·공지 동선 유지 |
| 기사님 | `driver/layout`, `UnifiedDriverRunPage`, `UnifiedDriverClient` | 공식 로고, 라벤더 시간·길안내, 기존 우측 소형 운행 시작, 420px 이하 학생 정보와 체크 버튼 두 줄 |

API·인증·데이터 조회·저장·GPS·출결·청구·알림 함수는 변경하지 않았다. 처리 상태의 빨강·노랑·초록은 유지한다. 상담 기록을 실제 업무 반영이나 전달 완료로 승격하지 않는다. 시안의 예시 학생·요청·수업을 제품에 넣지 않았다.

학원 경로는 `/admin`, `/mypage`, `/staff`, `/driver` 및 기존 기사 링크 `/shuttle/run`, `/shuttle/regular`다. 공통 CSS는 `academy-app` 내부에만 적용하며 공개 홈페이지의 브랜드 색상 상수는 변경하지 않는다. Pretendard 기반 고딕 글꼴은 기존 지연 폰트 로더를 재사용하고, 아이콘은 기존 Material Symbols 경로를 사용한다.

## 검증 증거

- `node node_modules/typescript/bin/tsc --noEmit`: 통과.
- `node scripts/test-storage-delivery-status-browser.mjs`: 실제 React 화면의 저장·전달·공지·기사 재조회/GPS **18/18** 통과.
- `docs/storage-delivery-status.md`에 명시된 14개 회귀 파일을 `node --test`로 실행: **121/121** 통과. `.tmp/lavender-qa/regression.log`.
- 변경 TypeScript·JSX·테스트 도구 24개 파일을 ESLint API로 검사하고 같은 경로의 `HEAD` 원문과 비교했다. 신규 오류·경고 없음. 기존 오류 2건(관리자 effect, 루트 설정의 any)·이미지 경고 2건은 범위 밖으로 유지했다. `.tmp/lavender-qa/lint-current.json`.
- 독립 tester가 실제 TSX·Tailwind·라벤더 CSS를 격리 번들로 실행했다. 화면·기능 43건과 테마 복귀 6건, 총 **49/49** 통과. 4역할 × 1440/1024/768/390/320px, 320px 큰 글씨, 자녀 선택·요청·관리자 상세 조회·교사 공지·기사 POST→GET 재확인을 검사했다.
- 고딕 폰트 스택 보완 후 레이아웃 20건·큰 글씨 4건·테마/로고 12건·본문/제목 글꼴 4건, **40/40** 재검증. 기존 49건과 중복 합산하지 않는다. `.tmp/lavender-qa/typography-layout-report.json`, 최신 화면 캡처 8장.
- `localStorage.theme = system`, OS 다크에서 학원 진입 라이트 → 공개 경로 복귀 다크를 포함한 실제 `ThemeProvider` 검사 6건 통과. `.tmp/lavender-qa/theme-spa.json`.
- 공식 로고 원본 **1701×737** 로드, 색 변형 없이 `object-contain` 유지. 실행 오류·제품 외부 요청 0건. `.tmp/lavender-qa/report.json` 및 `{admin,parent,staff,driver}-{1440,390}.png`.
- 독립 코드 검토 통과. `next-themes`의 초기 `enableSystem` 캡처 문제를 피하기 위해 경로별로 `forcedTheme`만 변경한다.

## 검증 경계와 배포 전 확인

- 운영 로그인·운영 DB·실제 문자/푸시·위치 전송은 실행하지 않았다. 인증·서버 액션·통신은 테스트 대체 응답으로 차단한 화면 검증이다.
- 학부모 서버 레이아웃은 인증 유입을 피하기 위해 헤더를 테스트 구성으로 감쌌다. 실제 본문·하단 메뉴는 제품 코드이며, 선생님은 실제 홈 링크·하단 메뉴·본문을 실행했다.
- 외부 폰트 로더는 격리 검사에서 제외했다. 고딕 폰트 스택·아이콘 예약 공간은 확인했지만 실제 웹폰트 다운로드와 기기별 설치 앱의 표시 상태는 후속 환경 확인 대상이다.
- 전체 관리자 세부 화면을 새 배치로 다시 만든 것은 아니다. 대표 화면을 조정하고 하위 메뉴에는 공통 테마를 상속한다. 기존 모든 메뉴·실제 기능을 유지한다.
- 운영 반영·푸시·배포는 하지 않았다. 사용자의 검증 결과 확인 후 별도 승인 범위로 진행한다.
