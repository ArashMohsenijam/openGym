import { useEffect, useState } from 'react'
import { healthStatus, loadHealth, enableHealth, disableHealth, openHealthConnect, onHealthChange } from '../lib/health-sync.js'
import { t } from '../lib/i18n.js'
import { menuSheet } from '../sheets.jsx'
import { Section, Row, Switch } from './ui.jsx'

// Android app: writing finished workouts and weigh-ins to Health Connect (#200), the phone's
// own store for health data, where other apps can read them. A fact about this phone, kept in
// its own file (lib/health-sync.js) and not in S, so it never switches on anywhere else. The card
// stays out of the way on a phone without Health Connect, and only points to installing it on
// Android 13 and lower, where it is an app of its own. The iPhone app's card is the same switch for
// Apple Health, which the Apple Watch app also goes by (heart rate per set).
const HEALTH_COPY = {
  android: () => ({
    section: t('Health Connect'), write: t('Write to Health Connect'), open: t('Open Health Connect'),
    footer: t('Workouts and weigh-ins go to Health Connect when you finish or change them. openGym reads nothing back.'),
    on: t('Writing to Health Connect'), denied: t('Health Connect permission not granted'), failed: t('Could not write to Health Connect'),
    removeFailed: t('Could not remove it from Health Connect'), stop: t('Stop writing to Health Connect?'),
    stopSub: t('What openGym already wrote can stay in Health Connect as your data, or be removed from it.'),
  }),
  ios: () => ({
    section: t('Apple Health'), write: t('Write to Apple Health'), open: t('Open Apple Health'),
    footer: t('Workouts and weigh-ins go to Apple Health when you finish or change them.'),
    on: t('Writing to Apple Health'), denied: t('Apple Health permission not granted'), failed: t('Could not write to Apple Health'),
    removeFailed: t('Could not remove it from Apple Health'), stop: t('Stop writing to Apple Health?'),
    stopSub: t('What openGym already wrote can stay in Apple Health as your data, or be removed from it.'),
  }),
}

export default function HealthConnectCard({ S, toast, android }) {
  const [st, setSt] = useState(null)
  const [h, setH] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let gone = false
    Promise.all([healthStatus(), loadHealth()]).then(([s, f]) => { if (!gone) { setSt(s); setH(f) } }).catch(() => {})
    const off = onHealthChange(f => { if (!gone) setH(f) })
    return () => { gone = true; off() }
  }, [])
  const ios = st?.platform === 'ios'
  if (!st || !h || st.status === 'unsupported' || (!android && !ios)) return null
  const c = HEALTH_COPY[ios ? 'ios' : 'android']()

  if (st.status !== 'available') return (
    <Section title={t('Health Connect')}>
      <Row icon="heart" iconTint="var(--red)" title={t('Health Connect')}
        subtitle={st.status === 'update'
          ? t('Update Health Connect to share workouts and weigh-ins with other apps.')
          : t('Install Health Connect to share workouts and weigh-ins with other apps.')}
        accessory="chevron" onClick={() => openHealthConnect().catch(() => {})} />
    </Section>
  )

  const turnOn = async () => {
    setBusy(true)
    try {
      const r = await enableHealth(S)
      if (r.health) setH(r.health)
      else setH(await loadHealth())
      if (r.ok) toast(c.on)
      else toast(r.reason === 'denied' ? c.denied : c.failed)
    } catch { toast(c.failed) }
    setBusy(false)
  }
  const turnOff = removeWritten => async () => {
    setBusy(true)
    try { setH(await disableHealth({ removeWritten })) }
    catch { toast(c.removeFailed) }
    setBusy(false)
  }
  // Off can mean two things for what is already there, so it asks; closing the sheet keeps it on.
  const askOff = () => menuSheet({
    title: c.stop,
    subtitle: c.stopSub,
    items: [
      { icon: 'check', label: t('Stop, keep what it wrote'), onClick: turnOff(false) },
      { icon: 'trash', label: t('Stop and remove what it wrote'), danger: true, onClick: turnOff(true) },
    ],
  })

  return (
    <Section title={c.section}
      footer={h.on ? c.footer : null}>
      <Row icon="heart" iconTint="var(--red)" title={c.write}
        subtitle={t('Finished workouts and weigh-ins, from this phone only.')}>
        <Switch checked={!!h.on} disabled={busy} onChange={v => (v ? turnOn() : askOff())} />
      </Row>
      {h.on && h.error === 'permission' && <Row icon="warning" iconTint="var(--orange)"
        title={t('Permission withdrawn. Tap to allow again')} accessory="chevron" onClick={turnOn} />}
      {h.on && <Row icon="list" iconTint="var(--blue)" title={c.open}
        accessory="chevron" onClick={() => openHealthConnect().catch(() => {})} />}
    </Section>
  )
}
