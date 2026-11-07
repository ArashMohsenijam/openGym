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
  const profiles = S.equipProfiles || []
  const remove = p => confirmSheet({
    title: t('Delete profile?'), message: t('"{0}" and its equipment list will be removed.', p.name),
    confirmText: t('Delete'), danger: true,
    onConfirm: () => update(s => {
      s.equipProfiles = (s.equipProfiles || []).filter(x => x.id !== p.id)
      if (s.activeEquipId === p.id) s.activeEquipId = (s.equipProfiles[0] && s.equipProfiles[0].id) || null
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
  return <Section title={t('Equipment')} footer={t('Filters the exercise library and picker, and flags routine exercises that need something you don’t have in the active profile.')}>
    <Row icon="plate" iconTint="var(--orange)" title={t('Plates')} subtitle={plateSummary} accessory="chevron" onClick={() => plateInventorySheet()} />
    <Row icon="dumbbell" iconTint="var(--teal)" title={t('Dumbbells')} subtitle={dumbbellSummary} accessory="chevron" onClick={() => dumbbellInventorySheet()} />
    <Row icon="barbell" iconTint="var(--blue)" title={t('Your bars')} subtitle={barSummary} accessory="chevron" onClick={() => barDefaultsSheet()} />
    {profiles.length > 0 && <Row icon="kettlebell" iconTint="var(--acc)" title={t('Filter by equipment')}>
      <Switch checked={!!S.equipFilterOn} onChange={v => update(s => { s.equipFilterOn = v })} />
    </Row>}
    {profiles.length > 0 && <SelectRow icon="house" iconTint="var(--blue)" title={t('Active profile')}
      value={S.activeEquipId || ''} onChange={v => update(s => { s.activeEquipId = v })}
      options={profiles.map(p => ({ value: p.id, label: p.name }))} />}
    {profiles.map(p => (
      <Row key={p.id} icon="house" iconTint="var(--teal)" title={p.name}
        subtitle={t('{0} equipment types', p.equipment.length)} accessory="chevron"
        onClick={() => equipmentProfileSheet(p)}>
        <button className="iconbtn" aria-label={t('Delete')} onClick={ev => { ev.stopPropagation(); remove(p) }}><Icon name="trash" /></button>
      </Row>
    ))}
    <Row icon="plus" iconTint="var(--acc)" title={t('Add equipment profile')} accessory="chevron" onClick={() => equipmentProfileSheet(null)} />
  </Section>
}
