import { logger } from "../../lib/logger.js";

export type QueueJob = {
  id: string;
  leadId: number;
  attempts: number;
  scheduledAt: number;
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours

const queue: QueueJob[] = [];
let processFn: ((leadId: number) => Promise<void>) | null = null;
let isProcessing = false;

export function registerProcessor(fn: (leadId: number) => Promise<void>) {
  processFn = fn;
}

/**
 * Enqueue a lead for calling. Skips if the same leadId is already queued
 * (unless delayMs > 0 which means it's a scheduled retry).
 */
export function enqueueLead(leadId: number, delayMs = 0) {
  // Prevent duplicate immediate jobs for the same lead
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
  };
  queue.push(job);
  logger.info({ leadId, delayMs, jobId: job.id }, "Lead enqueued");
  scheduleNextProcess();
}

function scheduleNextProcess() {
  if (isProcessing) return;

  const now = Date.now();
  const readyJob = queue.find((j) => j.scheduledAt <= now);

  if (readyJob) {
    // Use setImmediate to avoid deep call stacks when processing many jobs
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
  const idx = queue.findIndex((j) => j.scheduledAt <= now);
  if (idx === -1) return;

  const [job] = queue.splice(idx, 1);
  isProcessing = true;

  try {
    job.attempts++;
    logger.info({ jobId: job.id, leadId: job.leadId, attempt: job.attempts }, "Processing queue job");
    await processFn(job.leadId);
    logger.info({ jobId: job.id, leadId: job.leadId }, "Queue job completed");
  } catch (err) {
    logger.error({ err, jobId: job.id, leadId: job.leadId, attempt: job.attempts }, "Queue job failed");

    if (job.attempts < MAX_RETRIES) {
      job.scheduledAt = Date.now() + RETRY_DELAY_MS;
      queue.push(job);
      logger.info(
        { jobId: job.id, leadId: job.leadId, retryAt: new Date(job.scheduledAt).toISOString() },
        "Queue job rescheduled for retry"
      );
    } else {
      logger.warn({ jobId: job.id, leadId: job.leadId }, "Queue job exhausted max retries — dropping");
    }
  } finally {
    isProcessing = false;
    // Continue processing remaining jobs
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
      scheduledAt: new Date(j.scheduledAt).toISOString(),
    })),
  };
}

/** Remove all jobs for a lead (e.g. when lead is cancelled or deleted) */
export function dequeueLeadJobs(leadId: number) {
  const before = queue.length;
  const removed = queue.filter((j) => j.leadId === leadId).length;
  queue.splice(0, queue.length, ...queue.filter((j) => j.leadId !== leadId));
  if (removed > 0) {
    logger.info({ leadId, removed }, "Removed lead jobs from queue");
  }
  return removed;
}
