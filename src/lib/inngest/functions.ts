import { preMeetingScan, preMeetingDispatch } from './pre-meeting'
import {
  deliveryDropboxScan,
  deliverySpecsScan,
  deliveryJobNotifier,
  deliveryStaleSweep,
} from './delivery-crons'
import { studioKnowledgeAutoSummarize } from './studio-knowledge-cron'
import { brainDeadlineSweep, brainScavengerScan, brainConsolidate } from './brain-crons'
import { driveTranscriptScan } from './drive-transcripts'
import { plaudTranscriptScan } from './plaud-transcripts'
import { healthWatchdog } from './health-cron'
import { healthDailyDigest } from './health-digest'
import { projectControlSync, projectControlSyncOnEdit } from './project-control-sync'
import { selectRegisteredFunctions } from './registration'
import { archivePublisher } from '../archive/workflow'

/** Canonical Kit Inngest function list, kept outside the Next route module. */
export const inngestFunctions = [
  preMeetingScan,
  preMeetingDispatch,
  deliveryDropboxScan,
  deliverySpecsScan,
  deliveryJobNotifier,
  deliveryStaleSweep,
  studioKnowledgeAutoSummarize,
  brainDeadlineSweep,
  brainScavengerScan,
  brainConsolidate,
  driveTranscriptScan,
  plaudTranscriptScan,
  healthWatchdog,
  healthDailyDigest,
  projectControlSync,
  projectControlSyncOnEdit,
  archivePublisher,
]

/** Exact fail-closed list registered by the API adapter. */
export const registeredFunctions = selectRegisteredFunctions(inngestFunctions)
