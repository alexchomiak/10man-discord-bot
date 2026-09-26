import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Toaster, toast } from 'sonner';

const TIMEOUT_MS = 65000;
const fmt = seconds => {
  if (!Number.isFinite(seconds)) return '—:—';
  const n = Math.max(0, Math.floor(seconds));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

async function api(answer, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(route, { ...options, signal: controller.signal,
      headers: { Authorization: `Bearer ${answer}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error || result.message || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return result;
  } finally { clearTimeout(timer); }
}

function Icon({ name, size = 17 }) {
  const paths = {
    play: <path d="m8 5 11 7-11 7V5Z" />,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    skip: <><path d="m5 5 10 7-10 7V5Z" /><path d="M18 5v14" /></>,
    audio: <><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M17 9a4 4 0 0 1 0 6" /></>,
    move: <><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    edit: <><path d="m4 17-.5 3.5L7 20l11-11-3-3L4 17Z" /><path d="m13 8 3 3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12.4-2" /></>
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function SortableQueueItem({ item, index, canControl, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !canControl });
  return <div ref={setNodeRef} className={`queue-item ${isDragging ? 'dragging' : ''}`}
    style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button type="button" className="drag-handle" title="Drag to reorder" aria-label={`Reorder ${item.title}`}
      disabled={!canControl} {...attributes} {...listeners}>⠿</button>
    <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
    {item.thumbnail && <img className="queue-thumb" src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer"
      onError={event => { event.currentTarget.style.display = 'none'; }} />}
    <div className="queue-copy"><strong>{item.title}</strong><small>{item.isLive ? 'Live' : item.durationSec ? fmt(item.durationSec) : 'Video'}</small></div>
    <button type="button" className="queue-remove" aria-label={`Remove ${item.title} from queue`}
      title="Remove from queue" disabled={!canControl} onClick={() => onRemove(item.id)}>×</button>
  </div>;
}

function WorkerCard({ worker, guildId, guilds, channels, action, onModal, busy }) {
  const status = worker.status;
  const queue = status?.queue || [];
  const realQueue = queue.filter(item => !item.isFiller);
  const current = status?.current;
  const duration = current?.durationSec;
  const position = Number(status?.positionSec) || 0;
  const [source, setSource] = useState('');
  const [channelId, setChannelId] = useState('');
  const [seek, setSeek] = useState(null);
  const [previewIds, setPreviewIds] = useState(null);
  const [seeking, setSeeking] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const displayQueue = useMemo(() => {
    if (!previewIds) return realQueue;
    const byId = new Map(realQueue.map(item => [item.id, item]));
    return [...previewIds.map(id => byId.get(id)).filter(Boolean),
      ...realQueue.filter(item => !previewIds.includes(item.id))];
  }, [realQueue, previewIds]);
  const actualQueueIds = realQueue.map(item => item.id).join(',');
  useEffect(() => {
    if (!previewIds) return;
    if (previewIds.join(',') === actualQueueIds) { setPreviewIds(null); return; }
    const timer = setTimeout(() => setPreviewIds(null), 10000);
    return () => clearTimeout(timer);
  }, [actualQueueIds, previewIds]);
  const preferred = channelId || (status?.guildId === guildId ? status?.channelId : '');
  const selected = channels.some(channel => channel.id === preferred) ? preferred : channels[0]?.id || '';
  const canControl = worker.online && !busy;
  const channelName = channels.find(channel => channel.id === status?.channelId)?.name;
  const destination = () => ({ guildId, channelId: selected });
  const send = (operation, payload = {}) => action(worker.id, operation, payload);
  const play = async event => {
    event.preventDefault();
    if (!source.trim()) return;
    const where = status?.guildId && status?.channelId
      ? { guildId: status.guildId, channelId: status.channelId }
      : destination();
    if (await send('play', { ...where, source: source.trim() })) setSource('');
  };
  const reorder = async ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const ids = displayQueue.map(item => item.id);
    const from = ids.indexOf(active.id), to = ids.indexOf(over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setPreviewIds(next);
    if (!await send('reorder', { ids: next })) setPreviewIds(null);
  };
  const commitSeek = async value => {
    if (seeking || !canControl) return;
    const target = Number(value);
    if (!Number.isFinite(target)) return;
    const deltaSec = Math.round(target - position);
    if (!deltaSec) { setSeek(null); return; }
    setSeek(target);
    setSeeking(true);
    try { await send('scrub', { deltaSec }); }
    finally { setSeeking(false); setSeek(null); }
  };
  return <article className={`worker-card ${worker.online ? '' : 'offline'}`}>
    <header className="worker-header">
      <div className="avatar-wrap">
        {worker.profile?.avatarUrl ? <img className="avatar" src={worker.profile.avatarUrl} alt="" /> : <div className="avatar avatar-fallback">{worker.id.slice(0, 1).toUpperCase()}</div>}
        <span className={`presence ${worker.online ? 'on' : ''}`} />
      </div>
      <div className="worker-title">
        <div className="eyebrow">STREAM WORKER · {worker.id}</div>
        <h2>{worker.profile?.displayName || worker.id}</h2>
        <div className="worker-subtitle">{worker.online ? status?.channelId ? <><Icon name="audio" size={13} /> {channelName || `Voice ${status.channelId}`}</> : 'Standing by' : 'Offline'}</div>
      </div>
      <div className="worker-header-actions">
        <button className="icon-button" title="Change display name" aria-label="Change display name" onClick={() => onModal({ kind: 'name', worker })} disabled={!worker.online}><Icon name="edit" /></button>
        <div className="stats-wrap">
          <button className="icon-button" title="Stream stats" aria-label="Stream stats" onClick={event => event.currentTarget.parentElement.classList.toggle('open')}><Icon name="info" /></button>
          <div className="stats-popover">
            <div className="eyebrow">SIGNAL DETAILS</div>
            <dl>
              <dt>Target bitrate</dt><dd>{status?.stats?.targetBitrateKbps ? `${status.stats.targetBitrateKbps} kbps` : '—'}</dd>
              <dt>Measured send</dt><dd>{Number.isFinite(status?.stats?.rtcBitrateKbps) ? `${status.stats.rtcBitrateKbps} kbps` : '—'}</dd>
              <dt>Video</dt><dd>{status?.stats ? `${status.stats.videoCodec} · ${status.stats.videoEncoder}` : '—'}</dd>
              <dt>Output</dt><dd>{status?.stats ? `${status.stats.width} × ${status.stats.height} · ${status.stats.fps} fps` : '—'}</dd>
              <dt>RTC sent</dt><dd>{status?.stats ? `${(status.stats.rtcBytesSent / 1048576).toFixed(1)} MiB` : '—'}</dd>
              <dt>Worker ID</dt><dd>{worker.id}</dd>
              <dt>User ID</dt><dd>{worker.userId || '—'}</dd>
            </dl>
          </div>
        </div>
      </div>
    </header>

    <div className="now-playing">
      <div className="section-topline"><span className="live-dot" /> NOW PLAYING <span className="stage-state">{status?.paused ? 'PAUSED' : status?.isFiller ? 'FILLER' : status?.isLive ? 'LIVE' : current ? 'PLAYING' : 'IDLE'}</span></div>
      {current?.thumbnail && <img className="playing-thumb" src={current.thumbnail} alt="" referrerPolicy="no-referrer"
        onError={event => { event.currentTarget.style.display = 'none'; }} />}
      <div className="playing-title">{current?.title || 'Nothing on air'}</div>
      <div className="playing-meta">{current ? current.isFiller ? 'Ready for the next video' : current.isLive ? 'Live source' : 'Video on demand' : 'Join a voice channel to get started'}</div>
      <div className="progress-row"><span>{fmt(seek ?? position)}</span><span>{duration ? fmt(duration) : status?.isLive ? 'LIVE' : '—:—'}</span></div>
      {duration && !current?.isFiller ? <input className="seek-slider" aria-label="Seek playback position" type="range"
        min="0" max={duration} value={seek ?? position} onChange={event => setSeek(Number(event.target.value))}
        onPointerUp={event => void commitSeek(event.currentTarget.value)}
        onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void commitSeek(event.currentTarget.value); }}
        disabled={!canControl || seeking}
        style={{ '--seek-percent': `${Math.min(100, (seek ?? position) / duration * 100)}%` }} />
        : <div className="visual-progress"><span style={{ width: '0%' }} /></div>}
    </div>

    <div className="transport">
      <button className="transport-main" disabled={!canControl || !current} title={status?.paused ? 'Resume' : 'Pause'} onClick={() => send(status?.paused ? 'resume' : 'pause')}><Icon name={status?.paused ? 'play' : 'pause'} size={20} /></button>
      <button className="transport-button" disabled={!canControl || !current || status?.isLive} onClick={() => send('scrub', { deltaSec: -30 })}>−30s</button>
      <button className="transport-button" disabled={!canControl || !current || status?.isLive} onClick={() => send('scrub', { deltaSec: 30 })}>+30s</button>
      <span className="transport-spacer" />
      <button className="transport-button" disabled={!canControl || !current} title="Skip" onClick={() => send('skip')}><Icon name="skip" /></button>
      <button className="transport-button danger" disabled={!canControl || !status} title="Stop and leave" onClick={() => send('stop')}><Icon name="stop" /></button>
    </div>

    <div className="card-divider" />
    <div className="queue-title"><span>UP NEXT</span><span className="queue-count">{realQueue.length}</span></div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => void reorder(event)}>
      <SortableContext items={displayQueue.map(item => item.id)} strategy={verticalListSortingStrategy}>
        <div className="queue-list">
          {displayQueue.length ? displayQueue.map((item, index) =>
            <SortableQueueItem key={item.id} item={item} index={index} canControl={canControl}
              onRemove={queueId => void send('remove-queued', { queueId })} />)
            : <div className="queue-empty">No videos in the queue yet.</div>}
        </div>
      </SortableContext>
    </DndContext>

    <form className="add-form" onSubmit={play}>
      <label htmlFor={`source-${worker.id}`}>ADD TO QUEUE</label>
      <div className="input-row"><input id={`source-${worker.id}`} value={source} onChange={event => setSource(event.target.value)} placeholder="Paste a video URL or ShareTV slug" disabled={!canControl} /><button className="add-button" disabled={!canControl || !source.trim()} title="Play or queue"><Icon name="plus" /></button></div>
    </form>
    <div className="channel-controls">
      <select aria-label={`Destination voice channel for ${worker.id}`} value={selected} onChange={event => setChannelId(event.target.value)} disabled={!canControl || !guildId}>
        {!channels.length && <option value="">Choose a server first</option>}
        {channels.map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}
      </select>
      <button className="secondary-button" disabled={!canControl || !selected || !guildId} onClick={() => send(status ? 'move' : 'join', destination())}><Icon name="move" size={15} /> {status ? 'Switch' : 'Join'}</button>
      <button className="text-button manual" onClick={() => onModal({ kind: 'channel', worker, guildId, guilds })} disabled={!canControl}>Use IDs</button>
    </div>
  </article>;
}

function Modal({ modal, close, action, guildId }) {
  const [name, setName] = useState(modal.worker.profile?.displayName || '');
  const [manualGuild, setManualGuild] = useState(modal.worker.status?.guildId || guildId || '');
  const [manualChannel, setManualChannel] = useState(modal.worker.status?.channelId || '');
  const submit = async event => {
    event.preventDefault();
    const operation = modal.kind === 'name' ? 'set-name' : modal.worker.status ? 'move' : 'join';
    const payload = modal.kind === 'name' ? { name, guildId: manualGuild } : { guildId: manualGuild, channelId: manualChannel };
    if (await action(modal.worker.id, operation, payload)) close();
  };
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal" role="dialog" aria-modal="true" aria-label={modal.kind === 'name' ? 'Change display name' : 'Join or switch channel'} onMouseDown={event => event.stopPropagation()}>
    <div className="eyebrow">{modal.worker.id.toUpperCase()} · {modal.kind === 'name' ? 'IDENTITY' : 'VOICE ROUTING'}</div>
    <h2>{modal.kind === 'name' ? 'Change display name' : 'Use Discord IDs'}</h2>
    <p>{modal.kind === 'name' ? 'We’ll try the account’s global display name first. If Discord refuses it, the CS bot will set a nickname in the selected server.' : 'Use this for a server or channel that is not listed in the dropdown.'}</p>
    <form onSubmit={submit}>
      {modal.kind === 'name' && <label>New name<input value={name} maxLength="32" onChange={event => setName(event.target.value)} autoFocus required /></label>}
      <label>Server ID<input value={manualGuild} onChange={event => setManualGuild(event.target.value)} inputMode="numeric" placeholder="17–20 digit guild ID" required /></label>
      {modal.kind === 'channel' && <label>Voice channel ID<input value={manualChannel} onChange={event => setManualChannel(event.target.value)} inputMode="numeric" placeholder="17–20 digit channel ID" required /></label>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="primary-button">{modal.kind === 'name' ? 'Save name' : modal.worker.status ? 'Switch channel' : 'Join channel'}</button></div>
    </form>
  </div></div>;
}

export default function App() {
  const [answer, setAnswer] = useState(() => sessionStorage.getItem('stream-dashboard-answer') || '');
  const [question, setQuestion] = useState('Dashboard password');
  const [login, setLogin] = useState('');
  const [state, setState] = useState(null);
  const [guildId, setGuildId] = useState('');
  const [channels, setChannels] = useState([]);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState({});
  const [error, setError] = useState('');
  useEffect(() => { if (error) toast.error(error); }, [error]);
  useEffect(() => {
    fetch('/api/auth-question').then(response => response.json())
      .then(result => setQuestion(result.question || 'Dashboard password'))
      .catch(() => {});
  }, []);
  const refresh = useCallback(async () => {
    if (!answer) return;
    try {
      const next = await api(answer, `/api/state${guildId ? `?guildId=${encodeURIComponent(guildId)}` : ''}`);
      setState(next);
      setError('');
      if (!guildId && next.guilds.length) setGuildId(next.guilds[0].id);
    } catch (failure) {
      if (failure.status === 401) { sessionStorage.removeItem('stream-dashboard-answer'); setAnswer(''); setState(null); }
      setError(failure.message);
    }
  }, [answer, guildId]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!answer || !guildId) { setChannels([]); return; }
    let live = true;
    api(answer, `/api/guilds/${guildId}/channels`).then(result => { if (live) setChannels(result.channels); })
      .catch(() => { if (live) setChannels([]); });
    return () => { live = false; };
  }, [answer, guildId]);
  const workers = useMemo(() => state?.workers || [], [state]);
  const action = async (workerId, operation, payload = {}) => {
    setBusy(previous => ({ ...previous, [workerId]: true }));
    try {
      const result = await api(answer, `/api/workers/${encodeURIComponent(workerId)}/actions`,
        { method: 'POST', body: JSON.stringify({ operation, ...payload }) });
      toast.success(operation === 'play' ? 'Playback request accepted.' : result.message || 'Done.');
      setError('');
      await refresh();
      return result;
    } catch (failure) { toast.error(failure.message); return null; }
    finally { setBusy(previous => ({ ...previous, [workerId]: false })); }
  };
  if (!answer) return <div className="login-page"><Toaster position="top-right" theme="dark" richColors closeButton />
    <div className="login-glow" /><div className="login-card">
    <div className="brand-mark">▶</div><div className="eyebrow">10MAN CONTROL ROOM</div>
    <h1>Stream Deck</h1><p>Your Discord streams, all in one place.</p>
    <form onSubmit={event => { event.preventDefault(); sessionStorage.setItem('stream-dashboard-answer', login); setAnswer(login); }}>
      <label htmlFor="dashboard-answer">{question}</label><input id="dashboard-answer" type="password" value={login} onChange={event => setLogin(event.target.value)} autoComplete="off" placeholder="Your answer" required />
      <button className="primary-button" type="submit">Open control room <span>→</span></button>
    </form>
  </div></div>;
  return <div className="app-shell"><Toaster position="top-right" theme="dark" richColors closeButton />
    <aside className="sidebar"><div className="sidebar-brand"><div className="brand-mark">▶</div><span>10MAN<span className="brand-light">/STREAM</span></span></div>
      <div className="sidebar-label">WORKSPACE</div><div className="sidebar-item active">◫ <span>Control room</span></div>
      <div className="sidebar-section"><div className="sidebar-label">FLEET</div>{workers.map(worker => <a key={worker.id} href={`#worker-${worker.id}`} className="sidebar-worker"><span className={`sidebar-status ${worker.online ? 'on' : ''}`} />{worker.profile?.displayName || worker.id}</a>)}</div>
      <div className="sidebar-footer"><span className="sidebar-status on" /> Broker connected <button onClick={() => { sessionStorage.removeItem('stream-dashboard-answer'); setAnswer(''); }} title="Sign out">↪</button></div>
    </aside>
    <main className="main-content"><div className="topbar"><div className="eyebrow">DASHBOARD / CONTROL ROOM</div><button className="icon-button" title="Refresh" onClick={() => void refresh()}><Icon name="refresh" /></button></div>
      <section className="page-heading"><div><div className="eyebrow highlight">LIVE OPERATIONS</div><h1>Stream Deck<span className="heading-period">.</span></h1><p>Manage your Discord stream workers and playback queues.</p></div>
        <div className="guild-picker"><label htmlFor="guild-select">SERVER</label><select id="guild-select" value={guildId} onChange={event => setGuildId(event.target.value)}><option value="">Select a server</option>{state?.guilds?.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></div>
      </section>
      <div className="overview"><div><span className="overview-number">{workers.length}</span><span className="overview-label">WORKERS</span></div><div><span className="overview-number">{workers.filter(worker => worker.online).length}</span><span className="overview-label">ONLINE</span></div><div><span className="overview-number">{workers.filter(worker => worker.status?.current && !worker.status.current.isFiller).length}</span><span className="overview-label">ON AIR</span></div><div className="overview-note"><span className="pulse" /> Auto-refreshing every 5 seconds</div></div>
      <div className="cards-grid">{workers.map(worker => <div id={`worker-${worker.id}`} key={worker.id}><WorkerCard worker={worker} guildId={guildId} guilds={state.guilds} channels={channels} action={action} onModal={setModal} busy={busy[worker.id]} /></div>)}</div>
      {!workers.length && <div className="empty-fleet">No stream workers configured or connected.</div>}
      <footer>10MAN STREAM DECK <span>·</span> Persistent Go Live control</footer>
    </main>
    {modal && <Modal key={`${modal.kind}-${modal.worker.id}`} modal={modal} close={() => setModal(null)} action={action} guildId={guildId} />}
  </div>;
}
