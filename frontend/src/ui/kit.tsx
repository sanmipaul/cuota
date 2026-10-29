"use client";

import Link from "next/link";
import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { useI18n } from "@/i18n/context";

type Tone = "brick" | "ghost" | "outline" | "danger";

const TONES: Record<Tone, string> = {
  brick: "bg-brick text-brick-ink hover:bg-brick-hover shadow-[0_6px_18px_-8px_var(--brick)]",
  outline: "bg-card text-fg border border-line-strong hover:border-fg",
  ghost: "text-muted hover:text-fg",
  danger: "text-danger border border-danger/35 hover:bg-danger-soft",
};
const SIZES = { sm: "h-9 px-4 text-sm", md: "h-11 px-5 text-[15px]", lg: "h-13 px-7 text-base" };
const BASE = "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors disabled:opacity-45 disabled:pointer-events-none";

export function Btn({
  tone = "brick",
  size = "md",
  busy,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: keyof typeof SIZES; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} className={`${BASE} ${SIZES[size]} ${TONES[tone]} ${className}`}>
      {busy && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function BtnLink({ href, tone = "brick", size = "md", className = "", children }: { href: string; tone?: Tone; size?: keyof typeof SIZES; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={`${BASE} ${SIZES[size]} ${TONES[tone]} ${className}`}>
      {children}
    </Link>
  );
}

export function Label({ text, hint, children }: { text: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{text}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] leading-snug text-muted">{hint}</span>}
    </label>
  );
}

const field = "w-full rounded-xl border border-line-strong bg-card px-3.5 text-[15px] text-fg placeholder:text-faint focus:border-brick focus:outline-none";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${field} h-11 ${props.className ?? ""}`} />;
}

export function Choice(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${field} h-11 ${props.className ?? ""}`} />;
}

const BADGE: Record<string, string> = {
  proposed: "bg-sun-soft text-sun",
  active: "bg-olive-soft text-olive",
  cancelled: "bg-line text-muted",
  paid: "bg-olive-soft text-olive",
  upcoming: "bg-brick-soft text-brick",
};

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${BADGE[kind] ?? "bg-line text-muted"}`}>{children}</span>;
}

export function Note({ tone = "info", children }: { tone?: "info" | "sun" | "danger" | "olive"; children: ReactNode }) {
  const cls = { info: "bg-card border-line text-muted", sun: "bg-sun-soft border-sun/30 text-sun", danger: "bg-danger-soft border-danger/30 text-danger", olive: "bg-olive-soft border-olive/30 text-olive" }[tone];
  return <div className={`rounded-2xl border px-4 py-3 text-sm leading-relaxed ${cls}`}>{children}</div>;
}

export function CopyField({ value }: { value: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-full border border-line-strong bg-card py-1.5 pl-4 pr-1.5">
      <span className="num flex-1 truncate text-sm">{value}</span>
      <Btn
        size="sm"
        tone="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            window.prompt("", value);
          }
        }}
      >
        {done ? t.common.copied : t.common.copy}
      </Btn>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-2xl bg-line/70 ${className}`} />;
}
