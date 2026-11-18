import assert from 'node:assert/strict'
import { readGenerationResult } from '../src/workflow/session-result.mjs'
const text = text => ({ content: [{ type: 'text', text }] })
const user = (seq, prompt) => ({ seq, type: 'user/message', data: { message: text(prompt) } })
const answer = (seq, value) => ({ seq, type: 'assistant/message', data: { message: text(value) } })
const end = (seq, kind = 'completed') => ({ seq, type: 'turn/end', data: { reason: { kind } } })
const binding = { prompt: 'attempt:unique generate rules', afterSeq: 3 }
const prior = [user(1, 'old'), answer(2, 'old result'), end(3)]
assert.equal(readGenerationResult(prior, binding).status, 'pending')
assert.equal(readGenerationResult([...prior, user(4, binding.prompt), answer(5, 'partial')], binding).status, 'pending')
assert.deepEqual(readGenerationResult([end(6), answer(5, 'final'), user(4, binding.prompt), ...prior], binding), { status: 'completed', content: 'final', messageSeq: 5, endSeq: 6 })
assert.equal(readGenerationResult([user(4, binding.prompt), answer(5, 'partial'), end(6, 'aborted')], binding).status, 'failed')
assert.equal(readGenerationResult([user(4, binding.prompt), { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private thought' }] } } }, end(6)], binding).reason, 'generation_empty_result')
assert.equal(readGenerationResult([user(4, binding.prompt), user(5, 'unrelated'), answer(6, 'wrong'), end(7)], binding).reason, 'generation_interleaved_turn')
assert.equal(readGenerationResult([user(4, 'different prompt'), answer(5, 'wrong'), end(6)], binding).status, 'pending')
assert.equal(readGenerationResult([user(4, binding.prompt), answer(5, 'progress'), answer(6, 'final'), end(7)], binding).content, 'final')
console.log('PASS: exact prompt, cursor, completion, abort, reasoning exclusion, interleaving, unrelated turns, final response')
