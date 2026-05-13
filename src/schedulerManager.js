const cron = require('node-cron');

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

function buildDailyCronExpression(time) {
  return `${time.minute} ${time.hour} * * *`;
}

function buildIntervalCronExpression(intervalMs) {
  const safeIntervalMs = Math.max(MIN_INTERVAL_MS, Number.parseInt(intervalMs, 10) || MIN_INTERVAL_MS);
  const intervalMinutes = safeIntervalMs / 60_000;

  if (!Number.isInteger(intervalMinutes)) {
    throw new Error('Interval scheduler jobs must use whole-minute intervals.');
  }

  if (intervalMinutes < 60) {
    if (60 % intervalMinutes !== 0) {
      throw new Error(`Cannot represent every ${intervalMinutes} minutes as a stable cron expression. Use a divisor of 60 or configure a cron expression directly.`);
    }
    return intervalMinutes === 1 ? '* * * * *' : `*/${intervalMinutes} * * * *`;
  }

  if (intervalMinutes % 60 !== 0) {
    throw new Error(`Cannot represent every ${intervalMinutes} minutes as an hourly cron expression. Use whole-hour intervals or configure a cron expression directly.`);
  }

  const intervalHours = intervalMinutes / 60;
  if (intervalHours === 24) {
    return '0 0 * * *';
  }

  if (intervalHours >= 1 && intervalHours < 24 && 24 % intervalHours === 0) {
    return intervalHours === 1 ? '0 * * * *' : `0 */${intervalHours} * * *`;
  }

  throw new Error(`Cannot represent every ${intervalHours} hours as a stable daily cron expression. Use a divisor of 24 or configure a cron expression directly.`);
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
    this.registerCronJob({
      id,
      label,
      expression: buildDailyCronExpression(parsedTime),
      timezone,
      task,
      description: `daily at ${parsedTime.label} ${timezone}`
    });
  }

  registerIntervalJob({ id, label, intervalMs, timezone = 'UTC', task }) {
    this.registerCronJob({
      id,
      label,
      expression: buildIntervalCronExpression(intervalMs),
      timezone,
      task,
      description: `interval ${Math.max(MIN_INTERVAL_MS, Number.parseInt(intervalMs, 10) || MIN_INTERVAL_MS)}ms`
    });
  }

  registerCronJob({ id, label, expression, timezone = 'UTC', task, description = null }) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression for ${id}: '${expression}'.`);
    }

    this.jobs.push({
      id,
      label,
      expression,
      timezone,
      description: description || expression,
      task,
      cronTask: null
    });
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;

    for (const job of this.jobs) {
      this.startJob(job);
    }
  }

  async stop() {
    for (const job of this.jobs) {
      if (job.cronTask) {
        await job.cronTask.destroy();
        job.cronTask = null;
      }
    }
    this.started = false;
  }

  startJob(job) {
    if (job.cronTask) {
      return;
    }

    job.cronTask = cron.createTask(job.expression, async (context) => {
      await this.runJob(job, context);
    }, {
      name: job.id,
      timezone: job.timezone,
      noOverlap: true
    });

    job.cronTask.start();
    this.logNextRun(job);
  }

  logNextRun(job) {
    const nextRun = job.cronTask?.getNextRun?.() || null;
    console.log([
      `[scheduler] scheduled ${job.id} (${job.label})`,
      `cron='${job.expression}'`,
      `timezone='${job.timezone}'`,
      `next=${formatDateTime(nextRun)}`
    ].join(' '));
  }

  async runJob(job, context = {}) {
    const scheduledFor = context.date || new Date();
    const startedAt = context.triggeredAt || new Date();
    console.log(`[scheduler] starting ${job.id} (${job.label}) scheduled for ${formatDateTime(scheduledFor)}`);

    try {
      const result = await job.task({ scheduledFor, startedAt, reason: 'scheduled', cronContext: context });
      const summary = this.formatResult(result);
      console.log(`[scheduler] completed ${job.id}: ${summary}`);
      await this.postSchedulerEvent(job, 'completed', summary, { scheduledFor, startedAt }).catch((error) => {
        console.warn(`[scheduler] failed to post scheduler event for ${job.id}:`, error?.message || error);
      });
    } catch (error) {
      const summary = error?.message || String(error);
      console.error(`[scheduler] failed ${job.id}:`, error);
      await this.postSchedulerEvent(job, 'failed', summary, { scheduledFor, startedAt }).catch(() => {});
    } finally {
      this.logNextRun(job);
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

    const statusEmoji = status === 'completed' ? '✅' : '❌';
    await channel.send({
      content: [
        `${statusEmoji} **${job.label}** ${status}.`,
        `Cron: \`${job.expression}\` (${job.timezone})`,
        `Scheduled: \`${formatDateTime(context.scheduledFor)}\``,
        `Result: ${String(summary).slice(0, 1_500)}`
      ].join('\n'),
      allowedMentions: { parse: [] }
    });
  }
}

module.exports = {
  SchedulerManager,
  parseDailyTime,
  buildDailyCronExpression,
  buildIntervalCronExpression,
  DEFAULT_TIMEZONE
};
