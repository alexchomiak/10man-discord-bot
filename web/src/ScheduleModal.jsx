import React, { useEffect, useRef, useState } from 'react';

const localFields = date => {
  const pad = n => String(n).padStart(2, '0');
  return { day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
};
export default function ScheduleModal({ worker, close, request, channels, guilds, guildId, loadChannels, ChannelPicker }) {
  const [page, setPage] = useState('list');
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [server, setServer] = useState(worker.status?.guildId || guildId || '');
  const [destination, setDestination] = useState(worker.status?.channelId ? `${worker.status.guildId}:${worker.status.channelId}` : '');
  const [manual, setManual] = useState(false);
  const [manualGuild, setManualGuild] = useState(worker.status?.guildId || guildId || '');
  const [manualChannel, setManualChannel] = useState(worker.status?.channelId || '');
  const [available, setAvailable] = useState(channels);
  const [hint, setHint] = useState(null);
  const [cancel, setCancel] = useState(null);
  const revision = useRef(0);
  const root = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const trigger = useRef(document.activeElement);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const path = `/api/workers/${encodeURIComponent(worker.id)}/schedules`;
  const refresh = async () => { const result = await request(path); if (result) setSchedules(result.schedules || []); setLoading(false); };
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 10000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let live = true;
    setAvailable(channels.filter(c => c.guildId === server || c.external));
    if (server) loadChannels(server).then(result => { if (live && result) { const merged = [...result.channels, ...channels.filter(c => c.external)]; setAvailable([...new Map(merged.map(c => [`${c.guildId}:${c.id}`, c])).values()]); } });
    return () => { live = false; };
  }, [server]);
  useEffect(() => {
    root.current?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (cancel) setCancel(null); else closeRef.current(); }
      if (event.key === 'Tab') {
        const items = [...root.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]')];
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); trigger.current?.focus(); };
  }, [cancel]);
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
  const submit = async event => {
    event.preventDefault();
    const start = new Date(`${day}T${time}`);
    const [targetGuild, targetChannel] = manual ? [manualGuild.trim(), manualChannel.trim()] : destination.split(':');
    if (!Number.isFinite(start.getTime()) || start.getTime() <= Date.now() || localFields(start).day !== day || localFields(start).time !== time) { await request(null, { error: 'Choose a valid future date and time in your local timezone.' }); return; }
    if (!targetGuild || !targetChannel) { await request(null, { error: 'Choose a voice channel or enter server and channel IDs.' }); return; }
    setSaving(true);
    const result = await request(path, { method: 'POST', body: JSON.stringify({ sources: sources.split(/\r?\n/).map(s => s.trim()).filter(Boolean), startAt: start.toISOString(), guildId: targetGuild, channelId: targetChannel }) });
    setSaving(false);
    if (result) { setPage('list'); setSources(''); await refresh(); }
  };
  return <div className="modal-backdrop schedule-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={root} tabIndex={-1} className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
      <div className="schedule-heading"><div><div className="eyebrow">{worker.profile?.displayName || worker.id}</div><h2 id="schedule-title">Scheduled content</h2></div><button type="button" className="search-close" aria-label="Close scheduled content" onClick={close}>×</button></div>
      <nav className="schedule-breadcrumb" aria-label="Schedule navigation"><button type="button" onClick={() => { setPage('list'); setCancel(null); }}>Scheduled content</button>{page === 'new' && <span> › New schedule</span>}{cancel && <span> › Cancel schedule</span>}</nav>
      {cancel ? <div><h3>Cancel this schedule?</h3><p>The stream scheduled for {new Date(cancel.startAt).toLocaleString()} will not start.</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setCancel(null)}>Keep schedule</button><button type="button" className="primary-button" disabled={saving} onClick={async () => { setSaving(true); const result = await request(`${path}/${encodeURIComponent(cancel.id)}`, { method: 'DELETE' }); setSaving(false); if (result) { setCancel(null); await refresh(); } }}>Cancel schedule</button></div></div>
        : page === 'list' ? <><div className="schedule-list-toolbar"><span>Times shown in {zone}</span><button type="button" className="primary-button" onClick={() => setPage('new')}>+ New schedule</button></div><div className="schedule-list" aria-live="polite">{loading ? <p>Loading schedules…</p> : !schedules.length ? <p>No scheduled content yet.</p> : schedules.map(item => <article className="schedule-item" key={item.id}><strong>{new Date(item.startAt).toLocaleString()}</strong><span className="schedule-status">{{ completed: 'Started', running: 'Starting', pending: 'Scheduled', cancelled: 'Cancelled', failed: 'Failed' }[item.status] || item.status}</span>{item.status === 'pending' && !worker.online && new Date(item.startAt).getTime() <= Date.now() && <small>Waiting for worker (up to 5 minutes)</small>}<p>{item.sources.join('\n')}</p><small>Server {item.guildId} · Channel {item.channelId}</small>{item.error && <p>{item.error}</p>}{item.status === 'pending' && <button type="button" className="secondary-button" onClick={() => setCancel(item)}>Cancel</button>}</article>)}</div></>
        : <form onSubmit={submit}><label>Content links<textarea value={sources} onChange={e => setSources(e.target.value)} placeholder="Paste one video URL or ShareTV link per line" rows={4} required /></label>{hint && <div className="schedule-hint" role="status"><p>ShareTV Link detected, Start stream at {new Date(hint.startAt).toLocaleString()} ({zone}) time?</p><div><button type="button" className="primary-button" onClick={() => { const fields = localFields(new Date(hint.startAt)); editTime(setDay, fields.day); setTime(fields.time); }}>Yes</button><button type="button" className="secondary-button" onClick={() => { revision.current++; setHint(null); }}>No</button></div></div>}
          <div className="schedule-datetime"><label>Day<input type="date" value={day} min={localFields(new Date()).day} onChange={e => editTime(setDay, e.target.value)} required /></label><label>Time<input type="time" value={time} onChange={e => editTime(setTime, e.target.value)} required /></label></div><p className="schedule-note">Your local timezone: {zone}. The scheduled time is saved in UTC.</p>
          <div className="schedule-routing"><button type="button" className="secondary-button" onClick={() => setManual(!manual)}>{manual ? 'Choose from channels' : 'Use server / channel IDs'}</button>{manual ? <><label>Server ID<input value={manualGuild} inputMode="numeric" pattern="[0-9]{17,20}" onChange={e => setManualGuild(e.target.value)} required /></label><label>Voice channel ID<input value={manualChannel} inputMode="numeric" pattern="[0-9]{17,20}" onChange={e => setManualChannel(e.target.value)} required /></label></> : <><label>Server<select value={server} onChange={e => { setServer(e.target.value); setDestination(''); }}><option value="">Select a server</option>{guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><ChannelPicker workerId={worker.id} channels={available} selected={destination} onSelect={setDestination} disabled={saving} />{!available.length && <p className="schedule-note">No channels available. Use IDs to schedule an offline worker.</p>}</>}</div>
          <p className="schedule-note">At the scheduled time, this interrupts the current content and starts these links in order. The remaining queue is preserved. The worker joins the saved server and channel.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPage('list')}>Back</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Create schedule'}</button></div></form>}
    </div></div>;
}
