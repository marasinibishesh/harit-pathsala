import React, { useEffect, useRef, useState } from 'react';
import { BanaFace } from './Bana.jsx';
import Icon from './Icons.jsx';
import { useLang } from '../i18n.jsx';
import {
  pickChatModel, buildIndex, answerQuestion, makePlan,
  isPlanIntent, isAmbiguous, TOPIC_TO_FOCUS,
} from '../rag.js';

let UID = 0; const uid = () => { UID += 1; return UID; };
const FOCUS_KEYS = ['transport', 'cooking', 'food', 'waste'];

export default function AskBanaPage() {
  const { lang, t } = useLang();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('connecting');
  const [busy, setBusy] = useState(false);
  const model = useRef(null);
  const flow = useRef(null);        // { answers, focusKey }
  const history = useRef([]);       // [{role, content}] rolling memory
  const logRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const m = await pickChatModel();
      if (!alive) return;
      if (!m) { setStatus('offline'); return; }
      model.current = m; setStatus('ready');
      const idx = await buildIndex(lang);
      if (alive && idx.mode === 'keyword') setStatus('keyword');
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (model.current) buildIndex(lang); }, [lang]); // warm the other language's index
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [messages]);

  const push = (msg) => setMessages((m) => [...m, { id: uid(), ...msg }]);
  const patch = (id, fn) => setMessages((m) => m.map((x) => (x.id === id ? fn(x) : x)));

  async function runStream(kind, payload) {
    setBusy(true);
    const steps = kind === 'plan' ? t('ask.stepsPlan') : t('ask.stepsAnswer');
    const id = uid();
    setMessages((m) => [...m, { id, role: 'bana', text: '', streaming: true, steps }]);
    const onToken = (tok) => patch(id, (x) => ({ ...x, text: x.text + tok }));
    const hist = history.current.slice();
    let result;
    try {
      result = kind === 'plan'
        ? await makePlan({ model: model.current, answers: payload.answers, modifier: payload.modifier, history: hist, lang, onToken })
        : await answerQuestion({ model: model.current, query: payload.query, history: hist, lang, onToken });
    } catch (_) { result = null; }
    if (!result || !result.text) {
      patch(id, (x) => ({ ...x, streaming: false, steps: null, error: true, text: t('ask.error') }));
    } else {
      patch(id, (x) => ({ ...x, streaming: false, steps: null, text: result.text, sources: result.sources, refine: kind === 'plan' ? { answers: payload.answers } : null, offerPlan: kind === 'answer' }));
      // remember this exchange
      const userTurn = kind === 'plan'
        ? `${payload.modifier ? payload.modifier + ' — ' : ''}plan for ${payload.answers.area || ''}, ${payload.answers.focus || ''}`
        : payload.query;
      history.current.push({ role: 'user', content: userTurn }, { role: 'assistant', content: result.text });
      if (history.current.length > 12) history.current = history.current.slice(-12);
    }
    setBusy(false);
  }

  function nextQuestion(a, focusKey) {
    if (!a.area) return { key: 'area', ...t('ask.flow.area') };
    if (!a.focus) return { key: 'focus', ...t('ask.flow.focus') };
    if (!a.detail) { const d = t('ask.flow.detail.' + focusKey); return d && d.q ? { key: 'detail', ...d } : null; }
    return null;
  }
  function advanceFlow() {
    const f = flow.current;
    const q = nextQuestion(f.answers, f.focusKey);
    if (q) push({ role: 'mcq', q: q.q, options: q.options, qkey: q.key });
    else { const answers = f.answers; flow.current = null; push({ role: 'bana', text: t('ask.writingPlan'), streaming: false, note: true }); runStream('plan', { answers }); }
  }
  function startFlow(preset, focusKey, intro) {
    flow.current = { answers: preset || {}, focusKey: focusKey || null };
    push({ role: 'bana', text: intro || t('ask.planIntro'), streaming: false });
    advanceFlow();
  }
  function pickOption(msgId, value, qkey, index) {
    if (!flow.current) return;
    patch(msgId, (x) => ({ ...x, chosen: value }));
    push({ role: 'user', text: value });
    flow.current.answers[qkey] = value;
    if (qkey === 'focus') flow.current.focusKey = FOCUS_KEYS[index];
    setTimeout(advanceFlow, 140);
  }

  function route(text) {
    if (isPlanIntent(text)) { startFlow(); return; }
    if (isAmbiguous(text)) {
      const key = (text.toLowerCase().match(/[a-z\u0900-\u097f]+/g) || []).map((w) => TOPIC_TO_FOCUS[w]).find(Boolean);
      if (key) {
        const i = FOCUS_KEYS.indexOf(key);
        const focusLabel = t('ask.flow.focus').options[i];
        startFlow({ focus: focusLabel }, key, t('ask.ambigIntro'));
      } else startFlow(undefined, null, t('ask.ambigIntro'));
      return;
    }
    runStream('answer', { query: text });
  }
  function submit() { const text = input.trim(); if (!text || busy || status === 'offline') return; push({ role: 'user', text }); setInput(''); route(text); }
  function sendNow(text) { push({ role: 'user', text }); route(text); }

  const empty = messages.length === 0;
  return (
    <div className="page fade-in">
      <div className="hero">
        <span className="pill"><Icon name="chat" size={15} /> {t('ask.pill')}</span>
        <h1 style={{ marginTop: 8 }}>{t('ask.title')}</h1>
        <p>{t('ask.intro')}</p>
      </div>

      <div className="card chat-card">
        <div className={'chat-status ' + status}>
          <BanaFace size={30} />
          <div><b>Bana</b><span>{t('ask.' + status)}</span></div>
        </div>

        <div className="chat-log" ref={logRef}>
          {empty ? (<div className="chat-welcome"><BanaFace size={64} /><p>{t('ask.welcome')}</p></div>) : null}
          {messages.map((m) => {
            if (m.role === 'user') return (<div key={m.id} className="bubble-row user"><div className="bubble user">{m.text}</div></div>);
            if (m.role === 'mcq') return (
              <div key={m.id} className="bubble-row bana">
                <BanaFace size={34} />
                <div className="mcq">
                  <div className="bubble bana">{m.q}</div>
                  <div className="mcq-opts">
                    {m.options.map((o, i) => (
                      <button key={o} className={'mcq-opt' + (m.chosen === o ? ' chosen' : '')} disabled={!!m.chosen} onClick={() => pickOption(m.id, o, m.qkey, i)}>{o}</button>
                    ))}
                  </div>
                </div>
              </div>
            );
            return (
              <div key={m.id} className="bubble-row bana">
                <BanaFace size={34} />
                <div style={{ flex: 1 }}>
                  {m.streaming && !m.text && m.steps ? (
                    <div className="agent-steps">
                      {m.steps.map((s, i) => (<div className="agent-step" key={s} style={{ animationDelay: (i * 0.5) + 's' }}><span className="agent-dot"><i /></span>{s}</div>))}
                    </div>
                  ) : (
                    <div className={'bubble bana' + (m.error ? ' error' : '') + (m.note ? ' note' : '')}>
                      {m.text || (m.streaming ? <span className="dots"><i /><i /><i /></span> : '')}
                      {m.streaming && m.text ? <span className="cursor">&nbsp;</span> : null}
                    </div>
                  )}
                  {m.sources && m.sources.length ? (
                    <div className="sources"><Icon name="book" size={14} /> {t('ask.sources')}
                      {m.sources.map((s) => <span key={s.id} className="src-chip">{(s[lang] ? s[lang].title : s.en.title).replace(/^(Q:|प्रश्न:)\s*/, '')}</span>)}
                    </div>
                  ) : null}
                  {m.refine ? (
                    <div className="followups">
                      {t('ask.refine').map((r) => (<button key={r} className="followup" disabled={busy} onClick={() => { push({ role: 'user', text: r }); runStream('plan', { answers: m.refine.answers, modifier: r }); }}>{r}</button>))}
                    </div>
                  ) : null}
                  {m.offerPlan ? (<div className="followups"><button className="followup accent" disabled={busy} onClick={() => startFlow()}>{t('ask.makePlan')}</button></div>) : null}
                </div>
              </div>
            );
          })}
        </div>

        {empty ? (
          <div className="chat-suggest">
            {t('ask.suggestions').map((s) => (<button key={s} className="sugg" disabled={status === 'offline'} onClick={() => sendNow(s)}>{s}</button>))}
          </div>
        ) : null}

        <div className="chat-input">
          <input value={input} placeholder={status === 'offline' ? t('ask.placeholderOff') : t('ask.placeholder')}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} disabled={status === 'offline'} />
          <button className="btn" onClick={submit} disabled={busy || status === 'offline' || !input.trim()}><Icon name="send" size={18} /></button>
        </div>
        {status === 'offline' ? (<div className="muted" style={{ fontWeight: 700, fontSize: '.82rem', marginTop: 10 }}>{t('ask.offlineHint')}</div>) : null}
      </div>
    </div>
  );
}
