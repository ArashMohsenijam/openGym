import { useEffect, useRef } from 'react'
import { ACCENTS, ACCENT_NAMES } from '../lib/format.js'
import { setRestAccent } from '../lib/rest-alert.js'
import { CUSTOM, accentKey, adjustedIn, applyAccent, cleanHex, inkOn, isGrey } from '../lib/accent.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

// What the chosen accent is called: a preset's colour name, or the user's own.
export function accentLabel(S) {
  const k = accentKey(S)
  return k === CUSTOM ? t('Your own color') : t(ACCENT_NAMES[k] || 'Green')
}

/**
 * The presets, then one swatch for a colour of the user's own (lib/accent.js). With no colour
 * of their own yet it is a rainbow ring, and a tap opens the system colour picker straight away.
 * Once there is one it is filled with it: a tap picks it again (it is kept while a preset is
 * chosen), and a tap on it while it is the accent opens the picker to change it. The picker is
 * the native <input type="color"> laid over the swatch, so the tap that opens it is the user's
 * own, which iOS Safari and the Android WebView both want.
 */
// How long the colour picker has to rest before a colour is saved, when the browser sends no
// `change` at the end (it should, once the picker closes).
const OWN_COLOR_SETTLE_MS = 400

export function AccentSwatches({ S, update }) {
  const key = accentKey(S)
  const own = cleanHex(S.accentCustom)
  const onCustom = key === CUSTOM
  const pickPreset = k => { update(s => { s.accent = k }); setRestAccent(k) }
  const pickOwn = hex => {
    const c = cleanHex(hex)
    if (!c || (onCustom && c === own)) return
    update(s => { s.accent = CUSTOM; s.accentCustom = c })
    setRestAccent(c)
  }
  // The picker sends a colour for every step of a drag (React's onChange is the `input` event).
  // Those only repaint the page; the colour is saved, synced and sent to the native countdown
  // once: on the picker's `change`, after it has rested a moment, or when Settings closes.
  const inputRef = useRef(null)
  const pending = useRef(null)
  const timer = useRef(0)
  const pickOwnRef = useRef(pickOwn)
  pickOwnRef.current = pickOwn
  const commit = () => {
    clearTimeout(timer.current)
    const c = pending.current
    pending.current = null
    if (c) pickOwnRef.current(c)
  }
  const preview = hex => {
    const c = cleanHex(hex)
    if (!c) return
    const de = document.documentElement
    applyAccent(de, c, de.dataset.theme)
    pending.current = c
    clearTimeout(timer.current)
    timer.current = setTimeout(commit, OWN_COLOR_SETTLE_MS)
  }
  const hasInput = !(own && !onCustom)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onChange = () => { pending.current = cleanHex(el.value) || pending.current; commit() }
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  }, [hasInput]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => commit, []) // eslint-disable-line react-hooks/exhaustive-deps
  // The input is not controlled (React would put the saved colour back after every drag step);
  // a colour changed elsewhere (sync, another tab) is put in by hand.
  useEffect(() => {
    if (!pending.current && inputRef.current) inputRef.current.value = own || '#30d158'
  }, [own])
  const ownLabel = t('Your own color')
  const grey = own && isGrey(own)
  const notes = own && onCustom ? [
    adjustedIn(own, 'dark') && (grey ? t('Greys show lighter in dark mode, so buttons don’t look switched off.') : t('A touch lighter in dark mode, so you can still read it.')),
    adjustedIn(own, 'light') && (grey ? t('Greys show darker in light mode, so buttons don’t look switched off.') : t('A touch darker in light mode, so you can still read it.')),
  ].filter(Boolean) : []
  return <>
    <div className="swatches" style={{ flexBasis: '100%', paddingInlineStart: 41 }}>
      {Object.entries(ACCENTS).map(([k, c]) => (
        <button key={k} className={'swatch' + (key === k ? ' on' : '')}
          style={{ background: c }} onClick={() => pickPreset(k)} aria-label={t(ACCENT_NAMES[k] || k)} />
      ))}
      {!hasInput
        ? <button className="swatch swatch-own" style={{ background: own }} onClick={() => pickOwn(own)} aria-label={ownLabel} />
        : <span className={'swatch swatch-own' + (own ? ' on' : ' unset')} style={own ? { background: own, color: inkOn(own) } : undefined}>
          {own ? <Icon name="pencil" /> : <Icon name="plus" />}
          <input ref={inputRef} type="color" className="swatch-input" defaultValue={own || '#30d158'}
            onChange={e => preview(e.target.value)}
            aria-label={own ? t('Change your own color') : t('Pick your own color')} />
        </span>}
    </div>
    {notes.map(n => <span key={n} className="lrow-s swatch-note" style={{ flexBasis: '100%', paddingInlineStart: 41 }}>{n}</span>)}
  </>
}
