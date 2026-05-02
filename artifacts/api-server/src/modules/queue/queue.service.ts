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

function isWithinBusinessHours(): boolean {
  const hour = new Date().getHours();
  return hour >= platformSettings.callHoursStart && hour < platformSettings.callHoursEnd;
}

function msUntilNextBusinessWindow(): number {
  const now = new Date();
  const start = platformSettings.callHoursStart;

  const todayOpen = new Date(now);
  todayOpen.setHours(start, 0, 0, 0);

  if (now < todayOpen) {
    return todayOpen.getTime() - now.getTime();
  }

  const tomorrowOpen = new Date(now);
  tomorrowOpen.setDate(tomorrowOpen.getDate() + 1);
  tomorrowOpen.setHours(start, 0, 0, 0);
  return tomorrowOpen.getTime() - now.getTime();
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
