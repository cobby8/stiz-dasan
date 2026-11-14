"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { kstLabel } from "@/lib/datetime/kst";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import {
    ADMIN_FEED_DAYS_DEFAULT,
    ADMIN_FEED_DAYS_OPTIONS,
    applyAdminFeedFilter,
    countActiveFilters,
    DEFAULT_ADMIN_FEED_FILTER,
    feedPreview,
    groupAdminFeed,
    hasFeedContent,
    NO_TEACHER_LABEL,
    WEEKDAY_LABELS,
    WEEKDAY_ORDER,
    type AdminFeedFilter,
    type AdminFeedItem,
    type AdminFeedView,
} from "@/lib/feed/adminFeedRules";

// 보기 «전체 | 요일별 | 선생님별» — 선택은 브라우저에 기억
const VIEW_STORAGE_KEY = "admin-feed-view-mode";
const VIEW_VALUES = ["all", "weekday", "teacher"] as const;
const VIEW_OPTIONS = [
    { value: "all", label: "전체" },
    { value: "weekday", label: "요일별" },
    { value: "teacher", label: "선생님별" },
] as const;

const PUBLISH_OPTIONS: Array<{ value: AdminFeedFilter["publish"]; label: string }> = [
    { value: "ALL", label: "전체" },
    { value: "PUBLISHED", label: "발행됨" },
    { value: "DRAFT", label: "미발행" },
];

function PublishBadge({ item }: { item: AdminFeedItem }) {
    if (item.status === "IN_PROGRESS") {
        return <span className="inline-flex rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">수업 중</span>;
    }
    return item.published ? (
        <span className="inline-flex rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-success)]">발행됨</span>
    ) : (
        <span className="inline-flex rounded-full bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-muted)]">미발행</span>
    );
}

function mediaLabel(item: AdminFeedItem): string {
    const parts: string[] = [];
    if (item.photoCount > 0) parts.push(`사진 ${item.photoCount}`);
    if (item.videoCount > 0) parts.push(`영상 ${item.videoCount}`);
    return parts.join(" · ");
}

export default function AdminFeedClient({ items, days }: { items: AdminFeedItem[]; days: number }) {
    const router = useRouter();
    const [view, changeView] = useRememberedListView<AdminFeedView>(VIEW_STORAGE_KEY, VIEW_VALUES, "all");
    const [filter, setFilter] = useState<AdminFeedFilter>(DEFAULT_ADMIN_FEED_FILTER);
    const [draft, setDraft] = useState<AdminFeedFilter>(DEFAULT_ADMIN_FEED_FILTER);
    const [draftDays, setDraftDays] = useState<number>(days);
    const [filterOpen, setFilterOpen] = useState(false);
    const [detailId, setDetailId] = useState<string | null>(null);
    // 기간을 바꿔 서버에서 다시 읽는 동안 «불러오는 중» 표시
    const [reloading, startReload] = useTransition();

    const contentCount = useMemo(() => items.filter(hasFeedContent).length, [items]);
    const teachers = useMemo(
        () => [...new Set(items.map((item) => item.teacherName?.trim() || NO_TEACHER_LABEL))].sort((a, b) => {
            if (a === NO_TEACHER_LABEL) return 1;
            if (b === NO_TEACHER_LABEL) return -1;
            return a.localeCompare(b, "ko");
        }),
        [items],
    );
    const visible = useMemo(() => applyAdminFeedFilter(items, filter), [items, filter]);
    const groups = useMemo(() => groupAdminFeed(visible, view), [visible, view]);
    const activeFilterCount = countActiveFilters(filter);
    const detail = detailId ? items.find((item) => item.sessionId === detailId) ?? null : null;

    function openFilter() {
        setDraft(filter);
        setDraftDays(days);
        setFilterOpen(true);
    }

    function applyFilter() {
        setFilterOpen(false);
        if (draftDays !== days) {
            // 기간이 바뀌면 서버에서 다시 읽는다. 새 기간에 없는 선생님이 남아 목록이 비지 않게 선생님 조건은 푼다
            setFilter({ ...draft, teacher: "" });
            startReload(() => router.push(`/admin/attendance/feed?days=${draftDays}`));
            return;
        }
        setFilter(draft);
    }

    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailId(id);
        }
    }

    // 한 줄 행: 날짜 | 반 | 선생님 | 사진·영상 | 글 앞부분 | 상태
    const columnCount = 6;
    function renderRow(item: AdminFeedItem) {
        const preview = feedPreview(item.content);
        const media = mediaLabel(item);
        return (
            <tr
                key={item.sessionId}
                tabIndex={0}
                aria-label={`${item.className} ${kstLabel(item.ymd)} 수업 피드 보기`}
                onClick={() => setDetailId(item.sessionId)}
                onKeyDown={(event) => handleRowKeyDown(event, item.sessionId)}
                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
            >
                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{kstLabel(item.ymd)}</td>
                <td className="px-2 py-1.5 font-semibold text-[var(--color-academy-ink)]">{item.className}</td>
                <td className="px-2 py-1.5 text-[var(--color-academy-muted)]">{item.teacherName || "-"}</td>
                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{media || <span className="text-[var(--color-academy-muted)]">-</span>}</td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] md:table-cell">
                    {preview || <span className="text-[var(--color-academy-muted)]">한 줄 없음</span>}
                </td>
                <td className="px-2 py-1.5"><PublishBadge item={item} /></td>
            </tr>
        );
    }

    return (
        <div className="mx-auto max-w-5xl">
            <AdminPageHeader
                className="mb-3"
                title="수업 피드"
                description={<>{reloading && "불러오는 중 · "}최근 <span className="tabular-nums">{days}</span>일 · 내용 있는 수업 <span className="tabular-nums">{contentCount}</span>개 / 전체 <span className="tabular-nums">{items.length}</span>개</>}
            />

            {/* 보기 전환(전체·요일별·선생님별) + 필터 버튼 하나 */}
            <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <ListViewToggle value={view} options={VIEW_OPTIONS} ariaLabel="수업 피드 보기 방식" onChange={changeView} />
                <button type="button" onClick={openFilter} className="academy-button-secondary academy-button-sm">
                    필터{activeFilterCount > 0 && <> <span className="tabular-nums">{activeFilterCount}</span></>}
                </button>
            </div>

            {visible.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    {items.length === 0
                        ? "이 기간에 진행한 수업이 없습니다."
                        : filter.includeEmpty || countActiveFilters(filter) > 0
                            ? "조건에 맞는 수업이 없습니다."
                            : "선생님이 올린 사진·영상·한 줄이 없습니다. 필터에서 «내용 없는 수업도 보기»를 켜면 모든 수업이 보입니다."}
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-semibold text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="admin-cell-num px-2 py-2">날짜</th>
                                    <th className="px-2 py-2">반</th>
                                    <th className="px-2 py-2">선생님</th>
                                    <th className="admin-cell-num px-2 py-2">사진·영상</th>
                                    <th className="hidden px-2 py-2 md:table-cell">수업 한 줄</th>
                                    <th className="px-2 py-2">상태</th>
                                </tr>
                            </thead>
                            {groups.map((group) => (
                                <tbody key={group.key} className="divide-y divide-[var(--color-academy-line)]">
                                    {view !== "all" && (
                                        <tr>
                                            <th colSpan={columnCount} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-left text-xs font-semibold text-[var(--color-academy-ink)]">
                                                {group.label} · <span className="tabular-nums">{group.items.length}</span>개
                                            </th>
                                        </tr>
                                    )}
                                    {group.items.map(renderRow)}
                                </tbody>
                            ))}
                        </table>
                    </div>
                </div>
            )}

            {/* 필터 모달 — 기간·발행 상태·선생님·요일·내용 없는 수업 */}
            {filterOpen && (
                <AdminModal titleId="admin-feed-filter-title" onClose={() => setFilterOpen(false)} panelClassName="max-w-md p-5">
                    <h3 id="admin-feed-filter-title" className="mb-3 text-lg font-bold text-[var(--color-academy-ink)]">필터</h3>
                    <div className="space-y-3">
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            기간
                            <select value={draftDays} onChange={(event) => setDraftDays(Number(event.target.value))} className="academy-input min-h-11">
                                {ADMIN_FEED_DAYS_OPTIONS.map((d) => <option key={d} value={d}>최근 {d}일</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            발행 상태
                            <select value={draft.publish} onChange={(event) => setDraft({ ...draft, publish: event.target.value as AdminFeedFilter["publish"] })} className="academy-input min-h-11">
                                {PUBLISH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            선생님
                            <select value={draft.teacher} onChange={(event) => setDraft({ ...draft, teacher: event.target.value })} className="academy-input min-h-11">
                                <option value="">전체</option>
                                {teachers.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-academy-muted)]">
                            요일
                            <select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })} className="academy-input min-h-11">
                                <option value={-1}>전체</option>
                                {WEEKDAY_ORDER.map((dow) => <option key={dow} value={dow}>{WEEKDAY_LABELS[dow]}요일</option>)}
                            </select>
                        </label>
                        <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-academy-ink)]">
                            <input type="checkbox" checked={draft.includeEmpty} onChange={(event) => setDraft({ ...draft, includeEmpty: event.target.checked })} className="h-5 w-5" />
                            내용 없는 수업도 보기
                        </label>
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                        <button type="button" onClick={() => { setDraft(DEFAULT_ADMIN_FEED_FILTER); setDraftDays(ADMIN_FEED_DAYS_DEFAULT); }} className="academy-button-text">초기화</button>
                        <button type="button" onClick={() => setFilterOpen(false)} className="academy-button-secondary">닫기</button>
                        <button type="button" onClick={applyFilter} className="academy-button-primary">적용</button>
                    </div>
                </AdminModal>
            )}

            {/* 행 클릭 상세 — 학부모가 받는 게시물 하나와 같은 내용 */}
            {detail && (
                <ListDetailPanel onClose={() => setDetailId(null)} titleId="admin-feed-detail-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-3 flex items-center gap-2">
                        <h3 id="admin-feed-detail-title" className="min-w-0 break-keep text-lg font-bold text-[var(--color-academy-ink)]">{detail.className}</h3>
                        <PublishBadge item={detail} />
                        <button type="button" onClick={() => setDetailId(null)} className="ml-auto academy-button-text academy-button-sm shrink-0">닫기</button>
                    </div>
                    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-medium text-[var(--color-academy-muted)]">날짜</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detail.ymd)}{detail.startTime ? ` ${detail.startTime}~${detail.endTime ?? ""}` : ""}</dd>
                        <dt className="font-medium text-[var(--color-academy-muted)]">선생님</dt>
                        <dd className="text-[var(--color-academy-ink)]">{detail.teacherName || NO_TEACHER_LABEL}</dd>
                        {detail.endedByName && (
                            <>
                                <dt className="font-medium text-[var(--color-academy-muted)]">종료 처리</dt>
                                <dd className="text-[var(--color-academy-ink)]">{detail.endedByName}</dd>
                            </>
                        )}
                        <dt className="font-medium text-[var(--color-academy-muted)]">사진·영상</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">사진 {detail.photoCount} · 영상 {detail.videoCount}</dd>
                    </dl>
                    <div className="mt-4">
                        <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">수업 한 줄</p>
                        <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                            {detail.content || "아직 쓴 내용이 없습니다."}
                        </p>
                    </div>
                    {detail.photos.length > 0 && (
                        <div className="mt-4 grid grid-cols-3 gap-1.5">
                            {detail.photos.map((src) => (
                                // 비공개 사진은 권한 검사 라우트로만 열린다(관리자 = 전체 반 접근)
                                // eslint-disable-next-line @next/next/no-img-element
                                <img key={src} src={src} alt="수업 사진" loading="lazy" className="aspect-square w-full rounded-md object-cover" />
                            ))}
                        </div>
                    )}
                    {detail.photoCount > detail.photos.length && (
                        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">사진 {detail.photoCount - detail.photos.length}장 더 있음 — 리포트 편집에서 전부 볼 수 있습니다.</p>
                    )}
                    {!detail.published && detail.status === "COMPLETED" && (
                        <p className="mt-3 text-xs text-[var(--color-academy-muted)]">미발행 수업은 학부모에게 보이지 않습니다. 리포트 편집에서 발행할 수 있습니다.</p>
                    )}
                    <div className="mt-5 flex flex-wrap gap-2">
                        <Link href={`/admin/attendance/report/${detail.sessionId}`} prefetch={false} className="academy-button-primary">리포트 편집</Link>
                    </div>
                </ListDetailPanel>
            )}
        </div>
    );
}
