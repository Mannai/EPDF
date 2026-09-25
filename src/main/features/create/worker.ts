import { serveJob } from '../../jobs/serveJob'
import { runOp, type WorkerRequest } from './workerOps'

// One worker file for every heavy operation of Create PDF / Combine (see workerOps.ts).
serveJob<WorkerRequest, unknown>((req, report) => runOp(req as never, report))
