import { parentPort, workerData } from 'node:worker_threads';
import { parseRatingSuppliers } from './rating-excel.js';
import { parseAssignmentWorkbook } from './rating-assignment-import.js';
import { inspectWorkbook, parseWorkbook } from './parser.js';
try {
  const buffer = Buffer.from(workerData.buffer);
  const result = workerData.action === 'ratingAssignments' ? await parseAssignmentWorkbook(buffer) : workerData.action === 'ratingSuppliers' ? await parseRatingSuppliers(buffer) : workerData.action === 'inspect'
    ? await inspectWorkbook(buffer, workerData.options.slotId)
    : await parseWorkbook(buffer, workerData.options);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message, status: error.status || 422, issues: error.issues || [] });
}
