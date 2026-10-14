'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ID = /^\d{17,20}$/;
const SLUG = /^[A-Za-z0-9_-]+$/;
function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  return +month >= 1 && +month <= 12 && +day >= 1 && +day <= new Date(Date.UTC(+year, +month, 0)).getUTCDate() &&
    +hour <= 23 && +minute <= 59 && +second <= 59 && (!offsetHour || +offsetHour <= 23 && +offsetMinute <= 59) && Number.isFinite(Date.parse(value));
}
class StreamSchedules {
  constructor({ broker, filePath, now = Date.now, graceMs = 300000, log = console.log }) {
    this.broker = broker; this.filePath = filePath; this.now = now; this.graceMs = graceMs; this.log = log;
    this.activeWorkers = new Set(); this.jobs = []; this.serial = Promise.resolve(); this.timer = null; this.disposed = false;
    if (filePath && fs.existsSync(filePath)) {
      if (fs.statSync(filePath).size > 32 * 1024 * 1024) throw new Error('Schedule store exceeds size limit.');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(data) || data.length > 300) throw new Error('Invalid schedule store.');
      this.jobs = data;
    }
    let recovered = false;
    for (const job of this.jobs) if (job.status === 'running') {
      job.status = 'failed'; job.error = 'Server restarted after dispatch was claimed; playback outcome is unknown. No retry was sent.'; recovered = true;
    }
    if (recovered) this.serial = this._save();
  }
  async _save() {
    const pending = this.jobs.filter(job => ['pending', 'running'].includes(job.status));
    this.jobs = [...pending, ...this.jobs.filter(job => !['pending', 'running'].includes(job.status)).slice(-100)];
    if (!this.filePath) return;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const fd = await fs.promises.open(tmp, 'w', 0o600);
    try { await fd.writeFile(JSON.stringify(this.jobs)); await fd.sync(); } finally { await fd.close(); }
    await fs.promises.rename(tmp, this.filePath);
  }
  _lock(fn) { const result = this.serial.then(fn); this.serial = result.catch(() => {}); return result; }
  list(workerId) { return this.jobs.filter(job => job.workerId === workerId).map(job => ({ ...job, sources: [...job.sources] })); }
  add(workerId, body) { return this._lock(async () => {
    if (!Array.isArray(body?.sources) || !body.sources.length || body.sources.length > 100 || body.sources.some(source => {
      if (typeof source !== 'string' || !source.trim() || source.length > 2048) return true;
      if (SLUG.test(source.trim())) return false;
      try { return !['http:', 'https:'].includes(new URL(source.trim()).protocol); } catch { return true; }
    })) throw new Error('Provide 1–100 media URLs or ShareTV slugs (maximum 2048 characters each).');
    if (typeof body.startAt !== 'string' || !validDate(body.startAt) || Date.parse(body.startAt) <= this.now()) throw new Error('Start time must be a future ISO date with a timezone.');
    if (!ID.test(String(body.guildId || '')) || !ID.test(String(body.channelId || ''))) throw new Error('Valid server and voice channel IDs are required.');
    if (this.jobs.filter(job => ['pending', 'running'].includes(job.status)).length >= 100) throw new Error('Maximum 100 pending schedules reached.');
    const job = { id: crypto.randomUUID(), workerId, sources: body.sources.map(source => source.trim()), startAt: new Date(body.startAt).toISOString(), guildId: String(body.guildId), channelId: String(body.channelId), status: 'pending' };
    this.jobs.push(job); try { await this._save(); } catch (error) { this.jobs = this.jobs.filter(item => item !== job); throw error; }
    return { ...job };
  }); }
  cancel(workerId, id) { return this._lock(async () => {
    const job = this.jobs.find(item => item.workerId === workerId && item.id === id);
    if (!job) return null;
    if (job.status !== 'pending') throw new Error('Only pending schedules can be cancelled.');
    job.status = 'cancelled'; try { await this._save(); } catch (error) { job.status = 'pending'; throw error; }
    return { ...job };
  }); }
  async tick() {
    const claimed = await this._lock(async () => {
      if (this.disposed) return [];
      const ready = []; const changed = [];
      for (const job of [...this.jobs].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
        if (job.status !== 'pending' || Date.parse(job.startAt) > this.now()) continue;
        if (this.now() - Date.parse(job.startAt) > this.graceMs) { changed.push({ job, before: { ...job } }); job.status = 'failed'; job.error = 'Scheduled start missed its five-minute grace period.'; continue; }
        if (!this.broker.getWorker(job.workerId)) continue;
        // At most one dispatch per worker per tick; later starts retain chronological order.
        if (this.activeWorkers.has(job.workerId) || ready.some(other => other.workerId === job.workerId)) continue;
        changed.push({ job, before: { ...job } }); job.status = 'running'; ready.push(job);
      }
      if (changed.length) try { await this._save(); } catch (error) { for (const { job, before } of changed) { delete job.error; Object.assign(job, before); } throw error; }
      for (const job of ready) this.activeWorkers.add(job.workerId);
      return ready;
    });
    await Promise.all(claimed.map(async job => {
      let status = 'completed', error;
      try { const result = await this.broker.request('scheduled-play', { sources: job.sources, guildId: job.guildId, channelId: job.channelId, scheduleId: job.id, dispatchDeadline: Date.now() + Math.max(1000, (this.broker.requestTimeoutMs || 60000) - 2000), requestedBy: 'scheduler' }, job.workerId); if (!result.ok) throw new Error(result.message || 'Worker rejected scheduled playback.'); }
      catch (failure) { status = 'failed'; error = String(failure.message || failure).slice(0, 1000); }
      await this._lock(async () => { job.status = status; if (error) job.error = error; this.activeWorkers.delete(job.workerId); await this._save(); });
    }));
  }
  start() { if (this.timer) return; this.disposed = false; this.timer = setInterval(() => { void this.tick().catch(error => this.log(`[stream-schedules] ${error.message}`)); }, 1000); this.timer.unref?.(); void this.tick().catch(error => this.log(`[stream-schedules] ${error.message}`)); }
  dispose() { this.disposed = true; clearInterval(this.timer); this.timer = null; return this.serial; }
}
module.exports = { StreamSchedules };
