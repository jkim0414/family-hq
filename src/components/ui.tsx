import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { SOURCE_LABEL } from "../store";
import { personById, PEOPLE } from "../data/people";
import type { Category, Source } from "../data/types";

// ── Primitives shared by every view ──────────────────────────────────────────
// One vocabulary, iOS-flavoured: grouped inset cards with hairline separators,
// a single tinted accent, small-caps section headers, large page titles.
// Colors are semantic tokens (src/index.css) so dark mode is automatic.

export function Card({ children, className = "", accent }: { children: ReactNode; className?: string; accent?: string }) {
  return (
    <div className={`rounded-2xl bg-surface shadow-card ring-1 ring-line/70 ${className}`} style={accent ? { boxShadow: `inset 4px 0 0 ${accent}` } : undefined}>
      {children}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BTN_BASE = "inline-flex items-center justify-center whitespace-nowrap rounded-xl font-semibold transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100";
const BTN_SIZE: Record<Size, string> = {
  sm: "min-h-[36px] px-3.5 text-[13px]",
  md: "min-h-[46px] px-5 text-[15px]",
};
const BTN_VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-white",
  secondary: "bg-accent-soft text-accent",
  ghost: "text-accent hover:bg-fill",
  danger: "text-danger hover:bg-danger-soft",
};

/** The one button. primary = the main action; secondary = tinted alternative; ghost = low-emphasis; danger = destructive. */
export function Button({ variant = "primary", size = "md", className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} {...props} className={`${BTN_BASE} ${BTN_SIZE[size]} ${BTN_VARIANT[variant]} ${className}`} />;
}

/** Small-caps group header with optional right-side actions. */
export function SectionHeader({ title, children, hint }: { title: string; children?: ReactNode; hint?: string }) {
  return (
    <div className="mb-2 px-1">
      <div className="flex min-h-[28px] items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{title}</h2>
        {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
      </div>
      {hint && <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}

/**
 * A section whose body can be folded away. The header shows a count so a closed
 * section still says what's in it; actions (e.g. "+ Add") stay reachable.
 * Open/closed is remembered per device; a jump link to #id opens it.
 */
export function Collapsible({
  id,
  title,
  count,
  hint,
  actions,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  hint?: string;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `fhq:open:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash !== `#${id}`) return;
      setOpen(true);
      // Scroll after the section has expanded, so it lands at the top.
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [id]);

  return (
    <section id={id} className="scroll-mt-4">
      <div className="mb-2 px-1">
        <div className="flex min-h-[36px] items-center justify-between gap-3">
          <button type="button" aria-expanded={open} onClick={() => set(!open)} className="-ml-1 flex min-h-[36px] min-w-0 items-center gap-1.5 rounded-lg px-1 text-left">
            <Icon name="chevron" className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{title}</h2>
            {typeof count === "number" && <span className="rounded-full bg-fill px-1.5 text-[11px] font-semibold text-ink-3">{count}</span>}
          </button>
          {open && actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
        {open && hint && <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{hint}</p>}
      </div>
      {open && children}
    </section>
  );
}

/** Text action for section headers ("+ Add", "See all"). 36px hit area. */
export function TextAction({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`-my-2 min-h-[36px] rounded-lg px-2 text-[13px] font-semibold text-accent hover:bg-accent-soft ${className}`} />;
}

export function PersonChip({ id, variant = "fill" }: { id: string; variant?: "fill" | "outline" }) {
  const p = personById(id);
  const color = p?.color ?? "#8a8a92"; // guests → neutral
  const name = p?.name ?? id;
  const style = variant === "outline" ? { color, background: "transparent", boxShadow: `inset 0 0 0 1px ${color}80` } : { background: `${color}22`, color };
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium" style={style}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

export function PeopleChips({ ids, variant }: { ids: string[]; variant?: "fill" | "outline" }) {
  if (!ids?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <PersonChip key={id} id={id} variant={variant} />
      ))}
    </span>
  );
}

// Shows who it's FOR (filled chips) and who's RESPONSIBLE (outlined, after "resp").
export function WhoChips({ people, owner }: { people: string[]; owner?: string[] }) {
  const forIds = people || [];
  const ownerIds = (owner || []).filter((id) => !forIds.includes(id));
  if (!forIds.length && !ownerIds.length) return null;
  const everyone = PEOPLE.every((p) => forIds.includes(p.id));
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {everyone ? (
        <span className="inline-flex items-center rounded-full bg-fill px-2 py-0.5 text-[12px] font-medium text-ink-2">Whole family</span>
      ) : (
        forIds.map((id) => <PersonChip key={id} id={id} />)
      )}
      {ownerIds.length > 0 && (
        <>
          <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">resp</span>
          {ownerIds.map((id) => (
            <PersonChip key={`o-${id}`} id={id} variant="outline" />
          ))}
        </>
      )}
    </span>
  );
}

const CAT_STYLE: Record<Category, { label: string; cls: string }> = {
  alert: { label: "Alert", cls: "bg-danger-soft text-danger" },
  action: { label: "Action", cls: "bg-warn-soft text-warn" },
  calendar: { label: "Calendar", cls: "bg-accent-soft text-accent" },
  fyi: { label: "FYI", cls: "bg-fill text-ink-3" },
};

export const CATEGORY_LABEL = (c: Category) => CAT_STYLE[c].label;

export function CategoryBadge({ category }: { category: Category }) {
  const s = CAT_STYLE[category];
  return <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>;
}

export function SourceBadge({ source }: { source: Source }) {
  return <span className="rounded-md bg-fill px-1.5 py-0.5 text-[11px] font-medium text-ink-2">{SOURCE_LABEL[source] || source}</span>;
}

/** Large title, iOS style, with an optional trailing action. */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <h1 className="text-[32px] font-bold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[15px] text-ink-3">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 pb-1">{action}</div>}
    </div>
  );
}

// Line icons (24px grid, 1.9 stroke) — one visual language for controls.
const ICON_PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  chat: "M21 12a9 9 0 0 1-13.4 7.8L3 21l1.2-4.6A9 9 0 1 1 21 12z",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  people: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  sparkles: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7zM5 2l.6 1.6 1.6.6-1.6.6L5 6.4l-.6-1.6L2.8 4.2l1.6-.6z",
  pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  paperclip: "M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  chevron: "M9 18l6-6-6-6",
} as const;
export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** Kimi, the family's assistant. */
export function KimiAvatar({ size = 32, className = "" }: { size?: number; className?: string }) {
  return <img src="/kimi.jpg" alt="Kimi" width={size} height={size} className={`shrink-0 rounded-full ring-1 ring-line/60 ${className}`} style={{ width: size, height: size }} />;
}

/** iOS-style switch for on/off settings. */
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-ok" : "bg-fill ring-1 ring-inset ring-line"}`}
    >
      <span className={`absolute left-0 top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-[2px]"}`} />
    </button>
  );
}

/** The edit affordance on a card: a pencil in a 40px hit area. */
export function EditButton({ onClick, label, className = "" }: { onClick: () => void; label: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-fill hover:text-ink-2 ${className}`}>
      <Icon name="pencil" className="h-[18px] w-[18px]" />
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-line px-5 py-6 text-center text-[15px] text-ink-3">{children}</div>;
}
