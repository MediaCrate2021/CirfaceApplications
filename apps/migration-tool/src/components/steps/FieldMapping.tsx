import React, { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type {
  AsanaFieldType,
  EnumMappingEntry,
  FieldMappingEntry,
  NormalisedField,
  NormalisedFieldType,
  NormalisedSection,
  SectionMappingEntry,
} from '../../types/index.ts';

interface AsanaField {
  gid: string;
  name: string;
  type: string;
  enum_options?: Array<{ gid: string; name: string }>;
}

interface Props {
  state: AppState;
  onSave: (fieldMapping: FieldMappingEntry[], sectionMapping: SectionMappingEntry[]) => void;
  onBack: () => void;
}

// Sentinel values for native Asana task field destinations
const NATIVE_DUE_ON    = '__native:due_on';
const NATIVE_NOTES     = '__native:notes';
const NATIVE_ASSIGNEE  = '__native:assignee';
const NATIVE_FOLLOWERS = '__native:followers';

// Display order for native Asana fields (after the synthetic Title row)
const NATIVE_ORDER: Array<FieldMappingEntry['destNativeField']> = ['assignee', 'due_on', 'notes', 'followers'];

// Sentinel prefix for "create a new field of this type" in the existing-project dropdown
const NEW_FIELD_PREFIX = '__new:';
const NEW_FIELD_TYPES: Array<{ type: AsanaFieldType; label: string }> = [
  { type: 'text',       label: 'New Field: Text' },
  { type: 'number',     label: 'New Field: Number' },
  { type: 'date',       label: 'New Field: Date' },
  { type: 'enum',       label: 'New Field: Dropdown (single)' },
  { type: 'multi_enum', label: 'New Field: Dropdown (multi)' },
  { type: 'people',     label: 'New Field: People' },
];

// Dropdown options for new-project mode — native shortcuts first, then create-new types
const ASANA_CREATABLE_TYPES: Array<{ value: AsanaFieldType | string; label: string }> = [
  { value: NATIVE_ASSIGNEE,   label: '→ Assignee (native Asana field)' },
  { value: NATIVE_DUE_ON,     label: '→ Due Date (native Asana field)' },
  { value: NATIVE_NOTES,      label: '→ Notes / Description (native Asana field)' },
  { value: NATIVE_FOLLOWERS,  label: '→ Followers / Members (native Asana field)' },
  { value: 'text',            label: 'New Field Type: Text' },
  { value: 'number',          label: 'New Field Type: Number' },
  { value: 'date',            label: 'New Field Type: Date' },
  { value: 'enum',            label: 'New Field Type: Dropdown (single)' },
  { value: 'multi_enum',      label: 'New Field Type: Dropdown (multi)' },
  { value: 'people',          label: 'New Field Type: People' },
];

function defaultAsanaType(src: NormalisedFieldType): AsanaFieldType {
  const map: Record<NormalisedFieldType, AsanaFieldType> = {
    text: 'text', number: 'number', date: 'date',
    dropdown: 'enum', checkbox: 'enum', people: 'people',
    link: 'text', unknown: 'text',
  };
  return map[src];
}

/**
 * For Monday sources, automatically map well-known columns to native Asana fields.
 * Returns the native field key, or undefined if no match.
 */
function mondayNativeField(name: string, type: NormalisedFieldType): FieldMappingEntry['destNativeField'] {
  const n = name.toLowerCase().trim();
  if (type === 'people' && n === 'owner')                              return 'assignee';
  if (type === 'date'   && (n === 'due date' || n === 'deadline'))    return 'due_on';
  if (type === 'text'   && (n === 'notes' || n === 'description' || n === 'text')) return 'notes';
  return undefined;
}

/** A table row that visually separates groups of fields. */
function SeparatorRow({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          padding: '6px 12px',
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'var(--text-muted, #888)',
          background: 'var(--bg-subtle, #f8f9fa)',
          borderTop: '2px solid var(--border, #e0e0e0)',
          borderBottom: '1px solid var(--border, #e0e0e0)',
        }}
      >
        {label}
      </td>
    </tr>
  );
}

/** A read-only row for Title — always the first native Asana field. */
function TitleRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      {/* Omit cell — disabled for title */}
      <td className="omit-cell">
        <input type="checkbox" disabled title="Title is always migrated" />
      </td>
      <td>Name / Title</td>
      <td><span className="type-pill">text</span></td>
      <td colSpan={colSpan - 3} style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>
        Task Name — always migrated
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// New-project mode — type selector, no dest field picker
// ---------------------------------------------------------------------------

function NewProjectMapping({ state, onSave, onBack }: Props) {
  const [mapping, setMapping] = useState<FieldMappingEntry[]>(state.fieldMapping);
  const [sectionMapping, setSectionMapping] = useState<SectionMappingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const hasFired = useRef(false);

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;

    Promise.all([
      fetch(`/api/source/project-fields?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedField[]>),
      fetch(`/api/source/project-sections?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedSection[]>),
    ])
      .then(([src, sections]) => {
        if (!state.fieldMapping.length) {
          setMapping(src.map((f) => {
            const nativeField = state.sourcePlatform === 'monday'
              ? mondayNativeField(f.name, f.type)
              : undefined;
            return {
              sourceFieldId: f.id,
              sourceFieldName: f.name,
              sourceFieldType: f.type,
              sourceOptions: f.options,
              destFieldId: null,
              destFieldName: null,
              destFieldType: nativeField ? null : defaultAsanaType(f.type),
              destNativeField: nativeField,
              isOrgWide: false,
              confidence: nativeField ? 'exact' : 'none',
              omit: false,
            };
          }));
        }
        setSectionMapping(sections.map((s) => ({
          sourceId: s.id,
          sourceName: s.name,
          destId: null,
          destName: s.name,
          omit: false,
        })));
        setLoading(false);
      })
      .catch(() => { setError('Failed to load source fields'); setLoading(false); });
  }, []);

  function setType(sourceFieldId: string, value: string) {
    setMapping((prev) => prev.map((m) => {
      if (m.sourceFieldId !== sourceFieldId) return m;
      if (value === NATIVE_DUE_ON)    return { ...m, destFieldType: null, destNativeField: 'due_on'    as const };
      if (value === NATIVE_NOTES)     return { ...m, destFieldType: null, destNativeField: 'notes'     as const };
      if (value === NATIVE_ASSIGNEE)  return { ...m, destFieldType: null, destNativeField: 'assignee'  as const };
      if (value === NATIVE_FOLLOWERS) return { ...m, destFieldType: null, destNativeField: 'followers' as const };
      return { ...m, destFieldType: value as AsanaFieldType, destNativeField: undefined };
    }));
  }

  function toggleOmit(sourceFieldId: string) {
    setMapping((prev) => prev.map((m) =>
      m.sourceFieldId === sourceFieldId ? { ...m, omit: !m.omit } : m,
    ));
  }

  const omittedCount = mapping.filter((m) => m.omit).length;
  const activeCount = mapping.length - omittedCount;

  async function handleSave() {
    await fetch('/api/session/field-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping, sectionMapping }),
    });
    onSave(mapping, sectionMapping);
  }

  // Group entries for sectioned display
  const nativeEntries = mapping
    .filter((e) => e.destNativeField)
    .sort((a, b) => NATIVE_ORDER.indexOf(a.destNativeField!) - NATIVE_ORDER.indexOf(b.destNativeField!));
  const newEntries = mapping.filter((e) => !e.destNativeField);

  function renderRow(entry: FieldMappingEntry) {
    return (
      <tr key={entry.sourceFieldId} className={entry.omit ? 'row-omitted' : ''}>
        <td className="omit-cell">
          <input type="checkbox" checked={entry.omit} onChange={() => toggleOmit(entry.sourceFieldId)} title="Omit — do not create this field" />
        </td>
        <td>{entry.sourceFieldName}</td>
        <td><span className="type-pill">{entry.sourceFieldType}</span></td>
        <td>
          <select
            value={entry.destNativeField ? `__native:${entry.destNativeField}` : (entry.destFieldType ?? 'text')}
            onChange={(e) => setType(entry.sourceFieldId, e.target.value)}
            disabled={entry.omit}
          >
            {ASANA_CREATABLE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </td>
      </tr>
    );
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Project Mapping</h2>
      <p className="step-desc">
        These fields will be created as <strong>project-level custom fields</strong> in the new Asana project.
        Choose the Asana type for each field.
        {omittedCount > 0 && <> <span className="muted-text">{omittedCount} field{omittedCount !== 1 ? 's' : ''} omitted.</span></>}
        {activeCount === 0 && omittedCount > 0 && <> All fields omitted — no custom fields will be created.</>}
      </p>

      {loading && <p className="loading-text">Loading source fields…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <>
          <h3 className="mapping-section-heading">Sections</h3>
          <div className="mapping-table-wrapper">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>Omit</th>
                  <th>Source Section</th>
                  <th>Destination Name</th>
                </tr>
              </thead>
              <tbody>
                {sectionMapping.map((entry) => (
                  <tr key={entry.sourceId} className={entry.omit ? 'row-omitted' : ''}>
                    <td className="omit-cell">
                      <input type="checkbox" checked={entry.omit}
                        onChange={() => setSectionMapping(prev => prev.map(s => s.sourceId === entry.sourceId ? { ...s, omit: !s.omit } : s))} />
                    </td>
                    <td>{entry.sourceName}</td>
                    <td>
                      <input type="text" value={entry.destName ?? ''} disabled={entry.omit}
                        onChange={(e) => setSectionMapping(prev => prev.map(s => s.sourceId === entry.sourceId ? { ...s, destName: e.target.value } : s))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mapping-section-heading">Custom Fields</h3>
          <div className="mapping-table-wrapper">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>Omit</th>
                  <th>Source Field</th>
                  <th>Source Type</th>
                  <th>Destination</th>
                </tr>
              </thead>
              <tbody>
                <SeparatorRow label="Native Asana Fields" colSpan={4} />
                <TitleRow colSpan={4} />
                {nativeEntries.map(renderRow)}

                {newEntries.length > 0 && (
                  <SeparatorRow label="Custom Fields to Create" colSpan={4} />
                )}
                {newEntries.map(renderRow)}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || !!error}>
          Save &amp; Continue
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Existing-project mode — map to dest fields, enum value mapping, reload
// ---------------------------------------------------------------------------

function ExistingProjectMapping({ state, onSave, onBack }: Props) {
  const [destFields, setDestFields] = useState<AsanaField[]>([]);
  const [destSections, setDestSections] = useState<Array<{ gid: string; name: string }>>([]);
  const [mapping, setMapping] = useState<FieldMappingEntry[]>(state.fieldMapping);
  const [sectionMapping, setSectionMapping] = useState<SectionMappingEntry[]>([]);
  const [expandedEnums, setExpandedEnums] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const hasFired = useRef(false);

  function load(isReload = false) {
    setLoading(true);
    setError('');
    Promise.all([
      fetch(`/api/source/project-fields?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedField[]>),
      fetch(`/api/destination/project-fields?projectGid=${encodeURIComponent(state.selectedDestProjectGid ?? '')}`).then((r) => r.json() as Promise<AsanaField[]>),
      fetch(`/api/source/project-sections?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedSection[]>),
      fetch(`/api/destination/sections?projectGid=${encodeURIComponent(state.selectedDestProjectGid ?? '')}`).then((r) => r.json() as Promise<Array<{ gid: string; name: string }>>),
    ])
      .then(([src, dest, srcSections, dstSections]) => {
        const sortedDest = [...dest].sort((a, b) => a.name.localeCompare(b.name));
        setDestFields(sortedDest);
        setDestSections(dstSections);
        // Only auto-map on initial load — never overwrite changes the user has made
        if (!isReload && !state.fieldMapping.length) {
          setMapping(autoMap(src, sortedDest));
        }
        setSectionMapping(srcSections.map((s) => {
          const match = dstSections.find((d) => d.name.toLowerCase() === s.name.toLowerCase()) ?? null;
          return {
            sourceId: s.id,
            sourceName: s.name,
            destId: match?.gid ?? null,
            destName: match?.name ?? s.name,
            omit: false,
          };
        }));
        setLoading(false);
      })
      .catch(() => { setError('Failed to load custom fields'); setLoading(false); });
  }

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    load(false);
  }, []);

  function autoMap(src: NormalisedField[], dest: AsanaField[]): FieldMappingEntry[] {
    return src.map((field) => {
      const exactName = dest.find((d) => d.name.toLowerCase() === field.name.toLowerCase());
      const typeMatch = !exactName ? dest.find((d) => {
        if (field.type === 'dropdown') return d.type === 'enum' || d.type === 'multi_enum';
        return d.type === defaultAsanaType(field.type);
      }) : null;
      const match = exactName ?? typeMatch ?? null;
      const confidence: FieldMappingEntry['confidence'] = exactName ? 'exact' : typeMatch ? 'type' : 'none';

      const enumMapping = buildEnumMapping(field, match);
      return {
        sourceFieldId: field.id,
        sourceFieldName: field.name,
        sourceFieldType: field.type,
        sourceOptions: field.options,
        destFieldId: match?.gid ?? null,
        destFieldName: match?.name ?? null,
        destFieldType: match ? (match.type as AsanaFieldType) : null,
        isOrgWide: false,
        confidence,
        omit: false,
        enumMapping,
      };
    });
  }

  function buildEnumMapping(src: NormalisedField, dest: AsanaField | null): EnumMappingEntry[] | undefined {
    if (!src.options?.length) return undefined;
    const destOptions = dest?.enum_options ?? [];
    return src.options.map((opt) => {
      const nameMatch = destOptions.find((d) => d.name.toLowerCase() === opt.name.toLowerCase());
      return { sourceOption: opt.name, destOptionGid: nameMatch?.gid ?? null };
    });
  }

  function updateMapping(sourceFieldId: string, destGid: string) {
    // Native Asana field sentinels
    const nativeMap: Record<string, 'due_on' | 'notes' | 'assignee' | 'followers'> = {
      [NATIVE_DUE_ON]: 'due_on', [NATIVE_NOTES]: 'notes',
      [NATIVE_ASSIGNEE]: 'assignee', [NATIVE_FOLLOWERS]: 'followers',
    };
    if (destGid in nativeMap) {
      setMapping((prev) => prev.map((m) => {
        if (m.sourceFieldId !== sourceFieldId) return m;
        return { ...m, destFieldId: null, destFieldName: null, destFieldType: null, destNativeField: nativeMap[destGid], confidence: 'name', enumMapping: undefined };
      }));
      return;
    }

    // "Create new field of type X" sentinels
    if (destGid.startsWith(NEW_FIELD_PREFIX)) {
      const newType = destGid.slice(NEW_FIELD_PREFIX.length) as AsanaFieldType;
      setMapping((prev) => prev.map((m) => {
        if (m.sourceFieldId !== sourceFieldId) return m;
        return { ...m, destFieldId: null, destFieldName: null, destFieldType: newType, destNativeField: undefined, confidence: 'none', enumMapping: undefined };
      }));
      return;
    }

    // Map to an existing Asana custom field
    const dest = destFields.find((d) => d.gid === destGid) ?? null;
    setMapping((prev) => prev.map((m) => {
      if (m.sourceFieldId !== sourceFieldId) return m;
      const srcField = { options: m.sourceOptions } as NormalisedField;
      const enumMapping = buildEnumMapping(srcField, dest);
      return {
        ...m,
        destFieldId: dest?.gid ?? null,
        destFieldName: dest?.name ?? null,
        destFieldType: dest ? (dest.type as AsanaFieldType) : null,
        isOrgWide: false,
        destNativeField: undefined,
        confidence: dest ? 'name' : 'none',
        enumMapping,
      };
    }));
  }

  function updateEnumMapping(sourceFieldId: string, sourceOption: string, destOptionGid: string) {
    setMapping((prev) => prev.map((m) => {
      if (m.sourceFieldId !== sourceFieldId) return m;
      const enumMapping = (m.enumMapping ?? []).map((e) =>
        e.sourceOption === sourceOption ? { ...e, destOptionGid: destOptionGid || null } : e,
      );
      return { ...m, enumMapping };
    }));
  }

  function toggleOmit(sourceFieldId: string) {
    setMapping((prev) => prev.map((m) =>
      m.sourceFieldId === sourceFieldId ? { ...m, omit: !m.omit } : m,
    ));
  }

  function toggleEnumExpand(sourceFieldId: string) {
    setExpandedEnums((prev) => {
      const next = new Set(prev);
      next.has(sourceFieldId) ? next.delete(sourceFieldId) : next.add(sourceFieldId);
      return next;
    });
  }

  const unmappedCount = mapping.filter((m) => !m.omit && !m.destFieldId && !m.destNativeField).length;
  const omittedCount = mapping.filter((m) => m.omit).length;

  async function handleSave() {
    await fetch('/api/session/field-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping, sectionMapping }),
    });
    onSave(mapping, sectionMapping);
  }

  function confidenceBadge(c: FieldMappingEntry['confidence']) {
    const labels: Record<FieldMappingEntry['confidence'], { text: string; cls: string }> = {
      exact: { text: 'Exact', cls: 'badge-success' },
      name:  { text: 'Name', cls: 'badge-info' },
      type:  { text: 'Type', cls: 'badge-warning' },
      none:  { text: 'No match', cls: 'badge-error' },
    };
    const l = labels[c];
    return <span className={`badge ${l.cls}`}>{l.text}</span>;
  }

  // Group entries for sectioned display
  const nativeEntries = mapping
    .filter((e) => e.destNativeField)
    .sort((a, b) => NATIVE_ORDER.indexOf(a.destNativeField!) - NATIVE_ORDER.indexOf(b.destNativeField!));
  const mappedEntries = mapping.filter((e) => !e.destNativeField && e.destFieldId);
  const newEntries    = mapping.filter((e) => !e.destNativeField && !e.destFieldId);

  function renderRow(entry: FieldMappingEntry) {
    const showEnumToggle = !entry.omit && entry.sourceOptions?.length && entry.destFieldId &&
      (entry.destFieldType === 'enum' || entry.destFieldType === 'multi_enum');
    const destEnumOptions = destFields.find((d) => d.gid === entry.destFieldId)?.enum_options ?? [];
    const isExpanded = expandedEnums.has(entry.sourceFieldId);

    return (
      <React.Fragment key={entry.sourceFieldId}>
        <tr className={entry.omit ? 'row-omitted' : entry.confidence === 'none' && !entry.destNativeField ? 'row-warning' : ''}>
          <td className="omit-cell">
            <input type="checkbox" checked={entry.omit} onChange={() => toggleOmit(entry.sourceFieldId)} title="Omit — skip this field" />
          </td>
          <td>
            {entry.sourceFieldName}
            {showEnumToggle && (
              <button className="enum-toggle" onClick={() => toggleEnumExpand(entry.sourceFieldId)}>
                {isExpanded ? '▲' : '▼'} options
              </button>
            )}
          </td>
          <td><span className="type-pill">{entry.sourceFieldType}</span></td>
          <td>
            <select
              value={
                entry.destNativeField
                  ? `__native:${entry.destNativeField}`
                  : entry.destFieldId
                    ? entry.destFieldId
                    : entry.destFieldType
                      ? `${NEW_FIELD_PREFIX}${entry.destFieldType}`
                      : ''
              }
              onChange={(e) => updateMapping(entry.sourceFieldId, e.target.value)}
              disabled={entry.omit}
            >
              <option value="">— Not mapped —</option>
              <optgroup label="Native Asana Fields">
                <option value={NATIVE_ASSIGNEE}>→ Assignee</option>
                <option value={NATIVE_DUE_ON}>→ Due Date</option>
                <option value={NATIVE_NOTES}>→ Notes / Description</option>
                <option value={NATIVE_FOLLOWERS}>→ Followers / Members</option>
              </optgroup>
              <optgroup label="Create New Field">
                {NEW_FIELD_TYPES.map((t) => (
                  <option key={t.type} value={`${NEW_FIELD_PREFIX}${t.type}`}>{t.label}</option>
                ))}
              </optgroup>
              {destFields.length > 0 && (
                <optgroup label="Map to Existing Field">
                  {destFields.map((d) => (
                    <option key={d.gid} value={d.gid}>{d.name} ({d.type})</option>
                  ))}
                </optgroup>
              )}
            </select>
          </td>
          <td>{entry.omit ? <span className="badge badge-omit">Omitted</span> : confidenceBadge(entry.confidence)}</td>
        </tr>

        {showEnumToggle && isExpanded && (
          <tr key={`${entry.sourceFieldId}-enum`} className="enum-mapping-row">
            <td colSpan={5}>
              <div className="enum-mapping-panel">
                <p className="enum-mapping-title">Option mapping — {entry.sourceFieldName} → {entry.destFieldName}</p>
                <table className="enum-mapping-table">
                  <thead>
                    <tr><th>Source option</th><th>Asana enum option</th></tr>
                  </thead>
                  <tbody>
                    {(entry.enumMapping ?? []).map((em) => (
                      <tr key={em.sourceOption}>
                        <td><span className="type-pill">{em.sourceOption}</span></td>
                        <td>
                          <select
                            value={em.destOptionGid ?? ''}
                            onChange={(e) => updateEnumMapping(entry.sourceFieldId, em.sourceOption, e.target.value)}
                          >
                            <option value="">— No match / skip —</option>
                            {destEnumOptions.map((o) => (
                              <option key={o.gid} value={o.gid}>{o.name}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Project Mapping</h2>
      <p className="step-desc">
        Map source fields to the custom fields on <strong>{state.selectedDestProjectName}</strong>.
        Fields with no match will be created at project level.
        {unmappedCount > 0 && <> <strong className="warning-text">{unmappedCount} field{unmappedCount !== 1 ? 's' : ''} unmatched — will be created new.</strong></>}
        {omittedCount > 0 && <> <span className="muted-text">{omittedCount} omitted.</span></>}
      </p>

      {loading && <p className="loading-text">Loading custom fields…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <>
          <h3 className="mapping-section-heading">Sections</h3>
          <div className="mapping-table-wrapper">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>Omit</th>
                  <th>Source Section</th>
                  <th>Asana Section</th>
                </tr>
              </thead>
              <tbody>
                {sectionMapping.map((entry) => (
                  <tr key={entry.sourceId} className={entry.omit ? 'row-omitted' : ''}>
                    <td className="omit-cell">
                      <input type="checkbox" checked={entry.omit}
                        onChange={() => setSectionMapping(prev => prev.map(s => s.sourceId === entry.sourceId ? { ...s, omit: !s.omit } : s))} />
                    </td>
                    <td>{entry.sourceName}</td>
                    <td>
                      <select
                        value={entry.destId ?? ''}
                        disabled={entry.omit}
                        onChange={(e) => {
                          const dest = destSections.find(d => d.gid === e.target.value) ?? null;
                          setSectionMapping(prev => prev.map(s => s.sourceId === entry.sourceId
                            ? { ...s, destId: dest?.gid ?? null, destName: dest?.name ?? s.sourceName }
                            : s));
                        }}
                      >
                        <option value="">— Create new section —</option>
                        {destSections.map(d => (
                          <option key={d.gid} value={d.gid}>{d.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mapping-section-heading">Custom Fields</h3>
          <div className="reload-row">
            <button className="btn btn-ghost btn-sm" onClick={() => load(true)} disabled={loading}>
              ↺ Reload fields from Asana
            </button>
            <span className="field-hint-inline">Refresh after making changes to the destination project in Asana</span>
          </div>

          <div className="mapping-table-wrapper">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>Omit</th>
                  <th>Source Field</th>
                  <th>Type</th>
                  <th>Asana Field</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                <SeparatorRow label="Native Asana Fields" colSpan={5} />
                <TitleRow colSpan={5} />
                {nativeEntries.map(renderRow)}

                {mappedEntries.length > 0 && (
                  <SeparatorRow label="Mapped to Existing Fields" colSpan={5} />
                )}
                {mappedEntries.map(renderRow)}

                {newEntries.length > 0 && (
                  <SeparatorRow label="New Fields to Create" colSpan={5} />
                )}
                {newEntries.map(renderRow)}
              </tbody>
            </table>
          </div>

        </>
      )}

      {error && (
        <div className="reload-row">
          <button className="btn btn-ghost btn-sm" onClick={() => load(false)}>↺ Retry</button>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || !!error}>
          Save &amp; Continue
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export — delegates to the correct mode
// ---------------------------------------------------------------------------

export default function FieldMapping(props: Props) {
  return props.state.isNewDestProject
    ? <NewProjectMapping {...props} />
    : <ExistingProjectMapping {...props} />;
}
