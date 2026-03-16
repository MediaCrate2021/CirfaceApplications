import type { MigrationReport, MigrationReportItem } from '../../types/index.ts';

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

      <div className="report-meta">
        <p><strong>Source:</strong> {report.sourceProject}</p>
        <p><strong>Destination:</strong> {report.destProject}</p>
        <p><strong>Started:</strong> {new Date(report.startedAt).toLocaleString()}</p>
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
                .map((item: MigrationReportItem) => (
                  <tr key={item.taskId} className={item.status === 'error' ? 'row-error' : 'row-warning'}>
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
        <button className="btn btn-primary" onClick={onRunAnother}>
          Run Another Migration
        </button>
      </div>
    </div>
  );
}
