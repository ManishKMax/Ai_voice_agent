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

export function enqueueLead(leadId: number, delayMs = 0) {
  const job: QueueJob = {
    id: `lead-${leadId}-${Date.now()}`,
    leadId,
    attempts: 0,
    scheduledAt: Date.now() + delayMs,
  };
  queue.push(job);
  logger.info({ leadId, delayMs }, "Lead enqueued");
  scheduleNextProcess();
}

function scheduleNextProcess() {
  if (isProcessing) return;
  const now = Date.now();
  const next = queue.find((j) => j.scheduledAt <= now);
  if (next) {
    processNext();
  } else {
    const earliest = Math.min(...queue.map((j) => j.scheduledAt));
    if (isFinite(earliest)) {
      setTimeout(() => scheduleNextProcess(), earliest - now);
    }
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
    logger.info({ jobId: job.id, leadId: job.leadId, attempt: job.attempts }, "Processing job");
    await processFn(job.leadId);
  } catch (err) {
    logger.error({ err, jobId: job.id, attempt: job.attempts }, "Job failed");
    if (job.attempts < MAX_RETRIES) {
      job.scheduledAt = Date.now() + RETRY_DELAY_MS;
      queue.push(job);
      logger.info({ jobId: job.id, retryAt: new Date(job.scheduledAt) }, "Job scheduled for retry");
    } else {
      logger.warn({ jobId: job.id }, "Job exhausted max retries");
    }
  } finally {
    isProcessing = false;
    scheduleNextProcess();
  }
}

export function getQueueStats() {
  return {
    total: queue.length,
    pending: queue.filter((j) => j.scheduledAt <= Date.now()).length,
    scheduled: queue.filter((j) => j.scheduledAt > Date.now()).length,
    jobs: queue.map((j) => ({ ...j, scheduledAt: new Date(j.scheduledAt) })),
  };
}
