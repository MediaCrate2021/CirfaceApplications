//-------------------------//
// RunAnalysis.tsx
// SSE progress display while analysis runs on the server.
//-------------------------//

import { useEffect, useRef, useState } from 'react';
import type { AnalysisReport } from '@cirface/core/types';

interface ProgressLine {
  type: 'info' | 'warning' | 'error';
  message: string;
}

interface ProjectMeta {
  id: string;
  name: string;
  ownerName?: string;
  startDate?: string;
  endDate?: string;
}

interface Props {
  projects: ProjectMeta[];
  projectCount: number;
  onComplete: (report: AnalysisReport) => void;
  onBack: () => void;
}

export default function RunAnalysis({ projects, projectCount, onComplete, onBack }: Props) {
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params = new URLSearchParams({
      projectIds: JSON.stringify(projects.map((p) => p.id)),
      projectMeta: JSON.stringify(projects),
    });
    const es = new EventSource(`/api/analyze?${params}`);

    function addLine(type: ProgressLine['type'], message: string) {
      setLines((prev) => [...prev, { type, message }]);
    }

    es.addEventListener('info', (e) => {
      const data = JSON.parse(e.data) as { message: string; done?: number };
      addLine('info', data.message);
      if (data.done !== undefined) setDone(data.done);
    });

    es.addEventListener('warning', (e) => {
      const data = JSON.parse(e.data) as { message: string };
      addLine('warning', data.message);
    });

    es.addEventListener('error-msg', (e) => {
      const data = JSON.parse(e.data) as { message: string };
      addLine('error', data.message);
      setError(data.message);
    });

    es.addEventListener('complete', (e) => {
      es.close();
      setDone(projectCount);
      onComplete(JSON.parse(e.data) as AnalysisReport);
    });

    es.addEventListener('error', () => {
      es.close();
      setError('Connection lost. Please go back and try again.');
    });

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  const progress = projectCount > 0 ? Math.round((done / projectCount) * 100) : 0;

  return (
    <div className="step-panel">
      <h2 className="step-title">Analyzing Projects</h2>
      <p className="step-desc">
        Fetching data from {projectCount} project{projectCount === 1 ? '' : 's'}.
        This may take a few minutes for large projects.
      </p>

      <div className="run-progress">
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="progress-label">{done} / {projectCount} projects</span>
      </div>

      {error && (
        <div style={{ marginTop: '12px' }}>
          <p className="error-text">{error}</p>
          <div className="step-actions" style={{ marginTop: '12px' }}>
            <button className="btn btn-ghost" onClick={onBack}>Back to project selection</button>
          </div>
        </div>
      )}

      <div className="run-log" ref={logRef}>
        {lines.map((line, i) => (
          <div key={i} className={`run-log-line run-log-${line.type}`}>{line.message}</div>
        ))}
        {lines.length === 0 && (
          <div className="run-log-line run-log-info">Starting analysis…</div>
        )}
      </div>
    </div>
  );
}
