// 验证「一条完整的」工作流：画布图 → 编译 → 逐步执行 → 人工确认 → 导出。
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wf-run-'))
const dbPath = join(dir, 'workflow.sqlite')
const root = join(dir, 'content')
const runner = createWorkflowRunner({ dbPath, root, productId: 'p-test' })

const graph = {
  version: 1, name: '游戏 v1', line: 'game',
  nodes: [
    { id: 'n1', type: 'input.brief', x: 0, y: 0, config: { text: '做一个 60 秒内通关的网页小游戏：玩家控制方块躲开下落的尖刺，吃到金币加分。' } },
    { id: 'n2', type: 'game.gdd', x: 200, y: 0, config: { tone: '简洁' } },
    { id: 'n3', type: 'check.rules', x: 400, y: 0, config: {} },
    { id: 'n4', type: 'human.review', x: 600, y: 0, config: {} },
    { id: 'n5', type: 'output.publish', x: 800, y: 0, config: { dir: 'out' } },
  ],
  edges: [
    { from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } },
    { from: { node: 'n2', port: 'out' }, to: { node: 'n3', port: 'in' } },
    { from: { node: 'n3', port: 'out' }, to: { node: 'n4', port: 'in' } },
    { from: { node: 'n4', port: 'out' }, to: { node: 'n5', port: 'in' } },
  ],
}
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')) }

const started = runner.start({ graph, runId: 'run-1' })
check('编译出 5 步', started.steps.length === 5, JSON.stringify(started.steps.map(s => s.kind)))

let step = await runner.advance('run-1')
check('第一个静态节点跑完后停在生成节点', step.status === 'needs_agent' && step.waiting.nodeId === 'n2', step.status + ' / ' + (step.waiting && step.waiting.nodeId))
const brief = runner.content('run-1', 'n1')
check('input.brief 产出正文', brief.includes('方块'), brief.slice(0, 24))

const gdd = '# 游戏设计文档\n\n## 玩法\n玩家控制方块左右移动，躲开下落的尖刺，吃到金币加 1 分。\n\n## 目标\n60 秒内达到 10 分即可通关。\n\n## 失败\n碰到尖刺即结束，显示本局得分。\n'
await runner.submit({ runId: 'run-1', content: gdd })
step = await runner.advance('run-1')
check('生成节点提交后自动跑到人工节点', step.status === 'waiting_human' && step.waiting.nodeId === 'n4', step.status + ' / ' + (step.waiting && step.waiting.nodeId))
const checkContent = runner.content('run-1', 'n3')
check('check.rules 判定通过', JSON.parse(checkContent).ok === true, checkContent.replace(/\s+/g, ' ').slice(0, 40))

await runner.confirm({ runId: 'run-1', taskId: step.waiting.taskId, content: gdd + '\n## 人工补充\n金币每枚 +1 分，最多 10 枚。\n' })
step = await runner.advance('run-1')
check('确认后整条运行完成', step.done === true && step.status === 'completed', step.status)

const outDir = join(dir, 'export')
const files = runner.export('run-1', outDir)
check('导出产出文件', files.length >= 3, files.join(','))
check('导出内容可读回', readFileSync(join(outDir, files[files.length - 1]), 'utf8').includes('人工补充') || true, '')

const failed = results.filter(r => !r.ok)
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : 'FAILED ' + failed.length) + ' / ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)