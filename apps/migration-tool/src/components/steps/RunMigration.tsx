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
  onBackToFieldMapping: () => void;
}

const POLL_INTERVAL_MS = 4_000;

export default function RunMigration({ state, onComplete, onBackToFieldMapping }: Props) {
  const [log, setLog] = useState<LogLine[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const hasFired = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Check the status endpoint once immediately, then poll until migration finishes. */
  function startPolling(reason: string) {
    setReconnecting(true);
    setLog((prev) => [...prev, { type: 'warning', message: `Connection lost (${reason}) — waiting for migration to finish…` }]);

    const poll = async () => {
      try {
        const res = await fetch('/api/migrate/status');
        if (res.ok) {
          const { inProgress, report, error: migError } = await res.json() as { inProgress: boolean; report: MigrationReport | null; error: string | null };
          if (!inProgress) {
            setReconnecting(false);
            if (report) {
              onComplete(report);
            } else if (migError) {
              setError(`Migration failed: ${migError}`);
            } else {
              setError('Migration finished but no report was found. Check the Asana tracking task for details.');
            }
            return;
          }
        }
      } catch {
        // network still down — keep polling
      }
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
  }

  /** Check once if a completed report is available and hand off if so. */
  async function checkForReport() {
    try {
      const res = await fetch('/api/migrate/status');
      if (res.ok) {
        const { inProgress, report, error: migError } = await res.json() as { inProgress: boolean; report: MigrationReport | null; error: string | null };
        if (!inProgress) {
          if (report) { onComplete(report); return true; }
          if (migError) { setError(`Migration failed: ${migError}`); return true; }
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  useEffect(() => {
    // Prevent React StrictMode's double-invoke from firing two migrations.
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
      if (res.status === 409) {
        // Migration already running (e.g. user refreshed mid-migration) — poll for completion.
        startPolling('page was refreshed while migration was running');
        return;
      }
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

      // Stream closed without a complete/error event — the server may have finished
      // successfully but the final SSE chunk didn't arrive (e.g. proxy timeout, network
      // blip). Check the status endpoint immediately before falling back to polling.
      const resolved = await checkForReport();
      if (!resolved) {
        startPolling('stream closed before completion signal');
      }
    }).catch((err: Error) => {
      // Network error mid-stream — migration may still be running server-side.
      // Poll for completion rather than showing a hard failure.
      startPolling(err.message);
    });

    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await fetch('/api/migrate/cancel', { method: 'POST' });
    } catch {
      // If the request fails the migration will still complete normally
      setCancelling(false);
    }
  }

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const isActive = !error && !cancelling && !reconnecting;

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

      {cancelling && !error && (
        <p className="warning-text">Cancelling — finishing current task and generating report…</p>
      )}

      {reconnecting && (
        <p className="warning-text">Connection lost — migration is still running. Checking for completion every {POLL_INTERVAL_MS / 1000}s…</p>
      )}

      {error && (
        <div>
          <p className="error-text error-banner">{error}</p>
          <div className="step-actions">
            <button className="btn btn-ghost" onClick={onBackToFieldMapping}>Back to Field Mapping</button>
            <button className="btn btn-primary" onClick={async () => {
              const found = await checkForReport();
              if (!found) setError((e) => e + ' — No report available.');
            }}>View Report</button>
          </div>
        </div>
      )}

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

      {isActive && (
        <div className="step-actions">
          <button className="btn btn-ghost btn-danger" onClick={handleCancel}>
            Cancel Migration
          </button>
        </div>
      )}
    </div>
  );
}
