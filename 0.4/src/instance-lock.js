// 进程单实例锁：确保同一数据目录下只有一个 QQ Agent 核心在跑。
//
// 为什么需要（Electron 的 requestSingleInstanceLock 管不到的场景）：
//   - Electron 桌面端 + `npm run server` headless 同时启动 → 两份核心
//   - 双击 .bat 又手动 node src/server.js → 两份核心
//   两份核心会双份连 OneBot、双份处理群消息 → 群里看到重复回复。
//
// 原理：在数据目录放一个 qq-agent.lock 文件，内容 = PID。
//   启动时若锁文件存在且对应进程仍活着 → 判定已有实例，拒绝启动；
//   锁文件存在但进程已死（上次异常退出残留）→ 抢占锁，继续启动。
//   正常退出 / 被 kill 时删除锁文件。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOCK_FILE = path.join(DATA_DIR, 'qq-agent.lock');

/** 进程是否还活着（Windows / POSIX 通用：signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号（别的用户），也算活着
    return error?.code === 'EPERM';
  }
}

/**
 * 进程的启动标识（Linux）：/proc/<pid>/stat 的 starttime 字段 —— 进程启动以来的时钟滴答数。
 *
 * 为什么需要它：容器每次重启 PID 都从低序号重新分配，残留锁文件里记的旧 PID
 * 可能恰好被新容器里的另一个进程占用。只看"PID 还活着"会把残留锁误判成活锁，
 * 结果是容器永远起不来（2026-10-21 实测：锁里记 8，新进程是 7，
 * 而容器内 PID 8 确实存活 → 无限重启循环，只能手动删锁文件）。
 * 带上 starttime 就能区分"同一个进程实例"和"PID 被复用后的另一个进程"。
 *
 * 非 Linux（Windows 桌面端）没有 /proc，返回 null —— 此时退回纯 PID 判定，
 * 行为与改造前完全一致。
 */
function processStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 字段可能含空格和括号，从最后一个 ')' 之后切
    // 字段序：pid(1) comm(2) state(3) … starttime(22)
    // 去掉 pid/comm 后 state 是下标 0，starttime 是下标 19
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}

/** 写进锁文件的内容：PID + 启动标识（拿不到启动标识时只写 PID，保持旧格式）。 */
function buildLockContent() {
  const token = processStartToken(process.pid);
  return token ? `${process.pid}:${token}` : String(process.pid);
}

/** 解析锁文件：{ pid, token }。旧格式（纯数字）token 为 null。 */
function readLock() {
  try {
    const raw = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
    const sep = raw.indexOf(':');
    const pid = Number(sep >= 0 ? raw.slice(0, sep) : raw) || null;
    const token = sep >= 0 ? (raw.slice(sep + 1) || null) : null;
    return { pid, token };
  } catch {
    return { pid: null, token: null };
  }
}

/**
 * 判断锁的持有者是不是"当前这个 PID 对应的进程实例"。
 *
 * 已知活锁（有另一个实例真在跑）→ true
 * PID 被复用（残留锁）→ false
 * 信息不足（无 token 或读不到）→ true（保守：宁可拒绝启动，也不双开）
 */
function isSameInstance(lock) {
  if (!lock.token) return true;
  const current = processStartToken(lock.pid);
  if (!current) return true;
  return current === lock.token;
}

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再读 PID 判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* 忽略，下面写文件会再试 */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：仅当文件不存在时创建，已存在则抛 EEXIST —— 原子操作，无竞态窗口
      fs.writeFileSync(LOCK_FILE, buildLockContent(), { flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `无法写入实例锁文件：${error?.message ?? error}` };
      }
      // 锁文件已存在：读 PID 判断是否活锁
      const lock = readLock();
      if (lock.pid && lock.pid !== process.pid && pidAlive(lock.pid) && isSameInstance(lock)) {
        return { ok: false, reason: `已有 QQ Agent 实例在运行（PID ${lock.pid}）`, existingPid: lock.pid };
      }
      // 残留锁（进程已死 / PID 被复用 / 锁是自己上次异常留下的）：
      // 删掉，下一轮用 wx 重新抢
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
    }
  }
  return { ok: false, reason: '实例锁被占用且无法清除（可能有实例正在启动）' };
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  try {
    // 只删自己的锁：万一锁被新实例抢走了，不能误删
    if (readLock().pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 文件不存在/读不出都无所谓 */ }
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  const cleanup = () => releaseInstanceLock();
  // 锁的**唯一**释放时机是 'exit' 钩子：SIGINT 时立即释放会让优雅退出
  //（server.js 的 await app.stop()，可能数秒）期间新实例抢先拿锁、
  // 与旧实例短暂并存（双核心 = 群里重复回复）。交给 exit 钩子则天然
  // 排在进程真正结束之后，无竞态窗口。
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // ⚠️ 不做任何事：不退出、不提前释放锁 —— 优雅退出 handler
      //   （server.js / electron）紧随其后执行，最终 process.exit 触发
      //   上面的 'exit' 钩子释放锁。
      // 保险丝：若 30 秒内没有别的 handler 退出进程（异常场景，优雅退出
      // 挂死），强制退出 —— 用非零码，让外层（守护脚本）能识别异常退出。
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}
