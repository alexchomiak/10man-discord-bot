import React, { useEffect, useRef, useState } from 'react';

const localFields = date => {
  const pad = n => String(n).padStart(2, '0');
  return { day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
};
const dateLabel = value => new Date(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const timeLabel = value => new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const isFinished = item => ['completed', 'failed', 'cancelled'].includes(item.status);
const sourceDisplay = source => {
  try { const url = new URL(source); url.search = ''; url.hash = ''; return url.toString(); }
  catch { return source; }
};
const sourceLabel = source => {
  try {
    const url = new URL(source);
    const host = url.hostname.replace(/^www\./, '');
    if (/sharetv/i.test(host)) {
      const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '').replace(/[-_]+/g, ' ');
      if (slug) return slug;
    }
    return host;
  } catch { return source.replace(/[-_]+/g, ' '); }
};
function ScheduleIcon({ kind }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{kind === 'delete' ? <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></> : kind === 'edit' ? <><path d="m4 17-.5 3.5L7 20l11-11-3-3L4 17Z" /><path d="m13 8 3 3" /></> : <><path d="M6 6l12 12M18 6 6 18" /></>}</svg>;
}
export default function ScheduleModal({ worker, close, request, channels, loadChannels, ChannelPicker }) {
  const [page, setPage] = useState('list');
  const [editingId, setEditingId] = useState(null);
  const [originalStartAt, setOriginalStartAt] = useState(null);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState('');
  const [nickname, setNickname] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [server, setServer] = useState('');
  const [destination, setDestination] = useState('');
  const [manual, setManual] = useState(false);
  const [manualGuild, setManualGuild] = useState('');
  const [manualChannel, setManualChannel] = useState('');
  const [available, setAvailable] = useState(channels);
  const [hint, setHint] = useState(null);
  const [cancel, setCancel] = useState(null);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const revision = useRef(0);
  const root = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const trigger = useRef(document.activeElement);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const path = `/api/workers/${encodeURIComponent(worker.id)}/schedules`;
  const refresh = async () => { const result = await request(path); if (result) setSchedules(result.schedules || []); setLoading(false); };
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 10000); return () => clearInterval(timer); }, []);
  useEffect(() => { setAvailable(channels); }, [channels]);
  useEffect(() => {
    let live = true;
    loadChannels().then(result => { if (live && result) setAvailable(result.availableChannels || []); });
    return () => { live = false; };
  }, []);
  const guilds = [...new Map(available.map(channel => [channel.guildId, { id: channel.guildId, name: channel.guildName || channel.guildId }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const visibleChannels = server ? available.filter(channel => channel.guildId === server) : available;
  useEffect(() => { if (server && !guilds.some(guild => guild.id === server)) { setServer(''); setDestination(''); } }, [available, server]);
  useEffect(() => { if (destination && !available.some(channel => `${channel.guildId}:${channel.id}` === destination)) { setDestination(''); if (editingId) setManual(true); } }, [available, destination, editingId]);
  const refreshChannels = async () => { const result = await loadChannels(); if (result) setAvailable(result.availableChannels || []); };
  useEffect(() => { root.current?.focus(); root.current?.scrollTo({ top: 0 }); }, [page, cancel]);
  useEffect(() => {
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (cancelRef.current) setCancel(null); else closeRef.current(); }
      if (event.key === 'Tab') {
        const items = [...root.current.querySelectorAll('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); trigger.current?.focus(); };
  }, []);
  useEffect(() => {
    setHint(null);
    const current = ++revision.current;
    const source = sources.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (!source || page !== 'new') return;
    const timer = setTimeout(async () => {
      const result = await request('/api/schedules/sharetv-hint', { method: 'POST', body: JSON.stringify({ source }) }, true);
      if (revision.current === current && result?.detected && new Date(result.startAt).getTime() > Date.now()) setHint(result);
    }, 650);
    return () => { clearTimeout(timer); revision.current++; };
  }, [sources, page]);
  const editTime = (setter, value) => { revision.current++; setHint(null); setter(value); };
  const openForm = item => {
    const guild = item?.guildId || '';
    const channel = item?.channelId || '';
    const known = available.some(c => c.guildId === guild && c.id === channel);
    const fields = item ? localFields(new Date(item.startAt)) : { day: '', time: '' };
    setEditingId(item?.id || null); setOriginalStartAt(item?.startAt || null); setSources(item?.sources?.join('\n') || ''); setNickname(item?.nickname || '');
    setDay(fields.day); setTime(fields.time); setManual(!!item && !known); setManualGuild(guild); setManualChannel(channel);
    setServer(known ? guild : ''); setDestination(known ? `${guild}:${channel}` : '');
    setHint(null); setPage(item ? 'edit' : 'new');
  };
  const targetLabel = item => {
    const channel = available.find(c => c.guildId === item.guildId && c.id === item.channelId);
    return `${channel?.guildName || item.guildName || `Server ${item.guildId}`} · # ${channel?.name || item.channelName || item.channelId}`;
  };
  const submit = async event => {
    event.preventDefault();
    const originalFields = originalStartAt ? localFields(new Date(originalStartAt)) : null;
    const keepOriginalTime = editingId && originalFields?.day === day && originalFields?.time === time;
    const start = new Date(keepOriginalTime ? originalStartAt : `${day}T${time}`);
    const [targetGuild, targetChannel] = manual ? [manualGuild.trim(), manualChannel.trim()] : destination.split(':');
    if (!Number.isFinite(start.getTime()) || start.getTime() <= Date.now() || localFields(start).day !== day || localFields(start).time !== time) { await request(null, { error: 'Choose a valid future date and time in your local timezone.' }); return; }
    if (!targetGuild || !targetChannel || (!manual && !available.some(channel => channel.guildId === targetGuild && channel.id === targetChannel))) { await request(null, { error: 'Choose a voice channel or enter server and channel IDs.' }); return; }
    setSaving(true);
    try {
      const result = await request(editingId ? `${path}/${encodeURIComponent(editingId)}` : path, {
        method: editingId ? 'PUT' : 'POST', body: JSON.stringify({ sources: sources.split(/\r?\n/).map(s => s.trim()).filter(Boolean), startAt: keepOriginalTime ? originalStartAt : start.toISOString(), guildId: targetGuild, channelId: targetChannel, nickname: nickname.trim() || null })
      });
      if (result) { setPage('list'); setEditingId(null); setSources(''); await refresh(); }
    } finally { setSaving(false); }
  };
  const remove = async () => {
    setSaving(true);
    try { const result = await request(`${path}/${encodeURIComponent(cancel.id)}`, { method: 'DELETE' }); if (result) { setCancel(null); await refresh(); } }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop schedule-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={root} tabIndex={-1} className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
      <div className="schedule-heading"><div><div className="eyebrow">{worker.profile?.displayName || worker.id}</div><h2 id="schedule-title">Scheduled content</h2></div><button type="button" className="search-close" aria-label="Close scheduled content" onClick={close}>×</button></div>
      <nav className="schedule-breadcrumb" aria-label="Schedule navigation"><button type="button" disabled={saving || (page === 'list' && !cancel)} onClick={() => { setPage('list'); setCancel(null); }}>Schedules</button>{(page !== 'list' || cancel) && <><span aria-hidden="true">/</span><span aria-current="page">{cancel ? isFinished(cancel) ? 'Delete schedule' : 'Cancel schedule' : editingId ? 'Edit schedule' : 'New schedule'}</span></>}</nav>
      {cancel ? <section className="schedule-confirm"><h3>{isFinished(cancel) ? 'Delete this schedule?' : 'Cancel this schedule?'}</h3><p>{dateLabel(cancel.startAt)} at {timeLabel(cancel.startAt)} · {targetLabel(cancel)}</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setCancel(null)}>Keep schedule</button><button type="button" className="primary-button" disabled={saving} onClick={remove}>{isFinished(cancel) ? 'Delete schedule' : 'Cancel schedule'}</button></div></section>
        : page === 'list' ? <><div className="schedule-list-toolbar"><span>Times in {zone}</span><button type="button" className="primary-button" onClick={() => openForm(null)}>+ New schedule</button></div><div className="schedule-list" aria-live="polite">{loading ? <div className="schedule-empty">Loading schedules…</div> : !schedules.length ? <div className="schedule-empty">No scheduled content yet.</div> : schedules.map(item => <article className="schedule-item" key={item.id}>
          <header className="schedule-card-header"><div className="schedule-card-date"><strong>{dateLabel(item.startAt)}</strong><time dateTime={item.startAt}>{timeLabel(item.startAt)}</time></div><span className={`schedule-status ${item.status}`}>{{ completed: 'Started', running: 'Starting', pending: 'Scheduled', cancelled: 'Cancelled', failed: 'Failed' }[item.status] || item.status}</span></header>
          <div className="schedule-sources">{item.sources.map((source, index) => <div className="schedule-source" key={`${index}-${source}`}><strong>{sourceLabel(source)}</strong><span title={sourceDisplay(source)}>{sourceDisplay(source)}</span></div>)}</div>
          <div className="schedule-card-footer"><div className="schedule-card-target"><span title={`Server ${item.guildId} · Channel ${item.channelId}`}>{targetLabel(item)}</span>{item.nickname && <small>Nickname: {item.nickname}</small>}</div>{item.status === 'pending' && <div className="schedule-card-actions"><button type="button" className="schedule-icon-button" aria-label={`Edit schedule for ${dateLabel(item.startAt)} at ${timeLabel(item.startAt)}`} title="Edit schedule" disabled={saving} onClick={() => openForm(item)}><ScheduleIcon kind="edit" /></button><button type="button" className="schedule-icon-button cancel" aria-label={`Cancel schedule for ${dateLabel(item.startAt)} at ${timeLabel(item.startAt)}`} title="Cancel schedule" disabled={saving} onClick={() => setCancel(item)}><ScheduleIcon kind="cancel" /></button></div>}{isFinished(item) && <div className="schedule-card-actions"><button type="button" className="schedule-icon-button cancel" aria-label={`Delete ${item.status} schedule for ${dateLabel(item.startAt)} at ${timeLabel(item.startAt)}`} title="Delete schedule" disabled={saving} onClick={() => setCancel(item)}><ScheduleIcon kind="delete" /></button></div>}</div>
          {item.status === 'pending' && !worker.online && new Date(item.startAt).getTime() <= Date.now() && <small className="schedule-waiting">Waiting for worker (up to 5 minutes)</small>}{item.error && <p className="schedule-card-error">{item.error}</p>}
        </article>)}</div><p className="schedule-note">Schedule history is automatically removed after 1 hour.</p></>
        : <form className="schedule-form" onSubmit={submit}><fieldset disabled={saving}><legend>Content</legend><label>Content links<textarea value={sources} onChange={e => setSources(e.target.value)} placeholder="One video URL or ShareTV link per line" rows={3} required /></label>{hint && <div className="schedule-hint" role="status"><p>ShareTV starts {dateLabel(hint.startAt)} at {timeLabel(hint.startAt)}. Use this time?</p><div><button type="button" className="primary-button" onClick={() => { const fields = localFields(new Date(hint.startAt)); editTime(setDay, fields.day); setTime(fields.time); }}>Use time</button><button type="button" className="secondary-button" onClick={() => { revision.current++; setHint(null); }}>Dismiss</button></div></div>}</fieldset>
          <fieldset disabled={saving}><legend>When</legend><div className="schedule-datetime"><label>Day<input type="date" value={day} min={localFields(new Date()).day} onChange={e => editTime(setDay, e.target.value)} required /></label><label>Time<input type="time" value={time} onChange={e => editTime(setTime, e.target.value)} required /></label></div><p className="schedule-note">Your timezone: {zone}</p></fieldset>
          <fieldset disabled={saving}><legend>Bot identity</legend><label htmlFor="schedule-nickname">Bot nickname <span className="schedule-optional">Optional</span><input id="schedule-nickname" value={nickname} maxLength={32} onChange={e => setNickname(e.target.value)} placeholder="Leave blank to keep normal nickname behavior" aria-describedby="schedule-nickname-note" /></label><p id="schedule-nickname-note" className="schedule-note">Applied while this schedule’s content plays, overriding content-derived names. Requires the bot’s Change Nickname permission; a failed update won’t stop playback. Leave blank for normal nickname behavior.</p></fieldset>
          <fieldset disabled={saving}><legend>Voice destination</legend><div className="schedule-routing"><button type="button" className="secondary-button schedule-routing-mode" onClick={() => setManual(!manual)}>{manual ? 'Choose from channels' : 'Use server / channel IDs'}</button>{manual ? <><label>Server ID<input value={manualGuild} inputMode="numeric" pattern="[0-9]{17,20}" onChange={e => setManualGuild(e.target.value)} required /></label><label>Voice channel ID<input value={manualChannel} inputMode="numeric" pattern="[0-9]{17,20}" onChange={e => setManualChannel(e.target.value)} required /></label></> : <><label>Server<select value={server} onChange={e => { setServer(e.target.value); setDestination(''); }}><option value="">All servers</option>{guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><ChannelPicker workerId={worker.id} channels={visibleChannels} selected={destination} onSelect={value => { setDestination(value); setServer(value.split(':')[0]); }} onRefresh={refreshChannels} disabled={saving} />{!available.length && <p className="schedule-note">No channels available. Use IDs to schedule an offline worker.</p>}</>}</div></fieldset>
          <p className="schedule-note">At the scheduled time, these links interrupt the current content and play in order. The remaining queue is preserved.</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setPage('list')}>Back</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create schedule'}</button></div></form>}
    </div></div>;
}
