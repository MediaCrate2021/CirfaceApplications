import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type { AnalysisReport } from '@cirface/core/types';

interface ProgressLine {
  type: 'info' | 'warning' | 'error';
  message: string;
}

interface Props {
  state: AppState;
  onComplete: (report: AnalysisReport) => void;
}

// Only render the last N lines — keeps the DOM small even for large batches.
const MAX_VISIBLE_LINES = 150;

export default function RunAnalysis({ state, onComplete }: Props) {
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [done, setDone] = useState(0);
  const [total] = useState(state.analyzeProjectIds.length);
  const [error, setError] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | undefined;

    function addLine(type: ProgressLine['type'], message: string) {
      setLines((prev) => {
        const next = [...prev, { type, message }];
        return next.length > MAX_VISIBLE_LINES ? next.slice(next.length - MAX_VISIBLE_LINES) : next;
      });
    }

    fetch('/api/analyze/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectIds: state.analyzeProjectIds.map((p) => p.id),
        trackingProjectGid: state.trackingProjectGid,
        trackingPortfolioGid: state.trackingPortfolioGid,
      }),
    })
      .then((r) => { if (!r.ok) throw new Error(`Prepare failed: ${r.status}`); })
      .then(() => {
        const stream = new EventSource('/api/analyze');
        es = stream;

        stream.addEventListener('info', (e) => {
          const data = JSON.parse(e.data) as { message: string; done?: number };
          addLine('info', data.message);
          if (data.done !== undefined) setDone(data.done);
        });

        stream.addEventListener('warning', (e) => {
          const data = JSON.parse(e.data) as { message: string };
          addLine('warning', data.message);
        });

        stream.addEventListener('error-msg', (e) => {
          const data = JSON.parse(e.data) as { message: string };
          addLine('error', data.message);
          setError(data.message);
          stream.close();
        });

        stream.addEventListener('complete', (e) => {
          stream.close();
          setDone(total);
          onComplete(JSON.parse(e.data) as AnalysisReport);
        });

        stream.addEventListener('error', () => {
          stream.close();
          fetch('/api/analyze/status')
            .then((r) => r.json())
            .then((data: { inProgress: boolean; hasReport: boolean }) => {
              if (data.inProgress || data.hasReport) {
                setDisconnected(true);
              } else {
                setError('Connection lost. Please go back and try again.');
              }
            })
            .catch(() => setError('Connection lost. Please go back and try again.'));
        });
      })
      .catch((fetchErr) => setError(fetchErr instanceof Error ? fetchErr.message : 'Failed to start analysis'));

    return () => es?.close();
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

      {disconnected && (
        <div className="step-notice" style={{ marginTop: '12px' }}>
          <p>
            The connection timed out, but your analysis is still running in the background.
            Results will be emailed to you when complete.
          </p>
        </div>
      )}

      {error && <p className="error-text" style={{ marginTop: '12px' }}>{error}</p>}

      <div className="run-log" ref={logRef}>
        {lines.length === MAX_VISIBLE_LINES && (
          <div className="run-log-line run-log-info" style={{ color: 'var(--color-muted)', fontStyle: 'italic' }}>
            Earlier entries not shown
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={`run-log-line run-log-${line.type}`}>
            {line.message}
          </div>
        ))}
        {lines.length === 0 && !disconnected && (
          <div className="run-log-line run-log-info">Starting analysis…</div>
        )}
      </div>
    </div>
  );
}
