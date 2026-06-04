import React, { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type {
  AsanaFieldType,
  EnumMappingEntry,
  FieldMappingEntry,
  NormalisedField,
  NormalisedFieldOption,
  NormalisedFieldType,
  NormalisedSection,
  SectionMappingEntry,
} from '@cirface/core/types';

interface AsanaField {
  gid: string;
  name: string;
  type: string;
  isGlobal: boolean;
  enum_options?: Array<{ gid: string; name: string }>;
}

interface Props {
  state: AppState;
  onSave: (fieldMapping: FieldMappingEntry[], sectionMapping: SectionMappingEntry[], externalIdDestFieldGid: string | null) => void;
  onDraftChange: (fieldMapping: FieldMappingEntry[], sectionMapping: SectionMappingEntry[], externalIdDestFieldGid: string | null) => void;
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

// ---------------------------------------------------------------------------
// Import / export helpers
// ---------------------------------------------------------------------------

interface MappingExport {
  version: 2;
  sourcePlatform: string;
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  fieldMapping: FieldMappingEntry[];
  sectionMapping: SectionMappingEntry[];
  externalIdDestFieldGid: string | null;
}

function downloadMappingExport(
  state: Props['state'],
  fieldMapping: FieldMappingEntry[],
  sectionMapping: SectionMappingEntry[],
  externalIdDestFieldGid: string | null,
) {
  const data: MappingExport = {
    version: 2,
    sourcePlatform: state.sourcePlatform ?? '',
    sourceProjectId: state.selectedSourceProjectId ?? null,
    sourceProjectName: state.selectedSourceProjectName ?? null,
    fieldMapping,
    sectionMapping,
    externalIdDestFieldGid,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `field-mapping-${(state.selectedSourceProjectName ?? 'export').replace(/[^a-z0-9]/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Merge an imported mapping into the current one, matching by sourceFieldId.
 * Keeps live sourceOptions from the current entry so enum rows render correctly.
 */
function applyImportedFieldMapping(
  current: FieldMappingEntry[],
  imported: FieldMappingEntry[],
): { merged: FieldMappingEntry[]; matched: number } {
  const byId = new Map(imported.map((e) => [e.sourceFieldId, e]));
  let matched = 0;
  const merged = current.map((entry) => {
    const imp = byId.get(entry.sourceFieldId);
    if (!imp) return entry;
    matched++;
    return {
      ...entry,                           // keep live sourceOptions / sourceFieldName
      destFieldId:               imp.destFieldId,
      destFieldName:             imp.destFieldName,
      destFieldType:             imp.destFieldType,
      destNativeField:           imp.destNativeField,
      isOrgWide:                 imp.isOrgWide,
      confidence:                imp.confidence,
      omit:                      imp.omit,
      enumMapping:               imp.enumMapping,
      deduplicateOptions:        imp.deduplicateOptions,
      linkedToParentSourceFieldId: imp.linkedToParentSourceFieldId,
    };
  });
  return { merged, matched };
}

function applyImportedSectionMapping(
  current: SectionMappingEntry[],
  imported: SectionMappingEntry[],
): SectionMappingEntry[] {
  const byId = new Map(imported.map((s) => [s.sourceId, s]));
  return current.map((entry) => {
    const imp = byId.get(entry.sourceId);
    if (!imp) return entry;
    return { ...entry, destId: imp.destId, destName: imp.destName, omit: imp.omit };
  });
}

function parseMappingFile(
  text: string,
): { ok: true; data: MappingExport } | { ok: false; error: string } {
  try {
    const data = JSON.parse(text) as Partial<MappingExport>;
    if (data.version !== 2 || !Array.isArray(data.fieldMapping)) {
      return { ok: false, error: 'Unrecognised file format (expected version 2 mapping export).' };
    }
    return { ok: true, data: data as MappingExport };
  } catch {
    return { ok: false, error: 'Could not parse file — make sure it is a valid JSON mapping export.' };
  }
}

interface CheckIssue {
  severity: 'warning' | 'info';
  message: string;
  /** If set, an "Enable auto-deduplicate" button is shown for this issue. */
  dedupeFieldId?: string;
}

interface CheckResult {
  issues: CheckIssue[];
  ok: boolean; // no warnings
}

function runMappingCheck(
  mapping: FieldMappingEntry[],
  sectionMapping: SectionMappingEntry[],
  isExistingProject: boolean,
): CheckResult {
  const issues: CheckIssue[] = [];

  const active = mapping.filter((m) => !m.omit);

  // Fields with no type and no native mapping
  const untyped = active.filter((m) => !m.destFieldType && !m.destNativeField && !m.destFieldId);
  for (const m of untyped) {
    issues.push({ severity: 'warning', message: `"${m.sourceFieldName}" has no destination type — it will be created as text.` });
  }

  // Existing project: unmapped fields (no dest field, no type chosen) will be created new
  if (isExistingProject) {
    const willCreate = active.filter((m) => !m.destFieldId && !m.destNativeField);
    if (willCreate.length > 0) {
      issues.push({ severity: 'info', message: `${willCreate.length} field${willCreate.length !== 1 ? 's' : ''} have no existing Asana field selected and will be created new (m_ prefix).` });
    }
    // Enum fields mapped to existing dest but with unmatched options
    for (const m of active) {
      if (!m.enumMapping?.length) continue;
      const unmatched = m.enumMapping.filter((e) => !e.destOptionGid);
      if (unmatched.length > 0) {
        issues.push({ severity: 'warning', message: `"${m.sourceFieldName}": ${unmatched.length} option${unmatched.length !== 1 ? 's' : ''} have no Asana match (${unmatched.map((e) => `"${e.sourceOption}"`).join(', ')}) and will be skipped.` });
      }
    }
  }

  // Enum fields with duplicate or blank option names (Asana will reject them)
  for (const m of active) {
    if (!m.sourceOptions?.length) continue;
    const seen = new Set<string>();
    const dupes: string[] = [];
    const blanks: number[] = [];
    m.sourceOptions.forEach((opt, idx) => {
      const name = String(opt.name ?? '').trim();
      if (!name) { blanks.push(idx + 1); return; }
      if (seen.has(name.toLowerCase())) dupes.push(`"${name}"`);
      else seen.add(name.toLowerCase());
    });
    if (blanks.length) {
      issues.push({ severity: 'warning', message: `"${m.sourceFieldName}": ${blanks.length} blank option name${blanks.length !== 1 ? 's' : ''} — blank options will be skipped automatically.` });
    }
    if (dupes.length) {
      if (m.deduplicateOptions) {
        issues.push({ severity: 'info', message: `"${m.sourceFieldName}": duplicate option${dupes.length !== 1 ? 's' : ''} (${dupes.join(', ')}) will be auto-deduplicated.` });
      } else {
        issues.push({
          severity: 'warning',
          message: `"${m.sourceFieldName}": duplicate option name${dupes.length !== 1 ? 's' : ''} ${dupes.join(', ')} — fix in the source system, or enable auto-deduplication below.`,
          dedupeFieldId: m.sourceFieldId,
        });
      }
    }
  }

  // Sections with blank destination names
  const blankSections = sectionMapping.filter((s) => !s.omit && !s.destName?.trim());
  for (const s of blankSections) {
    issues.push({ severity: 'warning', message: `Section "${s.sourceName}" has no destination name.` });
  }

  return { issues, ok: !issues.some((i) => i.severity === 'warning') };
}

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

function NewProjectMapping({ state, onSave, onDraftChange, onBack }: Props) {
  const [mapping, setMapping] = useState<FieldMappingEntry[]>(state.fieldMapping);
  const [sectionMapping, setSectionMapping] = useState<SectionMappingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const hasFired = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist draft to AppState so changes survive navigation
  useEffect(() => {
    if (loading) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraftChange(mapping, sectionMapping, null), 400);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [mapping, sectionMapping]);

  function load(forceRemap = false) {
    setLoading(true);
    setError('');
    Promise.all([
      fetch(`/api/source/project-fields?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedField[]>),
      fetch(`/api/source/project-sections?projectId=${encodeURIComponent(state.selectedSourceProjectId ?? '')}`).then((r) => r.json() as Promise<NormalisedSection[]>),
    ])
      .then(([src, sections]) => {
        if (forceRemap || !state.fieldMapping.length) {
          // Build a name → field map for parent fields so subitem fields with the same
          // name can be linked. Only link if the field types match AND, for dropdown fields,
          // the option sets are identical — same name with different enum values = different field.
          const parentFieldByName = new Map<string, NormalisedField>();
          for (const f of src) {
            if (!f.isSubitemField) parentFieldByName.set(f.name.toLowerCase(), f);
          }
          const optionSetKey = (opts?: NormalisedFieldOption[]) =>
            (opts ?? []).map((o) => o.name).sort().join('|');
          const fieldEntries: FieldMappingEntry[] = src.map((f) => {
            const nativeField = state.sourcePlatform === 'monday'
              ? mondayNativeField(f.name, f.type)
              : undefined;
            let linkedToParentSourceFieldId: string | undefined;
            if (f.isSubitemField) {
              const parent = parentFieldByName.get(f.name.toLowerCase());
              if (parent && parent.type === f.type) {
                // For dropdown fields, only link if the option sets are identical
                const typesMatch = f.type !== 'dropdown' || optionSetKey(f.options) === optionSetKey(parent.options);
                if (typesMatch) linkedToParentSourceFieldId = parent.id;
              }
            }
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
              confidence: linkedToParentSourceFieldId ? 'exact' : nativeField ? 'exact' : 'none',
              omit: f.nonMigratable ? true : false,
              isSubitemField: f.isSubitemField,
              nonMigratable: f.nonMigratable,
              linkedToParentSourceFieldId,
            };
          });
          // Inject synthetic Assignee row if no real field already maps to assignee
          if (!fieldEntries.some((e) => e.destNativeField === 'assignee')) {
            fieldEntries.unshift({
              sourceFieldId: '__assignee__',
              sourceFieldName: 'Assignee',
              sourceFieldType: 'people',
              destFieldId: null,
              destFieldName: null,
              destFieldType: null,
              destNativeField: 'assignee',
              isOrgWide: false,
              confidence: 'exact',
              omit: false,
            });
          }
          // Inject synthetic Due Date row for connectors with a native due date field.
          // Trello, Wrike, and Asana (source) set task.dueDate from a platform-level property
          // that has no column in project.fields — without this entry the user cannot see or
          // omit the due date migration.
          const hasDueDateNative = ['trello', 'wrike', 'asana'].includes(state.sourcePlatform ?? '');
          if (hasDueDateNative && !fieldEntries.some((e) => e.destNativeField === 'due_on')) {
            fieldEntries.unshift({
              sourceFieldId: '__due_date__',
              sourceFieldName: 'Due Date',
              sourceFieldType: 'date',
              destFieldId: null,
              destFieldName: null,
              destFieldType: null,
              destNativeField: 'due_on',
              isOrgWide: false,
              confidence: 'exact',
              omit: false,
            });
          }
          setMapping(fieldEntries);
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
  }

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    load();
  }, []);

  function handleReload() {
    fetch('/api/session/reset-project', { method: 'POST' }).catch(() => {});
    load(true);
  }

  function handleExport() {
    downloadMappingExport(state, mapping, sectionMapping, null);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = parseMappingFile(ev.target?.result as string);
      if (!result.ok) { setImportMsg(`Error: ${result.error}`); return; }
      const { merged, matched } = applyImportedFieldMapping(mapping, result.data.fieldMapping);
      setMapping(merged);
      setSectionMapping((prev) => applyImportedSectionMapping(prev, result.data.sectionMapping ?? []));
      setImportMsg(`Loaded: ${matched} of ${mapping.length} fields matched.`);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

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

  function toggleDedup(sourceFieldId: string) {
    setMapping((prev) => prev.map((m) =>
      m.sourceFieldId === sourceFieldId ? { ...m, deduplicateOptions: !m.deduplicateOptions } : m,
    ));
    // Re-run the check so the panel updates immediately
    setCheckResult((prev) => {
      if (!prev) return prev;
      const updated = mapping.map((m) =>
        m.sourceFieldId === sourceFieldId ? { ...m, deduplicateOptions: !m.deduplicateOptions } : m,
      );
      return runMappingCheck(updated, sectionMapping, false);
    });
  }

  const omittedCount = mapping.filter((m) => m.omit).length;
  const activeCount = mapping.length - omittedCount;

  function handleCheck() {
    setCheckResult(runMappingCheck(mapping, sectionMapping, false));
  }

  async function handleSave() {
    await fetch('/api/session/field-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping, sectionMapping, externalIdDestFieldGid: null }),
    });
    onSave(mapping, sectionMapping, null);
  }

  // Group entries for sectioned display
  const nativeEntries = mapping
    .filter((e) => e.destNativeField && !e.nonMigratable)
    .sort((a, b) => NATIVE_ORDER.indexOf(a.destNativeField!) - NATIVE_ORDER.indexOf(b.destNativeField!));
  const activeEntries  = mapping.filter((e) => !e.destNativeField && !e.omit && !e.nonMigratable);
  const omittedEntries = mapping.filter((e) => !e.nonMigratable && e.omit);
  const nonMigratableEntries = mapping.filter((e) => e.nonMigratable);

  function renderRow(entry: FieldMappingEntry) {
    const isSynthetic = entry.sourceFieldId === '__assignee__';
    return (
      <tr key={entry.sourceFieldId} className={entry.nonMigratable || entry.omit ? 'row-omitted' : ''}>
        <td className="omit-cell">
          <input type="checkbox" checked={entry.omit} disabled={entry.nonMigratable}
            onChange={() => toggleOmit(entry.sourceFieldId)}
            title={entry.nonMigratable ? 'This field type cannot be migrated' : 'Omit — skip assignee migration'} />
        </td>
        <td>
          {entry.sourceFieldName}
          {entry.isSubitemField && <span className="subitem-badge">Subitem</span>}
        </td>
        <td><span className="type-pill">{entry.sourceFieldType}</span></td>
        <td>
          {entry.nonMigratable ? (
            <span className="linked-to-parent-label">Cannot be migrated to Asana</span>
          ) : entry.linkedToParentSourceFieldId ? (
            <span className="linked-to-parent-label">→ Same as parent field</span>
          ) : isSynthetic ? (
            <span style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>Assignee — native Asana field</span>
          ) : (
            <select
              value={entry.destNativeField ? `__native:${entry.destNativeField}` : (entry.destFieldType ?? 'text')}
              onChange={(e) => setType(entry.sourceFieldId, e.target.value)}
              disabled={entry.omit}
            >
              {ASANA_CREATABLE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Project Mapping</h2>
      <div className="project-name-banner">
        <span className="project-name-label">From:</span>
        <strong>{state.selectedSourceProjectName}</strong>
        <span className="project-name-arrow">→</span>
        <span className="project-name-label">To:</span>
        <strong>{state.selectedDestProjectName ?? 'New Asana project'}</strong>
      </div>
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

                {activeEntries.length > 0 && (
                  <SeparatorRow label="Custom Fields to Create" colSpan={4} />
                )}
                {activeEntries.map(renderRow)}

                {omittedEntries.length > 0 && (
                  <SeparatorRow label="Omitted Fields" colSpan={4} />
                )}
                {omittedEntries.map(renderRow)}

                {nonMigratableEntries.length > 0 && (
                  <SeparatorRow label="Non-Migratable Field Types" colSpan={4} />
                )}
                {nonMigratableEntries.map(renderRow)}
              </tbody>
            </table>
          </div>
        </>
      )}

      {checkResult && (
        <div className={`check-result-panel ${checkResult.ok ? 'check-ok' : 'check-warnings'}`}>
          <strong>{checkResult.ok ? '✓ Mapping looks good' : `⚠ ${checkResult.issues.filter(i => i.severity === 'warning').length} warning(s) found`}</strong>
          {checkResult.issues.length > 0 && (
            <ul className="check-issue-list">
              {checkResult.issues.map((issue, i) => (
                <li key={i} className={`check-issue check-issue-${issue.severity}`}>
                  {issue.message}
                  {issue.dedupeFieldId && (
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ marginLeft: 8 }}
                      onClick={() => toggleDedup(issue.dedupeFieldId!)}
                    >
                      Enable auto-deduplicate
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
      {importMsg && <p className="field-hint" style={{ marginTop: 8 }}>{importMsg}</p>}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-ghost" onClick={handleReload} disabled={loading}>
          ↺ Reload source data
        </button>
        <button className="btn btn-ghost" onClick={handleExport} disabled={loading || !!error} title="Download mapping as JSON">
          ↓ Export Mapping
        </button>
        <button className="btn btn-ghost" onClick={() => importRef.current?.click()} title="Load a previously exported mapping JSON">
          ↑ Import Mapping
        </button>
        <button className="btn btn-ghost" onClick={handleCheck} disabled={loading || !!error}>
          ✓ Check Mapping
        </button>
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

function ExistingProjectMapping({ state, onSave, onDraftChange, onBack }: Props) {
  const [destFields, setDestFields] = useState<AsanaField[]>([]);
  const [destSections, setDestSections] = useState<Array<{ gid: string; name: string }>>([]);
  const [mapping, setMapping] = useState<FieldMappingEntry[]>(state.fieldMapping);
  const [sectionMapping, setSectionMapping] = useState<SectionMappingEntry[]>([]);
  const [externalIdDestFieldGid, setExternalIdDestFieldGid] = useState<string | null>(state.externalIdDestFieldGid);
  const [expandedEnums, setExpandedEnums] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const hasFired = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist draft to AppState so changes survive navigation
  useEffect(() => {
    if (loading) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraftChange(mapping, sectionMapping, externalIdDestFieldGid), 400);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [mapping, sectionMapping, externalIdDestFieldGid]);

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
        // Auto-select the External ID destination field if a library field named
        // "External ID" exists and no selection has been made yet.
        if (!isReload && !state.externalIdDestFieldGid) {
          const libraryExtId = sortedDest.find(
            (d) => d.type === 'text' && d.isGlobal && d.name.toLowerCase() === 'external id',
          );
          if (libraryExtId) setExternalIdDestFieldGid(libraryExtId.gid);
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
    const usedDestGids = new Set<string>();
    // Build parent name → entry for linking subitem fields that share a name
    const parentEntryByName = new Map<string, FieldMappingEntry>();

    const entries = src.map((field) => {
      // For subitem fields that share a name with a parent, link to the parent's destination
      const parentEntry = field.isSubitemField
        ? parentEntryByName.get(field.name.toLowerCase())
        : undefined;
      if (parentEntry) {
        return {
          sourceFieldId: field.id,
          sourceFieldName: field.name,
          sourceFieldType: field.type,
          sourceOptions: field.options,
          destFieldId: parentEntry.destFieldId,
          destFieldName: parentEntry.destFieldName,
          destFieldType: parentEntry.destFieldType,
          isOrgWide: false,
          confidence: 'exact' as const,
          omit: false,
          enumMapping: parentEntry.enumMapping,
          isSubitemField: true,
          linkedToParentSourceFieldId: parentEntry.sourceFieldId,
        };
      }

      const exactName = dest.find((d) => !usedDestGids.has(d.gid) && d.name.toLowerCase() === field.name.toLowerCase());
      const typeMatch = !exactName ? dest.find((d) => {
        if (usedDestGids.has(d.gid)) return false;
        if (field.type === 'dropdown') return d.type === 'enum' || d.type === 'multi_enum';
        return d.type === defaultAsanaType(field.type);
      }) : null;
      const match = exactName ?? typeMatch ?? null;
      if (match) usedDestGids.add(match.gid);
      const confidence: FieldMappingEntry['confidence'] = exactName ? 'exact' : typeMatch ? 'type' : 'none';

      const enumMapping = buildEnumMapping(field, match);
      const entry: FieldMappingEntry = {
        sourceFieldId: field.id,
        sourceFieldName: field.name,
        sourceFieldType: field.type,
        sourceOptions: field.options,
        destFieldId: field.nonMigratable ? null : (match?.gid ?? null),
        destFieldName: field.nonMigratable ? null : (match?.name ?? null),
        destFieldType: field.nonMigratable ? null : (match ? (match.type as AsanaFieldType) : null),
        isOrgWide: false,
        confidence: field.nonMigratable ? 'none' : confidence,
        omit: field.nonMigratable ? true : false,
        enumMapping: field.nonMigratable ? undefined : enumMapping,
        isSubitemField: field.isSubitemField,
        nonMigratable: field.nonMigratable,
      };
      if (!field.isSubitemField) parentEntryByName.set(field.name.toLowerCase(), entry);
      return entry;
    });

    // Inject synthetic Assignee row if no real field already maps to assignee
    if (!entries.some((e) => e.destNativeField === 'assignee')) {
      entries.unshift({
        sourceFieldId: '__assignee__',
        sourceFieldName: 'Assignee',
        sourceFieldType: 'people',
        destFieldId: null,
        destFieldName: null,
        destFieldType: null,
        destNativeField: 'assignee',
        isOrgWide: false,
        confidence: 'exact',
        omit: false,
      });
    }

    return entries;
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

    // If this dest field is the current External ID selection, release it
    if (dest && externalIdDestFieldGid === dest.gid) {
      setExternalIdDestFieldGid(null);
    }

    setMapping((prev) => prev.map((m) => {
      // Displace any other row that currently owns this dest field
      if (dest && m.sourceFieldId !== sourceFieldId && m.destFieldId === dest.gid) {
        return { ...m, destFieldId: null, destFieldName: null, destFieldType: null, confidence: 'none' as const, enumMapping: undefined };
      }
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

  function handleExternalIdChange(gid: string | null) {
    // If this dest field is currently owned by a main-mapping row, release it
    if (gid) {
      setMapping((prev) => prev.map((m) =>
        m.destFieldId === gid
          ? { ...m, destFieldId: null, destFieldName: null, destFieldType: null, confidence: 'none' as const, enumMapping: undefined }
          : m,
      ));
    }
    setExternalIdDestFieldGid(gid);
  }

  function toggleOmit(sourceFieldId: string) {
    setMapping((prev) => prev.map((m) =>
      m.sourceFieldId === sourceFieldId ? { ...m, omit: !m.omit } : m,
    ));
  }

  function toggleDedup(sourceFieldId: string) {
    setMapping((prev) => prev.map((m) =>
      m.sourceFieldId === sourceFieldId ? { ...m, deduplicateOptions: !m.deduplicateOptions } : m,
    ));
    // Re-run the check so the panel updates immediately
    setCheckResult((prev) => {
      if (!prev) return prev;
      const updated = mapping.map((m) =>
        m.sourceFieldId === sourceFieldId ? { ...m, deduplicateOptions: !m.deduplicateOptions } : m,
      );
      return runMappingCheck(updated, sectionMapping, true);
    });
  }

  function toggleEnumExpand(sourceFieldId: string) {
    setExpandedEnums((prev) => {
      const next = new Set(prev);
      next.has(sourceFieldId) ? next.delete(sourceFieldId) : next.add(sourceFieldId);
      return next;
    });
  }

  function handleExport() {
    downloadMappingExport(state, mapping, sectionMapping, externalIdDestFieldGid);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = parseMappingFile(ev.target?.result as string);
      if (!result.ok) { setImportMsg(`Error: ${result.error}`); return; }
      const { merged, matched } = applyImportedFieldMapping(mapping, result.data.fieldMapping);
      setMapping(merged);
      setSectionMapping((prev) => applyImportedSectionMapping(prev, result.data.sectionMapping ?? []));
      if (result.data.externalIdDestFieldGid !== undefined) setExternalIdDestFieldGid(result.data.externalIdDestFieldGid);
      setImportMsg(`Loaded: ${matched} of ${mapping.length} fields matched.`);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const unmappedCount = mapping.filter((m) => !m.omit && !m.destFieldId && !m.destNativeField).length;
  const omittedCount = mapping.filter((m) => m.omit).length;

  // All dest field GIDs currently in use (across main mapping + External ID row)
  const usedFieldGids = new Set<string>([
    ...mapping.map((m) => m.destFieldId).filter(Boolean) as string[],
    ...(externalIdDestFieldGid ? [externalIdDestFieldGid] : []),
  ]);

  function handleCheck() {
    setCheckResult(runMappingCheck(mapping, sectionMapping, true));
  }

  async function handleSave() {
    await fetch('/api/session/field-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping, sectionMapping, externalIdDestFieldGid }),
    });
    onSave(mapping, sectionMapping, externalIdDestFieldGid);
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
  const nativeEntries      = mapping
    .filter((e) => e.destNativeField && !e.nonMigratable)
    .sort((a, b) => NATIVE_ORDER.indexOf(a.destNativeField!) - NATIVE_ORDER.indexOf(b.destNativeField!));
  const mappedEntries      = mapping.filter((e) => !e.destNativeField && !e.omit && !e.nonMigratable && e.destFieldId);
  const newEntries         = mapping.filter((e) => !e.destNativeField && !e.omit && !e.nonMigratable && !e.destFieldId);
  const omittedEntries     = mapping.filter((e) => !e.nonMigratable && e.omit);
  const nonMigratableEntries = mapping.filter((e) => e.nonMigratable);

  function renderRow(entry: FieldMappingEntry) {
    const isSynthetic = entry.sourceFieldId === '__assignee__';
    const showEnumToggle = !entry.omit && entry.sourceOptions?.length && entry.destFieldId &&
      (entry.destFieldType === 'enum' || entry.destFieldType === 'multi_enum');
    const destEnumOptions = destFields.find((d) => d.gid === entry.destFieldId)?.enum_options ?? [];
    const isExpanded = expandedEnums.has(entry.sourceFieldId);

    return (
      <React.Fragment key={entry.sourceFieldId}>
        <tr className={entry.nonMigratable ? 'row-omitted' : entry.omit ? 'row-omitted' : entry.confidence === 'none' && !entry.destNativeField && !entry.linkedToParentSourceFieldId ? 'row-warning' : ''}>
          <td className="omit-cell">
            <input type="checkbox" checked={entry.omit} disabled={entry.nonMigratable}
              onChange={() => toggleOmit(entry.sourceFieldId)}
              title={entry.nonMigratable ? 'This field type cannot be migrated' : 'Omit — skip this field'} />
          </td>
          <td>
            {entry.sourceFieldName}
            {entry.isSubitemField && <span className="subitem-badge">Subitem</span>}
            {showEnumToggle && (
              <button className="enum-toggle" onClick={() => toggleEnumExpand(entry.sourceFieldId)}>
                {isExpanded ? '▲' : '▼'} options
              </button>
            )}
          </td>
          <td><span className="type-pill">{entry.sourceFieldType}</span></td>
          <td>
            {entry.nonMigratable ? (
              <span className="linked-to-parent-label">Cannot be migrated to Asana</span>
            ) : entry.linkedToParentSourceFieldId ? (
              <span className="linked-to-parent-label">→ Same as parent field</span>
            ) : isSynthetic ? (
              <span style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>Assignee — native Asana field</span>
            ) : (
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
                {destFields.some((d) => d.isGlobal) && (
                  <optgroup label="Map to Library Field">
                    {destFields.filter((d) => d.isGlobal).map((d) => {
                      const inUse = usedFieldGids.has(d.gid) && d.gid !== entry.destFieldId;
                      return (
                        <option key={d.gid} value={d.gid} style={inUse ? { color: '#aaa' } : undefined}>
                          {d.name} ({d.type}){inUse ? ' — in use' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                )}
                {destFields.some((d) => !d.isGlobal) && (
                  <optgroup label="Map to Project Field">
                    {destFields.filter((d) => !d.isGlobal).map((d) => {
                      const inUse = usedFieldGids.has(d.gid) && d.gid !== entry.destFieldId;
                      return (
                        <option key={d.gid} value={d.gid} style={inUse ? { color: '#aaa' } : undefined}>
                          {d.name} ({d.type}){inUse ? ' — in use' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                )}
                <optgroup label="Create New Field">
                  {NEW_FIELD_TYPES.map((t) => (
                    <option key={t.type} value={`${NEW_FIELD_PREFIX}${t.type}`}>{t.label}</option>
                  ))}
                </optgroup>
              </select>
            )}
          </td>
          <td>{entry.nonMigratable ? <span className="badge badge-omit">Not migratable</span> : entry.omit ? <span className="badge badge-omit">Omitted</span> : entry.linkedToParentSourceFieldId ? <span className="badge badge-success">Linked</span> : confidenceBadge(entry.confidence)}</td>
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
      <div className="project-name-banner">
        <span className="project-name-label">From:</span>
        <strong>{state.selectedSourceProjectName}</strong>
        <span className="project-name-arrow">→</span>
        <span className="project-name-label">To:</span>
        <strong>{state.selectedDestProjectName}</strong>
      </div>
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
                <SeparatorRow label="Non-Optional Fields" colSpan={5} />
                <TitleRow colSpan={5} />
                <tr>
                  <td className="omit-cell">
                    <input type="checkbox" disabled title="Item ID is always migrated" />
                  </td>
                  <td>Item ID</td>
                  <td><span className="type-pill">text</span></td>
                  <td>
                    <select
                      value={externalIdDestFieldGid ?? ''}
                      onChange={(e) => handleExternalIdChange(e.target.value || null)}
                    >
                      {destFields.some((d) => d.type === 'text' && d.isGlobal) && (
                        <optgroup label="Library Fields">
                          {destFields.filter((d) => d.type === 'text' && d.isGlobal).map((d) => {
                            const inUse = usedFieldGids.has(d.gid) && d.gid !== externalIdDestFieldGid;
                            return (
                              <option key={d.gid} value={d.gid} style={inUse ? { color: '#aaa' } : undefined}>
                                {d.name}{inUse ? ' — in use' : ''}
                              </option>
                            );
                          })}
                        </optgroup>
                      )}
                      {destFields.some((d) => d.type === 'text' && !d.isGlobal) && (
                        <optgroup label="Project Fields">
                          {destFields.filter((d) => d.type === 'text' && !d.isGlobal).map((d) => {
                            const inUse = usedFieldGids.has(d.gid) && d.gid !== externalIdDestFieldGid;
                            return (
                              <option key={d.gid} value={d.gid} style={inUse ? { color: '#aaa' } : undefined}>
                                {d.name}{inUse ? ' — in use' : ''}
                              </option>
                            );
                          })}
                        </optgroup>
                      )}
                      <option value="">↳ Create new field (m_External ID)</option>
                    </select>
                  </td>
                  <td />
                </tr>

                {nativeEntries.length > 0 && (
                  <SeparatorRow label="Native Asana Fields" colSpan={5} />
                )}
                {nativeEntries.map(renderRow)}

                {mappedEntries.length > 0 && (
                  <SeparatorRow label="Mapped to Existing Fields" colSpan={5} />
                )}
                {mappedEntries.map(renderRow)}

                {newEntries.length > 0 && (
                  <SeparatorRow label="New Fields to Create" colSpan={5} />
                )}
                {newEntries.map(renderRow)}

                {omittedEntries.length > 0 && (
                  <SeparatorRow label="Omitted Fields" colSpan={5} />
                )}
                {omittedEntries.map(renderRow)}

                {nonMigratableEntries.length > 0 && (
                  <SeparatorRow label="Non-Migratable Field Types" colSpan={5} />
                )}
                {nonMigratableEntries.map(renderRow)}
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

      {checkResult && (
        <div className={`check-result-panel ${checkResult.ok ? 'check-ok' : 'check-warnings'}`}>
          <strong>{checkResult.ok ? '✓ Mapping looks good' : `⚠ ${checkResult.issues.filter(i => i.severity === 'warning').length} warning(s) found`}</strong>
          {checkResult.issues.length > 0 && (
            <ul className="check-issue-list">
              {checkResult.issues.map((issue, i) => (
                <li key={i} className={`check-issue check-issue-${issue.severity}`}>
                  {issue.message}
                  {issue.dedupeFieldId && (
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ marginLeft: 8 }}
                      onClick={() => toggleDedup(issue.dedupeFieldId!)}
                    >
                      Enable auto-deduplicate
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
      {importMsg && <p className="field-hint" style={{ marginTop: 8 }}>{importMsg}</p>}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-ghost" onClick={handleExport} disabled={loading || !!error}>
          ↓ Export Mapping
        </button>
        <button className="btn btn-ghost" onClick={() => importRef.current?.click()} disabled={loading || !!error}>
          ↑ Import Mapping
        </button>
        <button className="btn btn-ghost" onClick={handleCheck} disabled={loading || !!error}>
          ✓ Check Mapping
        </button>
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
