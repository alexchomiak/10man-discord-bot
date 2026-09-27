import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Toaster, toast } from 'sonner';

const TIMEOUT_MS = 65000;
const publicCode = document.querySelector('meta[name="stream-public-code"]')?.content || null;
const apiPrefix = publicCode
  ? window.location.pathname.slice(0, -publicCode.length)
  : window.location.pathname.replace(/[^/]*$/, '');
const apiRoute = route => `${apiPrefix.replace(/\/$/, '')}${route}`;
const workerIdFromHash = () => {
  const match = /^#\/([A-Za-z0-9_-]{1,32})$/.exec(window.location.hash)
    || /^#\/worker\/([A-Za-z0-9_-]{1,32})$/.exec(window.location.hash)
    || /^#worker-([A-Za-z0-9_-]{1,32})$/.exec(window.location.hash);
  return match?.[1] || null;
};
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
    const response = await fetch(apiRoute(route), { ...options, signal: controller.signal,
      headers: { ...(answer ? { Authorization: `Bearer ${answer}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
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

const channelKey = channel => `${channel.guildId}:${channel.id}`;

function ChannelPicker({ workerId, channels, selected, onSelect, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const search = useRef(null);
  const chosen = channels.find(channel => channelKey(channel) === selected);
  const matches = channels.filter(channel =>
    `${channel.guildName} ${channel.name}`.toLowerCase().includes(query.toLowerCase()));
  const localMatches = matches.filter(channel => !channel.external);
  const externalMatches = matches.filter(channel => channel.external);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const dismiss = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const choose = channel => { onSelect(channelKey(channel)); setOpen(false); setQuery(''); };
  const onKeyDown = event => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
    }
    if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active]); }
  };
  return <div className="channel-picker" ref={root}>
    <button type="button" className="channel-picker-trigger" aria-label={`Destination voice channel for ${workerId}`}
      aria-expanded={open} aria-haspopup="listbox" disabled={disabled || !channels.length}
      onClick={() => { setOpen(value => !value); setQuery(''); setActive(0); }}>
      <span className="channel-picker-label">
        <strong>{chosen ? `# ${chosen.name}` : 'Choose a voice channel'}</strong>
        {chosen && <small>{chosen.guildName}</small>}
      </span><span className="channel-picker-chevron">⌄</span>
    </button>
    {open && <div className="channel-picker-menu">
      <input ref={search} className="channel-picker-search" value={query} placeholder="Search servers or channels…"
        aria-label="Search voice channels" onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      <div className="channel-picker-options" role="listbox" aria-label="Voice channels">
        {localMatches.length > 0 && <div className="channel-picker-group">CURRENT SERVER</div>}
        {localMatches.map((channel, index) => <button type="button" role="option"
          aria-selected={selected === channelKey(channel)} key={channelKey(channel)} onClick={() => choose(channel)}
          className={`channel-picker-option ${active === index ? 'keyboard-active' : ''}`}><span># {channel.name}</span><small>{channel.guildName}</small></button>)}
        {externalMatches.length > 0 && <div className="channel-picker-group">EXTERNAL SERVERS</div>}
        {externalMatches.map((channel, index) => <button type="button" role="option"
          aria-selected={selected === channelKey(channel)} key={channelKey(channel)} onClick={() => choose(channel)}
          className={`channel-picker-option ${active === localMatches.length + index ? 'keyboard-active' : ''}`}><span># {channel.name}</span><small>{channel.guildName}</small></button>)}
        {!matches.length && <div className="channel-picker-empty">No matching channels</div>}
      </div>
    </div>}
  </div>;
}

function WorkerCard({ worker, guildId, guilds, channels, action, onModal, busy, expanded = false, publicView = false }) {
  const status = worker.status;
  const musicMode = worker.musicMode === true || status?.musicMode === true;
  const queue = status?.queue || [];
  const realQueue = queue.filter(item => !item.isFiller);
  const current = status?.current;
  const currentChapter = musicMode ? status?.currentChapter : null;
  const chapters = musicMode && Array.isArray(status?.musicChapters) ? status.musicChapters : [];
  const upcomingChapters = chapters.slice((currentChapter?.index ?? -1) + 1);
  const duration = current?.durationSec;
  const position = Number(status?.positionSec) || 0;
  const [source, setSource] = useState('');
  const [destinationKey, setDestinationKey] = useState('');
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
  const preferred = destinationKey || (status?.guildId && status?.channelId ? `${status.guildId}:${status.channelId}` : '');
  const selected = channels.find(channel => channelKey(channel) === preferred) || channels[0];
  const canControl = worker.online && !busy;
  const canAdd = canControl && (!publicView || !!status?.inVoiceChannel);
  const channelName = channels.find(channel => channel.guildId === status?.guildId && channel.id === status?.channelId)?.name;
  const destination = () => ({ guildId: selected?.guildId, channelId: selected?.id });
  const send = (operation, payload = {}) => action(worker.id, operation, payload);
  const play = async event => {
    event.preventDefault();
    if (!source.trim()) return;
    const where = publicView ? {} : status?.guildId && status?.channelId
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
    if (Math.round(target) === Math.round(position)) { setSeek(null); return; }
    setSeek(target);
    setSeeking(true);
    try { await send('seek', { positionSec: target }); }
    finally { setSeeking(false); setSeek(null); }
  };
  return <article className={`worker-card ${expanded ? 'expanded' : ''} ${worker.online ? '' : 'offline'}`}>
    <header className="worker-header">
      <div className="avatar-wrap">
        {worker.profile?.avatarUrl ? <img className="avatar" src={worker.profile.avatarUrl} alt="" /> : <div className="avatar avatar-fallback">{worker.id.slice(0, 1).toUpperCase()}</div>}
        <span className={`presence ${worker.online ? 'on' : ''}`} />
      </div>
      <div className="worker-title">
        <div className="eyebrow">STREAM WORKER · {worker.id}</div>
        <h2>{worker.profile?.displayName || worker.id}</h2>
        <div className="worker-subtitle">{worker.online ? publicView ? status?.inVoiceChannel ? 'In a voice channel' : 'Standing by' : status?.channelId ? <><Icon name="audio" size={13} /> {channelName || `Voice ${status.channelId}`}</> : 'Standing by' : 'Offline'}</div>
      </div>
      {!publicView && <div className="worker-header-actions">
        <button type="button" className={`mode-toggle ${musicMode ? 'active' : ''}`}
          aria-label={`Turn Music Mode ${musicMode ? 'off' : 'on'} for ${worker.id}`}
          aria-pressed={musicMode} disabled={!canControl}
          onClick={() => send('toggle-music-mode')}>
          ♫ <span>{musicMode ? 'Music on' : 'Music mode'}</span>
        </button>
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
      </div>}
    </header>

    <div className="now-playing">
      <div className="section-topline"><span className="live-dot" /> NOW PLAYING <span className="stage-state">{status?.paused ? 'PAUSED' : status?.isFiller ? 'FILLER' : status?.isLive ? 'LIVE' : current ? 'PLAYING' : 'IDLE'}</span></div>
      {current?.thumbnail && <img className="playing-thumb" src={current.thumbnail} alt="" referrerPolicy="no-referrer"
        onError={event => { event.currentTarget.style.display = 'none'; }} />}
      <div className="playing-title">{currentChapter?.title || current?.title || 'Nothing on air'}</div>
      <div className="playing-meta">{currentChapter ? `From ${current.title}` : current ? current.isFiller ? musicMode ? 'Ready for music' : 'Ready for the next video' : musicMode ? 'Audio plays through the bot’s voice' : current.isLive ? 'Live source' : 'Video on demand' : 'Join a voice channel to get started'}</div>
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
      {!publicView && <button className="transport-button danger" disabled={!canControl || !status} title="Stop and leave" onClick={() => send('stop')}><Icon name="stop" /></button>}
    </div>

    <div className="card-divider" />
    <div className="queue-title"><span>UP NEXT</span><span className="queue-count">{upcomingChapters.length + realQueue.length}</span></div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => void reorder(event)}>
      <SortableContext items={displayQueue.map(item => item.id)} strategy={verticalListSortingStrategy}>
        <div className="queue-list">
          {upcomingChapters.map((chapter, index) => <div className="queue-item chapter-item" key={`chapter-${chapter.startSec}`}>
            <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
            {current?.thumbnail && <img className="queue-thumb" src={current.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
            <div className="queue-copy"><strong>{chapter.title}</strong><small>Mix chapter · {chapter.endSec != null ? fmt(chapter.endSec - chapter.startSec) : fmt(chapter.startSec)}</small></div>
          </div>)}
          {displayQueue.length ? displayQueue.map((item, index) =>
            <SortableQueueItem key={item.id} item={item} index={index + upcomingChapters.length} canControl={canControl}
              onRemove={queueId => void send('remove-queued', { queueId })} />)
            : !upcomingChapters.length && <div className="queue-empty">{musicMode ? 'No music in the queue yet.' : 'No videos in the queue yet.'}</div>}
        </div>
      </SortableContext>
    </DndContext>

    <form className="add-form" onSubmit={play}>
      <label htmlFor={`source-${worker.id}`}>ADD TO QUEUE</label>
      <div className="input-row"><input id={`source-${worker.id}`} value={source} onChange={event => setSource(event.target.value)} placeholder={musicMode ? 'Paste a music URL' : 'Paste a video URL or ShareTV slug'} disabled={!canAdd} /><button className="add-button" disabled={!canAdd || !source.trim()} title="Play or queue"><Icon name="plus" /></button></div>
      {publicView && !status?.inVoiceChannel && <p className="public-hint">Ask the stream owner to join a voice channel before adding media.</p>}
    </form>
    {!publicView && <div className="channel-controls">
      <ChannelPicker workerId={worker.id} channels={channels} selected={selected ? channelKey(selected) : ''}
        onSelect={setDestinationKey} disabled={!canControl || !guildId} />
      <button className="secondary-button" disabled={!canControl || !selected} onClick={() => send(status ? 'move' : 'join', destination())}><Icon name="move" size={15} /> {status ? 'Switch' : 'Join'}</button>
      <button className="text-button manual" onClick={() => onModal({ kind: 'channel', worker, guildId, guilds })} disabled={!canControl}>Use IDs</button>
    </div>}
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

function PublicWorkerPage() {
  const [worker, setWorker] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const state = await api(null, `/api/public/${publicCode}/state`);
      setWorker(state.worker);
    } catch (failure) {
      if ([404, 410, 429].includes(failure.status)) setExpired(true);
      else toast.error(failure.message);
    }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  const action = async (_workerId, operation, payload = {}) => {
    setBusy(true);
    try {
      const result = await api(null, `/api/public/${publicCode}/actions`,
        { method: 'POST', body: JSON.stringify({ operation, ...payload }) });
      toast.success(result.message || 'Done.');
      await refresh();
      return result;
    } catch (failure) {
      if ([404, 410].includes(failure.status)) setExpired(true);
      toast.error(failure.message);
      return null;
    } finally { setBusy(false); }
  };
  return <div className="app-shell public-shell"><Toaster position="top-right" theme="dark" richColors closeButton />
    <main className="main-content detail-mode">
      <div className="topbar"><div className="topbar-identity"><span className="mobile-brand-mark" aria-hidden="true">▶</span><div className="eyebrow">10MAN / STREAM · PUBLIC PLAYER</div></div></div>
      <div className="detail-view">
        {expired ? <div className="empty-fleet">This player link has expired. Scan the worker’s current QR code for a new link.</div>
          : worker ? <WorkerCard worker={worker} guildId="" guilds={[]} channels={[]} action={action}
              onModal={() => {}} busy={busy} expanded publicView />
            : <div className="empty-fleet">Connecting to the stream worker…</div>}
      </div>
    </main>
  </div>;
}

function AdminApp() {
  const [selectedWorkerId, setSelectedWorkerId] = useState(workerIdFromHash);
  const [answer, setAnswer] = useState(() => sessionStorage.getItem('stream-dashboard-password') || '');
  const [login, setLogin] = useState('');
  const [state, setState] = useState(null);
  const [guildId, setGuildId] = useState('');
  const [channels, setChannels] = useState([]);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState({});
  const [error, setError] = useState('');
  useEffect(() => {
    const onRoute = () => { setSelectedWorkerId(workerIdFromHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onRoute);
    return () => window.removeEventListener('hashchange', onRoute);
  }, []);
  useEffect(() => { if (error) toast.error(error); }, [error]);
  const refresh = useCallback(async () => {
    if (!answer) return;
    try {
      const next = await api(answer, `/api/state${guildId ? `?guildId=${encodeURIComponent(guildId)}` : ''}`);
      setState(next);
      setError('');
      if (!guildId && next.guilds.length) setGuildId(next.guilds[0].id);
    } catch (failure) {
      if (failure.status === 401) { sessionStorage.removeItem('stream-dashboard-password'); setAnswer(''); setState(null); }
      setError(failure.message);
    }
  }, [answer, guildId]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!answer || !guildId) { setChannels([]); return; }
    setChannels([]);
    let live = true;
    api(answer, `/api/guilds/${guildId}/channels`).then(result => { if (live) setChannels(result.channels); })
      .catch(() => { if (live) setChannels([]); });
    return () => { live = false; };
  }, [answer, guildId]);
  const workers = useMemo(() => state?.workers || [], [state]);
  const selectedWorker = workers.find(worker => worker.id === selectedWorkerId);
  const action = async (workerId, operation, payload = {}) => {
    setBusy(previous => ({ ...previous, [workerId]: true }));
    try {
      const result = await api(answer, `/api/workers/${encodeURIComponent(workerId)}/actions`,
        { method: 'POST', body: JSON.stringify({ operation, ...payload }) });
      toast.success(result.message || 'Done.');
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
    <form onSubmit={event => { event.preventDefault(); sessionStorage.setItem('stream-dashboard-password', login); setAnswer(login); }}>
      <label htmlFor="dashboard-answer">Dashboard password</label><input id="dashboard-answer" type="password" value={login} onChange={event => setLogin(event.target.value)} autoComplete="current-password" placeholder="Password" required />
      <button className="primary-button" type="submit">Open control room <span>→</span></button>
    </form>
  </div></div>;
  return <div className="app-shell"><Toaster position="top-right" theme="dark" richColors closeButton />
    <aside className="sidebar"><div className="sidebar-brand"><div className="brand-mark">▶</div><span>10MAN<span className="brand-light">/STREAM</span></span></div>
      <div className="sidebar-label">WORKSPACE</div><a href="#/" className={`sidebar-item ${!selectedWorkerId ? 'active' : ''}`}>◫ <span>Control room</span></a>
      <div className="sidebar-section"><div className="sidebar-label">FLEET</div>{workers.map(worker => <a key={worker.id} href={`#/${worker.id}`} className={`sidebar-worker ${selectedWorkerId === worker.id ? 'active' : ''}`}><span className={`sidebar-status ${worker.online ? 'on' : ''}`} />{worker.profile?.displayName || worker.id}</a>)}</div>
      <div className="sidebar-footer"><span className="sidebar-status on" /> Broker connected <button onClick={() => { sessionStorage.removeItem('stream-dashboard-password'); setAnswer(''); }} title="Sign out">↪</button></div>
    </aside>
    <main className={`main-content ${selectedWorkerId ? 'detail-mode' : ''}`}><div className="topbar"><div className="topbar-identity"><span className="mobile-brand-mark" aria-hidden="true">▶</span><div className="eyebrow">DASHBOARD / {selectedWorkerId ? `WORKER / ${selectedWorkerId.toUpperCase()}` : 'CONTROL ROOM'}</div></div><button className="icon-button" title="Refresh" aria-label="Refresh dashboard" onClick={() => void refresh()}><Icon name="refresh" /></button></div>
      <nav className="mobile-nav" aria-label="Stream workers"><a href="#/" className={!selectedWorkerId ? 'active' : ''}>All workers</a>{workers.map(worker => <a key={worker.id} href={`#/${worker.id}`} className={selectedWorkerId === worker.id ? 'active' : ''}>{worker.profile?.displayName || worker.id}</a>)}</nav>
      {selectedWorkerId ? <div className="detail-view">
        <section className="detail-intro"><div><a href="#/" className="back-link">← All workers</a><div className="eyebrow highlight">PLAYER · {selectedWorkerId.toUpperCase()}</div></div>
          <div className="guild-picker"><label htmlFor="guild-select">SERVER</label><select id="guild-select" value={guildId} onChange={event => setGuildId(event.target.value)}><option value="">Select a server</option>{state?.guilds?.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></div>
        </section>
        {!state ? <div className="empty-fleet">Connecting to stream workers…</div>
          : selectedWorker ? <WorkerCard worker={selectedWorker} guildId={guildId} guilds={state.guilds} channels={channels} action={action} onModal={setModal} busy={busy[selectedWorker.id]} expanded />
            : <div className="empty-fleet">Worker “{selectedWorkerId}” is not configured. <a href="#/">View all workers</a></div>}
      </div> : <>
        <section className="page-heading"><div><div className="eyebrow highlight">LIVE OPERATIONS</div><h1>Stream Deck<span className="heading-period">.</span></h1><p>Manage your Discord stream workers and playback queues.</p></div>
          <div className="guild-picker"><label htmlFor="guild-select">SERVER</label><select id="guild-select" value={guildId} onChange={event => setGuildId(event.target.value)}><option value="">Select a server</option>{state?.guilds?.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></div>
        </section>
        <div className="overview"><div><span className="overview-number">{workers.length}</span><span className="overview-label">WORKERS</span></div><div><span className="overview-number">{workers.filter(worker => worker.online).length}</span><span className="overview-label">ONLINE</span></div><div><span className="overview-number">{workers.filter(worker => worker.status?.current && !worker.status.current.isFiller).length}</span><span className="overview-label">ON AIR</span></div><div className="overview-note"><span className="pulse" /> Auto-refreshing every 5 seconds</div></div>
        <div className="cards-grid">{workers.map(worker => <div key={worker.id}><WorkerCard worker={worker} guildId={guildId} guilds={state.guilds} channels={channels} action={action} onModal={setModal} busy={busy[worker.id]} /></div>)}</div>
        {!workers.length && <div className="empty-fleet">No stream workers configured or connected.</div>}
      </>}
      <footer>10MAN STREAM DECK <span>·</span> Persistent Go Live control</footer>
    </main>
    {modal && <Modal key={`${modal.kind}-${modal.worker.id}`} modal={modal} close={() => setModal(null)} action={action} guildId={guildId} />}
  </div>;
}

export default function App() { return publicCode ? <PublicWorkerPage /> : <AdminApp />; }
