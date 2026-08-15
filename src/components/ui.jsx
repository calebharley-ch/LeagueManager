import { useEffect, useState } from 'react'
import { X, Loader2, Inbox, Share2, Link2, Check } from 'lucide-react'
import { canNativeShare, shareLink } from '../lib/share'

export function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/* ── Buttons ──────────────────────────────────────────────────────────────── */

const BUTTON_VARIANTS = {
  primary: 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 focus-visible:outline-emerald-400',
  danger:  'bg-rose-600 text-white hover:bg-rose-500 focus-visible:outline-rose-400',
  neutral: 'bg-slate-800 text-slate-100 hover:bg-slate-700 ring-1 ring-inset ring-slate-700 focus-visible:outline-slate-400',
  ghost:   'bg-transparent text-slate-300 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-slate-500',
}

export function Button({ variant = 'neutral', busy = false, className, children, disabled, ...rest }) {
  return (
    <button
      // Busy must disable too, or a double-click fires the mutation twice.
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold',
        'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

/**
 * "Send this to the group chat."
 *
 * One button, two behaviours by device: the OS share sheet on a phone (which
 * is how it reaches WhatsApp in one tap) and the clipboard everywhere else.
 * The label follows, because "Share" on a desktop that silently copied is a
 * button you press twice.
 */
export function ShareButton({
  text, url, toast, label, title, variant = 'ghost', className, compact = false,
}) {
  const [done, setDone] = useState(null)

  async function go() {
    const result = await shareLink({ text, url, toast })
    if (result === 'shared' || result === 'copied') {
      setDone(result)
      setTimeout(() => setDone(null), 1800)
    }
  }

  const Icon = done ? Check : canNativeShare ? Share2 : Link2
  const words = label ?? (canNativeShare ? 'Share' : 'Copy link')
  const doneWords = done === 'shared' ? 'Sent' : 'Copied'

  return (
    <Button
      type="button"
      variant={variant}
      onClick={go}
      // Compact hides its label, so the tooltip has to carry it — otherwise
      // three icon-only buttons on a card all describe themselves identically.
      title={title ?? (compact ? words : canNativeShare ? 'Share this link' : 'Copy this link to the clipboard')}
      className={cx('text-xs', className)}
    >
      <Icon className={cx('h-3.5 w-3.5', done && 'text-emerald-400')} aria-hidden />
      <span className={cx(compact && 'sr-only')}>{done ? doneWords : words}</span>
    </Button>
  )
}

export function IconButton({ label, className, children, ...rest }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ── Surfaces ─────────────────────────────────────────────────────────────── */

export function Card({ className, children, ...rest }) {
  return (
    <div
      className={cx('rounded-xl border border-slate-800 bg-slate-900/60 shadow-sm', className)}
      {...rest}
    >
      {children}
    </div>
  )
}

export function Badge({ className, children, title }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap',
        className
      )}
    >
      {children}
    </span>
  )
}

/** Small red count on a nav tab. Renders nothing at zero — an always-visible
 *  "0" trains you to ignore the badge entirely. */
export function CountBadge({ count }) {
  if (!count) return null
  return (
    <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}

/* ── Form controls ────────────────────────────────────────────────────────── */

const FIELD_BASE =
  'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 ' +
  'placeholder:text-slate-500 transition-colors focus:border-emerald-500 focus:outline-none ' +
  'focus:ring-1 focus:ring-emerald-500 disabled:opacity-50'

export function Field({ label, hint, children, className }) {
  return (
    <label className={cx('block', className)}>
      {label && (
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
          {label}
        </span>
      )}
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

export function Input({ className, ...rest }) {
  return <input className={cx(FIELD_BASE, className)} {...rest} />
}

export function Textarea({ className, ...rest }) {
  return <textarea className={cx(FIELD_BASE, 'resize-y', className)} {...rest} />
}

export function Select({ className, children, ...rest }) {
  return (
    <select className={cx(FIELD_BASE, 'pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

/**
 * Segmented control — the pill-shaped row of exclusive choices used for tabs
 * within a screen.
 *
 * Extracted because this markup was hand-rolled in four files (trades, rules,
 * the league gate and sign-in), which meant any restyle was a four-place edit
 * and none of them carried the tablist semantics a screen reader needs.
 *
 * options: [{ value, label, count?, icon? }]
 */
export function Segmented({ value, onChange, options, className }) {
  return (
    <div
      role="tablist"
      className={cx('flex gap-1 rounded-lg bg-slate-900/60 p-1 ring-1 ring-slate-800', className)}
    >
      {options.map((o) => {
        const active = value === o.value
        const Icon = o.icon
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5',
              'text-sm font-semibold transition-colors',
              active ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />}
            {o.label}
            {o.count != null && <span className="text-slate-500">({o.count})</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ── Feedback ─────────────────────────────────────────────────────────────── */

export function Spinner({ className }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-slate-500', className)} aria-hidden />
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  )
}

export function EmptyState({ icon: Icon = Inbox, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <Icon className="h-8 w-8 text-slate-600" aria-hidden />
      <p className="text-sm font-semibold text-slate-300">{title}</p>
      {children && <p className="max-w-sm text-sm text-slate-500">{children}</p>}
    </div>
  )
}

/* ── Modal ────────────────────────────────────────────────────────────────── */

export function Modal({ open, onClose, title, children, footer, wide = false }) {
  // Escape-to-close, plus a scroll lock so the page behind doesn't scroll away
  // under the dialog on mobile.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // Backdrop click closes, but only when the backdrop ITSELF is the target —
      // otherwise a drag that starts inside the panel and ends outside closes it.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <Card className={cx('my-auto w-full', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-5 py-3.5">
          <h2 className="text-base font-bold text-slate-100">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="h-4 w-4" /></IconButton>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3.5">{footer}</div>
        )}
      </Card>
    </div>
  )
}
