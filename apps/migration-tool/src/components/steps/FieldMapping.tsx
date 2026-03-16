import React, { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type {
  AsanaFieldType,
  EnumMappingEntry,
  FieldMappingEntry,
  NormalisedField,
  NormalisedFieldType,
} from '../../types/index.ts';

interface AsanaField {
  gid: string;
  name: string;
  type: string;
  enum_options?: Array<{ gid: string; name: string }>;
}

interface Props {
  state: AppState;
  onSave: (mapping: FieldMappingEntry[]) => void;
  onBack: () => void;
}

// Sentinel values for native Asana task field destinations
const NATIVE_DUE_ON   = '__native:due_on';
const NATIVE_NOTES    = '__native:notes';
const NATIVE_ASSIGNEE = '__native:assignee';
const NATIVE_FOLLOWERS = '__native:followers';

// Asana types available when creating a new project-level field, plus native field shortcuts
const ASANA_CREATABLE_TYPES: Array<{ value: AsanaFieldType | string; label: string }> = [
  { value: 'text',            label: 'Text (custom field)' },
  { value: 'number',          label: 'Number (custom field)' },
  { value: 'date',            label: 'Date (custom field)' },
  { value: 'enum',            label: 'Dropdown (single) (custom field)' },
  { value: 'multi_enum',      label: 'Dropdown (multi) (custom field)' },
  { value: 'people',          label: 'People (custom field)' },
  { value: NATIVE_DUE_ON,     label: '→ Due Date (native Asana field)' },
  { value: NATIVE_NOTES,      label: '→ Notes / Description (native Asana field)' },
  { value: NATIVE_ASSIGNEE,   label: '→ Assignee (native Asana field)' },
  { value: NATIVE_FOLLOWERS,  label: '→ Followers / Members (native Asana field)' },
];

function defaultAsanaType(src: NormalisedFieldType): AsanaFieldType {
  const map: Record<NormalisedFieldType, AsanaFieldType> = {
    text: 'text', number: 'number', date: 'date',
    dropdown: 'enum', checkbox: 'text', people: 'people',
    link: 'text', unknown: 'text',
  };
  return map[src];
}

// ---------------------------------------------------------------------------
// New-project mode — type selector, no dest field picker
// ---------------------------------------------------------------------------

function NewProjectMapping({ state, onSave, onBack }: Props) {
  const [mapping, setMapping] = useState<FieldMappingEntry[]>(state.fieldMapping);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const hasFired = useRef(false);

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;

    fetch(`/api/source/project-fields?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`)
      .then((r) => r.json() as Promise<NormalisedField[]>)
      .then((src) => {
        if (!state.fieldMapping.length) {
          setMapping(src.map((f) => ({
            sourceFieldId: f.id,
            sourceFieldName: f.name,
            sourceFieldType: f.type,
            sourceOptions: f.options,
            destFieldId: null,
            destFieldName: null,
            destFieldType: defaultAsanaType(f.type),
            isOrgWide: false,
            confidence: 'none',
            omit: false,
          })));
        }
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
      body: JSON.stringify({ mapping }),
    });
    onSave(mapping);
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Custom Field Mapping</h2>
      <p className="step-desc">
        These fields will be created as <strong>project-level custom fields</strong> in the new Asana project.
        Choose the Asana type for each field.
        {omittedCount > 0 && <> <span className="muted-text">{omittedCount} field{omittedCount !== 1 ? 's' : ''} omitted.</span></>}
        {activeCount === 0 && omittedCount > 0 && <> All fields omitted — no custom fields will be created.</>}
      </p>

      {loading && <p className="loading-text">Loading source fields…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <div className="mapping-table-wrapper">
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Omit</th>
                <th>Source Field</th>
                <th>Source Type</th>
                <th>Asana Type to Create</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((entry) => (
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
              ))}
            </tbody>
          </table>
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
// Existing-project mode — map to dest fields, enum value mapping, reload
// ---------------------------------------------------------------------------

function ExistingProjectMapping({ state, onSave, onBack }: Props) {
  const [destFields, setDestFields] = useState<AsanaField[]>([]);
  const [mapping, setMapping] = useState<FieldMappingEntry[]>(state.fieldMapping);
  const [expandedEnums, setExpandedEnums] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const hasFired = useRef(false);

  function load() {
    setLoading(true);
    setError('');
    Promise.all([
      fetch(`/api/source/project-fields?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedField[]>),
      fetch(`/api/destination/project-fields?projectGid=${encodeURIComponent(state.selectedDestProjectGid ?? '')}`).then((r) => r.json() as Promise<AsanaField[]>),
    ])
      .then(([src, dest]) => {
        const sortedDest = [...dest].sort((a, b) => a.name.localeCompare(b.name));
        setDestFields(sortedDest);
        if (!state.fieldMapping.length) {
          setMapping(autoMap(src, sortedDest));
        }
        setLoading(false);
      })
      .catch(() => { setError('Failed to load custom fields'); setLoading(false); });
  }

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    load();
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
    // Handle native Asana field sentinels
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

  const unmappedCount = mapping.filter((m) => !m.omit && !m.destFieldId).length;
  const omittedCount = mapping.filter((m) => m.omit).length;

  async function handleSave() {
    await fetch('/api/session/field-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping }),
    });
    onSave(mapping);
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

  return (
    <div className="step-panel">
      <h2 className="step-title">Custom Field Mapping</h2>
      <p className="step-desc">
        Map source fields to the custom fields on <strong>{state.selectedDestProjectName}</strong>.
        Fields with no match will be created at project level.
        {unmappedCount > 0 && <> <strong className="warning-text">{unmappedCount} field{unmappedCount !== 1 ? 's' : ''} unmatched.</strong></>}
        {omittedCount > 0 && <> <span className="muted-text">{omittedCount} omitted.</span></>}
      </p>

      {loading && <p className="loading-text">Loading custom fields…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <>
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
                {mapping.map((entry) => {
                  const showEnumToggle = !entry.omit && entry.sourceOptions?.length && entry.destFieldId &&
                    (entry.destFieldType === 'enum' || entry.destFieldType === 'multi_enum');
                  const destEnumOptions = destFields.find((d) => d.gid === entry.destFieldId)?.enum_options ?? [];
                  const isExpanded = expandedEnums.has(entry.sourceFieldId);

                  return (
                    <React.Fragment key={entry.sourceFieldId}>
                      <tr
                        className={entry.omit ? 'row-omitted' : entry.confidence === 'none' ? 'row-warning' : ''}
                      >
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
                            value={entry.destNativeField ? `__native:${entry.destNativeField}` : (entry.destFieldId ?? '')}
                            onChange={(e) => updateMapping(entry.sourceFieldId, e.target.value)}
                            disabled={entry.omit}
                          >
                            <option value="">— Create new at project level —</option>
                            <option value={NATIVE_DUE_ON}>→ Due Date (native Asana field)</option>
                            <option value={NATIVE_NOTES}>→ Notes / Description (native Asana field)</option>
                            <option value={NATIVE_ASSIGNEE}>→ Assignee (native Asana field)</option>
                            <option value={NATIVE_FOLLOWERS}>→ Followers / Members (native Asana field)</option>
                            {destFields.map((d) => (
                              <option key={d.gid} value={d.gid}>{d.name} ({d.type})</option>
                            ))}
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
                })}
              </tbody>
            </table>
          </div>

          <div className="reload-row">
            <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
              ↺ Reload fields from Asana
            </button>
            <span className="field-hint-inline">Use this after adding or changing fields in Asana</span>
          </div>
        </>
      )}

      {error && (
        <div className="reload-row">
          <button className="btn btn-ghost btn-sm" onClick={load}>↺ Retry</button>
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
