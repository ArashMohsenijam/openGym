import { useUI } from '../store/useUI.js'
import { activeGym, gymLabel, switchGym } from '../lib/gym-inventory.js'
import { fmtPlate } from '../lib/format.js'
import { inventoryFor, ownsPlates } from '../lib/plates.js'
import { BAR_TYPES, ownBarDefault } from '../lib/bar.js'
import { dumbbellsOf, ownsNoDumbbells } from '../lib/dumbbells.js'
import { t } from '../lib/i18n.js'
import { confirmSheet, equipmentProfileSheet, plateInventorySheet, dumbbellInventorySheet, barDefaultsSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Section, Row, SelectRow, Switch } from './ui.jsx'

// Equipment profiles ("Home", "Gym", ...) — each an id/name/eq-list; the active one filters
// the Library, exercise picker, and flags routine entries that need something outside it
// (see lib/equipment.js). Purely local/synced state — no server changes needed.
export default function EquipmentCard({ S, update }) {
  const toast = useUI(s => s.toast)
  const profiles = S.equipProfiles || []
  // Each profile is a gym with its own plates, dumbbells, bars and stacks (#808, lib/gym-inventory.js);
  // the rows below edit the active one's, and switching here switches all of it.
  const gym = activeGym(S)
  const pickGym = id => {
    const g = profiles.find(p => p.id === id)
    if (!g || id === S.activeEquipId) return
    update(s => { switchGym(s, id) })
    toast(t('Using {0} equipment', gymLabel(g)))
  }
  // Removing the active gym makes the next one active, with its own lists.
  const remove = p => confirmSheet({
    title: t('Delete profile?'), message: t('"{0}" and its equipment list will be removed.', p.name),
    confirmText: t('Delete'), danger: true,
    onConfirm: () => update(s => {
      const rest = (s.equipProfiles || []).filter(x => x.id !== p.id)
      if (s.activeEquipId === p.id && rest[0]) switchGym(s, rest[0].id)
      s.equipProfiles = (s.equipProfiles || []).filter(x => x.id !== p.id)
      if (s.activeEquipId === p.id) s.activeEquipId = null
      if (s.invGym === p.id) delete s.invGym
    }),
  })
  // The plates you own, per unit (lib/plates.js) — what the set rows' plate lines load from.
  const plateSummary = ownsPlates(S)
    ? inventoryFor(S).map(p => fmtPlate(p.w) + '×' + p.n).join(' · ') || t('None')
    : t('Standard set. Tap to count the pairs you own.')
  // The dumbbells you own, per unit (lib/dumbbells.js): what dumbbell lifts step and progress over.
  const bells = dumbbellsOf(S)
  const dumbbellSummary = ownsNoDumbbells(S) ? t('None, so dumbbell lifts stay hidden.')
    : bells.length ? bells.map(fmtPlate).join(' · ')
      : t('Any weight. Tap to list the ones you own.')
  // Your bars (lib/bar.js ownBarDefault): the types you set a weight for, in the profile unit.
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const ownBars = BAR_TYPES.filter(eq => ownBarDefault(S, eq) !== null)
  const barSummary = ownBars.length
    ? ownBars.map(eq => { const n = t(eq); return n.charAt(0).toLocaleUpperCase() + n.slice(1) + ' ' + fmtPlate(ownBarDefault(S, eq)) + ' ' + unit }).join(' · ')
    : t('Standard bars. Tap if yours are lighter.')
  return <>
  {profiles.length > 0 && <Section title={t('Your gym')} footer={t('Plates, dumbbells, bars and machine stacks are kept per gym. Switch gyms and all of it switches.')}>
    <SelectRow icon="house" iconTint="var(--blue)" title={t('Active gym')} value={gym?.id || ''} onChange={pickGym}
      options={[...(gym ? [] : [{ value: '', label: t('Pick a gym') }]), ...profiles.map(p => ({ value: p.id, label: gymLabel(p) }))]} />
  </Section>}
  <Section title={gym ? t('Equipment at {0}', gymLabel(gym)) : t('Equipment')} footer={t('Filters the exercise library and picker, and flags routine exercises that need something you don’t have in the active profile.')}>
    <Row icon="plate" iconTint="var(--orange)" title={t('Plates')} subtitle={plateSummary} accessory="chevron" onClick={() => plateInventorySheet()} />
    <Row icon="dumbbell" iconTint="var(--teal)" title={t('Dumbbells')} subtitle={dumbbellSummary} accessory="chevron" onClick={() => dumbbellInventorySheet()} />
    <Row icon="barbell" iconTint="var(--blue)" title={t('Your bars')} subtitle={barSummary} accessory="chevron" onClick={() => barDefaultsSheet()} />
    {profiles.length > 0 && <Row icon="kettlebell" iconTint="var(--acc)" title={t('Filter by equipment')}>
      <Switch checked={!!S.equipFilterOn} onChange={v => update(s => { s.equipFilterOn = v })} />
    </Row>}
    {profiles.map(p => (
      <Row key={p.id} icon="house" iconTint="var(--teal)" title={p.name}
        subtitle={t('{0} equipment types', p.equipment.length)} accessory="chevron"
        onClick={() => equipmentProfileSheet(p)}>
        <button className="iconbtn" aria-label={t('Delete')} onClick={ev => { ev.stopPropagation(); remove(p) }}><Icon name="trash" /></button>
      </Row>
    ))}
    <Row icon="plus" iconTint="var(--acc)" title={t('Add equipment profile')} accessory="chevron" onClick={() => equipmentProfileSheet(null)} />
  </Section>
  {!profiles.length && <p className="sect-f">{t('Train in more than one place? Add a profile for each gym and each keeps its own plates, dumbbells and bars.')}</p>}
  </>
}
