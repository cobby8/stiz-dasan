# STIZ 농구교실 관리 시스템 — 개발 기록

**프로젝트**: STIZ 농구교실 (다산점) 학원 관리 + 홈페이지 통합 시스템
**기술 스택**: Next.js 16 + Supabase (PostgreSQL) + Prisma 5 + Vercel
**시작일**: 2026-02 (추정)
**최종 업데이트**: 2026-03-20

---

## 1. 프로젝트 목표

랠리즈(외부 학원 관리 서비스) 의존에서 벗어나, **자체 홈페이지 + 학원 운영 관리 시스템**을 구축한다.
- 학부모 대상 홈페이지 (학원 소개, 프로그램, 시간표, 갤러리, 공지사항)
- 관리자 대시보드 (원생/출결/수납/일정/갤러리/공지/요청 관리)
- 학부모 마이페이지 (자녀 출결/수납 확인, 알림, 학원 요청)

---

## 2. 기술 아키텍처 핵심 결정

| 결정사항 | 이유 |
|---------|------|
| `$queryRawUnsafe` 사용 (Prisma ORM 메서드 X) | Supabase PgBouncer 트랜잭션 모드가 prepared statement 차단 |
| ISR 캐싱 전략 (공개 5분, 관리자 30초) | 성능 최적화 + Server Action이 즉시 캐시 무효화 |
| Google Sheets CSV 파싱으로 시간표 | 기존 시간표 운영 방식 유지 |
| Supabase Auth 미들웨어 | `/admin/*` 경로 보호 |
| VAPID 기반 웹 푸시 | 앱 설치 없이 브라우저 푸시 알림 |

---

## 3. DB 스키마 (현재 모델 목록)

| 모델 | 용도 | Phase |
|------|------|-------|
| User | 사용자 (관리자/강사/학부모) | 초기 |
| Student | 원생 | 초기 |
| Program | 프로그램 (농구교실 종류) | 초기 |
| Class | 반 (프로그램 하위) | 초기 |
| Enrollment | 수강 등록 (학생↔반) | Phase 2 |
| Session | 수업 세션 (날짜별) | Phase 3 |
| Attendance | 출석 기록 | Phase 3 |
| Payment | 수납/결제 기록 | Phase 3 |
| Coach | 코치/강사 | 초기 |
| Route / Stop | 셔틀버스 노선/정류장 | 초기 |
| AcademySettings | 학원 설정 (싱글턴) | 초기 |
| ClassSlotOverride | 시간표 슬롯 오버라이드 | 초기 |
| CustomClassSlot | 커스텀 시간표 슬롯 | 초기 |
| SheetSlotCache | Google Sheets 캐시 | 초기 |
| AnnualEvent | 연간 일정 | 초기 |
| GalleryPost | 사진/영상 갤러리 | Phase 6 |
| Notice | 공지사항 | Phase 6 |
| Notification | 인앱 알림 | Phase 7 |
| PushSubscription | 웹 푸시 구독 정보 | Phase 7 |
| ParentRequest | 학부모 요청 (결석/셔틀 등) | Phase 8 |

---

## 4. 페이지 구조 (현재)

### 공개 페이지 (학부모/방문자용)
| 경로 | 용도 | 캐싱 |
|------|------|------|
| `/` | 메인 랜딩 | Static |
| `/about` | 학원/멤버 소개 | Static |
| `/programs` | 프로그램·수강료 | ISR 5분 |
| `/schedule` | 수업 시간표 | ISR 5분 |
| `/annual` | 연간 일정표 | ISR 5분 |
| `/apply` | 체험/수강 신청 | Static |
| `/gallery` | 사진/영상 갤러리 | ISR 1분 |
| `/notices` | 공지사항 목록 | ISR 1분 |
| `/notices/[id]` | 공지 상세 | Dynamic |
| `/login` | 로그인 | Static |
| `/mypage` | 학부모 마이페이지 | Dynamic |

### 관리자 페이지 (`/admin/*` — 로그인 보호)
| 경로 | 용도 |
|------|------|
| `/admin` | 경영 대시보드 (KPI, 차트, 요청, 오늘 수업, 신규 원생) |
| `/admin/settings` | 학원 소개 관리 |
| `/admin/programs` | 프로그램·이용약관 |
| `/admin/coaches` | 코치/강사진 관리 |
| `/admin/schedule` | 수업 시간표 관리 |
| `/admin/apply` | 체험/수강신청 관리 |
| `/admin/annual` | 연간일정 관리 |
| `/admin/gallery` | 사진/영상 갤러리 관리 |
| `/admin/notices` | 공지사항 관리 |
| `/admin/students` | 원생 관리 (CRUD) |
| `/admin/students/[id]` | 원생 상세 (출결/수납/수강 이력) |
| `/admin/attendance` | 출결 관리 |
| `/admin/finance` | 수납/결제 관리 |
| `/admin/requests` | 학부모 요청 관리 |
| `/admin/shuttle` | 셔틀버스 관제 |

### API 엔드포인트
| 경로 | 용도 |
|------|------|
| `/api/upload` | 이미지/파일 업로드 (Supabase Storage) |
| `/api/push` | 웹 푸시 구독 등록/해제 |
| `/api/admin/backup` | DB 백업 다운로드/복원 |
| `/api/admin/backup-now` | 즉시 클라우드 백업 |
| `/api/admin/cloud-backups` | 클라우드 백업 목록/복원/삭제 |
| `/api/admin/export-seed` | seed-data.ts 코드 생성 |
| `/api/admin/seed` | seed-data.ts로 DB 복구 |
| `/api/admin/attendance` | 출결 데이터 API |
| `/api/admin/finance` | 수납 데이터 API |
| `/api/admin/diagnostics` | DB 진단 |
| `/api/admin/sync-schedule` | 시간표 동기화 |
| `/api/cron/backup` | 자동 백업 (Vercel Cron) |
| `/api/cron/sync-schedule` | 시간표 자동 동기화 |

---

## 5. Phase별 개발 이력

### 초기 구축 (2026-02)
- 커밋: `88514bd` ~ `ca6b98b`
- 내용:
  - Next.js 16 + Supabase 프로젝트 셋업
  - 랜딩 페이지, 관리자 레이아웃 (사이드바)
  - Supabase Auth 로그인/회원가입
  - 학원 소개, 프로그램, 코치 관리
  - Google Calendar ICS → 연간일정 동기화
  - Google Sheets CSV → 수업 시간표 파싱
  - 셔틀버스 노선 관리
  - 체험/수강 신청 (구글폼 모달)
  - DB 백업/복원 시스템 (3-레이어)
  - PgBouncer 호환 쿼리 전환 (`$queryRawUnsafe`)
  - react.cache() + ISR 캐싱 성능 최적화

### Phase 1 — 학원 소개 콘텐츠 & 운영 기반 (2026-03-19)
- 커밋: `feac7ad`
- 변경 파일: 다수
- 내용:
  - 학원 소개 콘텐츠 관리 강화
  - 운영 기반 기능 추가

### Phase 2 — 원생 관리 CRUD, 반 관리, 수강 등록 (2026-03-19)
- 커밋: `62edc45`
- 변경 파일: `admin.ts`, `queries.ts`, `StudentManagementClient.tsx` 등
- 내용:
  - 원생 CRUD (이름, 생년월일, 성별, 학부모 정보)
  - 반 관리 개선
  - 수강 등록/해제 기능 (Enrollment)
  - 학부모 User 자동 생성 (이메일 기준)

### Phase 3 — 출결 관리 & 수납/결제 관리 (2026-03-19)
- 커밋: `7fe3991`
- 변경 파일: `admin.ts`, `queries.ts`, attendance/finance 페이지
- 내용:
  - 세션(Session) + 출석(Attendance) 기록
  - 반별 날짜별 출결 입력
  - 수납(Payment) CRUD (청구/납부/연체)
  - 수납 상태 변경 (PENDING → PAID)

### Phase 4 — 프로그램 이미지 & 홈페이지 포토갤러리 (2026-03-19)
- 커밋: `b17f4d8`
- 내용:
  - 프로그램별 이미지 업로드
  - 홈페이지 포토갤러리 (AcademySettings.galleryImagesJSON)

### Phase 5 — 마이페이지 실제 데이터 연동 (2026-03-20)
- 커밋: `b434876`
- 변경 파일: `MyPageClient.tsx`, `page.tsx`, `queries.ts`
- 내용:
  - 마이페이지에 실제 DB 데이터 연동
  - 자녀별 출결/수납 현황 표시
  - 수강 중인 반 목록 표시
  - 자녀 전환 (다자녀 지원)

### Phase 6 — 갤러리, 공지사항, 학생 상세 페이지 (2026-03-20)
- 커밋: `75e6252`
- 변경 파일: 21개 파일, +2,309줄
- 신규 DB 모델: `GalleryPost`, `Notice`
- 신규 페이지:
  - `/admin/gallery` — 관리자 갤러리 CRUD (사진/영상 업로드, 클래스별 분류)
  - `/admin/notices` — 관리자 공지사항 CRUD (전체/클래스별, 고정 기능)
  - `/gallery` — 공개 갤러리
  - `/notices`, `/notices/[id]` — 공개 공지사항
  - `/admin/students/[id]` — 원생 상세 (출결/수납 이력, 수강 관리)
- 마이페이지에 갤러리/공지 섹션 추가
- 랠리즈 → STIZ 전환 분석 보고서 작성 (`docs/rallyz-migration-report.md`)

### Phase 7 — 인앱 알림 + 웹 푸시 알림 시스템 (2026-03-20)
- 커밋: `3364907`
- 변경 파일: 8개 파일, +566줄
- 신규 DB 모델: `Notification`, `PushSubscription`
- 신규 파일:
  - `public/sw.js` — Service Worker (푸시 수신/표시/클릭)
  - `src/lib/pushNotification.ts` — 서버 푸시 발송 유틸 (web-push)
  - `src/app/api/push/route.ts` — 푸시 구독 등록/해제 API
- 내용:
  - 출결 저장 → 학부모 알림 (인앱 + 푸시)
  - 공지 작성 → 전체 학부모 알림
  - 수납 등록 → 해당 학부모 알림
  - 마이페이지 알림 탭 (뱃지, 개별/전체 읽음)
  - 푸시 ON/OFF 토글 (VAPID 인증)
  - 만료 구독 자동 정리 (410 Gone)

### Phase 8 — 학부모 요청 시스템 + 대시보드 개선 (2026-03-20)
- 커밋: `fe4eb70`
- 변경 파일: 9개 파일, +788줄
- 신규 DB 모델: `ParentRequest`
- 신규 페이지:
  - `/admin/requests` — 관리자 요청 관리 (필터, 상태 변경, 답변)
- 내용:
  - 학부모 마이페이지에서 요청 접수 (결석/셔틀/조퇴/기타)
  - 요청 유형 선택 + 자녀/날짜/내용 입력
  - 내 요청 내역 확인 (상태 + 관리자 답변)
  - 요청 접수 → 관리자에게 자동 알림 + 푸시
  - 요청 처리 → 학부모에게 결과 알림
  - 관리자 대시보드 개선:
    - 미처리 요청 배너 (노란색, 클릭 시 요청 관리로 이동)
    - 오늘의 수업 카드 (오늘 요일 기준 반 목록, 등록/정원)
    - 신규 원생 카드 (최근 7일)
    - 대기중 요청 미니 목록
  - 사이드바에 "학부모 요청" 메뉴 추가

### 보안 패치 — API 인증 + SQL 인젝션 수정 + PgBouncer 호환 (2026-03-20)
- 커밋: `e7651f3`
- 변경 파일: 14개 파일, +312줄 -54줄
- 내용:
  - **[보안]** `/api/admin/*` 전체 9개 API (16개 핸들러)에 Supabase Auth 인증 체크 추가
  - **[보안]** DELETE `/api/push`에 인증 체크 추가
  - **[보안]** SQL 인젝션 취약점 2건 수정 (reorderPrograms, reorderCoaches) → 파라미터 바인딩
  - **[안정성]** Prisma ORM 메서드 6곳 → `$executeRawUnsafe`/`$queryRawUnsafe` 전환 (PgBouncer 호환)
  - **[안정성]** `getAcademySettings`에서 `findUnique` + `$queryRaw` 태그드 템플릿 제거 → raw SQL 단일 쿼리
  - **[버그]** `getAllRequests` statusFilter 미적용 버그 수정

---

## 6. 랠리즈 대비 기능 현황 (2026-03-20 기준)

| 기능 | 랠리즈 | STIZ 현재 | 상태 |
|------|--------|-----------|------|
| 원생 관리 CRUD | O | O | 완료 |
| 클래스/반 관리 | O | O | 완료 |
| 수강 등록 | O | O | 완료 |
| 출결 관리 | O | O | 완료 |
| 학원비 수납/결제 | O (모바일결제) | O (수동기록) | 부분 완료 |
| 시간표 관리 | O | O (Sheets 연동) | 완료 |
| 코치/강사 관리 | O | O | 완료 |
| 학부모 마이페이지 | O | O | 완료 |
| 학부모 로그인 | O | O | 완료 |
| 연간 일정표 | O | O | 완료 |
| 프로그램 소개/가격 | O | O | 완료 |
| **사진/영상 갤러리** | O | **O** | **Phase 6 완료** |
| **공지사항** | O | **O** | **Phase 6 완료** |
| **알림 (인앱+푸시)** | O | **O** | **Phase 7 완료** |
| **학부모 요청 시스템** | X | **O** | **Phase 8 완료 (STIZ 우위)** |
| 홈페이지 (공개) | X | O | STIZ 우위 |
| 체험/수강 신청 | X | O | STIZ 우위 |
| 셔틀 관리 | X | O | STIZ 우위 |
| 자동 백업 | X | O | STIZ 우위 |
| 경영 대시보드 | X | O | STIZ 우위 |
| --- | --- | --- | --- |
| 실시간 채팅 | O | X | 미구현 |
| 모바일 간편결제 | O | X | 미구현 |
| 학습 현황/피드백 | O | X | 미구현 |
| 자료실 | O | X | 미구현 |
| 모바일 앱 (PWA) | O (iOS/Android) | X | 미구현 |

---

## 7. 남은 개발 계획

### 단기 (다음 Phase)
| 순위 | 기능 | 설명 | 난이도 |
|------|------|------|--------|
| 1 | **PWA 전환** | manifest.json + Service Worker + 앱 아이콘 → 앱 설치 가능 | 하 |
| 2 | **학습 현황/피드백** | 코치가 학생별 피드백 작성 → 학부모 마이페이지에서 확인 | 중 |

### 중기
| 순위 | 기능 | 설명 | 난이도 |
|------|------|------|--------|
| 3 | **모바일 결제 연동** | 토스페이먼츠/카카오페이 PG사 연동 | 상 |
| 4 | **자료실** | 수업 자료, 안내문 파일 공유 | 하 |

### 장기
| 순위 | 기능 | 설명 | 난이도 |
|------|------|------|--------|
| 5 | **실시간 채팅** | 코치-학부모 1:1 또는 그룹 채팅 | 상 |

---

## 8. 환경변수 목록

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=          # 프로젝트 URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=     # 공개 anon 키
SUPABASE_SERVICE_ROLE_KEY=         # 서비스 롤 키 (서버 전용)

# 데이터베이스
DATABASE_URL=                      # PgBouncer URL (포트 6543)
DIRECT_URL=                        # 직접 연결 URL (포트 5432, migrate용)

# 웹 푸시 알림
NEXT_PUBLIC_VAPID_PUBLIC_KEY=      # VAPID 공개키 (클라이언트)
VAPID_PRIVATE_KEY=                 # VAPID 비밀키 (서버)

# STIZ 본사 유니폼 주문 연동
STIZ_PARTNER_SECRET=               # 본사 API HMAC 서명 비밀키 (서버 전용)
STIZ_UNIFORM_ORDER_API_URL=        # 선택: 본사 주문 API URL override

# 선택사항
GOOGLE_CALENDAR_API_KEY=           # Google Calendar API v3
CRON_SECRET=                       # Vercel Cron 인증 토큰
```

---

## 9. 주요 파일 구조

```
src/
├── app/
│   ├── admin/
│   │   ├── layout.tsx              ← 사이드바 + 백업 버튼
│   │   ├── page.tsx                ← 경영 대시보드
│   │   ├── gallery/                ← 갤러리 관리
│   │   ├── notices/                ← 공지사항 관리
│   │   ├── requests/               ← 학부모 요청 관리
│   │   ├── students/[id]/          ← 원생 상세
│   │   └── ...
│   ├── api/
│   │   ├── push/route.ts           ← 푸시 구독 API
│   │   └── ...
│   ├── gallery/                    ← 공개 갤러리
│   ├── notices/                    ← 공개 공지사항
│   ├── mypage/                     ← 학부모 마이페이지
│   └── actions/admin.ts            ← 모든 Server Actions
├── lib/
│   ├── queries.ts                  ← 모든 DB 조회 함수
│   ├── pushNotification.ts         ← 웹 푸시 발송 유틸
│   └── supabase/middleware.ts      ← 인증 미들웨어
├── components/
│   └── PublicPageLayout.tsx        ← 공개 페이지 공통 레이아웃
public/
├── sw.js                           ← Service Worker (푸시)
prisma/
├── schema.prisma                   ← DB 스키마 (20개 모델)
└── seed-data.ts                    ← 핵심 데이터 스냅샷
docs/
├── development-log.md              ← 이 파일
└── rallyz-migration-report.md      ← 랠리즈 전환 분석
```
