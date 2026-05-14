import type { FailedAttachment, MigrationReport, MigrationReportItem, SkippedSubitemField } from '../../types/index.ts';

function SourceLink({ platform, boardId, taskId }: { platform: string; boardId: string; taskId: string }) {
  if (platform === 'monday') {
    return <a href={`https://monday.com/boards/${boardId}/pulses/${taskId}`} target="_blank" rel="noopener noreferrer">Open in Monday</a>;
  }
  if (platform === 'smartsheet') {
    return <a href={`https://app.smartsheet.com/sheets/${boardId}`} target="_blank" rel="noopener noreferrer">Open in Smartsheet</a>;
  }
  if (platform === 'trello') {
    return <a href={`https://trello.com/c/${taskId}`} target="_blank" rel="noopener noreferrer">Open in Trello</a>;
  }
  if (platform === 'asana') {
    return <a href={`https://app.asana.com/0/${boardId}/${taskId}`} target="_blank" rel="noopener noreferrer">Open in Asana</a>;
  }
  return <span>—</span>;
}

interface Props {
  report: MigrationReport;
  onRunAnother: () => void;
}

export default function Report({ report, onRunAnother }: Props) {
  const duration = report.completedAt && report.startedAt
    ? Math.round((new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime()) / 1000)
    : null;

  return (
    <div className="step-panel">
      <h2 className="step-title">Migration Report</h2>

      {report.cancelled && (
        <p className="warning-text error-banner">
          This migration was cancelled before completion. The report below reflects what was migrated before the stop.
        </p>
      )}

      <div className="report-summary">
        <div className="report-stat">
          <span className="report-stat-value">{report.migratedTasks}</span>
          <span className="report-stat-label">Tasks migrated</span>
        </div>
        <div className="report-stat">
          <span className="report-stat-value">{report.migratedSubtasks}</span>
          <span className="report-stat-label">Subtasks</span>
        </div>
        <div className="report-stat">
          <span className="report-stat-value">{report.migratedComments}</span>
          <span className="report-stat-label">Comments</span>
        </div>
        <div className="report-stat">
          <span className="report-stat-value">{report.migratedAttachments}</span>
          <span className="report-stat-label">Attachments</span>
        </div>
        <div className="report-stat">
          <span className="report-stat-value">{report.migratedDependencies}</span>
          <span className="report-stat-label">Dependencies</span>
        </div>
        <div className={`report-stat ${report.warnings > 0 ? 'stat-warning' : ''}`}>
          <span className="report-stat-value">{report.warnings}</span>
          <span className="report-stat-label">Warnings</span>
        </div>
        <div className={`report-stat ${report.errors > 0 ? 'stat-error' : ''}`}>
          <span className="report-stat-value">{report.errors}</span>
          <span className="report-stat-label">Errors</span>
        </div>
      </div>

      {report.sourceCount && (
        <div className="report-issues">
          <h3>Source vs Migrated</h3>
          <table className="mapping-table">
            <thead>
              <tr><th>Item</th><th>Source</th><th>Migrated</th><th>Delta</th></tr>
            </thead>
            <tbody>
              {(() => {
                const failedCount = report.failedAttachments?.length ?? 0;
                const failedComments = report.failedComments || 0;
                const rows: [string, number, number, number?, boolean?][] = [
                  ['Tasks',       report.sourceCount.tasks,        report.migratedTasks],
                  ['Subtasks',    report.sourceCount.subtasks,     report.migratedSubtasks],
                  ['Comments',    report.sourceCount.comments,     report.migratedComments, failedComments || undefined],
                  ['Attachments', report.sourceCount.attachments,  report.migratedAttachments, failedCount, report.attachmentsSkipped],
                  ['Dependencies',report.sourceCount.dependencies, report.migratedDependencies],
                ];
                return rows.map(([label, source, migrated, failed, skipped]) => {
                  const accounted = migrated + (failed ?? 0);
                  const delta = accounted - source;
                  const migratedCell = skipped
                    ? <span className="muted-text">skipped</span>
                    : failed != null && failed > 0
                    ? `${migrated} (+${failed} failed)`
                    : migrated;
                  const deltaCell = skipped ? '—' : delta === 0 ? '✓' : delta > 0 ? `+${delta}` : delta;
                  return (
                    <tr key={label} className={!skipped && delta < 0 ? 'row-warning' : ''}>
                      <td>{label}</td>
                      <td>{source}</td>
                      <td>{migratedCell}</td>
                      <td>{deltaCell}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      )}

      {report.destProject && (
        <div className="report-project-link">
          <a
            href={`https://app.asana.com/0/${report.destProject}/list`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
          >
            Open Migrated Project in Asana
          </a>
          <span className="report-project-id">Project ID: <code>{report.destProject}</code></span>
        </div>
      )}

      <div className="report-meta">
        <p><strong>Source:</strong> {report.sourceProject}</p>
        <p><strong>Destination:</strong> {report.destProjectName || report.destProject}</p>
        {report.destProject && <p><strong>Asana Project ID:</strong> <code>{report.destProject}</code></p>}
        <p><strong>Migration started:</strong> {new Date(report.startedAt).toLocaleString()}</p>
        {duration !== null && <p><strong>Duration:</strong> {duration}s</p>}
        {report.trackingTaskGid && (
          <p>
            <strong>Report task:</strong>{' '}
            <a
              href={`https://app.asana.com/0/0/${report.trackingTaskGid}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View in Asana
            </a>
          </p>
        )}
      </div>

      {report.skippedSubitemFields?.length > 0 && (
        <div className="report-issues">
          <h3>Skipped subitem fields</h3>
          <p className="step-desc">These subitem fields had no mapping and were not migrated.</p>
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Values skipped</th>
              </tr>
            </thead>
            <tbody>
              {report.skippedSubitemFields.map((f: SkippedSubitemField) => (
                <tr key={f.fieldId} className="row-warning">
                  <td>{f.fieldName !== f.fieldId ? f.fieldName : `Unknown field (${f.fieldId})`}</td>
                  <td>{f.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.failedAttachments?.length > 0 && (
        <div className="report-issues">
          <h3>Failed Attachments</h3>
          <p className="step-desc">
            These attachments could not be transferred after multiple retries. A link was posted as a comment on the task.
            Download them manually and re-attach if needed.
          </p>
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Attachment</th>
                <th>Reason</th>
                <th>Find in Source</th>
              </tr>
            </thead>
            <tbody>
              {report.failedAttachments.map((a: FailedAttachment) => (
                <tr key={`${a.taskId}-${a.attachmentId}`} className="row-warning">
                  <td>{a.taskName}</td>
                  <td>{a.attachmentName}</td>
                  <td>{a.reason}</td>
                  <td><SourceLink platform={report.sourcePlatform} boardId={a.boardId} taskId={a.taskId} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.items.some((i) => i.status !== 'success') && (
        <div className="report-issues">
          <h3>Issues</h3>
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {report.items
                .filter((i) => i.status !== 'success')
                .map((item: MigrationReportItem, idx: number) => (
                  <tr key={`${item.taskId}-${idx}`} className={item.status === 'error' ? 'row-error' : 'row-warning'}>
                    <td>{item.taskName}</td>
                    <td><span className={`badge badge-${item.status}`}>{item.status}</span></td>
                    <td>{item.message ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onRunAnother}>
          Migrate Another Project
        </button>
      </div>
    </div>
  );
}
