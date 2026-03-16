import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type { MigrationReport } from '../../types/index.ts';

interface LogLine {
  type: 'task' | 'info' | 'warning' | 'error';
  message: string;
  done?: number;
  total?: number;
}

interface Props {
  state: AppState;
  onComplete: (report: MigrationReport) => void;
}

export default function RunMigration({ state, onComplete }: Props) {
  const [log, setLog] = useState<LogLine[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);
  const hasFired = useRef(false);

  useEffect(() => {
    // Prevent React StrictMode's double-invoke from firing two migrations.
    // We intentionally omit an AbortController: StrictMode's cleanup would abort
    // the stream before any events arrive. Once a migration starts, it runs to completion.
    if (hasFired.current) return;
    hasFired.current = true;

    fetch('/api/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceProjectId: state.selectedSourceProjectId,
        destProjectGid: state.selectedDestProjectGid ?? '',
        destProjectName: state.selectedDestProjectName ?? '',
        destTeamGid: state.selectedDestTeamGid ?? undefined,
        isNewProject: state.isNewDestProject,
      }),
    }).then(async (res) => {
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const chunk of lines) {
          const eventLine = chunk.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!eventLine || !dataLine) continue;

          const eventType = eventLine.replace('event:', '').trim();
          const payload = JSON.parse(dataLine.replace('data:', '').trim());

          if (eventType === 'complete') {
            onComplete(payload as MigrationReport);
            return;
          }

          if (eventType === 'error') {
            setError(payload.message ?? 'Migration failed');
            return;
          }

          const line: LogLine = {
            type: eventType as LogLine['type'],
            message: payload.message ?? '',
            done: payload.done,
            total: payload.total,
          };

          setLog((prev) => [...prev, line]);
          if (payload.done) setDone(payload.done);
          if (payload.total) setTotal(payload.total);
        }
      }
    }).catch((err) => {
      setError(err.message);
    });
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="step-panel">
      <h2 className="step-title">Running Migration</h2>

      {total > 0 && (
        <div className="progress-section">
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <p className="progress-text">{done} / {total} tasks — {progress}%</p>
        </div>
      )}

      {error && <p className="error-text error-banner">{error}</p>}

      <div className="migration-log">
        {log.map((line, i) => (
          <div key={i} className={`log-line log-${line.type}`}>
            <span className="log-icon">
              {line.type === 'task' ? '→' : line.type === 'warning' ? '⚠' : line.type === 'error' ? '✕' : '·'}
            </span>
            {line.message}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
