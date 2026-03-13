import { useEffect, useState } from 'react';
import type { AppState } from '../../App.tsx';
import type { NormalisedUser, UserMappingEntry } from '../../types/index.ts';

interface AsanaUser { gid: string; name: string; email: string; }

interface Props {
  state: AppState;
  onSave: (mapping: UserMappingEntry[]) => void;
  onBack: () => void;
}

function localPart(email: string) {
  return email.split('@')[0].toLowerCase();
}

export default function UserMapping({ state, onSave, onBack }: Props) {
  const [sourceUsers, setSourceUsers] = useState<NormalisedUser[]>([]);
  const [destUsers, setDestUsers]     = useState<AsanaUser[]>([]);
  const [mapping, setMapping]         = useState<UserMappingEntry[]>(state.userMapping);
  const [sameDomain, setSameDomain]   = useState(false);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/source/users').then((r) => r.json() as Promise<NormalisedUser[]>),
      fetch('/api/destination/users').then((r) => r.json() as Promise<AsanaUser[]>),
    ])
      .then(([src, dest]) => {
        setSourceUsers(src);
        setDestUsers(dest);
        setMapping(autoMap(src, dest, false));
        setLoading(false);
      })
      .catch(() => { setError('Failed to load users'); setLoading(false); });
  }, []);

  // Re-run auto-map when same-domain toggle changes
  useEffect(() => {
    if (!sourceUsers.length || !destUsers.length) return;
    setMapping(autoMap(sourceUsers, destUsers, sameDomain));
  }, [sameDomain]); // eslint-disable-line react-hooks/exhaustive-deps

  function autoMap(src: NormalisedUser[], dest: AsanaUser[], samedom: boolean): UserMappingEntry[] {
    return src.map((u) => {
      let match: AsanaUser | undefined;

      if (samedom) {
        // Same domain: match on the local part of the email only
        match = dest.find((d) => localPart(d.email) === localPart(u.email));
      } else {
        // Different domains: require exact full email, fall back to name
        match = dest.find((d) => d.email.toLowerCase() === u.email.toLowerCase())
          ?? dest.find((d) => d.name.toLowerCase() === u.name.toLowerCase());
      }

      return {
        sourceId:    u.id,
        sourceName:  u.name,
        sourceEmail: u.email,
        destId:      match?.gid  ?? null,
        destName:    match?.name ?? null,
      };
    });
  }

  function updateMapping(sourceId: string, destGid: string) {
    const dest = destUsers.find((d) => d.gid === destGid) ?? null;
    setMapping((prev) =>
      prev.map((m) =>
        m.sourceId === sourceId
          ? { ...m, destId: dest?.gid ?? null, destName: dest?.name ?? null }
          : m,
      ),
    );
  }

  const unmappedCount = mapping.filter((m) => !m.destId).length;

  async function handleSave() {
    await fetch('/api/session/user-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping }),
    });
    onSave(mapping);
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">User Mapping</h2>
      <p className="step-desc">
        Map source platform users to Asana users. Users are auto-matched by email.
        {unmappedCount > 0 && (
          <> <strong className="warning-text">{unmappedCount} user{unmappedCount !== 1 ? 's' : ''} unmapped</strong> — tasks assigned to them will have no assignee in Asana.</>
        )}
      </p>

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={sameDomain}
          onChange={(e) => setSameDomain(e.target.checked)}
        />
        Users are on the same domain — match by email username only (ignore domain suffix)
      </label>

      {loading && <p className="loading-text">Loading users…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && (
        <div className="mapping-table-wrapper">
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Source User</th>
                <th>Source Email</th>
                <th>Asana User</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((entry) => (
                <tr key={entry.sourceId} className={!entry.destId ? 'row-warning' : ''}>
                  <td>{entry.sourceName}</td>
                  <td className="email-cell">{entry.sourceEmail}</td>
                  <td>
                    <select
                      value={entry.destId ?? ''}
                      onChange={(e) => updateMapping(entry.sourceId, e.target.value)}
                    >
                      <option value="">— Unmapped (no assignee) —</option>
                      {destUsers.map((d) => (
                        <option key={d.gid} value={d.gid}>{d.name} ({d.email})</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={loading || !!error}>
          Save &amp; Continue
        </button>
      </div>
    </div>
  );
}
