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
// ── 两级，都不花模型调用 ──────────────────────────────────────────────────
//   ① reply.is-planning-text  整段否决「候选稿/计划腔」（内心戏，不能发）
//   ② reply.loose-send        正则级抽取成稿
// 上游还支持 reply.salvage-lines / reply.salvage（模型当裁判），本插件不实现：
// 多一次模型调用既慢又要花钱，且当前的误发率已经够低。

import { getSkillConfig } from '../../src/skills/config.js';

const DEFAULTS = {
  enabled: true,
  maxMessages: 3,
  maxCharsPerMessage: 80,
  minChars: 2
};

function cfg() {
  try {
    return { ...DEFAULTS, ...(getSkillConfig('reply-safety', DEFAULTS) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

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
   * @param {{text?: string}} args
   * @returns {{messages: string[]}} 空数组 = 这轮不发
   */
  'reply.loose-send': ({ text } = {}) => {
    try {
      const conf = cfg();
      if (!conf.enabled) return { messages: [] };

      const body = String(text || '').trim();
      if (!body) return { messages: [] };
      // 整段超过 400 字基本是分析/长文，不是聊天
      if (body.length > 400) return { messages: [] };

      const maxMessages = Math.max(1, Math.min(6, Number(conf.maxMessages) || 3));
      const maxChars = Math.max(10, Math.min(300, Number(conf.maxCharsPerMessage) || 80));
      const minChars = Math.max(1, Math.min(20, Number(conf.minChars) || 2));

      const kept = [];
      for (const raw of body.split(/\r?\n/)) {
        let line = raw.trim();
        if (!line) continue;
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
      for (const line of kept) {
        const parts = line.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
          const plain = part.replace(/[。！？!?…~～\s]+$/, '');
          if (plain.length < minChars) continue;
          sentences.push(part.length > maxChars ? part.slice(0, maxChars) : part);
          if (sentences.length >= maxMessages) break;
        }
        if (sentences.length >= maxMessages) break;
      }

      return { messages: sentences.slice(0, maxMessages) };
    } catch {
      // 出错一律不发：宁可这轮沉默，也不能把内心戏发进群
      return { messages: [] };
    }
  }
};
