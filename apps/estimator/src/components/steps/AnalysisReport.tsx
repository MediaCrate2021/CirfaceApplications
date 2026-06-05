//-------------------------//
// AnalysisReport.tsx
// Displays the analysis report with a download button.
// Report is also silently posted to Cirface's Asana by the server (Phase 5).
//-------------------------//

import { useState } from 'react';
import type { AnalysisReport as AnalysisReportType, NormalisedField, ProjectAnalysis } from '@cirface/core/types';

interface Props {
  report: AnalysisReportType;
  onRunAnother: () => void;
}

export default function AnalysisReport({ report, onRunAnother }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const totals = report.projects.reduce(
    (acc, p) => ({
      tasks:        acc.tasks        + p.tasks,
      subtasks:     acc.subtasks     + p.subtasks,
      comments:     acc.comments     + p.comments,
      attachments:  acc.attachments  + p.attachments,
      dependencies: acc.dependencies + p.dependencies,
    }),
    { tasks: 0, subtasks: 0, comments: 0, attachments: 0, dependencies: 0 },
  );

  async function handleDownload() {
    setDownloading(true);
    setDownloadError('');
    try {
      const res = await fetch('/api/report/download');
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `analysis-report-${date}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Analysis Complete</h2>
      <p className="step-desc">
        Analyzed {report.projects.length} project{report.projects.length === 1 ? '' : 's'} from {report.sourcePlatform}.
        {report.trackingTaskGid && (
          <> A copy has been saved to Cirface for review.</>
        )}
      </p>

      {/* Project TOC */}
      <div className="review-section review-section-full" style={{ marginBottom: '24px' }}>
        <h3 className="review-section-title">Projects Analyzed</h3>
        <ul className="analysis-project-list">
          {report.projects.map((p, i) => {
            const sourceUrl = getSourceLink(report.sourcePlatform, p.projectId);
            return (
              <li key={p.projectId} className="analysis-project-list-item">
                <a href={`#project-${p.projectId}`}>{i + 1}. {p.projectName}</a>
                {sourceUrl && (
                  <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="analysis-source-link">
                    Open in {report.sourcePlatform}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Grand totals (multi-project only) */}
      {report.projects.length > 1 && (
        <div className="review-section review-section-full" style={{ marginBottom: '24px' }}>
          <h3 className="review-section-title">Totals across all projects</h3>
          <div className="review-grid" style={{ marginTop: '0.5rem' }}>
            <div>
              <dl className="review-dl">
                <dt>Projects</dt><dd>{report.projects.length}</dd>
              </dl>
            </div>
            <div>
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
          </div>
        </div>
      )}

      {/* Per-project breakdown */}
      {report.projects.map((proj) => (
        <ProjectSection key={proj.projectId} project={proj} platform={report.sourcePlatform} />
      ))}

      {/* Actions */}
      {downloadError && <p className="error-text" style={{ marginTop: '12px' }}>{downloadError}</p>}
      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onRunAnother}>
          Start Over
        </button>
        <button
          className="btn btn-secondary"
          onClick={handleDownload}
          disabled={downloading}
        >
          {downloading ? 'Downloading…' : 'Download Report (.txt)'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-project section
// ---------------------------------------------------------------------------

function ProjectSection({ project, platform }: { project: ProjectAnalysis; platform: string }) {
  const migratable      = project.fields.filter((f) => !f.nonMigratable);
  const nonMigratable   = project.fields.filter((f) => f.nonMigratable);
  const parentFields    = migratable.filter((f) => !f.isSubitemField);
  const subitemFields   = migratable.filter((f) => f.isSubitemField);
  const libraryFields   = migratable.filter((f) => !f.isSubitemField && f.isLibraryField);
  const projectFields   = migratable.filter((f) => !f.isSubitemField && !f.isLibraryField);

  return (
    <div id={`project-${project.projectId}`} className="analysis-project-section">
      <div className="analysis-project-header">
        <h3 className="analysis-project-title">{project.projectName}</h3>
      </div>

      <div className="review-grid" style={{ marginBottom: '20px' }}>
        <div className="review-section">
          <h4 className="review-section-title">Content</h4>
          <dl className="review-dl">
            <dt>Tasks</dt>        <dd>{project.tasks}</dd>
            <dt>Subtasks</dt>     <dd>{project.subtasks}</dd>
            <dt>Dependencies</dt> <dd>{project.dependencies}</dd>
            <dt>Comments</dt>     <dd>{project.comments}</dd>
            <dt>Attachments</dt>  <dd>{project.attachments}</dd>
            <dt><strong>Total</strong></dt>
            <dd><strong>{project.tasks + project.subtasks + project.dependencies + project.comments + project.attachments}</strong></dd>
          </dl>
        </div>
        <div className="review-section">
          <h4 className="review-section-title">Structure</h4>
          <dl className="review-dl">
            <dt>Users in source</dt>    <dd>{project.users}</dd>
            <dt>Migratable fields</dt>  <dd>{migratable.length}</dd>
            {platform === 'asana' ? (<>
              {libraryFields.length > 0 && <><dt>Library fields</dt><dd>{libraryFields.length}</dd></>}
              {projectFields.length > 0 && <><dt>Project fields</dt><dd>{projectFields.length}</dd></>}
            </>) : (<>
              <dt>Main task fields</dt>   <dd>{parentFields.length}</dd>
              {subitemFields.length > 0 && <><dt>Subitem fields</dt><dd>{subitemFields.length}</dd></>}
            </>)}
            {nonMigratable.length > 0 && <><dt>Non-migratable</dt><dd>{nonMigratable.length}</dd></>}
          </dl>
        </div>
      </div>

      {project.fields.length > 0 && (
        <div className="analysis-field-table-wrap">
          <div className="analysis-field-table-toolbar">
            <span className="analysis-field-table-label">Custom Fields</span>
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
  if (platform === 'asana')       return `https://app.asana.com/0/${projectId}/list`;
  if (platform === 'smartsheet')  return `https://app.smartsheet.com/sheets/${projectId}`;
  return null;
}

