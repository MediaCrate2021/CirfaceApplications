import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type { AnalysisReport } from '../../types/index.ts';

interface ProgressLine {
  type: 'info' | 'warning' | 'error';
  message: string;
}

interface Props {
  state: AppState;
  onComplete: (report: AnalysisReport) => void;
}

export default function RunAnalysis({ state, onComplete }: Props) {
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [done, setDone] = useState(0);
  const [total] = useState(state.analyzeProjectIds.length);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const projectIds = state.analyzeProjectIds.map((p) => p.id);

    const es = new EventSource(
      `/api/analyze?projectIds=${encodeURIComponent(JSON.stringify(projectIds))}&trackingProjectGid=${encodeURIComponent(state.trackingProjectGid ?? '')}&trackingPortfolioGid=${encodeURIComponent(state.trackingPortfolioGid ?? '')}`,
    );

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
    });

    es.addEventListener('complete', (e) => {
      es.close();
      const report = JSON.parse(e.data) as AnalysisReport;
      setDone(total);
      onComplete(report);
    });

    es.addEventListener('error', () => {
      es.close();
      setError('Connection to server lost. Please try again.');
    });

    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="step-panel">
      <h2 className="step-title">Analyzing Projects</h2>
      <p className="step-desc">
        Fetching data from {total} project{total === 1 ? '' : 's'}. This may take a few minutes depending on project size.
      </p>

      <div className="run-progress">
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="progress-label">{done} / {total} projects</span>
      </div>

      {error && <p className="error-text" style={{ marginTop: '12px' }}>{error}</p>}

      <div className="run-log" ref={logRef}>
        {lines.map((line, i) => (
          <div key={i} className={`run-log-line run-log-${line.type}`}>
            {line.message}
          </div>
        ))}
        {lines.length === 0 && <div className="run-log-line run-log-info">Starting analysis…</div>}
      </div>
    </div>
  );
}
