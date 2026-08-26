import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { api, type Person, type Repo } from '../api';

export function People(props: { onError: (error: unknown) => void }): JSX.Element {
  const { onError } = props;
  const [people, setPeople] = useState<Person[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [subject, setSubject] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [clearance, setClearance] = useState('internal');
  const [admin, setAdmin] = useState(false);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ subject: string; token: string; granted: number } | null>(
    null,
  );

  const load = useCallback(() => {
    api
      .people()
      .then((r) => setPeople(r.people))
      .catch(onError);
    api
      .repos()
      .then((r) => setRepos(r.repos))
      .catch(onError);
  }, [onError]);

  useEffect(load, [load]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api
      .addPerson({
        subject: subject.trim(),
        displayName: displayName.trim() || null,
        clearance,
        admin,
        repoIds,
        reason: reason.trim(),
      })
      .then((result) => {
        setIssued({
          subject: result.subject,
          token: result.token,
          granted: result.grantedRepoIds.length,
        });
        setSubject('');
        setDisplayName('');
        setRepoIds([]);
        setReason('');
        setAdmin(false);
        load();
      })
      .catch((e: unknown) => {
        onError(e);
        setError(e instanceof Error ? e.message : 'Could not create that person.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="shell">
      <div className="banner">
        Sessions here are an API token exchanged for a cookie, not single sign-on. Anyone reaching
        this console with an administrator token can act as one — put it behind your network, and
        replace this with SSO before it is generally available.
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      )}

      {issued && (
        <section className="card">
          <h2>Token for {issued.subject}</h2>
          <p className="error">Shown once. It is stored only as a hash and cannot be recovered.</p>
          <pre className="secret">{issued.token}</pre>
          <p className="muted small">Granted read access to {issued.granted} repository(ies).</p>
          <p className="muted small">
            Send it with somewhere to use it. <strong>/chat</strong> needs nothing installed — they
            paste this token and ask a question. The same token also works for{' '}
            <span className="mono">kna ask</span> and for the MCP server in an editor.
          </p>
          <button className="quiet" type="button" onClick={() => setIssued(null)}>
            Done
          </button>
        </section>
      )}

      <section className="card">
        <h2>People</h2>
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>Clearance</th>
              <th>Roles</th>
              <th className="n">Repositories</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id}>
                <td>
                  <strong>{person.subject}</strong>
                  {person.displayName && (
                    <>
                      <br />
                      <span className="small muted">{person.displayName}</span>
                    </>
                  )}
                </td>
                <td>{person.clearance}</td>
                <td>{person.roles.join(', ') || '—'}</td>
                <td className="n">{person.repositories}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="card" onSubmit={submit}>
        <h2>Add someone</h2>
        <p className="muted small">
          Creates the person and issues one token, shown once. Use their single sign-on subject so
          that the same identity is found rather than duplicated when SSO login is built.
        </p>

        <label htmlFor="subject">Subject</label>
        <input
          id="subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="alex@example.com"
          required
        />

        <label htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        <label htmlFor="clearance">Clearance</label>
        <select id="clearance" value={clearance} onChange={(e) => setClearance(e.target.value)}>
          <option value="public">public</option>
          <option value="internal">internal</option>
          <option value="confidential">confidential</option>
          <option value="restricted">restricted</option>
        </select>

        <label>Repositories they may read</label>
        <div className="checks">
          {repos.map((repo) => (
            <label key={repo.id}>
              <input
                type="checkbox"
                checked={repoIds.includes(repo.id)}
                onChange={(e) =>
                  setRepoIds((prior) =>
                    e.target.checked ? [...prior, repo.id] : prior.filter((id) => id !== repo.id),
                  )
                }
              />
              {repo.name}
            </label>
          ))}
        </div>

        <label>
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />{' '}
          Administrator
        </label>

        <label htmlFor="reason">Reason</label>
        <input
          id="reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="joining the team"
          required
        />

        <p style={{ marginTop: '1.25rem' }}>
          <button
            type="submit"
            disabled={busy || subject.trim().length === 0 || reason.trim().length === 0}
          >
            Create and issue a token
          </button>
        </p>
      </form>
    </div>
  );
}
