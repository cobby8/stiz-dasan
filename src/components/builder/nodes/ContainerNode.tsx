"use client";
import React from "react";
import { useNode } from "@craftjs/core";
import { Resizable } from "re-resizable";

export const ContainerSettings = () => {
    const { actions: { setProp }, background, padding, flexDirection, align, justify } = useNode((node) => ({
        background: node.data.props.background,
        padding: node.data.props.padding,
        flexDirection: node.data.props.flexDirection,
        align: node.data.props.align,
        justify: node.data.props.justify,
    }));

    return (
        <div className="space-y-4">
            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">배경색</label>
                <input
                    type="color"
                    value={background || "#ffffff"}
                    onChange={(e) => setProp((props: any) => props.background = e.target.value)}
                    className="w-full h-10 border border-gray-300 rounded cursor-pointer"
                />
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">내부 여백 (Padding: {padding}px)</label>
                <input
                    type="range" min="0" max="100"
                    value={padding || 0}
                    onChange={(e) => setProp((props: any) => props.padding = parseInt(e.target.value))}
                    className="w-full"
                />
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">내부 요소 배열 방향</label>
                <select
                    value={flexDirection || "column"}
                    onChange={(e) => setProp((props: any) => props.flexDirection = e.target.value)}
                    className="w-full border border-gray-300 rounded p-1.5 text-sm"
                >
                    <option value="column">수직으로 쌓기 (기본)</option>
                    <option value="row">가로 한 줄로 나열 (다단)</option>
                </select>
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">정렬 (수직/가로 방향에 따라 다름)</label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                        <span className="text-gray-500 dark:text-gray-400 mb-1 block">주축 (Justify)</span>
                        <select value={justify} onChange={(e) => setProp((props: any) => props.justify = e.target.value)} className="w-full border border-gray-300 rounded p-1">
                            <option value="flex-start">시작점</option>
                            <option value="center">가운데</option>
                            <option value="flex-end">끝점</option>
                            <option value="space-between">간격 균등</option>
                        </select>
                    </div>
                    <div>
                        <span className="text-gray-500 dark:text-gray-400 mb-1 block">교차축 (Align)</span>
                        <select value={align} onChange={(e) => setProp((props: any) => props.align = e.target.value)} className="w-full border border-gray-300 rounded p-1">
                            <option value="stretch">늘이기 (가득참)</option>
                            <option value="flex-start">시작점</option>
                            <option value="center">가운데</option>
                            <option value="flex-end">끝점</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const ContainerNode = ({
    children,
    background,
    padding,
    flexDirection = "column",
    align = "stretch",
    justify = "flex-start",
    width = "100%",
    height = "auto"
}: any) => {
    const { connectors: { connect, drag }, selected, actions: { setProp } } = useNode((node) => ({
        selected: node.events.selected,
    }));

    const [isShiftPressed, setIsShiftPressed] = React.useState(false);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Shift") setIsShiftPressed(true);
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Shift") setIsShiftPressed(false);
        };
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    return (
        <div ref={(ref) => { if (ref) connect(drag(ref)); }} className="h-full w-full relative flex justify-center">
            <Resizable
                size={{ width, height: height === "auto" ? "auto" : height }}
                onResizeStop={(e, direction, ref, d) => {
                    let newWidth = ref.style.width;
                    if (newWidth.endsWith('px') && ref.parentElement) {
                        const parentWidth = ref.parentElement.offsetWidth;
                        if (parentWidth > 0) {
                            const pxWidth = parseFloat(newWidth);
                            newWidth = `${(pxWidth / parentWidth) * 100}%`;
                        }
                    }
                    setProp((props: any) => {
                        props.width = newWidth;
                        props.height = ref.style.height;
                    });
                }}
                enable={{
                    top: true, right: true, bottom: true, left: true,
                    topRight: true, bottomRight: true, bottomLeft: true, topLeft: true
                }}
                bounds="parent"
                lockAspectRatio={isShiftPressed}
                handleComponent={selected ? {
                    top: <div className="w-4 h-1 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 absolute left-1/2 -ml-2 -top-0.5 rounded" />,
                    right: <div className="h-4 w-1 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 absolute top-1/2 -mt-2 -right-0.5 rounded" />,
                    bottom: <div className="w-4 h-1 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 absolute left-1/2 -ml-2 -bottom-0.5 rounded" />,
                    left: <div className="h-4 w-1 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 absolute top-1/2 -mt-2 -left-0.5 rounded" />,
                    topRight: <div className="w-3 h-3 bg-white dark:bg-gray-800 border-2 border-brand-orange-500 dark:border-brand-neon-lime absolute -right-1.5 -top-1.5 rounded-full" />,
                    bottomRight: <div className="w-3 h-3 bg-white dark:bg-gray-800 border-2 border-brand-orange-500 dark:border-brand-neon-lime absolute -right-1.5 -bottom-1.5 rounded-full" />,
                    bottomLeft: <div className="w-3 h-3 bg-white dark:bg-gray-800 border-2 border-brand-orange-500 dark:border-brand-neon-lime absolute -left-1.5 -bottom-1.5 rounded-full" />,
                    topLeft: <div className="w-3 h-3 bg-white dark:bg-gray-800 border-2 border-brand-orange-500 dark:border-brand-neon-lime absolute -left-1.5 -top-1.5 rounded-full" />
                } : undefined}
                className={`transition-all ${selected ? 'z-10 ring-2 ring-brand-orange-500 dark:focus:ring-brand-neon-lime ring-offset-1' : ''}`}
                style={{ position: 'relative', maxWidth: '100%' }}
            >
                <div
                    style={{
                        background: background || "transparent",
                        padding: `${padding}px`,
                        minHeight: "50px",
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        flexDirection: flexDirection,
                        alignItems: align,
                        justifyContent: justify,
                        gap: "10px",
                        outline: selected ? "2px solid #ea580c" : "1px dashed #e5e7eb",
                        outlineOffset: "-2px"
                    }}
                    className={`relative overflow-hidden ${selected ? 'bg-orange-50/10' : ''}`}
                >
                    {selected && (
                        <div className="absolute top-0 right-0 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white text-xs px-1 py-0.5 z-10 font-bold">Container</div>
                    )}
                    {children}
                </div>
            </Resizable>
        </div>
    );
};

ContainerNode.craft = {
    props: {
        background: "transparent",
        padding: 20,
        flexDirection: "column",
        align: "stretch",
        justify: "flex-start",
        width: "100%",
        height: "auto",
    },
    related: {
        settings: ContainerSettings,
    },
    displayName: "컨테이너 박스",
};
