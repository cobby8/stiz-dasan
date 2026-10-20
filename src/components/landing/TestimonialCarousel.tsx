import FontFreeIcon from "@/components/ui/FontFreeIcon";

type Testimonial = { name: string; info: string; text: string; rating: number };

export default function TestimonialCarousel({ testimonials = [], naverPlaceUrl }: { testimonials?: Testimonial[]; naverPlaceUrl?: string }) {
  if (testimonials.length === 0 && !naverPlaceUrl) return null;
  return <section className="public-section"><div className="public-container">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-extrabold text-[var(--color-public-text)]">학부모님이 전하는 이야기</h2>{naverPlaceUrl && <a href={naverPlaceUrl} target="_blank" rel="noopener noreferrer" className="public-link inline-flex min-h-11 items-center gap-1">네이버 후기 보기 <FontFreeIcon name="open_in_new" size={17} /></a>}</div>
    {testimonials.length > 0 && <div role="region" aria-label="학부모 후기 목록" tabIndex={0} className="flex gap-3 overflow-x-auto pb-2 [scroll-snap-type:x_mandatory]">{testimonials.map((item, index) => <figure key={`${item.name}-${index}`} className="public-card m-0 w-[min(82vw,320px)] shrink-0 snap-start p-5 md:w-[calc((100%_-_1.5rem)/3)]"><div className="text-sm font-bold text-[var(--color-public-accent)]" aria-label={`5점 만점에 ${item.rating}점`}>{"★".repeat(Math.max(0, Math.min(5, Math.round(item.rating))))}</div><blockquote className="my-3 text-base leading-relaxed text-[var(--color-public-text)]">{item.text}</blockquote><figcaption className="border-t border-[var(--color-public-border)] pt-3 text-sm"><span className="font-bold text-[var(--color-public-text)]">{item.name}</span><span className="ml-2 text-[var(--color-public-muted)]">{item.info}</span></figcaption></figure>)}</div>}
  </div></section>;
}
