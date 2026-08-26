import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { api, type Answer, type Citation, type ScopeGroup } from '../api';
import { citedIn, groupByRepository, sourcesHeading } from '../citations';

/**
 * The conversation.
 *
 * This is the screen that earns a client-side application. The server-rendered version posted a
 * form and re-rendered the page for every question, which meant the conversation had to travel
 * in a hidden field, the scroll position was lost on each turn, and there was nowhere to say
 * "thinking" while a model call ran for several seconds. All three are state that belongs in the
 * page rather than in a round trip.
 */

interface Turn {
  question: string;
  answer: Answer | null;
  error: string | null;
}

export function Chat(props: {
  everywhere: boolean;
  go: (path: string) => void;
  onError: (error: unknown) => void;
}): JSX.Element {
  const { everywhere, go, onError } = props;

  const [groups, setGroups] = useState<ScopeGroup[]>([]);
  const [scope, setScope] = useState('org');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .scope()
      .then((result) => {
        setGroups(result.groups);
        const first = result.groups.flatMap((g) => g.options).find((o) => !o.disabled);
        if (first) setScope(first.value);
      })
      .catch(onError);
  }, [onError]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, asking]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || asking) return;

    setQuestion('');
    setAsking(true);

    // Only what was actually answered goes into the history. A turn that errored is not
    // something the model should be asked to treat as its own previous reply.
    const history = turns
      .filter((t) => t.answer !== null)
      .flatMap((t) => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.answer!.text },
      ])
      .slice(-16);

    api
      .ask({ question: asked, scope, history, everywhere })
      .then((result) =>
        setTurns((prior) => [...prior, { question: asked, answer: result.answer, error: null }]),
      )
      .catch((e: unknown) => {
        onError(e);
        setTurns((prior) => [
          ...prior,
          {
            question: asked,
            answer: null,
            error: e instanceof Error ? e.message : 'Something went wrong.',
          },
        ]);
      })
      .finally(() => setAsking(false));
  };

  return (
    <>
      <div className="shell chat-shell">
        <Tabs everywhere={everywhere} go={go} />

        <div className="banner">
          {everywhere
            ? 'Asking across every repository you can read. Answers are grouped by which repository each piece of evidence came from — an answer that spans services is only worth anything if you can see which services it came from.'
            : 'Answers come from the code you are allowed to read, and cite the lines they came from. Check anything you are about to act on — a citation is there so you can.'}
        </div>

        {turns.length === 0 && !asking ? (
          <div className="empty">
            {everywhere ? (
              <>
                <p>Ask something that crosses a service boundary.</p>
                <p className="small">“Who calls the billing API, and from which repositories?”</p>
              </>
            ) : (
              <>
                <p>
                  Ask about how something works, where it is implemented, or why it was built that
                  way.
                </p>
                <p className="small">“How does billing retry a failed charge?”</p>
              </>
            )}
          </div>
        ) : (
          turns.map((turn, i) => <TurnView key={i} turn={turn} index={i} everywhere={everywhere} />)
        )}

        {asking && (
          <div className="turn">
            <div className="said">{'…'}</div>
            <div className="replied muted thinking">Reading the code</div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form className="ask" onSubmit={submit}>
        <div className="inner">
          <div className="grow">
            <div className="scoped">
              {everywhere ? (
                <span>Every repository you can read</span>
              ) : (
                <>
                  <label htmlFor="scope">Ask about</label>
                  <select id="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                    {groups.map((group, gi) =>
                      group.label === null ? (
                        group.options.map((o) => (
                          <option key={o.value} value={o.value} disabled={o.disabled}>
                            {o.label}
                          </option>
                        ))
                      ) : (
                        <optgroup key={gi} label={group.label}>
                          {group.options.map((o) => (
                            <option key={o.value} value={o.value} disabled={o.disabled}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      ),
                    )}
                  </select>
                </>
              )}
            </div>
            <textarea
              rows={2}
              value={question}
              placeholder={everywhere ? 'What crosses …?' : 'How does …?'}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a new line — what every chat does, and the
                // thing a form post could never offer.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(e);
                }
              }}
              autoFocus
            />
          </div>
          <button type="submit" disabled={asking || question.trim().length === 0}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
    </>
  );
}

function Tabs(props: { everywhere: boolean; go: (path: string) => void }): JSX.Element {
  const tab = (path: string, label: string, on: boolean): JSX.Element => (
    <a
      href={path}
      className={on ? 'on' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        props.go(path);
      }}
    >
      {label}
    </a>
  );
  return (
    <div className="tabs">
      {tab('/chat', 'One project', !props.everywhere)}
      {tab('/chat/all', 'Across every repository', props.everywhere)}
    </div>
  );
}

function TurnView(props: { turn: Turn; index: number; everywhere: boolean }): JSX.Element {
  const { turn, index, everywhere } = props;

  // Only the evidence the answer actually cites. The response carries everything that was put
  // in front of the model; numbering all of it claims eight citations for an answer that made
  // one, which is the opposite of what citations are for.
  const cited = useMemo(
    () => (turn.answer ? citedIn(turn.answer.text, turn.answer.citations) : []),
    [turn.answer],
  );
  const grouped = useMemo(() => groupByRepository(cited), [cited]);

  return (
    <div className="turn">
      <div className="said">{turn.question}</div>
      <div className={`replied${turn.answer?.abstained || turn.error ? ' abstained' : ''}`}>
        {turn.error ? (
          <p className="error">{turn.error}</p>
        ) : (
          <AnswerText text={turn.answer!.text} index={index} />
        )}

        {cited.length > 0 && (
          <div className="sources">
            <div className="heading">{sourcesHeading(cited, grouped, everywhere)}</div>
            {everywhere ? (
              grouped.map(([repo, items]) => (
                <div className="repo-group" key={repo}>
                  <div className="repo-name">{repo}</div>
                  <ol>
                    {items.map((c) => (
                      <SourceItem key={c.marker} citation={c} index={index} />
                    ))}
                  </ol>
                </div>
              ))
            ) : (
              <ol>
                {cited.map((c) => (
                  <SourceItem key={c.marker} citation={c} index={index} />
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceItem(props: { citation: Citation; index: number }): JSX.Element {
  const { citation: c, index } = props;
  return (
    <li id={`s${index}-${c.marker}`}>
      {c.qualifiedName ?? 'evidence'}{' '}
      <span className="where">
        {c.path ?? 'unknown'}
        {c.startLine === null ? '' : `:${c.startLine}`}
      </span>{' '}
      {c.analysisDepth === 'shallow' && <span className="depth">shallow</span>}
    </li>
  );
}

/**
 * Renders the answer with its `[1]` markers as links to the matching source.
 *
 * Built from an array of nodes rather than by setting HTML. The answer is model output over a
 * corpus of attacker-controllable text, and there is no version of this where interpolating it
 * into `dangerouslySetInnerHTML` is the right call.
 */
function AnswerText(props: { text: string; index: number }): JSX.Element {
  const paragraphs = props.text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((paragraph, p) => (
        <p key={p}>
          {paragraph.split(/(\[\d+\])/).map((piece, i) => {
            const marker = /^\[(\d+)\]$/.exec(piece);
            if (!marker) return <span key={i}>{piece}</span>;
            return (
              <a key={i} className="cite" href={`#s${props.index}-${marker[1]}`}>
                {marker[1]}
              </a>
            );
          })}
        </p>
      ))}
    </>
  );
}
