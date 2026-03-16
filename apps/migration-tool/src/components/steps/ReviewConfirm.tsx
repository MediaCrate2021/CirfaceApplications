import type { AppState } from '../../App.tsx';

interface Props {
  state: AppState;
  onConfirm: () => void;
  onBack: () => void;
}

export default function ReviewConfirm({ state, onConfirm, onBack }: Props) {
  const unmappedUsers = state.userMapping.filter((m) => !m.destId).length;
  const unmappedFields = state.fieldMapping.filter((m) => !m.destFieldId).length;

  return (
    <div className="step-panel">
      <h2 className="step-title">Review &amp; Confirm</h2>
      <p className="step-desc">Review the migration plan before starting. This action cannot be undone, though the source data will not be modified.</p>

      <div className="review-grid">
        <ReviewSection title="Source">
          <ReviewRow label="Platform" value={state.sourcePlatform ?? '—'} />
          <ReviewRow label="Workspace" value={state.sourceWorkspaceName ?? '—'} />
          <ReviewRow label="Project" value={state.selectedSourceProjectName ?? '—'} />
        </ReviewSection>

        <ReviewSection title="Destination">
          <ReviewRow label="Asana workspace" value={state.destWorkspaceName ?? '—'} />
          <ReviewRow
            label="Project"
            value={
              state.isNewDestProject
                ? `New: ${state.selectedDestProjectName}`
                : state.selectedDestProjectName ?? '—'
            }
          />
          {!state.isNewDestProject && (
            <ReviewRow
              label="Mode"
              value="Adding to existing project"
              warning
            />
          )}
        </ReviewSection>

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
          <ReviewRow label="Unmapped users" value={`${unmappedUsers} (tasks will have no assignee)`} warning={unmappedUsers > 0} />
          <ReviewRow label="Fields mapped to org-wide" value={`${state.fieldMapping.length - unmappedFields} / ${state.fieldMapping.length}`} />
          <ReviewRow label="Fields to create at project level" value={String(unmappedFields)} warning={unmappedFields > 0} />
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

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="review-section">
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
