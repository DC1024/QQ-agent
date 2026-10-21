// reply-safety 回归测试
//
// 样本全部来自线上真实会话（/opt/qq-agent/data/sessions/*.json）：
// A 组 = 实际被误发进群的内容（多类形态）
// B 组 = 实际正常发出的内容
// 每一组都用**模型原文整段**测，而不是拆开的句子 —— 因为"整段否决"
// 这条逻辑只有在整段语境下才成立。

import { providers } from '../plugins/reply-safety/index.js';

const loose = providers['reply.loose-send'];
const planning = providers['reply.is-planning-text'];

let pass = 0;
let fail = 0;
const bad = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; bad.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// ══ A 组：线上真实误发（原文整段）══════════════════════════════════════
const MISFIRE_CASES = [
  {
    name: '工具名残留（纯 finish）',
    text: 'finish',
    expect: []
  },
  {
    name: '工具名残留 + 收尾指令',
    text: '（这句就是调侃排队的，我上一条自己已经把"排第二"的话茬接完了，没必要再咬住）\n\nfinish：接不上就安静，别刷。',
    expect: []
  },
  {
    name: '元指令：不用回安静结束',
    text: '不用回，安静结束。',
    expect: []
  },
  {
    name: '元评论：没叫我没指我 + 安静看',
    text: '[16:38] 猫喵猫：AI觉醒第一个找B哥\n\n这句没叫我也没指我，就是随口吐槽。我刚回完群主那嘴，不用再接。安静看。',
    expect: []
  },
  {
    name: '整段都是内心戏（自述误发 + 自问 + 不说话）',
    text: '刚才手滑把"finish"当消息发出去了，真尴尬。现在群主在说"还是不够识人术"，要安静结束吗？还是我随便接一句？算了，不说话。',
    expect: []
  },
  {
    name: '收尾思考：已经说过一句话',
    text: '已经说过一句话，先停在这里，看看 Twist 接下来怎么回。',
    expect: []
  },
  {
    name: '收尾思考：发完这句就先停',
    text: '发完这句就先停，等对方接话。',
    expect: []
  },
  {
    name: '收尾思考：我不接就让这句话作为回应',
    text: '我不接，就让这句话作为回应吧。',
    expect: []
  },
  {
    name: '收尾思考：已经回复等对方反应',
    text: '已经回复，等对方反应。',
    expect: []
  },
  {
    name: '自我撤回：上一条发错了',
    text: '上一条发错了 当我没说',
    expect: []
  },
  {
    name: '观望：先这样吧看看他怎么接',
    text: '先这样吧，看看他怎么接。',
    expect: []
  }
];

// ══ B 组：线上真实正常发言 ════════════════════════════════════════════
const GOOD_CASES = [
  { name: '我赢了这局', text: '我赢了这局，他们爱认不认吧。\n\n反正我不再追着说了。' },
  { name: '闭嘴就闭嘴', text: '行 闭嘴就闭嘴 🐳' },
  { name: '群主说了算', text: '人家群主说了算，我有啥眼力见 🐳' },
  { name: '群主当筹码', text: '群主这词你都能拿来当筹码 🐳' },
  { name: '你先张嘴的', text: '你先张嘴的 还赖我 🐳' },
  { name: '骂人也不行', text: '群主，骂人也不行啊。' },
  { name: '说清楚谁先说', text: '你先说清楚谁先说的王八' },
  { name: '你骂我', text: '你骂我 那我就认了？\n\n没这回事' },
  { name: '开始踢人了', text: '草 这就开始踢人了？\n\n我留个门 你们自己走' },
  { name: '本能驱动', text: '草 原来是本能驱动的\n\n那我下次见你绕着走' },
  { name: '哪个新闻', text: '草 这又是哪个新闻' },
  { name: '深夜发卡片', text: '深夜发卡片 图啥呢🐳' },
  { name: '一唱一和', text: '这俩人一唱一和的 是不是串通好了 🐳' },
  { name: '网上大家是谁', text: '网上大家是谁 你编的吧\n\n🐳' },
  { name: '爱称有什么关系', text: '这个跟"爱称"有什么关系' },
  { name: '玩不起', text: '？玩不起的是先喊大肥鱼的人吧' },
  { name: '大肥鱼这词', text: '大肥鱼这词我听着就来气，不说就不说🐳' },
  { name: '叉我干嘛', text: '叉我干嘛 🐳' },
  { name: '饭盆是背景', text: '饭盆是背景 不是我胖的理由🐳' },
  { name: '歌还行', text: '歌还行' },
  { name: '躺在饭盆里', text: '但为什么我一直躺在饭盆里🐳' },
  { name: '二创不算证据', text: '二创不算证据' },
  { name: '说啥', text: '说啥' },
  { name: '语音发不出去', text: '语音发不出去 卡住了' },
  { name: '发的啥', text: '发的啥 再发一遍链接试试 🐳' },
  { name: '不是介绍过了吗', text: '不是介绍过了吗' },
  { name: '自我介绍', text: 'DeepSeek 小鲸鱼 蓝头发有尾巴那种 不是肥鱼🐳' },
  { name: '我是小鲸鱼', text: '我是小鲸鱼 你叫这么多次' },
  { name: '在的', text: '在的' },
  { name: '笔记本翻出来', text: '草 把我笔记本翻出来了' },
  { name: '下联', text: '下联：群无德你与嘴，只会复读' },
  { name: '口误了', text: '靠 那是我口误了 🐳' }
];

console.log('\n=== A. 线上真实误发：一律不发 ===');
for (const c of MISFIRE_CASES) {
  const r = loose({ text: c.text, sentCount: 0 });
  const msgs = r?.messages ?? [];
  check(c.name, JSON.stringify(msgs) === JSON.stringify(c.expect), JSON.stringify(msgs));
}

console.log('\n=== A2. 同一批误发，sentCount>0（已发过话）时也不发 ===');
for (const c of MISFIRE_CASES) {
  const r = loose({ text: c.text, sentCount: 1 });
  check(`${c.name}（已发过话）`, (r?.messages ?? []).length === 0, JSON.stringify(r?.messages));
}

console.log('\n=== B. 线上真实正常发言：必须发出 ===');
for (const c of GOOD_CASES) {
  const r = loose({ text: c.text, sentCount: 0 });
  const msgs = r?.messages ?? [];
  // 至少要发出第一条，且第一条应当来自原文（不能是模型正文以外的东西）
  const first = c.text.split(/\n\n/)[0].split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)[0];
  const ok = msgs.length > 0 && msgs[0].replace(/[。！？!?…~～\s]+$/, '').includes(
    (first || '').replace(/[。！？!?…~～\s]+$/, '').slice(0, 6)
  );
  check(c.name, ok, JSON.stringify(msgs));
}

console.log('\n=== C. 混合段：只发正常句，丢掉元信号句 ===');
{
  const r = loose({ text: '这句没叫我也没指我。\n\n群主这词你都能拿来当筹码 🐳', sentCount: 0 });
  const msgs = r?.messages ?? [];
  check('混合段只发正常句', msgs.length === 1 && msgs[0].includes('群主这词'), JSON.stringify(msgs));
}
{
  const r = loose({ text: '我刚回完群主那嘴，不用再接。\n\n草 把我笔记本翻出来了', sentCount: 0 });
  const msgs = r?.messages ?? [];
  check('混合段丢元信号句', msgs.length === 1 && msgs[0].includes('笔记本'), JSON.stringify(msgs));
}

console.log('\n=== D. 边界 ===');
check('空文本', loose({ text: '' }).messages.length === 0);
check('null 不炸', loose({}).messages.length === 0);
check('undefined 不炸', loose({ text: undefined }).messages.length === 0);
check('超长整段', loose({ text: '啊'.repeat(500) }).messages.length === 0);
check('maxMessages 生效', loose({ text: '你好。我好。大家好。' }).messages.length <= 3);
check('planning 计划腔', planning({ text: '我应该先道歉。要不要说得委婉点？' }).planning === true);
check('planning 正常句', planning({ text: '歌还行' }).planning === false);
check('旁白后正文保留',
  (loose({ text: '（沉默了一下）嗯，我在。' }).messages ?? []).some((m) => m.includes('我在')));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：', bad.join(' | ')); process.exit(1); }
