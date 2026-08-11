import { useEffect, useRef, useState } from 'react'
import { Search, X, AlertTriangle } from 'lucide-react'
import { Input, cx } from './ui'

const INJURY_TONE = {
  OUT: 'text-rose-400',
  INJURY_RESERVE: 'text-rose-400',
  IR: 'text-rose-400',
  DOUBTFUL: 'text-orange-400',
  QUESTIONABLE: 'text-amber-400',
  SUSPENSION: 'text-rose-400',
}
const isHurt = (s) => s && s !== 'ACTIVE' && s !== 'NORMAL'

/**
 * Typeahead over the synced ESPN player universe, with free-text fallback.
 *
 * Falls back deliberately rather than blocking: if `sync:espn` has never run,
 * or the player genuinely isn't in ESPN's list (offseason UDFA, a placeholder
 * asset), you can still type a name and trade him. The picker upgrades the
 * experience, it never gates it.
 *
 * onChange({ player_name, player_position, espn_player_id })
 */
export default function PlayerPicker({
  value, position, onChange, search, available, disabled, className, placeholder,
}) {
  const [query, setQuery] = useState(value ?? '')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const boxRef = useRef(null)

  // Keep in sync when the parent resets the row (e.g. after submitting).
  useEffect(() => { setQuery(value ?? '') }, [value])

  // Close on outside click. Without this the list stays open behind the next
  // asset row and swallows its clicks.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const results = available && open ? search(query) : []

  function choose(p) {
    setQuery(p.name)
    setOpen(false)
    onChange({ player_name: p.name, player_position: p.position, espn_player_id: p.espn_id })
  }

  function handleKeyDown(e) {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % results.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + results.length) % results.length) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[highlight]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={boxRef} className={cx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden />
      <Input
        className="pl-8 pr-7"
        value={query}
        disabled={disabled}
        placeholder={available ? (placeholder ?? 'Search players…') : 'Player name'}
        aria-label="Player name"
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value)
          setHighlight(0)
          setOpen(true)
          // Typing past a chosen player detaches the espn id — the free text is
          // now the truth and a stale id would silently mislabel the asset.
          onChange({ player_name: e.target.value, player_position: position, espn_player_id: null })
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {query && (
        <button
          type="button"
          aria-label="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200"
          onClick={() => {
            setQuery('')
            onChange({ player_name: '', player_position: position, espn_player_id: null })
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {open && results.length > 0 && (
        <ul
          // min-w-full, not w-full: it can grow past the input where there is
          // room, but never shrink below it. A fixed larger width would be
          // clipped — the modal body is overflow-y-auto, which forces
          // overflow-x to auto too.
          className="absolute z-30 mt-1 max-h-60 w-max min-w-full max-w-[min(20rem,80vw)] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl scrollbar-thin"
          role="listbox"
        >
          {results.map((p, i) => (
            <li key={p.espn_id}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                // mousedown, not click: the input's blur would close the list
                // before a click ever lands.
                onMouseDown={(e) => { e.preventDefault(); choose(p) }}
                onMouseEnter={() => setHighlight(i)}
                className={cx(
                  'block w-full px-2.5 py-1.5 text-left text-sm transition-colors',
                  i === highlight ? 'bg-slate-800' : 'hover:bg-slate-800/60'
                )}
              >
                {/* ⚠️ TWO LINES ON PURPOSE. This dropdown is only as wide as the
                    input, and the input lives in a grid cell inside the trade
                    builder — measured at ~110px. Competing for that row with a
                    position badge, team and rank (all shrink-0) left the name
                    span 4px, so every player rendered as a single letter. The
                    name now owns its own line and the metadata sits beneath. */}
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-100">
                    {p.name}
                  </span>
                  {isHurt(p.injury_status) && (
                    <AlertTriangle
                      className={cx('h-3 w-3 shrink-0', INJURY_TONE[p.injury_status] ?? 'text-amber-400')}
                      aria-label={p.injury_status}
                    />
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                  <span className="rounded bg-slate-800 px-1 py-px font-bold text-slate-300">
                    {p.position}
                  </span>
                  <span>{p.pro_team}</span>
                  {p.espn_rank && <span className="text-slate-600">#{p.espn_rank}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
