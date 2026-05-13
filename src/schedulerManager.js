const MAX_TIMEOUT_MS = 2_147_483_647;
const MIN_INTERVAL_MS = 60_000;
const DEFAULT_TIMEZONE = 'America/Chicago';


function parseDailyTime(value, fallback = '18:00') {
  const raw = String(value || fallback).trim();
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Invalid daily scheduler time '${raw}'. Expected HH:mm in 24-hour time.`);
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2] || '0', 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid daily scheduler time '${raw}'. Expected HH:mm in 24-hour time.`);
  }

  return { hour, minute, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function formatDateTime(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : 'unknown';
}

class SchedulerManager {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
    this.jobs = [];
    this.started = false;
  }

  registerDailyJob({ id, label, time, timezone = DEFAULT_TIMEZONE, task }) {
    const parsedTime = typeof time === 'string' || !time ? parseDailyTime(time) : time;
    this.jobs.push({
      id,
      label,
      type: 'daily',
      timezone,
      time: parsedTime,
      task,
      timer: null,
      running: false,
      nextRunAt: null
    });
  }

  registerIntervalJob({ id, label, intervalMs, task }) {
    const safeIntervalMs = Math.max(MIN_INTERVAL_MS, Number.parseInt(intervalMs, 10) || MIN_INTERVAL_MS);
    this.jobs.push({
      id,
      label,
      type: 'interval',
      intervalMs: safeIntervalMs,
      task,
      timer: null,
      running: false,
      nextRunAt: null
    });
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;

    for (const job of this.jobs) {
      this.schedule(job);
    }
  }

  stop() {
    for (const job of this.jobs) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      job.nextRunAt = null;
      job.running = false;
    }
    this.started = false;
  }

  schedule(job, from = new Date()) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    job.nextRunAt = job.type === 'daily'
      ? this.getNextDailyRunDate(job, from)
      : new Date(from.getTime() + job.intervalMs);

    const delayMs = Math.max(1_000, job.nextRunAt.getTime() - Date.now());
    console.log(`[scheduler] scheduled ${job.id} (${job.label}) for ${job.nextRunAt.toISOString()}`);

    job.timer = setTimeout(() => {
      job.timer = null;
      if (Date.now() + 1_000 < job.nextRunAt.getTime()) {
        this.schedule(job, new Date(Date.now()));
        return;
      }
      this.runJob(job).catch((error) => {
        console.error(`[scheduler] unexpected scheduler failure for ${job.id}:`, error);
      });
    }, Math.min(delayMs, MAX_TIMEOUT_MS));
  }

  async runJob(job, reason = 'scheduled') {
    const scheduledFor = job.nextRunAt || new Date();
    if (job.running) {
      const summary = 'Skipped because the previous run is still in progress.';
      console.warn(`[scheduler] ${job.id} ${summary}`);
      await this.postSchedulerEvent(job, 'skipped', summary, { scheduledFor, reason }).catch(() => {});
      this.schedule(job);
      return;
    }

    job.running = true;
    const startedAt = new Date();
    console.log(`[scheduler] starting ${job.id} (${job.label}) scheduled for ${formatDateTime(scheduledFor)}`);

    try {
      const result = await job.task({ scheduledFor, startedAt, reason });
      const summary = this.formatResult(result);
      console.log(`[scheduler] completed ${job.id}: ${summary}`);
      await this.postSchedulerEvent(job, 'completed', summary, { scheduledFor, startedAt, reason }).catch((error) => {
        console.warn(`[scheduler] failed to post scheduler event for ${job.id}:`, error?.message || error);
      });
    } catch (error) {
      const summary = error?.message || String(error);
      console.error(`[scheduler] failed ${job.id}:`, error);
      await this.postSchedulerEvent(job, 'failed', summary, { scheduledFor, startedAt, reason }).catch(() => {});
    } finally {
      job.running = false;
      this.schedule(job);
    }
  }

  formatResult(result) {
    if (typeof result === 'string') {
      return result;
    }
    if (!result || typeof result !== 'object') {
      return 'Finished.';
    }
    return Object.entries(result)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || 'Finished.';
  }

  async postSchedulerEvent(job, status, summary, context = {}) {
    const channelId = this.config.schedulerEventsChannelId;
    if (!channelId) {
      return;
    }

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('send' in channel)) {
      console.warn(`[scheduler] scheduler events channel ${channelId} is unavailable.`);
      return;
    }

    const statusEmoji = status === 'completed' ? '✅' : status === 'skipped' ? '⏭️' : '❌';
    await channel.send({
      content: [
        `${statusEmoji} **${job.label}** ${status}.`,
        `Scheduled: \`${formatDateTime(context.scheduledFor)}\``,
        `Result: ${String(summary).slice(0, 1_500)}`
      ].join('\n'),
      allowedMentions: { parse: [] }
    });
  }

  getZonedParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => Number.parseInt(parts.find((part) => part.type === type).value, 10);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute')
    };
  }

  getNextDailyRunDate(job, from = new Date()) {
    const start = new Date(from.getTime() + 1_000);
    start.setUTCSeconds(0, 0);

    for (let minuteOffset = 0; minuteOffset <= 60 * 48; minuteOffset += 1) {
      const candidate = new Date(start.getTime() + (minuteOffset * 60 * 1000));
      const parts = this.getZonedParts(candidate, job.timezone);
      if (parts.hour === job.time.hour && parts.minute === job.time.minute) {
        return candidate;
      }
    }

    throw new Error(`Could not find next run for daily job ${job.id} in timezone ${job.timezone}.`);
  }
}

module.exports = {
  SchedulerManager,
  parseDailyTime,
  DEFAULT_TIMEZONE
};
