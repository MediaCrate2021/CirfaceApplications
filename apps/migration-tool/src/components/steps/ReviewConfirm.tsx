import { useEffect, useState } from 'react';
import type { AppState } from '../../App.tsx';

interface ProjectSummary {
  tasks: number;
  subtasks: number;
  comments: number;
  attachments: number;
}

interface Props {
  state: AppState;
  onConfirm: () => void;
  onBack: () => void;
}

export default function ReviewConfirm({ state, onConfirm, onBack }: Props) {
  const unmappedUsers = state.userMapping.filter((m) => !m.destId).length;
  const activeFields = state.fieldMapping.filter((f) => !f.omit);
  const mappedFields = activeFields.filter((f) => f.destFieldId || f.destNativeField).length;
  const newFields    = activeFields.filter((f) => !f.destFieldId && !f.destNativeField).length;
  const omittedFields = state.fieldMapping.filter((f) => f.omit).length;

  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  useEffect(() => {
    if (!state.selectedSourceProjectId) return;
    setSummaryLoading(true);
    fetch(`/api/source/project-summary?projectId=${encodeURIComponent(state.selectedSourceProjectId)}`)
      .then((r) => r.json() as Promise<ProjectSummary>)
      .then((data) => { setSummary(data); setSummaryLoading(false); })
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
              <ReviewRow label="Comments" value={String(summary.comments)} />
              <ReviewRow label="Attachments" value={String(summary.attachments)} />
            </>
          ) : (
            <ReviewRow label="Tasks" value="Could not load counts" />
          )}
        </ReviewSection>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
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

function ReviewRow({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={warning ? 'warning-text' : ''}>{value}</dd>
    </>
  );
}
