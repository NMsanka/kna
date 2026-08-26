import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { api, type Repo } from '../api';

export function Repositories(props: { onError: (error: unknown) => void }): JSX.Element {
  const { onError } = props;
  const [repos, setRepos] = useState<Repo[]>([]);
  const [remote, setRemote] = useState('');
  const [slugs, setSlugs] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown once and never stored. Kept in state only so it survives a re-render, and dropped
  // the moment the page changes.
  const [secret, setSecret] = useState<{ what: string; value: string } | null>(null);

  const load = useCallback(() => {
    api
      .repos()
      .then((r) => setRepos(r.repos))
      .catch(onError);
  }, [onError]);

  useEffect(load, [load]);

  const guard = (promise: Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    promise
      .catch((e: unknown) => {
        onError(e);
        setError(e instanceof Error ? e.message : 'That did not work.');
      })
      .finally(() => setBusy(false));
  };

  const register = (event: FormEvent): void => {
    event.preventDefault();
    guard(
      api
        .addRepo({
          remote: remote.trim(),
          projectSlugs: slugs
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        })
        .then((result) => {
          setRemote('');
          setSlugs('');
          setFlash(
            result.unknownProjectSlugs.length
              ? `Registered. Unknown project slug(s): ${result.unknownProjectSlugs.join(', ')} — it will index but answer nothing to project-scoped questions.`
              : 'Registered, and you have read access.',
          );
          load();
        }),
    );
  };

  return (
    <div className="shell">
      <div className="banner">
        Sessions here are an API token exchanged for a cookie, not single sign-on. Anyone reaching
        this console with an administrator token can act as one — put it behind your network, and
        replace this with SSO before it is generally available.
      </div>

      {flash && (
        <div className="card">
          <p className="muted">{flash}</p>
        </div>
      )}
      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      )}

      {secret && (
        <section className="card">
          <h2>{secret.what}</h2>
          <p className="error">Shown once. It is not stored anywhere it can be read back.</p>
          <pre className="secret">{secret.value}</pre>
          <button className="quiet" type="button" onClick={() => setSecret(null)}>
            Done
          </button>
        </section>
      )}

      <section className="card">
        <h2>Repositories</h2>
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th className="n">Modules</th>
              <th className="n">Symbols</th>
              <th className="n">Documents</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id}>
                <td>
                  <strong>{repo.name}</strong>
                  <br />
                  <span className="mono small muted">{repo.id}</span>
                </td>
                <td className="n">{repo.modules}</td>
                <td className="n">{repo.symbols}</td>
                <td className="n">{repo.documents}</td>
                <td className="actions">
                  <button
                    className="quiet"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      guard(
                        api.credential(repo.id, 'issued from the console').then((r) =>
                          setSecret({
                            what: `Publish credential for ${repo.name}`,
                            value: r.token,
                          }),
                        ),
                      )
                    }
                  >
                    Publish credential
                  </button>
                  <button
                    className="quiet"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      guard(
                        api
                          .reindex(repo.id, 'requested from the console')
                          .then((r) => setFlash(`Queued ${r.queued} job(s) for ${repo.name}.`)),
                      )
                    }
                  >
                    Reindex
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="card" onSubmit={register}>
        <h2>Register a repository</h2>
        <p className="muted small">
          Grants you read access and checks the project slug exists. A slug that matches nothing is
          not an error — the repository still indexes — but it will answer nothing to project-scoped
          questions, so it is reported.
        </p>
        <label htmlFor="remote">Git remote</label>
        <input
          id="remote"
          type="text"
          value={remote}
          onChange={(e) => setRemote(e.target.value)}
          placeholder="github.com/you/service"
          required
        />
        <label htmlFor="slugs">Projects, comma separated</label>
        <input
          id="slugs"
          type="text"
          value={slugs}
          onChange={(e) => setSlugs(e.target.value)}
          placeholder="platform"
        />
        <p style={{ marginTop: '1.25rem' }}>
          <button type="submit" disabled={busy || remote.trim().length === 0}>
            Register
          </button>
        </p>
      </form>
    </div>
  );
}
