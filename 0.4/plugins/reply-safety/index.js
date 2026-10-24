// 回复安全网 —— 确定性型插件
//
// ── 解决什么问题 ──────────────────────────────────────────────────────────
// 本项目约定「模型的文本输出只是思考，要发言必须调用 send_message」。工具集较大时
// （内置 28 个），模型会退化成直接把话写在正文里，程序按设计不发 —— 用户看到的是
// 「思考完成了但不回复」。换模型只能降低概率（实测同 prompt 下 hy3 约 1/4，
// deepseek 6/6，但真实长对话里仍会复现）。
//
// 核心在 src/orchestrator.js 的 #rescueUnsentReply 里已备好兜底路径，但它
// **全部通过 capability 取用**：没有提供者时所有分支都是空操作。本插件就是那两个
// 提供者（注释原文：「插件没装/没启用时 #capFirst 一律返回 null」）。
//
// ── 硬约束 ────────────────────────────────────────────────────────────────
//   · 只搬原句：不生成、不改写、不润色、不"帮模型把话说完"
//   · 拿不准一律沉默：任何判定失败都返回空数组
//   · 不自己发送：返回消息让核心走统一的 send_message 链路（限频/去重/存档都在那）
//
// ── 三道闸门（每一道都来自线上真实误发样本）──────────────────────────────
//   闸门一「已发过话就不抢救」：模型本次运行里已经用 send_message 发过消息，
//     说明它遵守了工具协议 —— 那之后残留的正文就是真正的思考，不是漏发的成稿。
//   闸门二「工具名残留」：模型有时把想调的工具名当正文写出来（"finish"、
//     "finish：接不上就安静，别刷。"），这种整行不是人话。
//   闸门三「元信号逐句过滤 + 密度否决」：正文里混着内心戏时逐句丢掉；
//     若整段都是内心戏（元信号句数达到阈值），整段否决。
//
// 线上实测：25 次抢救里有 8 次是误发（32%），形态有三类 ——
//   ① 工具名残留        "finish" / "finish：接不上就安静，别刷。"
//   ② 元指令/收尾决策   "不用回，安静结束。" / "安静看。"
//   ③ 元评论            "这句没叫我也没指我，就是随口吐槽。" / "我刚回完群主那嘴。"
// 三类都必须挡住，否则群里看到的就是"把思考内容发出来了"。
//
// 上游还支持 reply.salvage-lines / reply.salvage（模型当裁判），本插件不实现：
// 多一次模型调用既慢又要花钱，且当前的误发率已经够低。

import { getSkillConfig } from '../../src/skills/config.js';

const DEFAULTS = {
  enabled: true,
  // 已经发过话之后还要不要再抢救？默认否 —— 那条路径实测全是误发。
  rescueAfterSent: false,
  maxMessages: 3,
  maxCharsPerMessage: 80,
  minChars: 2,
  // 正文里有几句被判为"元信号"就整段否决。2 = 整段都是内心戏时放弃。
  metaDenyCount: 2
};

function cfg() {
  try {
    return { ...DEFAULTS, ...(getSkillConfig('reply-safety', DEFAULTS) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

// ── 闸门一 / 闸门二的判定表 ───────────────────────────────────────────────

// 计划腔特征：模型在正文里比较备选说法、列提纲、自我提示要不要说。
// 命中两条及以上才整段否决 —— 单条命中太容易误杀正常句子
// （"我说话太直"里也有"我"，但那是要说的话，不是自我提示）。
const PLANNING_PATTERNS = [
  /(候选|备选|说法[一二三四]|方案[一二三四]|选项[一二三四])/,
  /(太长|太生硬|不够自然|换个说法|换一种说法|换个角度)/,
  /(→|->|=>)/,
  /^\s*(思路|分析|判断|考虑|备注)[:：]/m,
  // "我应该先道歉" / "我得回他一句" 这类自我提示。必须带后续动作词，
  // 否则会误伤"我得说句公道话"这种正常表达（但单条命中不足以否决，见下面的 >= 2）
  /我(应该|需要|得|该)(先|去|再|马上|立刻|回|说|答|想|安慰|道|解释|委婉)/,
  /(要不要(说|回|提|发)|该不该(说|回|发))/,
  /(心想|心里想|暗想|内心OS|我心说)/
];

/**
 * 工具名残留 —— 整行丢掉。
 * 模型有时把"我想调的工具"当正文写出来。
 * 样本：「finish」「finish：接不上就安静，别刷。」
 */
const TOOL_NAMES = [
  'finish', 'send_message', 'send_to', 'send_sticker', 'send_poke', 'send_image',
  'set_reminder', 'web_search', 'web_fetch', 'memory_append', 'report_feedback',
  'collect_sticker'
];
const TOOL_LINE = [
  // 整行就是工具名
  new RegExp(`^(${TOOL_NAMES.join('|')})\\s*$`, 'i'),
  // 工具名 + 内容："finish：接不上就安静，别刷。"
  new RegExp(`^(${TOOL_NAMES.join('|')})\\s*[:：]`, 'i'),
  // 裸 JSON / 特殊标记
  /^\{[\s\S]*\}$/,
  /^<\|[^|]*\|>/
];

/**
 * 元信号强指纹 —— 命中一条就丢掉这一句。
 * 全是"模型在描述自己刚才说了什么 / 现在打算怎么处理"，不是要说的话。
 */
const SELF_TALK_STRONG = [
  // ── ① 已经说过 / 说完了 ──
  /已经(说过|说了|回复|回过|回完|发过|发完|说完|讲过|回过一句)/,
  /(说|发|回|讲)完(这|了|一句|两句|那)/,
  // ── ② 收尾 / 观望动作 ──
  /(先|就|暂|且)(停|收|歇)(在|到|住)?(这|这里|此)/,
  /(停|收|结束|截止)(在|到)?(这里|这儿|此)(为止)?/,
  // "看看他怎么接" / "等对方反应" / "瞧他回不回"
  /(等|看看|看下|瞧|听)(一下)?(对方|他|她|人家|大家|别人)?(怎么|如何)?(接话|反应|回应|回|接|说)/,
  /(作为|当作|算是|就是)(我的)?(回应|回答|答复|结论|回复)/,
  /(接下来|然后|之后|下面)(怎么|如何|该)(回|说|答|接|办|做)/,
  // 只收"不再/不用/别/无需"这类明确收尾，不收单独一个"不" ——
  // 否则"就不说。"这种真会对群友说的话会被误砍
  /(不再|不用|不必|别|无需|不要再)(接|回|说|管|理|提|发)(了|话|下去|了啊)?[。！？!?…~～]*$/,
  /(当我没说|当我没发|忽略上一条|无视上一条|忽略上面)/,
  /((发|说|打|写)错了|(误|错)把)/,
  /(内部(想法|思考|分析|判断|独白)|心里话|自言自语)/,
  /^(思路|分析|判断|总结|备注|想法|打算|计划|策略|草稿|候选)[:：]/,
  /(先|就)(这样|到这|如此)(吧|了|收)?[。！？!?…~～]*$/,
  /(保持|维持|继续)(沉默|安静|不说话|观望)/,
  /(打住|到此为止|就到这|先不说了|不再多说|到此)/,
  // ── ③ 元指令：明确"不回应" ──
  // "不用回，安静结束。" / "不用再接" / "我不接"
  /(不用|不需要|没必要|不必)(再)?(回|接|理|说|搭理)(话|我|他|她|一句|一下)?[。！？!?…~～，,、]*$/,
  /(我(先)?不接|别接了|不用接|不接话|先不接|不回了)/,
  // ── ④ 元指令：安静收场 ──
  // "安静结束。" / "安静看。" / "不说话。"
  /(安静(结束|看|待着)|就此(结束|打住)|(这|本|此)(轮|次)?(就)?结束|结束(这轮|本次|这次))/,
  /(不|别)(用)?说话[。！？!?…~～]*$/,
  // ── ⑤ 元评论：这条不是在跟我说话 ──
  // "这句没叫我也没指我，就是随口吐槽。"
  /(没叫我|没指我|没提我|没艾特我|没@我|跟我无关|不是(在)?跟(我|我俩)|不在叫我)/,
  // ── ⑥ 元评论：我刚回过，别再接 ──
  /我(刚|刚才)(回|说|发)(完|过)/,
  /不用再接|没必要再(咬|接|说|理)/,
  // ── ⑦ 谈论"把消息发出去"这个动作本身 ──
  // "刚才手滑把 finish 当消息发出去了，真尴尬。"
  /(手滑|误发|误把|发错|发成|当成(消息|话)|当成一?句(话|消息)|刚(才)?发(的|出去))/
];

/** 自我指涉：句子在指"自己刚发出去的那条消息" */
const SELF_REF = [
  /这(一)?(句|条)(话|消息|发言|回复)?/,
  /那(一)?(句|条)(话|消息|发言|回复)?/,
  /(上|下)(一)?(条|句|轮|波|回合)/,
  /我(刚|刚才|之前|前面|上面)/,
  /我的(回复|回答|回应|上一|这条)/
];

/** 收尾 / 观望 / 决策动作：跟 SELF_REF 同时出现时，这句基本是内心戏 */
const WRAP_UP = [
  /(先|就|暂)(停|收|歇)/,
  /(等|看看|看下|瞧)(对方|他|她|人家|大家|别人)?(接话|反应|回应|回|接|说)/,
  /(作为|当作|算是)(回应|回答|答复|结论|回复)/,
  /(接下来|然后|之后)(怎么|如何|该)(回|说|答|接)/,
  /(不再|不用|不必|别)(接|再接|回|再回|说|再说|管)(了|话)?[。！？!?…~～]*$/,
  /到此为止|打住|就到这|先不说了|不再多说/,
  /(沉默|安静|不说话|观望|看戏)/,
  /(够了|行了|可以了|就这样)[。！？!?…~～]*$/
];

/**
 * 自问句 —— 模型在跟自己确认，不是说给群友听。
 * "还是我随便接一句？" / "要安静结束吗？"
 * 必须是问句收尾 + 含"我" + 含决策动词，正常聊天里的"你说对吧？"不满足。
 */
function isSelfAsk(sentence) {
  const s = sentence.replace(/[。！？!?…~～\s]+$/, '');
  if (!/[？?]$/.test(s)) return false;
  if (!/我/.test(s)) return false;
  if (!/(接|说|回|理|发|结束|安静|随便|闭嘴|不理|忽略)/.test(s)) return false;
  // 带明确的第二人称指向时更像在问对方
  if (/你|您/.test(s)) return false;
  return true;
}

/**
 * 这一句像不像"模型对自己说的"，而不是"对群友说的"。
 * @returns {boolean} true = 元信号，丢掉
 */
function isMeta(sentence) {
  if (SELF_TALK_STRONG.some((re) => re.test(sentence))) return true;
  if (isSelfAsk(sentence)) return true;
  const ref = SELF_REF.some((re) => re.test(sentence));
  if (ref && WRAP_UP.some((re) => re.test(sentence))) return true;
  return false;
}

/** 旁白 / 动作描写 / markdown 结构 —— 都不是"要说的话" */
const NOT_SPEECH = [
  /^[（(\[【*#>|`~]/,
  /^[-+]\s/,
  /^\d+[.、)]\s/,
  /【[^】]*】/,
  /^(系统|提示|注)[:：]/
];

export const providers = {
  /**
   * 整段否决「计划腔」。
   * 返回 { planning: true } 时 rescueUnsentReply 直接放弃，一个字都不发。
   * @param {{text?: string}} args
   */
  'reply.is-planning-text': ({ text } = {}) => {
    const body = String(text || '').trim();
    if (!body) return { planning: false };
    let hits = 0;
    for (const re of PLANNING_PATTERNS) if (re.test(body)) hits += 1;
    return { planning: hits >= 2 };
  },

  /**
   * 正则级抽取成稿。
   * @param {{text?: string, sentCount?: number}} args
   *   sentCount = 本次运行里已经用 send_message 发出去的条数（由核心透传）
   * @returns {{messages: string[]}} 空数组 = 这轮不发
   */
  'reply.loose-send': ({ text, sentCount } = {}) => {
    try {
      const conf = cfg();
      if (!conf.enabled) return { messages: [] };

      // 闸门一：已经发过话了。模型遵守了工具协议，剩下的正文是思考不是成稿。
      // 这条路径实测 100% 是误发（收尾声明），默认直接放弃抢救。
      const alreadySpoke = Number(sentCount) > 0;
      if (alreadySpoke && !conf.rescueAfterSent) return { messages: [] };

      const body = String(text || '').trim();
      if (!body) return { messages: [] };
      // 整段超过 400 字基本是分析/长文，不是聊天
      if (body.length > 400) return { messages: [] };

      const maxMessages = Math.max(1, Math.min(6, Number(conf.maxMessages) || 3));
      const maxChars = Math.max(10, Math.min(300, Number(conf.maxCharsPerMessage) || 80));
      const minChars = Math.max(1, Math.min(20, Number(conf.minChars) || 2));
      const metaDeny = Math.max(1, Math.min(6, Number(conf.metaDenyCount) || 2));

      const kept = [];
      for (const raw of body.split(/\r?\n/)) {
        let line = raw.trim();
        if (!line) continue;
        // 闸门二：整行就是工具名残留（"finish" / "finish：xxx"），整行丢掉
        if (TOOL_LINE.some((re) => re.test(line))) continue;
        // 剥离行首旁白：「（沉默了一下）嗯，我在。」要保留后半句，
        // 不能因为整行以括号开头就把正文一起丢掉。
        const lead = line.match(/^[（(][^）)]*[）)]\s*/);
        if (lead) line = line.slice(lead[0].length).trim();
        if (!line) continue;
        if (line.length > 120) continue;                 // 单行长段落不像聊天
        if (NOT_SPEECH.some((re) => re.test(line))) continue;
        kept.push(line);
      }
      if (!kept.length) return { messages: [] };

      // 按句末标点拆条：保留标点，一句一条更像真人打字。
      // 用后行断言切分，避免把标点弄丢。
      const sentences = [];
      let metaCount = 0;
      for (const line of kept) {
        const parts = line.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
          const plain = part.replace(/[。！？!?…~～\s]+$/, '');
          if (plain.length < minChars) continue;
          // 闸门三：逐句判定。命中"元信号"的丢掉这一句 ——
          // 不是整段否决，保住同一段里真正该发的那句。
          if (isMeta(part)) { metaCount += 1; continue; }
          sentences.push(part.length > maxChars ? part.slice(0, maxChars) : part);
          if (sentences.length >= maxMessages) break;
        }
        if (sentences.length >= maxMessages) break;
      }

      // 闸门三（续）：整段都是内心戏时（元信号句数达阈值），整段放弃。
      // 逐句过滤只能挡住"混着"的情况；正文通篇是自说自话时必须全丢。
      if (metaCount >= metaDeny) return { messages: [] };

      return { messages: sentences.slice(0, maxMessages) };
    } catch {
      // 出错一律不发：宁可这轮沉默，也不能把内心戏发进群
      return { messages: [] };
    }
  }
};
