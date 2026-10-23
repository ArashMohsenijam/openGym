import { useEffect, useState } from 'react'
import { useStore, DEF } from '../store/useStore.js'
import { localTZ } from '../lib/format.js'
import { MOBILE, syncReminder } from '../lib/mobile.js'
import { NUDGE_COPY, NUDGE_TONES, toneOf } from '../lib/nudge.js'
import { pushSupported, enablePush, disablePush, sendTestPush, syncPushSubscription } from '../lib/push.js'
import { t } from '../lib/i18n.js'
import { Section, Row, SelectRow, Switch, Button } from './ui.jsx'

// Settings → Notifications: the push switch and day reminder in a browser, a native local
// reminder in the mobile build, and the missed-workout nudge under either.
export function NotificationsCard({ S, update, toast }) {
  if (MOBILE) return <MobileReminderCard S={S} update={update} toast={toast} />
  return <PushCard S={S} update={update} toast={toast} />
}

// Mobile build: the reminder is a native local notification scheduled on planned weekdays —
// no push server involved. The schedule itself is (re)synced by the store on every persist;
// this card only owns the OS permission prompt when the switch turns on.
function MobileReminderCard({ S, update, toast }) {
  // A paired phone checks with the server before a nudge (lib/nudge-check.js); the footer says
  // so, and that the phone decides when.
  const paired = useStore(s => !!s.user)
  const setReminder = patch => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), ...patch, tz: localTZ() } })
  const toggle = async () => {
    const on = !S.reminder?.on
    if (on) {
      const ok = await syncReminder({ ...S, reminder: { ...(S.reminder || DEF.reminder), on: true } }, true)
      if (!ok) { toast(t('Could not change notification settings')); return }
    }
    setReminder({ on })
  }
  return (
    <Section title={t('Notifications')}
      footer={S.reminder?.on ? t('Reminds you at this time on days that have a routine planned.') + nudgeNote(S) + (paired && S.reminder?.nudge ? ' ' + t('Logged a workout on another device? Before the nudge goes out, the phone checks with your server whenever it lets the app run in the background. Opening the app always catches up.') : '') : null}>
      <Row icon="calendar" iconTint="var(--orange)" title={t('Workout day reminder')}>
        <Switch checked={!!S.reminder?.on} onChange={toggle} aria-label={t('Workout day reminder')} />
      </Row>
      {S.reminder?.on && (
        <Row icon="clock" iconTint="var(--purple)" title={t('Reminder time')}>
          <input type="time" className="timef" value={S.reminder?.time || DEF.reminder.time}
            onChange={e => setReminder({ time: e.target.value })} />
        </Row>
      )}
      {S.reminder?.on && <NudgeRows S={S} setReminder={setReminder} />}
    </Section>
  )
}

// The missed-workout nudge (lib/nudge.js): a switch and its tone, under the reminder they ride
// on — the server sends it with the same push (or the phone schedules it beside the reminder).
function NudgeRows({ S, setReminder }) {
  const r = S.reminder || {}
  return <>
    <Row icon="bell" iconTint="var(--red)" title={t('Nudge me when I skip a planned workout')}>
      <Switch checked={!!r.nudge} onChange={() => setReminder({ nudge: !r.nudge })} aria-label={t('Nudge me when I skip a planned workout')} />
    </Row>
    {r.nudge && (
      <SelectRow icon="chat" iconTint="var(--blue)" title={t('Nudge tone')}
        value={toneOf(r)} onChange={v => setReminder({ tone: v })}
        options={NUDGE_TONES.map(k => ({ value: k, label: toneLabel(k), subtitle: t(NUDGE_COPY[k].title) }))} />
    )}
  </>
}
const toneLabel = k => k === 'guilt' ? t('Guilt trip') : k === 'drill' ? t('Drill sergeant') : t('Friendly')
const nudgeNote = S => S.reminder?.nudge
  ? ' ' + t('One nudge in the evening of a planned day with nothing logged, between 20:00 and 21:30. After 3 missed days in a row it goes quiet until your next workout.')
  : ''

function PushCard({ S, update, toast }) {
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const supported = pushSupported()

  // "On" means the server holds this browser's subscription, not merely that the browser has
  // one: a row the instance dropped (dead send, rebuilt db.json) left the switch on with nothing
  // ever arriving. syncPushSubscription re-registers on the way; if the server cannot be asked
  // (offline), the browser's side is the best answer available. A server that refused this
  // browser's subscription, even a fresh one, has answered: the switch is off, with its reason.
  useEffect(() => {
    if (!supported) return
    let gone = false
    syncPushSubscription()
      .then(ok => { if (!gone) setOn(ok) })
      .catch(e => {
        if (e?.refused) { if (!gone) { setOn(false); toast(e.message) } return }
        return navigator.serviceWorker.ready.then(reg => reg.pushManager.getSubscription()).then(sub => { if (!gone) setOn(!!sub) }).catch(() => {})
      })
    return () => { gone = true }
  }, [supported])

  const toggle = async v => {
    setBusy(true)
    try {
      if (!v) { await disablePush(); setOn(false); toast(t('Notifications off')) }
      else { await enablePush(); setOn(true); toast(t('Notifications on')) }
    } catch (e) { toast(e.message || t('Could not change notification settings')) }
    setBusy(false)
  }
  const test = async () => {
    try { await sendTestPush(); toast(t('Test sent! Should pop up any second')) }
    catch (e) { toast(e.message || t('Test failed')) }
  }

  if (!supported) return (
    <Section title={t('Notifications')}>
      <Row icon="bellSlash" iconTint="var(--grey)" title={t('Not supported in this browser.')} />
    </Section>
  )

  return <>
    <Section
      title={t('Notifications')}
      footer={on && S.reminder?.on
        ? t("Only sent on days you have a routine planned and haven't logged a workout yet.") +
          (S.reminder?.tz ? ' ' + t('Timezone: {0} (auto-detected, updates if you travel).', S.reminder.tz) : '') +
          nudgeNote(S)
        : null}
    >
      <Row icon="bell" iconTint="var(--red)" title={t('Push notifications')} subtitle={t('Rest-timer alerts, even if openGym is closed.')}>
        <Switch checked={on} disabled={busy} onChange={toggle} />
      </Row>
      {on && (
        <Row icon="calendar" iconTint="var(--orange)" title={t('Workout day reminder')}>
          <Switch checked={!!S.reminder?.on} onChange={() => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), on: !s.reminder?.on, tz: localTZ() } })} />
        </Row>
      )}
      {on && S.reminder?.on && (
        <Row icon="clock" iconTint="var(--purple)" title={t('Reminder time')}>
          <input type="time" className="timef" value={S.reminder?.time || DEF.reminder.time}
            onChange={e => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), time: e.target.value, tz: localTZ() } })} />
        </Row>
      )}
      {on && S.reminder?.on && (
        <NudgeRows S={S} setReminder={patch => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), ...patch, tz: localTZ() } })} />
      )}
    </Section>
    {on && <div style={{ marginTop: -12, marginBottom: 22 }}><Button size="sm" icon="bell" onClick={test}>{t('Send test notification')}</Button></div>}
  </>
}
