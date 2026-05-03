import { logger } from "../../lib/logger.js";
import { platformSettings } from "../../config/platform.config.js";

export type QueueJob = {
  id: string;
  leadId: number;
  attempts: number;
  scheduledAt: number;
  priority: number;
};

const queue: QueueJob[] = [];
let processFn: ((leadId: number) => Promise<void>) | null = null;
let isProcessing = false;

export function registerProcessor(fn: (leadId: number) => Promise<void>) {
  processFn = fn;
}

const BUSINESS_TIMEZONE = "Asia/Kolkata";

function getCurrentHourInTz(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
}

function isWithinBusinessHours(): boolean {
  const hour = getCurrentHourInTz();
  return hour >= platformSettings.callHoursStart && hour < platformSettings.callHoursEnd;
}

function msUntilNextBusinessWindow(): number {
  const now = new Date();
  const start = platformSettings.callHoursStart;

  // Get current date components in IST
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) =>
    parseInt(tzParts.find((p) => p.type === type)?.value ?? "0", 10);

  const year = get("year");
  const month = get("month") - 1;
  const day = get("day");
  const currentHour = get("hour");

  // Build opening time today in IST, convert to UTC ms
  const todayOpenIST = new Date(
    Date.UTC(year, month, day, start, 0, 0, 0) - (5 * 60 + 30) * 60 * 1000,
  );

  if (now < todayOpenIST) {
    return todayOpenIST.getTime() - now.getTime();
  }

  // Already past opening today — open tomorrow
  const tomorrowOpenIST = new Date(todayOpenIST.getTime() + 24 * 60 * 60 * 1000);
  return tomorrowOpenIST.getTime() - now.getTime();
}

/**
 * Enqueue a lead for calling.
 * - priority: 4=urgent, 3=high, 2=normal, 1=low (default 2)
 * - Skips duplicate immediate jobs for the same lead.
 */
export function enqueueLead(leadId: number, delayMs = 0, priority = 2) {
  const alreadyQueued = delayMs === 0 && queue.some((j) => j.leadId === leadId);
  if (alreadyQueued) {
    logger.info({ leadId }, "Lead already in queue — skipping duplicate enqueue");
    return;
  }

  const job: QueueJob = {
    id: `lead-${leadId}-${Date.now()}`,
    leadId,
    attempts: 0,
    scheduledAt: Date.now() + delayMs,
    priority,
  };
  queue.push(job);
  logger.info({ leadId, delayMs, jobId: job.id, priority }, "Lead enqueued");
  scheduleNextProcess();
}

function scheduleNextProcess() {
  if (isProcessing) return;

  const now = Date.now();
  const readyJob = queue.find((j) => j.scheduledAt <= now);

  if (readyJob) {
    setImmediate(() => processNext());
  } else if (queue.length > 0) {
    const earliest = Math.min(...queue.map((j) => j.scheduledAt));
    const wait = Math.max(earliest - now, 100);
    setTimeout(() => scheduleNextProcess(), wait);
  }
}

async function processNext() {
  if (isProcessing || !processFn) return;

  const now = Date.now();

  const readyJobs = queue
    .filter((j) => j.scheduledAt <= now)
    .sort((a, b) => b.priority - a.priority || a.scheduledAt - b.scheduledAt);

  if (readyJobs.length === 0) return;

  if (!isWithinBusinessHours()) {
    const delay = msUntilNextBusinessWindow();
    const readyIds = new Set(readyJobs.map((j) => j.id));
    queue.forEach((j) => {
      if (readyIds.has(j.id)) {
        j.scheduledAt = Date.now() + delay;
      }
    });
    const nextOpen = new Date(Date.now() + delay).toISOString();
    logger.info(
      { count: readyJobs.length, nextOpen },
      "Outside business hours — rescheduling ready jobs"
    );
    setTimeout(() => scheduleNextProcess(), Math.min(delay, 60_000));
    return;
  }

  const job = readyJobs[0];
  const idx = queue.findIndex((j) => j.id === job.id);
  if (idx === -1) return;

  queue.splice(idx, 1);
  isProcessing = true;

  try {
    job.attempts++;
    logger.info(
      { jobId: job.id, leadId: job.leadId, attempt: job.attempts, priority: job.priority },
      "Processing queue job"
    );
    await processFn(job.leadId);
    logger.info({ jobId: job.id, leadId: job.leadId }, "Queue job completed");
  } catch (err) {
    logger.error(
      { err, jobId: job.id, leadId: job.leadId, attempt: job.attempts },
      "Queue job failed"
    );

    const maxRetries = platformSettings.callRetries;
    if (job.attempts < maxRetries) {
      const delayMins = [
        platformSettings.retryDelay1,
        platformSettings.retryDelay2,
        platformSettings.retryDelay3,
      ][job.attempts - 1] ?? 120;

      job.scheduledAt = Date.now() + delayMins * 60_000;
      queue.push(job);
      logger.info(
        { jobId: job.id, leadId: job.leadId, retryAt: new Date(job.scheduledAt).toISOString(), delayMins },
        "Queue job rescheduled for retry"
      );
    } else {
      logger.warn({ jobId: job.id, leadId: job.leadId }, "Queue job exhausted max retries — dropping");
    }
  } finally {
    isProcessing = false;
    scheduleNextProcess();
  }
}

export function getQueueStats() {
  const now = Date.now();
  return {
    total: queue.length,
    pending: queue.filter((j) => j.scheduledAt <= now).length,
    scheduled: queue.filter((j) => j.scheduledAt > now).length,
    jobs: queue.map((j) => ({
      id: j.id,
      leadId: j.leadId,
      attempts: j.attempts,
      priority: j.priority,
      scheduledAt: new Date(j.scheduledAt).toISOString(),
    })),
  };
}

export function dequeueLeadJobs(leadId: number) {
  const removed = queue.filter((j) => j.leadId === leadId).length;
  queue.splice(0, queue.length, ...queue.filter((j) => j.leadId !== leadId));
  if (removed > 0) {
    logger.info({ leadId, removed }, "Removed lead jobs from queue");
  }
  return removed;
}
