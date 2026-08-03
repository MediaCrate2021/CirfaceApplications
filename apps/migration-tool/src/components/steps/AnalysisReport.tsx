import { useState } from 'react';
import type { AnalysisReport as AnalysisReportType, NormalisedField, ProjectAnalysis } from '@cirface/core/types';

const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  workfront:  'WorkFront',
  monday:     'Monday.com',
  trello:     'Trello',
  smartsheet: 'Smartsheet',
  asana:      'Asana',
  wrike:      'Wrike',
};
function platformDisplayName(platform: string): string {
  return PLATFORM_DISPLAY_NAMES[platform] ?? platform;
}

interface Props {
  report: AnalysisReportType;
  onRunAnother: () => void;
  onProceedToMigrate: () => void;
}

export default function AnalysisReport({ report, onRunAnother, onProceedToMigrate }: Props) {
  const totals = report.projects.reduce(
    (acc, p) => ({
      tasks: acc.tasks + p.tasks,
      subtasks: acc.subtasks + p.subtasks,
      comments: acc.comments + p.comments,
      attachments: acc.attachments + p.attachments,
      dependencies: acc.dependencies + p.dependencies,
    }),
    { tasks: 0, subtasks: 0, comments: 0, attachments: 0, dependencies: 0 },
  );

  return (
    <div className="step-panel">
      <h2 className="step-title">Analysis Report</h2>
      <p className="step-desc">
        Analyzed {report.projects.length} project{report.projects.length === 1 ? '' : 's'} from {platformDisplayName(report.sourcePlatform)}.
        {report.trackingTaskGid && (
          <> Report saved to Asana — <a href={`https://app.asana.com/0/0/${report.trackingTaskGid}/f`} target="_blank" rel="noopener noreferrer">view task</a>.</>
        )}
      </p>

      {/* Project list with source links */}
      <div className="review-section review-section-full" style={{ marginBottom: '24px' }}>
        <h3 className="review-section-title">Projects</h3>
        <ul className="analysis-project-list">
          {report.projects.map((p, i) => {
            const sourceUrl = getSourceLink(report.sourcePlatform, p.projectId);
            return (
              <li key={p.projectId} className="analysis-project-list-item">
                <a href={`#project-${p.projectId}`}>{i + 1}. {p.projectName}</a>
                {sourceUrl && (
                  <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="analysis-source-link">
                    Open in {platformDisplayName(report.sourcePlatform)}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Summary totals across all projects */}
      {report.projects.length > 1 && (
        <div className="review-section review-section-full" style={{ marginBottom: '24px' }}>
          <h3 className="review-section-title">Item Totals Across All {report.projects.length} Projects</h3>
          <dl className="review-dl">
            <dt>Tasks</dt><dd>{totals.tasks}</dd>
            <dt>Subtasks</dt><dd>{totals.subtasks}</dd>
            <dt>Dependencies</dt><dd>{totals.dependencies}</dd>
            <dt>Comments</dt><dd>{totals.comments}</dd>
            <dt>Attachments</dt><dd>{totals.attachments}</dd>
            <dt><strong>Total items</strong></dt>
            <dd><strong>{totals.tasks + totals.subtasks + totals.dependencies + totals.comments + totals.attachments}</strong></dd>
          </dl>
        </div>
      )}

      {/* Per-project sections */}
      {report.projects.map((proj) => (
        <ProjectSection key={proj.projectId} project={proj} platform={report.sourcePlatform} />
      ))}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onRunAnother}>
          Analyze Another Set
        </button>
        <button className="btn btn-primary" onClick={onProceedToMigrate}>
          Proceed to Migration
        </button>
      </div>
    </div>
  );
}

function ProjectSection({ project, platform }: { project: ProjectAnalysis; platform: string }) {
  const [copied, setCopied] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  function copyFields() {
    const text = buildCopyText(project, platformDisplayName(platform));
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const migratable    = project.fields.filter((f) => !f.nonMigratable);
  const nonMigratable = project.fields.filter((f) => f.nonMigratable);
  const parentFields  = migratable.filter((f) => !f.isSubitemField);
  const subitemFields = migratable.filter((f) => f.isSubitemField);
  const libraryFields = migratable.filter((f) => !f.isSubitemField && f.isLibraryField);
  const projectFields = migratable.filter((f) => !f.isSubitemField && !f.isLibraryField);

  return (
    <div id={`project-${project.projectId}`} className="analysis-project-section">
      <div className="analysis-project-header">
        <h3 className="analysis-project-title">{project.projectName}</h3>
      </div>

      <div className="analysis-project-body">
        <div className="review-grid" style={{ marginBottom: '0' }}>
          <div className="review-section">
            <h4 className="review-section-title">Content</h4>
            <dl className="review-dl">
              <dt>Tasks</dt><dd>{project.tasks}</dd>
              <dt>Subtasks</dt><dd>{project.subtasks}</dd>
              <dt>Dependencies</dt><dd>{project.dependencies}</dd>
              <dt>Comments</dt><dd>{project.comments}</dd>
              <dt>Attachments</dt><dd>{project.attachments}</dd>
              <dt><strong>Total</strong></dt><dd><strong>{project.tasks + project.subtasks + project.dependencies + project.comments + project.attachments}</strong></dd>
            </dl>
          </div>
          <div className="review-section">
            <h4 className="review-section-title">Structure</h4>
            <dl className="review-dl">
              <dt>Users in source</dt><dd>{project.users}</dd>
              <dt>Migratable fields</dt><dd>{migratable.length}</dd>
              {platform === 'asana' ? (<>
                {libraryFields.length > 0 && <><dt>Library fields</dt><dd>{libraryFields.length}</dd></>}
                {projectFields.length > 0 && <><dt>Project fields</dt><dd>{projectFields.length}</dd></>}
              </>) : (<>
                <dt>Main task fields</dt><dd>{parentFields.length}</dd>
                {subitemFields.length > 0 && <><dt>Subitem fields</dt><dd>{subitemFields.length}</dd></>}
              </>)}
              {nonMigratable.length > 0 && <><dt>Non-migratable</dt><dd>{nonMigratable.length}</dd></>}
            </dl>
          </div>
        </div>
      </div>

      {project.fields.length > 0 && (<>
        <button className="analysis-fields-toggle" onClick={() => setFieldsOpen((o) => !o)}>
          Custom Fields ({project.fields.length})
          <span className={`analysis-fields-toggle-icon ${fieldsOpen ? 'open' : ''}`}>▼</span>
        </button>
        {fieldsOpen && (
          <div className="analysis-field-table-wrap">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" onClick={copyFields}>
                {copied ? 'Copied!' : 'Copy field list'}
              </button>
            </div>
            <table className="mapping-table analysis-field-table">
              <thead>
                <tr>
                  <th>Field Name</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Options</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {project.fields.map((f) => (
                  <FieldRow key={f.id} field={f} platform={platform} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>)}
    </div>
  );
}

function fieldSource(field: NormalisedField, platform: string): string {
  if (platform === 'monday') return field.isSubitemField ? 'Subitem' : 'Main task';
  if (platform === 'asana')  return field.isLibraryField ? 'Library' : 'Project';
  return '—';
}

function FieldRow({ field, platform }: { field: NormalisedField; platform: string }) {
  const optionCount = field.options?.length ?? 0;
  return (
    <tr className={field.nonMigratable ? 'row-muted' : ''}>
      <td>{field.name}</td>
      <td><span className="type-pill">{field.type}</span></td>
      <td>{fieldSource(field, platform)}</td>
      <td>{optionCount > 0 ? optionCount : '—'}</td>
      <td>{field.nonMigratable ? <span className="badge badge-warning">non-migratable</span> : ''}</td>
    </tr>
  );
}

function getSourceLink(platform: string, projectId: string): string | null {
  if (platform === 'asana') return `https://app.asana.com/0/${projectId}/list`;
  if (platform === 'smartsheet') return `https://app.smartsheet.com/sheets/${projectId}`;
  return null;
}

function buildCopyText(project: ProjectAnalysis, platform: string): string {
  const lines: string[] = [];
  lines.push(`Fields in "${project.projectName}" (${platform})`);
  lines.push('='.repeat(60));
  lines.push('');

  const colWidths = { name: 30, type: 16, source: 10, options: 8, notes: 16 };
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

  lines.push(
    pad('Field Name', colWidths.name) +
    pad('Type', colWidths.type) +
    pad('Source', colWidths.source) +
    pad('Options', colWidths.options) +
    'Notes',
  );
  lines.push('-'.repeat(colWidths.name + colWidths.type + colWidths.source + colWidths.options + colWidths.notes));

  for (const f of project.fields) {
    lines.push(
      pad(f.name, colWidths.name) +
      pad(f.type, colWidths.type) +
      pad(fieldSource(f, platform), colWidths.source) +
      pad(f.options?.length ? String(f.options.length) : '—', colWidths.options) +
      (f.nonMigratable ? 'non-migratable' : ''),
    );
  }

  lines.push('');
  lines.push(`Tasks: ${project.tasks}  Subtasks: ${project.subtasks}  Comments: ${project.comments}  Attachments: ${project.attachments}  Dependencies: ${project.dependencies}`);

  return lines.join('\n');
}
