"use client";

// ─────────────────────────────────────────────────────────────────────────
// ResizableImage — 본문 이미지에 "좌/중/우 정렬 + 드래그 크기조절"을 더한 확장.
//
// 왜 기존 Image를 확장하나?
//   레고로 비유하면, 이미 잘 동작하는 이미지 블록(Image)에 새 기능 조각만
//   덧붙이는 방식이다. 삽입/드롭/붙여넣기(2단계)와 setImage 명령이 그대로 유지된다.
//
// 저장되는 HTML 마크업 (★5단계 sanitize 허용목록이 알아야 할 부분):
//   - 정렬: <img class="align-left|align-center|align-right" data-align="...">
//   - 크기: <img width="320">   (정수 px, HTML width 속성)
//   정렬 미지정(기본) 이미지는 class/data-align이 붙지 않는다(하위호환).
// ─────────────────────────────────────────────────────────────────────────

import { Image } from '@tiptap/extension-image';
import {
    ReactNodeViewRenderer,
    NodeViewWrapper,
    type ReactNodeViewProps,
} from '@tiptap/react';
import { useRef } from 'react';

// 리사이즈 폭 가드 — 너무 작거나 컨테이너보다 크지 않게 막는다.
const MIN_WIDTH = 40; // px

// 정렬 방향 타입
type Align = 'left' | 'center' | 'right';

// ── React NodeView: 에디터 안에서 이미지를 그리는 실제 UI ──
function ImageNodeView(props: ReactNodeViewProps) {
    const { node, updateAttributes, selected, editor } = props;
    // 노드에 저장된 현재 폭(px)과 정렬값을 읽는다.
    const width = node.attrs.width as number | null;
    const align = (node.attrs.align as Align | null) ?? null;

    // 실제 <img> DOM 참조 — 리사이즈 시작 시 현재 렌더 폭을 읽기 위함
    const imgRef = useRef<HTMLImageElement>(null);

    // 편집 가능 상태에서 이 이미지가 선택됐을 때만 핸들/툴바를 노출
    const showControls = selected && editor.isEditable;

    // ── 드래그로 폭 조절 시작 ──
    // dir: 'nw'|'ne'|'sw'|'se' (어느 모서리를 잡았는지)
    function startResize(e: React.MouseEvent, dir: 'nw' | 'ne' | 'sw' | 'se') {
        // 기본 드래그/선택 동작을 막아야 우리 로직만 동작한다.
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        // 현재 화면에 그려진 폭을 시작점으로 삼는다(속성이 없으면 자연 크기).
        const startWidth = imgRef.current?.offsetWidth ?? (width ?? 200);
        // 왼쪽 모서리(nw/sw)를 잡으면 마우스를 왼쪽으로 끌수록 커져야 하므로 부호 반전
        const sign = dir === 'nw' || dir === 'sw' ? -1 : 1;
        // 최대 폭 = 에디터 본문 영역 폭 (이미지가 밖으로 넘치지 않게)
        const maxWidth = editor.view.dom.clientWidth || 800;

        function onMove(ev: MouseEvent) {
            const delta = (ev.clientX - startX) * sign;
            let next = Math.round(startWidth + delta);
            // 최소/최대 가드 적용
            next = Math.max(MIN_WIDTH, Math.min(next, maxWidth));
            // 노드 속성에 폭을 반영 → 화면이 즉시 갱신되고 HTML에도 저장된다.
            updateAttributes({ width: next });
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // ── 정렬 버튼 클릭 ──
    function setAlign(value: Align) {
        // 이미 같은 정렬이면 해제(토글) — 다시 기본(중앙)으로
        updateAttributes({ align: align === value ? null : value });
    }

    // 모서리 핸들 하나를 그리는 헬퍼 (네 귀퉁이 공통 스타일)
    const handle = (dir: 'nw' | 'ne' | 'sw' | 'se', pos: React.CSSProperties, cursor: string) => (
        <span
            onMouseDown={e => startResize(e, dir)}
            style={{
                position: 'absolute',
                width: 12,
                height: 12,
                background: 'var(--color-brand-orange-500)',
                border: '2px solid #fff',
                borderRadius: 2,
                cursor,
                zIndex: 20,
                ...pos,
            }}
        />
    );

    return (
        // 바깥 래퍼: 블록 레벨. text-align으로 안쪽 이미지의 좌/중/우 위치를 잡는다.
        // 기본(align=null)은 기존 동작과 동일하게 가운데 정렬을 유지한다(UX 보존).
        <NodeViewWrapper
            as="div"
            style={{ textAlign: align ?? 'center' }}
            data-align={align ?? undefined}
        >
            {/* 이미지+핸들을 감싸는 상대 위치 컨테이너(인라인블록이라 text-align의 영향을 받음) */}
            <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: 0 }}>
                <img
                    ref={imgRef}
                    src={node.attrs.src}
                    alt={node.attrs.alt || ''}
                    title={node.attrs.title || undefined}
                    draggable={false}
                    style={{
                        width: width ? `${width}px` : undefined, // 저장된 폭이 있으면 px로 고정
                        maxWidth: '100%', // 컨테이너보다 크면 축소(넘침 방지)
                        height: 'auto', // 비율 유지
                        display: 'block',
                        borderRadius: '0.5rem',
                        // 선택됐을 때 테두리로 강조
                        outline: showControls ? '2px solid var(--color-brand-orange-500)' : 'none',
                    }}
                />

                {showControls && (
                    <>
                        {/* 정렬 툴바 — 이미지 위쪽에 떠서 좌/중/우 버튼 제공 */}
                        <span
                            // 버튼 영역에서의 마우스다운이 노드 선택을 해제하지 않도록 방지
                            onMouseDown={e => e.preventDefault()}
                            style={{
                                position: 'absolute',
                                top: -38,
                                left: '50%',
                                transform: 'translateX(-50%)',
                                display: 'flex',
                                gap: 2,
                                padding: 3,
                                borderRadius: 6,
                                background: 'var(--color-brand-orange-500)',
                                boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                                zIndex: 30,
                                lineHeight: 1,
                            }}
                        >
                            {(['left', 'center', 'right'] as Align[]).map(a => (
                                <button
                                    key={a}
                                    type="button"
                                    onClick={() => setAlign(a)}
                                    title={a === 'left' ? '왼쪽 정렬' : a === 'center' ? '가운데 정렬' : '오른쪽 정렬'}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        minWidth: 26,
                                        height: 26,
                                        padding: '0 6px',
                                        fontSize: 12,
                                        whiteSpace: 'nowrap',
                                        borderRadius: 4,
                                        color: '#fff',
                                        // 현재 정렬과 같으면 눌린 느낌으로 강조
                                        background: align === a ? 'rgba(255,255,255,0.35)' : 'transparent',
                                    }}
                                >
                                    {/* 글자 라벨(2026-11-14 아이콘 완전 제거) */}
                                    {a === 'left' ? '왼쪽' : a === 'center' ? '가운데' : '오른쪽'}
                                </button>
                            ))}
                        </span>

                        {/* 네 모서리 리사이즈 핸들 */}
                        {handle('nw', { top: -6, left: -6 }, 'nwse-resize')}
                        {handle('ne', { top: -6, right: -6 }, 'nesw-resize')}
                        {handle('sw', { bottom: -6, left: -6 }, 'nesw-resize')}
                        {handle('se', { bottom: -6, right: -6 }, 'nwse-resize')}
                    </>
                )}
            </span>
        </NodeViewWrapper>
    );
}

// ── 확장 정의: Image에 width/align 속성과 위 NodeView를 얹는다 ──
export const ResizableImage = Image.extend({
    // 새 속성을 추가하되, 부모의 기존 속성(src/alt/title)은 그대로 유지
    addAttributes() {
        return {
            ...this.parent?.(),
            // 폭(px 정수) — HTML의 width 속성으로 저장/복원
            width: {
                default: null,
                parseHTML: element => {
                    const w = element.getAttribute('width');
                    return w ? parseInt(w, 10) : null;
                },
                renderHTML: attributes => {
                    // 폭이 지정된 경우에만 width 속성을 남긴다.
                    return attributes.width ? { width: attributes.width } : {};
                },
            },
            // 정렬 — class(스타일용) + data-align(파싱용) 둘 다로 저장
            align: {
                default: null,
                parseHTML: element => {
                    // data-align 우선, 없으면 class에서 추출(하위호환)
                    const attr = element.getAttribute('data-align');
                    if (attr === 'left' || attr === 'center' || attr === 'right') return attr;
                    const m = element.className.match(/align-(left|center|right)/);
                    return m ? m[1] : null;
                },
                renderHTML: attributes => {
                    if (!attributes.align) return {};
                    return {
                        class: `align-${attributes.align}`,
                        'data-align': attributes.align,
                    };
                },
            },
        };
    },
    // 커스텀 React NodeView로 렌더링(정렬 툴바 + 리사이즈 핸들)
    addNodeView() {
        return ReactNodeViewRenderer(ImageNodeView);
    },
});
