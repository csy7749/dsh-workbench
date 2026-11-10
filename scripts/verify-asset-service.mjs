// 资产库服务自检：视图决策（进入/刷新该不该复查）+ 真实进程的起/复用/退出/再起。
//
// 为什么必须起真进程：老大点名的缺口是「首次就绪后服务退出，再进入视图不复查」。
// 这条边界用假实现测不出来——只有真起一个进程、真把它关掉、再真拉一次，
// 才能证明「退出后能自己恢复」。所以这里在临时目录里造一个假资产库
// （node_modules/tsx/dist/cli.mjs + src/web.ts），该 cli 只干一件事：起 HTTP 服务吐页面标记。
//
// 两条隔离性要求（验收时被点出来的，别再写死）：
//  ① 端口必须运行时分配。写死 4188 在用户机器上可能正好被别的服务占着，
//     而宿主探测认的是「端口上有没有资产库页面标记」——被占就会误判成本库已在跑。
//  ② 临时目录清理失败必须报错。Windows 上子进程没退干净时 rmSync 会 EPERM，
//     吞掉异常只会留下垃圾还以为过了；所以先等进程退出，删不掉就明确判失败。
//
// 用法：node scripts/verify-asset-service.mjs（无外网、不碰真 4173、不碰真资产库目录）
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  ✓', name) } else { fail += 1; console.log('  ✗', name, detail) }
}

/** 让系统分一个当前空闲的端口：绑 0 取 returned port 再关，避免与用户机器上已有服务撞车。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/* ---------- 0. 造一个假资产库 ----------
   目录全部落在系统临时目录，端口运行时分配。假 cli.mjs 的职责就是把
   ASSET_LIBRARY_PORT 上的页面跑起来；web.ts 内容是空文件，因为待测的是宿主侧
   的生命周期，不是资产库页面本身。 */
const SANDBOX = join(tmpdir(), `wbasset-${process.pid}-${Date.now()}`)
const FAKE_LIB = join(SANDBOX, 'lib')
const FAKE_BROKEN = join(SANDBOX, 'broken')
const FAKE_MISSING = join(SANDBOX, 'nope')
/* 兜底上报：正常路径走 finally 清理；真异常退出时至少让人知道目录在哪，别静默。 */
let cleanupDone = false
process.on('exit', code => {
  if (!cleanupDone) console.error(`[verify-asset-service] 未完成清理，临时目录可能残留：${SANDBOX}（退出码 ${code}）`)
})

mkdirSync(join(FAKE_LIB, 'node_modules', 'tsx', 'dist'), { recursive: true })
mkdirSync(join(FAKE_LIB, 'src'), { recursive: true })
writeFileSync(join(FAKE_LIB, 'src', 'web.ts'), '// 假资产库入口，内容不参与断言\n')

const FAKE_CLI = `
import { createServer } from 'node:http'
const port = Number(process.env.ASSET_LIBRARY_PORT || 4173)
const html = '<title>资产库 · Unity Asset Store</title><body>fake</body>'
createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) }).listen(port, '127.0.0.1')
`
writeFileSync(join(FAKE_LIB, 'node_modules', 'tsx', 'dist', 'cli.mjs'), FAKE_CLI)

/* 第二个假库：cli 立刻以退出码 1 结束，用来看「起不来时是否立刻失败」而不是白等 25 秒。
   它不监听端口，所以与第一个库共用同一个分配出来的端口没有冲突。 */
mkdirSync(join(FAKE_BROKEN, 'node_modules', 'tsx', 'dist'), { recursive: true })
mkdirSync(join(FAKE_BROKEN, 'src'), { recursive: true })
writeFileSync(join(FAKE_BROKEN, 'src', 'web.ts'), '// 同上\n')
writeFileSync(join(FAKE_BROKEN, 'node_modules', 'tsx', 'dist', 'cli.mjs'), `console.error('boom: fake asset library cannot start'); process.exit(1)\n`)

const PORT = await freePort()
check('测试端口是运行时分配的，且不是真库的 4173', PORT !== 4173 && Number.isInteger(PORT) && PORT > 1024, String(PORT))
console.log(`  · 本次使用临时端口 ${PORT}`)

process.env.ASSET_LIBRARY_PORT = String(PORT)
process.env.DSH_ASSET_LIBRARY_DIR = FAKE_LIB

const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)

try {
  /* ---------- 1. 视图决策（纯函数）----------
     这两条就是老大指的缺口：ready 之后服务退出，再进入必须复查；
     而 renderAll 每次重绘都会调用，非「进入」一律不许请求。 */
  console.log('\n[1] 视图决策：进入/刷新该不该复查')
  const need = ['shouldProbeOnEnter', 'shouldProbeOnReload', 'phaseAfterProbe', 'shouldReloadFrame']
  for (const key of need) check(`导出 ${key}`, typeof host[key] === 'function', typeof host[key])

  check('首次进入（idle）要复查', host.shouldProbeOnEnter(true, 'idle') === true)
  check('已就绪后再进入仍要复查（服务可能已退出）', host.shouldProbeOnEnter(true, 'ready') === true, '这正是原缺口')
  check('失败态再进入要复查（给用户恢复机会）', host.shouldProbeOnEnter(true, 'failed') === true)
  check('启动中进入不叠加请求', host.shouldProbeOnEnter(true, 'starting') === false)
  check('非进入的重绘一律不请求', host.shouldProbeOnEnter(false, 'ready') === false && host.shouldProbeOnEnter(false, 'idle') === false)
  check('刷新：就绪态也要复查', host.shouldProbeOnReload('ready') === true)
  check('刷新：失败态可重试', host.shouldProbeOnReload('failed') === true)
  check('刷新：启动中不叠加', host.shouldProbeOnReload('starting') === false)
  check('探测成功 → ready', host.phaseAfterProbe(true) === 'ready')
  check('探测失败 → failed（带原因给重试）', host.phaseAfterProbe(false) === 'failed')
  check('刷新且仍在跑 → 重载 iframe', host.shouldReloadFrame('reload', 'ready', true) === true)
  check('进入时 iframe 已在 → 不重载（避免闪）', host.shouldReloadFrame('enter', 'ready', true) === false)
  check('服务没在跑 → 不重载 iframe（该走启动）', host.shouldReloadFrame('reload', 'ready', false) === false)

  /* ---------- 2. 真实进程：起 → 复用 → 退出 → 再起 ---------- */
  console.log('\n[2] 真实进程生命周期')
  const before = await host.getAssetServiceStatus()
  check('初始未运行', before.running === false && before.ok === false, JSON.stringify(before))

  const t0 = Date.now()
  const first = await host.ensureAssetService()
  const firstMs = Date.now() - t0
  check('首次 ensure 起服成功', first.running === true && first.ok === true, JSON.stringify(first))
  check('返回里 starting 已归位（不是 running+starting 并存）', first.starting === false, JSON.stringify(first))

  const again = await host.ensureAssetService()
  check('再次 ensure 复用同一进程', again.running === true && again.ownedByUs === true, JSON.stringify(again))

  /* 并发去重：同时打三次，只能有一个进程（做不到的话第二次会撞端口后报错）。 */
  const raced = await Promise.all([host.ensureAssetService(), host.ensureAssetService(), host.ensureAssetService()])
  check('并发 ensure 全部返回运行中', raced.every(s => s.running === true))

  console.log('  · 首次起服耗时', `${firstMs}ms`)
  check('首次起服没有白等满超时预算', firstMs < 8000, `${firstMs}ms`)

  /* 关键一条：把服务关掉，模拟「用户看了一会儿，服务在后台退出」。
     await 而不是裸 kill——必须等进程真退出，否则下一步的目录清理会撞文件占用。 */
  const stopped = await host.stopAssetService()
  check('stopAssetService 等到进程退出', stopped === true, String(stopped))
  const down = await host.getAssetServiceStatus()
  check('停止后端口确实关了（服务真的退出了）', down.running === false, JSON.stringify(down))

  /* 再进入视图 → 必须能自己起来。这就是缺口修复后应有的行为。 */
  const restarted = await host.ensureAssetService()
  check('服务退出后再次 ensure 能自动重启', restarted.running === true && restarted.ok === true, JSON.stringify(restarted))
  check('自动重启后仍是本宿主拉起的进程', restarted.ownedByUs === true, JSON.stringify(restarted))
  check('重启后再 stop 也能等到退出', (await host.stopAssetService()) === true)

  /* ---------- 3. 起不来的边界：不许白等 25 秒 ---------- */
  console.log('\n[3] 起不来时的失败路径')
  process.env.DSH_ASSET_LIBRARY_DIR = FAKE_BROKEN
  const t1 = Date.now()
  const broken = await host.ensureAssetService()
  const brokenMs = Date.now() - t1
  check('子进程立即退出 → 判失败', broken.running === false && broken.ok === false, JSON.stringify(broken))
  check('失败原因带上退出码与 stderr 尾巴', /退出码|boom/.test(broken.lastError), broken.lastError)
  check('没有白等 25 秒超时（<8s 返回）', brokenMs < 8000, `${brokenMs}ms`)

  process.env.DSH_ASSET_LIBRARY_DIR = FAKE_MISSING
  const t2 = Date.now()
  const missing = await host.ensureAssetService()
  check('目录不存在 → 明确报错而不是超时', /目录不存在/.test(missing.lastError), missing.lastError)
  check('目录不存在立即返回', Date.now() - t2 < 3000, `${Date.now() - t2}ms`)
} finally {
  /* ---------- 4. 清理：必须真的干净，失败要判错 ----------
     顺序不能变：先关进程并等它退出 → 再删目录。反过来在 Windows 上必 EPERM。 */
  console.log('\n[4] 清理')
  let stopped = false
  try {
    stopped = await host.stopAssetService()
  } catch (cause) {
    check('清理：关闭子进程时未抛异常', false, String(cause))
  }
  check('清理：托管的子进程已全部退出', stopped === true, String(stopped))

  const afterStop = await host.getAssetServiceStatus().catch(() => ({ running: null }))
  check('清理：测试结束后没有残留监听', afterStop.running === false, JSON.stringify(afterStop))

  /* 这里刻意不吞异常：删不掉就是没清理干净，必须让整个脚本失败，不能静默掩盖。 */
  let removeError = ''
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch (cause) {
    removeError = String(cause?.message ?? cause)
  }
  check('清理：临时目录已删除', removeError === '', removeError)
  if (removeError === '') cleanupDone = true
}

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail > 0) process.exitCode = 1
