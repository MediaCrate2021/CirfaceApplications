import React, { useEffect, useState } from 'react';
import type { AppState } from '../../App.tsx';

interface ProjectSummary {
  tasks: number;
  subtasks: number;
  comments: number;
  attachments: number;
  dependencies: number;
}

interface SubitemFieldWarning {
  fieldId: string;
  fieldName: string;
  fieldType: string;
}

interface Props {
  state: AppState;
  onConfirm: () => void;
  onShellConfirm: () => void;
  onBack: () => void;
  onReloadMapping: () => void;
  onSkipAttachmentsChange: (skip: boolean) => void;
  onConvertParentTasksChange: (convert: boolean) => void;
}

export default function ReviewConfirm({ state, onConfirm, onShellConfirm, onBack, onReloadMapping, onSkipAttachmentsChange, onConvertParentTasksChange }: Props) {
  const unmappedUsers = state.userMapping.filter((m) => !m.destId).length;
  const activeFields = state.fieldMapping.filter((f) => !f.omit);
  const mappedFields = activeFields.filter((f) => f.destFieldId || f.destNativeField).length;
  const newFields    = activeFields.filter((f) => !f.destFieldId && !f.destNativeField).length;
  const omittedFields = state.fieldMapping.filter((f) => f.omit).length;

  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [subitemWarnings, setSubitemWarnings] = useState<SubitemFieldWarning[]>([]);

  useEffect(() => {
    if (!state.selectedSourceProjectId) return;
    setSummaryLoading(true);
    Promise.all([
      fetch(`/api/source/project-summary?projectId=${encodeURIComponent(state.selectedSourceProjectId)}`).then((r) => r.json() as Promise<ProjectSummary>),
      fetch(`/api/source/subitem-field-warnings?projectId=${encodeURIComponent(state.selectedSourceProjectId)}`).then((r) => r.json() as Promise<SubitemFieldWarning[]>),
    ])
      .then(([summaryData, warnings]) => {
        setSummary(summaryData);
        setSubitemWarnings(warnings);
        setSummaryLoading(false);
      })
      .catch(() => setSummaryLoading(false));
  }, [state.selectedSourceProjectId]);

  return (
    <div className="step-panel">
      <h2 className="step-title">Review &amp; Confirm</h2>
      <p className="step-desc">Review the migration plan before starting. This action cannot be undone, though the source data will not be modified.</p>

      <div className="review-grid">
        {/* Row 1: Source + Destination */}
        <ReviewSection title="Source">
          <ReviewRow label="Platform" value={state.sourcePlatform ?? '—'} />
          <ReviewRow label="Workspace" value={state.sourceWorkspaceName ?? '—'} />
          <ReviewRow label="Project" value={state.selectedSourceProjectName ?? '—'} />
        </ReviewSection>

        <ReviewSection title="Destination">
          <ReviewRow label="Asana workspace" value={state.destWorkspaceName ?? '—'} />
          {state.selectedDestTeamName && (
            <ReviewRow label="Team" value={state.selectedDestTeamName} />
          )}
          <ReviewRow
            label="Project"
            value={
              state.isNewDestProject
                ? `New: ${state.selectedDestProjectName}`
                : state.selectedDestProjectName ?? '—'
            }
          />
          {!state.isNewDestProject && (
            <ReviewRow label="Mode" value="Adding to existing project" warning />
          )}
        </ReviewSection>

        {/* Row 2: Tracking + Mappings */}
        <ReviewSection title="Tracking">
          <ReviewRow label="Report project" value={state.trackingProjectName ?? '—'} />
          {state.trackingPortfolioName && (
            <ReviewRow label="Portfolio" value={state.trackingPortfolioName} />
          )}
          {state.trackingOwnerName && (
            <ReviewRow label="Project owner" value={state.trackingOwnerName} />
          )}
        </ReviewSection>

        <ReviewSection title="Mappings">
          <ReviewRow label="Users mapped" value={`${state.userMapping.length - unmappedUsers} / ${state.userMapping.length}`} warning={unmappedUsers > 0} />
          {unmappedUsers > 0 && (
            <ReviewRow label="Unmapped users" value={`${unmappedUsers} will have no assignee`} warning />
          )}
          <ReviewRow label="Fields mapped" value={String(mappedFields)} />
          <ReviewRow label="Fields to create" value={String(newFields)} warning={newFields > 0} />
          {omittedFields > 0 && (
            <ReviewRow label="Fields omitted" value={String(omittedFields)} />
          )}
        </ReviewSection>

        {/* Row 3: Content — full width */}
        <ReviewSection title="Content" full>
          {summaryLoading ? (
            <ReviewRow label="Tasks" value="Loading…" />
          ) : summary ? (
            <>
              <ReviewRow label="Tasks" value={String(summary.tasks)} />
              <ReviewRow label="Subtasks" value={String(summary.subtasks)} />
              <ReviewRow label="Dependencies" value={String(summary.dependencies)} />
              <ReviewRow label="Comments" value={String(summary.comments)} />
              <ReviewRow
                label="Attachments"
                value={state.skipAttachments ? `${summary.attachments} (will be skipped)` : String(summary.attachments)}
                muted={state.skipAttachments}
                action={
                  <label className="skip-toggle">
                    <input
                      type="checkbox"
                      checked={state.skipAttachments}
                      onChange={(e) => onSkipAttachmentsChange(e.target.checked)}
                    />
                    Skip attachments
                  </label>
                }
              />
              {(state.sourcePlatform === 'workfront' || state.sourcePlatform === 'smartsheet') && (
                <ReviewRow
                  label="Parent tasks"
                  value={state.convertParentTasksToSections ? 'Convert to sections' : 'Keep as tasks'}
                  action={
                    <label className="skip-toggle">
                      <input
                        type="checkbox"
                        checked={state.convertParentTasksToSections}
                        onChange={(e) => onConvertParentTasksChange(e.target.checked)}
                      />
                      Convert parent tasks to sections
                    </label>
                  }
                />
              )}
            </>
          ) : (
            <ReviewRow label="Tasks" value="Could not load counts" />
          )}
        </ReviewSection>
      </div>

      {subitemWarnings.length > 0 && (
        <div className="review-warnings">
          <h3 className="review-warnings-title">⚠ Subitem fields that will not be migrated</h3>
          <p className="review-warnings-desc">
            These fields exist on subitems but have no matching entry in the field mapping.
            Their values will be silently skipped. Go back and reload the mapping to include them.
          </p>
          <table className="mapping-table">
            <thead>
              <tr><th>Field Name</th><th>Type</th></tr>
            </thead>
            <tbody>
              {subitemWarnings.map((w) => (
                <tr key={w.fieldId} className="row-warning">
                  <td>{w.fieldName}</td>
                  <td><span className="type-pill">{w.fieldType}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-ghost" onClick={onReloadMapping}>
          ↺ Reload &amp; re-map
        </button>
        <button className="btn btn-ghost" onClick={onShellConfirm}>
          Create Shell
        </button>
        <button className="btn btn-primary btn-danger" onClick={onConfirm}>
          Start Migration
        </button>
      </div>
    </div>
  );
}

function ReviewSection({ title, children, full }: { title: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`review-section${full ? ' review-section-full' : ''}`}>
      <h3 className="review-section-title">{title}</h3>
      <dl className="review-dl">{children}</dl>
    </div>
  );
}

function ReviewRow({ label, value, warning, muted, action }: { label: string; value: string; warning?: boolean; muted?: boolean; action?: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={warning ? 'warning-text' : muted ? 'muted-text' : ''}>
        {value}
        {action && <span className="review-row-action">{action}</span>}
      </dd>
    </>
  );
}
