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

// Only render the last N lines — keeps the DOM small even for large batches.
const MAX_VISIBLE_LINES = 150;

export default function RunAnalysis({ projects, projectCount, onComplete, onBack }: Props) {
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');
  // Set when the SSE connection drops mid-run (proxy timeout, etc.).
  // The analysis keeps running on the server; user can refresh to reconnect.
  const [backgroundRunning, setBackgroundRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const openStreamRef = useRef<(() => void) | null>(null);
  // True once we've received at least one progress event — distinguishes a
  // mid-run connection drop (show Refresh) from a failed initial connection (show error).
  const analysisStarted = useRef(false);

  useEffect(() => {
    let es: EventSource | undefined;

    function addLine(type: ProgressLine['type'], message: string) {
      setLines((prev) => {
        const next = [...prev, { type, message }];
        // Keep only the tail so the DOM stays small.
        return next.length > MAX_VISIBLE_LINES ? next.slice(next.length - MAX_VISIBLE_LINES) : next;
      });
    }

    function openStream() {
      setBackgroundRunning(false);
      setError('');
      const stream = new EventSource('/api/analyze');
      es = stream;

      stream.addEventListener('info', (e) => {
        analysisStarted.current = true;
        const data = JSON.parse(e.data) as { message: string; done?: number };
        addLine('info', data.message);
        if (data.done !== undefined) setDone(data.done);
      });

      stream.addEventListener('warning', (e) => {
        analysisStarted.current = true;
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
        setDone(projectCount);
        onComplete(JSON.parse(e.data) as AnalysisReport);
      });

      // Connection dropped. If analysis had already started, the server is still
      // running it — show Refresh so the user can reconnect. If nothing had
      // started yet, it's a connection failure — show an error instead.
      stream.addEventListener('error', () => {
        stream.close();
        if (analysisStarted.current) {
          setBackgroundRunning(true);
        } else {
          setError('Could not connect to the server. Please go back and try again.');
        }
      });
    }

    // Expose openStream so the Refresh button can call it.
    openStreamRef.current = openStream;

    // POST project list to session first — EventSource is GET-only so large
    // selections can't go in the URL without hitting the 431 header size limit.
    fetch('/api/analyze/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: projects.map((p) => p.id), projectMeta: projects }),
    })
      .then((r) => { if (!r.ok) throw new Error(`Prepare failed: ${r.status}`); })
      .then(() => openStream())
      .catch((fetchErr) => { setError(fetchErr instanceof Error ? fetchErr.message : 'Failed to start analysis'); });

    return () => es?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll log
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

      {backgroundRunning && (
        <div className="step-notice" style={{ marginTop: '12px' }}>
          <p>The analysis is still running in the background.</p>
          <div className="step-actions" style={{ marginTop: '8px' }}>
            <button
              className="btn btn-primary"
              onClick={() => openStreamRef.current?.()}
            >
              Refresh
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '12px' }}>
          <p className="error-text">{error}</p>
          <div className="step-actions" style={{ marginTop: '12px' }}>
            <button className="btn btn-ghost" onClick={onBack}>Back to project selection</button>
          </div>
        </div>
      )}

      <div className="run-log" ref={logRef}>
        {lines.length === MAX_VISIBLE_LINES && (
          <div className="run-log-line run-log-info" style={{ color: 'var(--color-muted)', fontStyle: 'italic' }}>
            Earlier entries not shown
          </div>
        )}
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
