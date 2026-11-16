"use client";
import React, { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useNode } from "@craftjs/core";
import { Resizable } from "re-resizable";
import ReactCrop, { Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { compressImageForUpload } from "@/lib/clientImageCompression";
import { showNotice } from "@/components/ui/feedback";

function SymbolIcon({
    name,
    size = 18,
    className = "",
}: {
    name: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={`material-symbols-outlined leading-none ${className}`}
            style={{ fontSize: `${size}px` }}
            aria-hidden="true"
        >
            {name}
        </span>
    );
}

export const ImageSettings = () => {
    const { actions: { setProp, setCustom }, borderRadius, objectFit, isCropModalOpen, hasImage } = useNode((node) => ({
        borderRadius: node.data.props.borderRadius,
        objectFit: node.data.props.objectFit,
        isCropModalOpen: node.data.custom.isCropModalOpen,
        hasImage: !!node.data.props.src
    }));

    return (
        <div className="space-y-4">
            {hasImage && (
                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                    <p className="text-xs text-orange-800 mb-2 font-medium">이미지의 원하는 부분만 잘라내려면 아래 버튼을 클릭하세요.</p>
                    <button
                        onClick={() => setCustom((custom: any) => custom.isCropModalOpen = true)}
                        className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-2 px-4 rounded flex items-center justify-center gap-2 text-sm transition"
                    >
                        <SymbolIcon name="crop" size={16} /> 이미지 자르기 모드 시작
                    </button>
                    {isCropModalOpen && (
                        <p className="text-xs text-orange-600 mt-2 text-center animate-pulse">중앙 화면에서 자르기 영역을 설정하세요</p>
                    )}
                </div>
            )}

            <div className="h-px bg-gray-200 my-4" />

            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">모서리 둥글기 ({borderRadius}px)</label>
                <input
                    type="range" min="0" max="100"
                    value={borderRadius || 0}
                    onChange={(e) => setProp((props: any) => props.borderRadius = parseInt(e.target.value))}
                    className="w-full"
                />
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">이미지 맞춤 방식</label>
                <select
                    value={objectFit || "cover"}
                    onChange={(e) => setProp((props: any) => props.objectFit = e.target.value)}
                    className="w-full border border-gray-300 rounded p-1.5 text-sm"
                >
                    <option value="cover">꽉 채우기 (Cover)</option>
                    <option value="contain">비율 유지 포함 (Contain)</option>
                    <option value="fill">비율 무시 채움 (Fill)</option>
                </select>
            </div>
        </div>
    );
};

export const ImageNode = ({
    src,
    width = "100%",
    height = "auto",
    borderRadius = 8,
    objectFit = "cover"
}: any) => {
    const { connectors: { connect, drag }, selected, actions: { setProp, setCustom }, isCropModalOpen } = useNode((node) => ({
        selected: node.events.selected,
        isCropModalOpen: node.data.custom.isCropModalOpen
    }));

    const fileInputRef = useRef<HTMLInputElement>(null);

    // Image Cropper States
    const [crop, setCrop] = useState<Crop>();
    const imageRef = useRef<HTMLImageElement>(null);

    const [mounted, setMounted] = useState(false);
    const [isShiftPressed, setIsShiftPressed] = useState(false);

    useEffect(() => {
        setMounted(true);
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

    // Turn off crop mode globally when unselected
    useEffect(() => {
        if (!selected && isCropModalOpen) {
            setCustom((custom: any) => custom.isCropModalOpen = false);
        }
    }, [selected, isCropModalOpen, setCustom]);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const compressed = await compressImageForUpload(file);
            const formData = new FormData();
            formData.append("file", compressed);
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            const data = await res.json();
            if (data.url) {
                setProp((props: any) => { props.src = data.url; });
                setCrop(undefined); // Reset crop state for new image
            }
        } catch (error) {
            console.error("Upload failed", error);
            showNotice(error instanceof Error ? error.message : "이미지 업로드에 실패했습니다.");
        }
    };

    const getCroppedImg = async () => {
        if (!imageRef.current || !crop || !crop.width || !crop.height) {
            setCustom((custom: any) => custom.isCropModalOpen = false);
            return;
        }

        const canvas = document.createElement("canvas");
        const scaleX = imageRef.current.naturalWidth / imageRef.current.width;
        const scaleY = imageRef.current.naturalHeight / imageRef.current.height;

        canvas.width = crop.width * scaleX;
        canvas.height = crop.height * scaleY;
        const ctx = canvas.getContext("2d");

        if (!ctx) return;

        ctx.drawImage(
            imageRef.current,
            crop.x * scaleX,
            crop.y * scaleY,
            crop.width * scaleX,
            crop.height * scaleY,
            0,
            0,
            crop.width * scaleX,
            crop.height * scaleY
        );

        canvas.toBlob(async (blob) => {
            if (!blob) return;
            const file = new File([blob], "cropped.jpg", { type: "image/jpeg" });

            try {
                const compressed = await compressImageForUpload(file, { maxEdge: 1400, targetBytes: 900 * 1024 });
                const formData = new FormData();
                formData.append("file", compressed);
                const res = await fetch("/api/upload", { method: "POST", body: formData });
                const data = await res.json();
                if (data.url) {
                    setProp((props: any) => { props.src = data.url; });
                }
            } catch (error) {
                console.error("Upload failed", error);
                showNotice(error instanceof Error ? error.message : "이미지 업로드에 실패했습니다.");
            }
            setCustom((custom: any) => custom.isCropModalOpen = false);
        }, "image/jpeg", 0.82);
    };

    return (
        <>
            {/* Contextual Crop Modal taking up screen space globally using createPortal to escape canvas boundary */}
            {isCropModalOpen && src && mounted && createPortal(
                <div className="fixed inset-0 z-[99999] bg-black/90 flex flex-col items-center justify-center p-8 backdrop-blur-sm"
                    style={{ WebkitTransform: "translateZ(0)" }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setCustom((custom: any) => custom.isCropModalOpen = false);
                        }
                    }}
                >
                    <div className="text-white mb-6 text-center">
                        <h3 className="text-2xl font-bold mb-2">이미지 자르기</h3>
                        <p className="text-gray-400">자르기를 원하는 영역을 드래그하여 선택하세요.</p>
                    </div>

                    <div className="bg-white dark:bg-gray-800/10 p-4 rounded-xl shadow-2xl overflow-hidden max-h-[60vh] flex items-center justify-center max-w-4xl w-full relative z-10">
                        <ReactCrop crop={crop} onChange={c => setCrop(c)} className="max-h-full">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img ref={imageRef} src={src} className="max-h-[55vh] object-contain mx-auto shadow-lg" alt="Crop target" />
                        </ReactCrop>
                    </div>

                    <div className="flex gap-4 mt-8 relative z-10">
                        <button
                            onClick={getCroppedImg}
                            className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-8 py-3 rounded-lg font-bold flex items-center gap-2 hover:bg-orange-600 hover:scale-105 transition shadow-lg"
                        >
                            <SymbolIcon name="check" size={20} /> 이대로 자르기 적용
                        </button>
                        <button
                            onClick={() => setCustom((custom: any) => custom.isCropModalOpen = false)}
                            className="bg-gray-700 text-white px-8 py-3 rounded-lg font-bold flex items-center gap-2 hover:bg-gray-600 transition shadow-lg"
                        >
                            <SymbolIcon name="close" size={20} /> 취소
                        </button>
                    </div>
                </div>,
                document.body
            )}

            <div ref={(ref) => { if (ref) connect(drag(ref)); }} className="h-full relative w-full flex justify-center">
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
                            // Make height auto for responsive scaling unless explicitly dragged vertically
                            if (direction === 'bottom' || direction === 'top' || direction.includes('Right') || direction.includes('Left')) {
                                props.height = ref.style.height;
                            } else {
                                props.height = "auto";
                            }
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
                    style={{ position: 'relative', maxWidth: '100%' }}
                    className={`${selected ? 'z-10 ring-2 ring-brand-orange-500 dark:focus:ring-brand-neon-lime ring-offset-1' : ''}`}
                >
                    <div
                        style={{
                            width: "100%",
                            height: "100%",
                            outline: selected ? "2px solid #ea580c" : "none",
                            outlineOffset: "2px",
                        }}
                        className={`relative flex items-center justify-center overflow-hidden w-full h-full ${!src ? 'bg-gray-100 dark:bg-gray-800 min-h-[100px] border-2 border-dashed border-gray-300' : ''}`}
                    >
                        {src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={src}
                                alt="builder-image"
                                className="w-full h-full pointer-events-none"
                                style={{ objectFit: objectFit, borderRadius: `${borderRadius}px` }}
                                onDoubleClick={() => fileInputRef.current?.click()}
                            />
                        ) : (
                            <div
                                className="w-full h-full min-h-[100px] flex flex-col items-center justify-center text-gray-400 cursor-pointer"
                                style={{ borderRadius: `${borderRadius}px` }}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <SymbolIcon name="image" size={32} className="mb-2" />
                                <span className="text-sm font-medium">클릭하여 이미지 업로드</span>
                            </div>
                        )}
                        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleUpload} />
                    </div>
                </Resizable>
            </div>
        </>
    );
};

ImageNode.craft = {
    props: {
        src: "",
        width: "100%",
        height: "auto",
        borderRadius: 8,
        objectFit: "cover",
    },
    custom: {
        isCropModalOpen: false
    },
    related: {
        settings: ImageSettings,
    },
    displayName: "이미지 블록",
};
