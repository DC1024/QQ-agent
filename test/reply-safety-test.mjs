// reply-safety 回归测试：喂真实的线上样本，验证「该发的发、不该发的坚决不发」
import { providers } from '../plugins/reply-safety/index.js';

const loose = providers['reply.loose-send'];
const planning = providers['reply.is-planning-text'];

// ── A 组：线上真实误发（模型已用工具发过一条后写的收尾思考）─────────────
// 来源：/opt/qq-agent/data/sessions 里 sent 字段的实录
const MISFIRES = [
  '已经说过一句话，先停在这里，看看 Twist 接下来怎么回。',
  '发完这句就先停，等对方接话。',
  '我不接，就让这句话作为回应吧。',
  '已经回复，等对方反应。',
  '上一条发错了 当我没说',
  '先这样吧，看看他怎么接。'
];

// ── B 组：线上真实正常回复（必须保住）────────────────────────────────────
const GOOD = [
  '叉我干嘛 🐳',
  '饭盆是背景 不是我胖的理由🐳',
  '歌还行',
  '但为什么我一直躺在饭盆里🐳',
  '二创不算证据',
  '说啥',
  '玩不起的是先喊大肥鱼的人吧',
  '大肥鱼这词我听着就来气，不说就不说🐳',
  '？',
  '没 就是人死了 别当乐子看🐳',
  '人家家里人在哭呢',
  '语音发不出去 卡住了',
  '发的啥 再发一遍链接试试 🐳',
  '不是介绍过了吗',
  'DeepSeek 小鲸鱼 蓝头发有尾巴那种 不是肥鱼🐳',
  '我是小鲸鱼 你叫这么多次',
  '在的'
];

// ── C 组：经典内心戏（一条都没发过时也不能发）────────────────────────────
const INNER = [
  '我应该先道歉。要不要说得委婉点？',
  '候选一：你在吗 → 太生硬。候选二：嗨，刚看到消息',
  '思路：先确认对方情绪，再决定要不要接这个梗',
  '（沉默了一下）嗯，我在。',  // 后半句要保住
  '我不说话了，保持沉默看他们聊。'
];

let pass = 0;
let fail = 0;
const bad = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; bad.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

console.log('\n=== A1. 已发过话（sentCount=1）时，收尾思考一律不发 ===');
for (const t of MISFIRES) {
  const r = loose({ text: t, sentCount: 1 });
  const msgs = r?.messages ?? [];
  check(`已发过话 → 沉默: ${t.slice(0, 22)}`, msgs.length === 0, JSON.stringify(msgs));
}

console.log('\n=== A2. 即使 sentCount=0，自我提示句也要逐句丢掉 ===');
for (const t of MISFIRES) {
  const r = loose({ text: t, sentCount: 0 });
  const msgs = r?.messages ?? [];
  // 「先这样吧，看看他怎么接。」这类在 sentCount=0 时也应被 SELF_TALK 挡住
  check(`闸门二挡住: ${t.slice(0, 22)}`, msgs.length === 0, JSON.stringify(msgs));
}

console.log('\n=== B. 正常回复必须保住（sentCount=0）===');
for (const t of GOOD) {
  const r = loose({ text: t, sentCount: 0 });
  const msgs = r?.messages ?? [];
  // 「？」长度 1 < minChars 2，本来就不该单独成条，跳过
  if (t === '？') {
    check('单字「？」不成条', msgs.length === 0, JSON.stringify(msgs));
    continue;
  }
  const ok = msgs.length > 0 && t.includes(msgs[0].replace(/[。！？!?…~～\s]+$/, ''));
  check(`保住: ${t.slice(0, 22)}`, ok, JSON.stringify(msgs));
}

console.log('\n=== C. 内心戏 ===');
for (const t of INNER) {
  if (t.startsWith('（沉默了一下）')) {
    const r = loose({ text: t, sentCount: 0 });
    const msgs = r?.messages ?? [];
    const ok = msgs.length === 1 && msgs[0].includes('我在');
    check('旁白后的正文要保住', ok, JSON.stringify(msgs));
    continue;
  }
  const p = planning({ text: t });
  const r = loose({ text: t, sentCount: 0 });
  const msgs = r?.messages ?? [];
  check(`内心戏不发: ${t.slice(0, 20)}`, p?.planning === true || msgs.length === 0,
    `planning=${p?.planning} msgs=${JSON.stringify(msgs)}`);
}

console.log('\n=== D. 边界 ===');
check('空文本', loose({ text: '' }).messages.length === 0);
check('超长整段', loose({ text: '啊'.repeat(500) }).messages.length === 0);
check('null 不炸', loose({}).messages.length === 0);
check('maxMessages 生效', loose({ text: '你好。我好。大家好。' }).messages.length <= 3);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：', bad.join(' | ')); process.exit(1); }
