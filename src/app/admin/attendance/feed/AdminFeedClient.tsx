"use client";

import { adminErrorText } from "@/components/admin/adminDisplayText";
import { useCallback, useEffect, useRef, useState } from "react";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { SessionReportEditorLoader } from "@/components/admin/SessionReportEditor";
import { SessionVideoList } from "@/components/parent/SessionVideoPlayer";
import {
    ADMIN_FEED_DAYS_OPTIONS,
    adminFeedFilterToParams,
    appendAdminFeedItems,
    countActiveFilters,
    DEFAULT_ADMIN_FEED_FILTER,
    feedDateHeading,
    feedPostHeading,
    needsDateDivider,
    WEEKDAY_LABELS,
    WEEKDAY_ORDER,
    type AdminFeedFacets,
    type AdminFeedFilter,
    type AdminFeedItem,
} from "@/lib/feed/adminFeedRules";

const PUBLISH_OPTIONS: Array<{ value: AdminFeedFilter["publish"]; label: string }> = [
    { value: "ALL", label: "전체" },
    { value: "PUBLISHED", label: "발행됨" },
    { value: "DRAFT", label: "미발행" },
];

// PC(오른쪽 고정 패널) / 휴대폰(아래 시트) 경계 = Tailwind lg
const DESKTOP_QUERY = "(min-width: 1024px)";

/** 지금 화면이 PC 폭인가 — 첫 그리기는 false(서버와 같게), 붙은 뒤 실제 값으로 */
function useIsDesktop(): boolean {
    const [desktop, setDesktop] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia(DESKTOP_QUERY);
        const update = () => setDesktop(mq.matches);
        update();
        mq.addEventListener("change", update);
        return () => mq.removeEventListener("change", update);
    }, []);
    return desktop;
}

function PublishBadge({ item }: { item: AdminFeedItem }) {
    if (item.status === "IN_PROGRESS") {
        return <span className="inline-flex shrink-0 rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">수업 중</span>;
    }
    return item.published ? (
        <span className="inline-flex shrink-0 rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-success)]">발행됨</span>
    ) : (
        <span className="inline-flex shrink-0 rounded-full bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-muted)]">미발행</span>
    );
}

/**
 * 사진 여러 장 가로로 넘겨 보기 — 라이브러리 없이 CSS scroll-snap 만.
 * 휴대폰은 손가락으로 밀고, PC 는 양옆 «‹ ›» 글자 버튼으로 한 장씩 넘긴다.
 */
function PhotoCarousel({ photos, label }: { photos: string[]; label: string }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const [index, setIndex] = useState(0);
    const count = photos.length;

    function handleScroll() {
        const el = scrollerRef.current;
        if (!el || el.clientWidth === 0) return;
        setIndex(Math.min(count - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth))));
    }

    function go(delta: number) {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollBy({ left: delta * el.clientWidth, behavior: "smooth" });
    }

    return (
        <div className="relative bg-[var(--color-academy-soft)]">
            <div
                ref={scrollerRef}
                onScroll={handleScroll}
                className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                aria-label={`${label} 사진 ${count}장`}
            >
                {photos.map((src, i) => (
                    // 비공개 사진은 권한 검사 라우트로만 열린다(관리자 = 전체 반)
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        key={src}
                        src={src}
                        alt={`수업 사진 ${i + 1}/${count}`}
                        loading="lazy"
                        className="aspect-[4/3] w-full shrink-0 snap-center object-cover"
                    />
                ))}
            </div>
            {count > 1 && (
                <>
                    <span className="absolute right-2 top-2 rounded-full bg-[var(--color-academy-ink)] px-2 py-0.5 text-xs tabular-nums text-[var(--color-academy-on-primary)]">
                        {index + 1}/{count}
                    </span>
                    {index > 0 && (
                        <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); go(-1); }}
                            aria-label="이전 사진"
                            className="absolute left-1 top-1/2 grid min-h-11 min-w-11 -translate-y-1/2 place-items-center rounded-full bg-[var(--color-academy-surface)] text-lg text-[var(--color-academy-ink)] shadow-sm"
                        >
                            ‹
                        </button>
                    )}
                    {index < count - 1 && (
                        <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); go(1); }}
                            aria-label="다음 사진"
                            className="absolute right-1 top-1/2 grid min-h-11 min-w-11 -translate-y-1/2 place-items-center rounded-full bg-[var(--color-academy-surface)] text-lg text-[var(--color-academy-ink)] shadow-sm"
                        >
                            ›
                        </button>
                    )}
                </>
            )}
        </div>
    );
}

type FeedPageResponse = { items?: AdminFeedItem[]; nextCursor?: string | null; facets?: AdminFeedFacets; error?: string };

export default function AdminFeedClient({
    initialItems,
    initialNextCursor,
    initialFacets,
}: {
    initialItems: AdminFeedItem[];
    initialNextCursor: string | null;
    initialFacets: AdminFeedFacets;
}) {
    // 실제 화면 폭(PC 인가)
    const screenDesktop = useIsDesktop();

    // ── 피드 목록 ──
    const [items, setItems] = useState<AdminFeedItem[]>(initialItems);
    const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
    const [facets, setFacets] = useState<AdminFeedFacets>(initialFacets);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    // 필터를 바꾸는 동안 늦게 도착한 옛 응답을 버리기 위한 번호
    const requestIdRef = useRef(0);
    const loadingRef = useRef(false);

    // ── 필터(모달) ──
    const [filter, setFilter] = useState<AdminFeedFilter>(DEFAULT_ADMIN_FEED_FILTER);
    const [draft, setDraft] = useState<AdminFeedFilter>(DEFAULT_ADMIN_FEED_FILTER);
    const [filterOpen, setFilterOpen] = useState(false);
    const activeFilterCount = countActiveFilters(filter);

    // ── 편집 패널 ──
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // 편집 중 저장하지 않은 수정이 있는가(편집 부품이 알려 준다)
    const [dirty, setDirty] = useState(false);
    // 수정이 남은 채 다른 게시물로 옮기거나 닫으려 할 때 — 어디로 가려 했는지(null = 닫기)
    const [pendingMove, setPendingMove] = useState<{ to: string | null } | null>(null);
    const selectedItem = selectedId ? items.find((item) => item.sessionId === selectedId) ?? null : null;

    // 편집기를 어디에 둘지(PC 패널 / 휴대폰 시트). 폭이 바뀌어도 저장 안 한 수정이 있으면 자리를 옮기지 않는다 —
    // 자리를 옮기면 편집 부품이 새로 그려져 쓰던 내용이 사라지기 때문(저장하면 그때 실제 폭을 따른다)
    const [isDesktop, setIsDesktop] = useState(false);
    useEffect(() => {
        if (!dirty) setIsDesktop(screenDesktop);
    }, [screenDesktop, dirty]);
    // PC 패널에서 수정 중인데 화면이 좁아졌다 — 패널을 피드 위로 올려 보이게 둔다
    const narrowWhileEditing = isDesktop && !screenDesktop;

    // 저장 안 한 수정 확인 문구가 뜨면 화면 안으로 끌어온다(휴대폰 시트 아래쪽에 있어도 보이게)
    const pendingRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (pendingMove) pendingRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [pendingMove]);

    const fetchPage = useCallback(async (target: AdminFeedFilter, cursor: string | null): Promise<FeedPageResponse> => {
        const params = adminFeedFilterToParams(target);
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/admin/feed?${params.toString()}`, { cache: "no-store" });
        const body = (await response.json().catch(() => ({}))) as FeedPageResponse;
        if (!response.ok) throw new Error(body.error || "수업 피드를 불러오지 못했습니다.");
        return body;
    }, []);

    // 다음 20개 — 끝에 닿거나 «더 보기»를 누르면
    const loadMore = useCallback(async () => {
        if (loadingRef.current || !nextCursor) return;
        loadingRef.current = true;
        setLoading(true);
        setLoadError(null);
        const requestId = requestIdRef.current;
        try {
            const body = await fetchPage(filter, nextCursor);
            if (requestId !== requestIdRef.current) return; // 그 사이 필터가 바뀌었다
            setItems((prev) => appendAdminFeedItems(prev, body.items ?? []));
            setNextCursor(body.nextCursor ?? null);
        } catch (error) {
            if (requestId === requestIdRef.current) setLoadError(adminErrorText(error, "수업 피드를 불러오지 못했습니다."));
        } finally {
            if (requestId === requestIdRef.current) {
                loadingRef.current = false;
                setLoading(false);
            }
        }
    }, [fetchPage, filter, nextCursor]);

    // 필터 적용 — 첫 20개부터 다시 받는다
    const reload = useCallback(async (target: AdminFeedFilter) => {
        const requestId = ++requestIdRef.current;
        loadingRef.current = true;
        setLoading(true);
        setLoadError(null);
        setItems([]);
        setNextCursor(null);
        try {
            const body = await fetchPage(target, null);
            if (requestId !== requestIdRef.current) return;
            setItems(body.items ?? []);
            setNextCursor(body.nextCursor ?? null);
            if (body.facets) setFacets(body.facets);
        } catch (error) {
            if (requestId === requestIdRef.current) setLoadError(adminErrorText(error, "수업 피드를 불러오지 못했습니다."));
        } finally {
            if (requestId === requestIdRef.current) {
                loadingRef.current = false;
                setLoading(false);
            }
        }
    }, [fetchPage]);

    // 끝 표시(sentinel)가 화면 가까이 오면 다음 20개 — 지원 안 되는 브라우저는 «더 보기» 버튼으로
    const sentinelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || !nextCursor || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) void loadMore();
        }, { rootMargin: "600px 0px" });
        observer.observe(el);
        return () => observer.disconnect();
    }, [nextCursor, loadMore]);

    // 편집 패널에서 저장·발행한 뒤 그 게시물 카드만 다시 읽어 바꿔 끼운다
    const refreshItem = useCallback(async (sessionId: string) => {
        try {
            const response = await fetch(`/api/admin/feed?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
            if (!response.ok) return;
            const body = (await response.json()) as { item?: AdminFeedItem };
            if (!body.item) return;
            setItems((prev) => prev.map((item) => (item.sessionId === sessionId ? body.item! : item)));
        } catch {
            // 카드 갱신 실패는 조용히 넘긴다 — 저장 자체는 끝났다
        }
    }, []);

    // 게시물 고르기·닫기 — 저장 안 한 수정이 있으면 먼저 묻는다
    function moveTo(to: string | null) {
        if (to === selectedId) return;
        if (dirty) {
            setPendingMove({ to });
            return;
        }
        setPendingMove(null);
        setDirty(false);
        setSelectedId(to);
    }

    function confirmMove() {
        const to = pendingMove?.to ?? null;
        setPendingMove(null);
        setDirty(false);
        setSelectedId(to);
    }

    function openFilter() {
        setDraft(filter);
        setFilterOpen(true);
    }

    function applyFilter() {
        setFilterOpen(false);
        setFilter(draft);
        void reload(draft);
    }

    // 편집 패널 안쪽(PC 고정 패널·휴대폰 시트 공용)
    function renderEditor(sessionId: string) {
        return (
            <div className="min-w-0">
                <div className="mb-2 flex items-start gap-2">
                    <h2 id="admin-feed-editor-title" className="min-w-0 flex-1 break-keep text-base font-bold text-[var(--color-academy-ink)]">
                        {selectedItem ? feedPostHeading(selectedItem) : "수업 편집"}
                    </h2>
                    {selectedItem && <PublishBadge item={selectedItem} />}
                    <button type="button" onClick={() => moveTo(null)} className="academy-button-text academy-button-sm shrink-0">닫기</button>
                </div>
                {pendingMove && (
                    // 저장 안 한 수정이 남은 채 옮기려 할 때 — 그 자리에서 한 번 묻는다
                    <div ref={pendingRef} role="alert" className="mb-3 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-warning-soft)] p-3">
                        <p className="text-sm text-[var(--color-academy-ink)]">저장하지 않은 수정이 있습니다. 버리고 {pendingMove.to ? "다른 수업으로 옮길까요" : "닫을까요"}?</p>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                            <button type="button" onClick={() => setPendingMove(null)} className="academy-button-secondary academy-button-sm">계속 편집</button>
                            <button type="button" onClick={confirmMove} className="academy-button-danger academy-button-sm">버리고 {pendingMove.to ? "옮기기" : "닫기"}</button>
                        </div>
                    </div>
                )}
                <SessionReportEditorLoader
                    key={sessionId}
                    sessionId={sessionId}
                    onSaved={() => void refreshItem(sessionId)}
                    onPublishedChange={() => void refreshItem(sessionId)}
                    onDirtyChange={setDirty}
                />
            </div>
        );
    }

    function renderPost(item: AdminFeedItem) {
        const heading = feedPostHeading(item);
        const selected = item.sessionId === selectedId;
        return (
            <article
                key={item.sessionId}
                aria-label={heading}
                // PC 에서는 게시물 아무 곳이나 누르면 오른쪽 패널에서 편집(휴대폰은 «편집» 버튼만 — 스크롤 중 잘못 열림 방지)
                onClick={() => { if (isDesktop) moveTo(item.sessionId); }}
                className={`overflow-hidden rounded-xl border bg-[var(--color-academy-surface)] ${isDesktop ? "cursor-pointer" : ""} ${
                    selected ? "border-[var(--color-academy-secondary)] ring-1 ring-[var(--color-academy-secondary)]" : "border-[var(--color-academy-line)]"
                }`}
            >
                {/* 머리줄: 반 · 날짜 시각 · 선생님 + 발행 상태 + 편집 */}
                <header className="flex items-center gap-2 py-1 pl-3 pr-1">
                    <p className="min-w-0 flex-1 break-keep text-sm font-semibold text-[var(--color-academy-ink)]">{heading}</p>
                    <PublishBadge item={item} />
                    <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); moveTo(item.sessionId); }}
                        aria-label={`${heading} 편집`}
                        aria-pressed={selected}
                        className="academy-button-text academy-button-sm min-h-11 shrink-0"
                    >
                        편집
                    </button>
                </header>

                {item.photos.length > 0 && <PhotoCarousel photos={item.photos} label={heading} />}

                {item.videoCount > 0 && (
                    // 영상 재생 — 학부모 소식과 같은 부품, 정보는 선생님 라우트(관리자 = 전체 반)에서 받는다
                    <div className="px-3 pt-2" onClick={(event) => event.stopPropagation()}>
                        <SessionVideoList
                            sessionId={item.sessionId}
                            endpoint={`/api/staff/sessions/${encodeURIComponent(item.sessionId)}/videos`}
                            className="grid gap-2"
                        />
                    </div>
                )}

                <div className="px-3 pb-2.5 pt-2 text-sm">
                    {item.topic && <p className="mb-0.5 text-xs font-medium text-[var(--color-academy-muted)]">{item.topic}</p>}
                    {item.content ? (
                        <p className="whitespace-pre-wrap break-words text-[var(--color-academy-ink)]">{item.content}</p>
                    ) : (
                        <p className="text-[var(--color-academy-muted)]">아직 쓴 수업 한 줄이 없습니다.</p>
                    )}
                    <p className="mt-1.5 text-xs text-[var(--color-academy-muted)]">
                        <span className="tabular-nums">사진 {item.photoCount} · 영상 {item.videoCount}</span>
                        {item.photoCount > item.photos.length && <> · 앞 <span className="tabular-nums">{item.photos.length}</span>장만 표시</>}
                        {item.endedByName && <> · 종료 처리 {item.endedByName}</>}
                    </p>
                </div>
            </article>
        );
    }

    return (
        <div className="mx-auto flex max-w-[1080px] flex-col items-start gap-4 lg:flex-row">
            {/* 왼쪽: 피드 — 읽기 좋은 폭(최대 600px) */}
            <div className="w-full min-w-0 flex-1 lg:max-w-[600px]">
                <AdminPageHeader
                    className="mb-2"
                    title="수업 피드"
                    description={
                        <>
                            최근 <span className="tabular-nums">{filter.days}</span>일 · <span className="tabular-nums">{items.length}</span>개 표시{nextCursor ? " · 아래로 내리면 더 보입니다" : ""}
                        </>
                    }
                    actions={
                        <button type="button" onClick={openFilter} className="academy-button-secondary academy-button-sm">
                            필터{activeFilterCount > 0 && <> <span className="tabular-nums">{activeFilterCount}</span></>}
                        </button>
                    }
                />

                {items.length === 0 && !loading && !loadError ? (
                    <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                        {activeFilterCount > 0
                            ? "조건에 맞는 수업이 없습니다."
                            : "선생님이 올린 사진·영상·한 줄이 없습니다. 필터에서 «내용 없는 수업도 보기»를 켜면 모든 수업이 보입니다."}
                    </div>
                ) : (
                    <div className="space-y-2">
                        {items.map((item, index) => (
                            <div key={item.sessionId} className="space-y-2">
                                {needsDateDivider(items, index) && (
                                    // 날짜가 바뀌는 곳에 구분줄
                                    <div className="flex items-center gap-2 pt-1 text-xs font-semibold text-[var(--color-academy-muted)]">
                                        <span>{feedDateHeading(item.ymd)}</span>
                                        <span aria-hidden="true" className="h-px flex-1 bg-[var(--color-academy-line)]" />
                                    </div>
                                )}
                                {renderPost(item)}
                            </div>
                        ))}
                    </div>
                )}

                {/* 끝 표시 + 불러오는 중 / 오류 / 더 보기 */}
                <div ref={sentinelRef} className="py-3 text-center text-sm text-[var(--color-academy-muted)]">
                    {loading ? (
                        "불러오는 중…"
                    ) : loadError ? (
                        <span className="inline-flex flex-wrap items-center justify-center gap-2 text-[var(--color-academy-danger)]">
                            {loadError}
                            <button type="button" onClick={() => (nextCursor ? void loadMore() : void reload(filter))} className="academy-button-secondary academy-button-sm">다시 불러오기</button>
                        </span>
                    ) : nextCursor ? (
                        <button type="button" onClick={() => void loadMore()} className="academy-button-secondary academy-button-sm">더 보기</button>
                    ) : items.length > 0 ? (
                        "마지막 수업까지 다 봤습니다."
                    ) : null}
                </div>
            </div>

            {/* 오른쪽: 편집 패널(PC) — 스크롤해도 따라오는 고정 패널 */}
            <aside
                aria-label="수업 편집"
                className={`shrink-0 lg:block lg:w-[360px] xl:w-[420px] ${narrowWhileEditing ? "order-first block w-full" : "hidden"}`}
            >
                <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
                    {isDesktop && selectedId ? (
                        renderEditor(selectedId)
                    ) : (
                        <p className="py-6 text-center text-sm text-[var(--color-academy-muted)]">
                            왼쪽 게시물을 누르면 여기서 수업 한 줄·사진·학생 코멘트를 고치고 학부모에게 발행할 수 있습니다.
                        </p>
                    )}
                </div>
            </aside>

            {/* 휴대폰: 아래에서 올라오는 편집 시트 */}
            {!isDesktop && selectedId && (
                <ListDetailPanel
                    onClose={() => moveTo(null)}
                    titleId="admin-feed-editor-title"
                    closeOnBackdrop={false}
                    panelClassName="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                >
                    {renderEditor(selectedId)}
                </ListDetailPanel>
            )}

            {/* 필터 모달 — 기간·선생님·요일·반·발행 상태·내용 없는 수업 */}
            {filterOpen && (
                <AdminModal titleId="admin-feed-filter-title" onClose={() => setFilterOpen(false)} panelClassName="max-w-md p-5">
                    <h3 id="admin-feed-filter-title" className="mb-3 text-lg font-bold text-[var(--color-academy-ink)]">필터</h3>
                    <div className="space-y-3">
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            기간
                            <select value={draft.days} onChange={(event) => setDraft({ ...draft, days: Number(event.target.value) })} className="academy-input min-h-11">
                                {ADMIN_FEED_DAYS_OPTIONS.map((d) => <option key={d} value={d}>최근 {d}일</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            선생님
                            <select value={draft.teacher} onChange={(event) => setDraft({ ...draft, teacher: event.target.value })} className="academy-input min-h-11">
                                <option value="">전체</option>
                                {facets.teachers.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            요일
                            <select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })} className="academy-input min-h-11">
                                <option value={-1}>전체</option>
                                {WEEKDAY_ORDER.map((dow) => <option key={dow} value={dow}>{WEEKDAY_LABELS[dow]}요일</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            반
                            <select value={draft.classId} onChange={(event) => setDraft({ ...draft, classId: event.target.value })} className="academy-input min-h-11">
                                <option value="">전체</option>
                                {facets.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            발행 상태
                            <select value={draft.publish} onChange={(event) => setDraft({ ...draft, publish: event.target.value as AdminFeedFilter["publish"] })} className="academy-input min-h-11">
                                {PUBLISH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </label>
                        <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-academy-ink)]">
                            <input type="checkbox" checked={draft.includeEmpty} onChange={(event) => setDraft({ ...draft, includeEmpty: event.target.checked })} className="h-5 w-5" />
                            내용 없는 수업도 보기
                        </label>
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                        <button type="button" onClick={() => setDraft(DEFAULT_ADMIN_FEED_FILTER)} className="academy-button-text">초기화</button>
                        <button type="button" onClick={() => setFilterOpen(false)} className="academy-button-secondary">닫기</button>
                        <button type="button" onClick={applyFilter} className="academy-button-primary">적용</button>
                    </div>
                </AdminModal>
            )}
        </div>
    );
}
