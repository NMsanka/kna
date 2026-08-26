import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, ApiError, type Me } from './api';
import { SignIn } from './pages/SignIn';
import { Chat } from './pages/Chat';
import { Repositories } from './pages/Repositories';
import { People } from './pages/People';

/**
 * Routing, without a router.
 *
 * Five routes, all of them flat, none of them with parameters. A routing library would be a
 * dependency, a bundle and an API to learn for a `switch` — and this repository has spent the
 * whole of its history arguing that a dependency has to earn its place.
 *
 * `history.pushState` plus a `popstate` listener is the whole mechanism, which means the back
 * button works and every page is linkable.
 */

type Route = { name: 'chat'; everywhere: boolean } | { name: 'repositories' } | { name: 'people' };

function parse(path: string): Route {
  if (path.startsWith('/admin/people')) return { name: 'people' };
  if (path.startsWith('/admin')) return { name: 'repositories' };
  return { name: 'chat', everywhere: path.startsWith('/chat/all') };
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));
  const [me, setMe] = useState<Me | null>(null);
  // Distinguished from "signed out": until the first `me` call returns we do not know which,
  // and rendering the sign-in form in the meantime makes a signed-in reload flash a login page.
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const onPop = (): void => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  const go = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(parse(path));
  }, []);

  const signOut = useCallback(() => {
    void api.signOut().finally(() => {
      setMe(null);
      go('/chat');
    });
  }, [go]);

  // A session can expire while the page is open. Any call that comes back 401 drops us to the
  // sign-in form rather than leaving a screen that quietly fails every action.
  const onError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) setMe(null);
  }, []);

  if (!checked) return <div className="shell" />;
  if (!me) return <SignIn onSignedIn={setMe} />;

  return (
    <>
      <Chrome me={me} route={route} go={go} onSignOut={signOut} />
      {route.name === 'chat' && (
        <Chat
          key={route.everywhere ? 'all' : 'one'}
          everywhere={route.everywhere}
          go={go}
          onError={onError}
        />
      )}
      {route.name === 'repositories' && <Repositories onError={onError} />}
      {route.name === 'people' && <People onError={onError} />}
    </>
  );
}

function Chrome(props: {
  me: Me;
  route: Route;
  go: (path: string) => void;
  onSignOut: () => void;
}): JSX.Element {
  const { me, route, go, onSignOut } = props;

  const link = (path: string, label: string, active: boolean): JSX.Element => (
    <a
      href={path}
      className={active ? 'on' : undefined}
      onClick={(event) => {
        // Plain left clicks are routed in the page; anything with a modifier is left to the
        // browser, so "open in a new tab" keeps working.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        go(path);
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="shell" style={{ paddingBottom: 0 }}>
      <header className="bar">
        <span className="brand">KNA</span>
        <nav>
          {link('/chat', 'Chat', route.name === 'chat')}
          {me.isAdmin && link('/admin', 'Repositories', route.name === 'repositories')}
          {me.isAdmin && link('/admin/people', 'People', route.name === 'people')}
        </nav>
        <span className="muted small">{me.subject}</span>
        <button className="link" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
    </div>
  );
}
