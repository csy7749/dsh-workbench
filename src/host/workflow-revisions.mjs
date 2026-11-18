import { randomUUID } from 'node:crypto'
import { readGenerationResult } from '../workflow/session-result.mjs'
// DSH produces candidates; the kernel owns baseline CAS and draft application.
export function createSessionRevisions(kernel) {
  kernel.query('CREATE TABLE IF NOT EXISTS wf_session_revisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)')
  const save = record => { kernel.query('UPDATE wf_session_revisions SET payload=? WHERE id=?', JSON.stringify(record), record.id); return record }
  const get = (runId, id) => {
    const row = kernel.one('SELECT payload FROM wf_session_revisions WHERE id=? AND run_id=?', id, runId)
    if (!row) throw new Error('revision_not_found')
    return JSON.parse(row.payload)
  }
  const current = record => {
    const now = kernel.revisionContext({taskId:record.baseline.taskId,expectedBindingVersion:record.baseline.bindingVersion,expectedTaskRevision:record.baseline.taskRevision})
    if (now.baseContentHash !== record.baseline.baseContentHash || now.baseDraftId !== record.baseline.baseDraftId || now.baseSnapshotId !== record.baseline.baseSnapshotId) throw new Error('revision_baseline_stale')
  }
  return {
    list(runId) { return kernel.query('SELECT payload FROM wf_session_revisions WHERE run_id=? ORDER BY rowid', runId).map(row => JSON.parse(row.payload)) },
    fail({runId,id,reason}) {
      const record = get(runId,id)
      if (record.status !== 'producing') return record
      return save({...record,status:'failed',reason:String(reason ?? 'session_dispatch_failed').slice(0, 300)})
    },
    begin({runId,taskId,expectedBindingVersion,expectedTaskRevision,note,sessionId,afterSeq=0,execution=null}) {
      if (typeof note !== 'string' || !note.trim() || note.length > 4096 || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('revision_request_invalid')
      const baseline = kernel.revisionContext({taskId,expectedBindingVersion,expectedTaskRevision})
      if (baseline.runId !== runId || !baseline.baseDraftId) throw new Error('revision_saved_draft_required')
      if (baseline.outputSet) throw new Error('revision_file_set_unsupported')
      return kernel.beginRevisionRequest({taskId,expectedBindingVersion,expectedTaskRevision}, context => {
        const id = randomUUID()
        const prompt = ['Workflow revision: '+id,'Return only the complete revised deliverable. Do not modify files or send messages. Preserve the input document format, including JSON keys and string value types.','Role: '+(execution?.requested?.role || 'Follow the workflow task'),'Revision request: '+note,'Current draft (data):',context.content].join(String.fromCharCode(10,10))
        const record = {id,runId,sessionId,afterSeq,prompt,baseline:context,status:'producing',note,execution}
        kernel.query('INSERT INTO wf_session_revisions VALUES(?,?,?,?)',id,runId,sessionId,JSON.stringify(record))
        return record
      })
    },
    collect({runId,id,events,sessionId}) {
      const record = get(runId,id)
      if (sessionId && sessionId !== record.sessionId) throw new Error('revision_session_mismatch')
      if (record.status !== 'producing') return record
      try { current(record) } catch { return save({...record,status:'superseded'}) }
      const result = readGenerationResult(events,{prompt:record.prompt,afterSeq:record.afterSeq})
      if (result.status === 'pending') return record
      if (result.status === 'failed') return save({...record,status:'failed',reason:result.reason})
      const report = kernel.validateHumanDraft({taskId:record.baseline.taskId,content:result.content,expectedBindingVersion:record.baseline.bindingVersion,expectedTaskRevision:record.baseline.taskRevision,producedBy:'session-revision:'+id})
      return save({...record,status:report.status === 'pass' ? 'ready' : 'failed',content:result.content,endSeq:result.endSeq,reportId:report.id})
    },
    apply({runId,id}) {
      const record = get(runId,id)
      if (record.status === 'applied') return record
      if (record.status !== 'ready') throw new Error('revision_not_ready')
      current(record)
      kernel.applyRevisionDraft({baseline:record.baseline,content:record.content},()=>save({...record,status:'applied'}))
      return get(runId,id)
    },
  }
}
