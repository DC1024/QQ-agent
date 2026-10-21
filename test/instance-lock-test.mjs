// 实例锁回归测试
//
// 重点覆盖 2026-10-21 踩到的坑：容器重启后 PID 从低序号重新分配，
// 残留锁文件里记的旧 PID 恰好被新容器里的另一个进程占用 →
// 只看"PID 还活着"会误判成活锁 → 容器无限重启循环，只能手动删锁文件。
//
// 修法：锁文件记 "PID:启动标识"，启动标识取 /proc/<pid>/stat 的 starttime，
// 用来区分"同一个进程实例"和"PID 被复用后的另一个进程"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lock-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const lock = await import('../src/instance-lock.js');
const lockFile = path.join(dataDir, 'qq-agent.lock');

let pass = 0;
let fail = 0;
const bad = [];
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; bad.push(name); console.log(`  FAIL ${name}  ${e.message}`); }
}

const isLinux = process.platform === 'linux';

/** 取某进程的启动标识（与 src/instance-lock.js 同一套解析） */
function startToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] || null;
  } catch { return null; }
}

console.log('\n=== 1. 基本抢锁 / 释放 ===');
check('首次抢锁成功', () => {
  lock.releaseInstanceLock();
  const r = lock.acquireInstanceLock();
  assert.equal(r.ok, true, r.reason ?? '');
});
check('锁文件记录本进程 PID', () => {
  const raw = fs.readFileSync(lockFile, 'utf8');
  assert.ok(raw.includes(String(process.pid)), `锁文件内容：${raw}`);
});
check('释放后可再抢', () => {
  lock.releaseInstanceLock();
  const r = lock.acquireInstanceLock();
  assert.equal(r.ok, true, r.reason ?? '');
});

console.log('\n=== 2. 残留锁（PID 已死）应被抢占 ===');
check('死进程的锁可抢占', () => {
  lock.releaseInstanceLock();
  // 找一个几乎不可能存在的 PID
  fs.writeFileSync(lockFile, '999999');
  const r = lock.acquireInstanceLock();
  assert.equal(r.ok, true, r.reason ?? '');
});

console.log('\n=== 3. 旧格式锁（无启动标识）保持保守语义 ===');
// 用同命名空间内 spawn 出来的子进程当"另一个活着的实例"：
// 不能用 process.ppid —— 容器里 docker exec 起的进程，其父进程在宿主 PID
// 命名空间，容器内 /proc 看不到它，pidAlive 会误判为死。
const { spawn } = await import('node:child_process');
const helper = spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore'
});
await new Promise((r) => setTimeout(r, 400));
const helperPid = helper.pid;
const helperToken = startToken(helperPid);
console.log(`  （参照实例 PID=${helperPid} 启动标识=${helperToken ?? '无（该平台无 /proc）'}）`);

check('活进程 + 无 token → 仍然拒绝（行为不变）', () => {
  lock.releaseInstanceLock();
  fs.writeFileSync(lockFile, String(helperPid));
  const r = lock.acquireInstanceLock();
  assert.equal(r.ok, false, '应当拒绝启动');
  assert.ok(/已有 QQ Agent 实例在运行/.test(r.reason ?? ''), r.reason ?? '');
});

if (isLinux) {
  console.log('\n=== 4. PID 复用场景（Linux 专有）===');
  check('PID 存活但启动标识不同 → 判定残留锁，可抢占', () => {
    lock.releaseInstanceLock();
    assert.ok(helperToken, '应能读到子进程 starttime');
    // 模拟：残留锁记着这个 PID，但那是另一个（早已退出的）进程实例
    fs.writeFileSync(lockFile, `${helperPid}:${helperToken === '999' ? '998' : '999'}`);
    const r = lock.acquireInstanceLock();
    assert.equal(r.ok, true, `PID 复用应可抢占，实际：${r.reason ?? ''}`);
  });

  check('PID 存活且启动标识一致 → 判定活锁，拒绝启动', () => {
    lock.releaseInstanceLock();
    assert.ok(helperToken, '应能读到子进程 starttime');
    fs.writeFileSync(lockFile, `${helperPid}:${helperToken}`);
    const r = lock.acquireInstanceLock();
    assert.equal(r.ok, false, '同一进程实例应拒绝启动');
    assert.ok(/已有 QQ Agent 实例在运行/.test(r.reason ?? ''), r.reason ?? '');
  });

  check('本进程自己的残留锁（PID 相同）→ 可抢占', () => {
    lock.releaseInstanceLock();
    fs.writeFileSync(lockFile, `${process.pid}:${startToken(process.pid) ?? 'x'}`);
    const r = lock.acquireInstanceLock();
    assert.equal(r.ok, true, r.reason ?? '');
  });
} else {
  console.log('\n=== 4. PID 复用场景：非 Linux，跳过 ===');
  console.log('  （/proc 只在 Linux 存在，该用例请在容器里跑）');
}

console.log('\n=== 5. 跨进程互斥（真有两个实例）===');

{
  lock.releaseInstanceLock();
  try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  const moduleUrl = new URL('../src/instance-lock.js', import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    m.acquireInstanceLock();
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程 5 秒内没抢到锁')), 5000);
      const iv = setInterval(() => {
        if (fs.existsSync(lockFile)) { clearInterval(iv); clearTimeout(timer); resolve(); }
      }, 100);
    });
    const r = lock.acquireInstanceLock();
    assert.equal(r.ok, false, '子进程真在持锁时应抢不到');
    assert.ok(/已有 QQ Agent 实例在运行/.test(r.reason ?? ''), r.reason ?? '');
    pass += 1;
    console.log('  ok   子进程持锁时本进程抢锁失败');
  } catch (e) {
    fail += 1; bad.push('子进程持锁时本进程抢锁失败');
    console.log(`  FAIL 子进程持锁时本进程抢锁失败  ${e.message}`);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
}

lock.releaseInstanceLock();
try { helper.kill(); } catch { /* ignore */ }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：', bad.join(' | ')); process.exit(1); }
