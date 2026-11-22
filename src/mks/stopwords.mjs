// AEC 5.1 O3-11：口语停用词表（独立成文件，便于审计）。
//
// 只在 AEC_MKS_SEARCH_V2=1 的查询构造中使用：先从查询 token 中剥离，再进 FTS。
// 原则：只收「对检索语义无区分贡献的口语/功能词」（提示词 §4.1 点名的「帮我 / 用 AEC / 怎么」类）；
// 有业务含义的词（下载 / 解析 / 直链 / 水印…）一律不收。
// 修改本表必须同步两侧（aec / upstream/aec-mcp，两份文件内容保持一致），并重跑 O3-09 评测证明不回退。
export const STOPWORDS = new Set([
  // 称谓与客套
  '帮我', '帮忙', '麻烦', '请', '我想', '我要', '我想问', '问一下', '问下',
  // 疑问/泛指
  '怎么', '怎样', '如何', '什么', '啥', '哪个', '哪些', '几个', '多少', '为什么', '为啥',
  '多久', '多长', '是否', '是不是', '能不能', '可不可以',
  // 泛量词与指代
  '一下', '一些', '这个', '那个', '这些', '那些', '看看', '看下', '查一下', '查下', '查查',
  '我们', '你们', '他们', '它们', '上次', '完了', '了吗',
  // 平台自指（意图模板「用 AEC …」）
  'aec',
  // 功能虚词（单字 token 仅在孤立成词时出现）
  '吗', '呢', '吧', '啊', '的', '了', '么', '给', '把', '被', '对', '关于', '还是', '或者', '以及',
]);

// 字符串级剥离：多字词 + 高频安全单字（的/了）。仅用于 v2 查询预处理——
// 先从查询原串删停用词再切 n-gram，可消解「跨词 bigram 噪声」（如 帮我|打包|这个|图集
// 产生 我打/包这/个图 等永不命中的噪声 token，导致词覆盖率失真）。
// 单字 对/给/把/被 等易伤词内（对象/给予），只在 token 级剥离。
export const STRING_LEVEL_STOPWORDS = new Set([
  ...[...STOPWORDS].filter(w => w.length >= 2), '的', '了',
]);

/** 查询原串 → 删除字符串级停用词（子串替换，词边界用空格隔开）。 */
export function stripStopwordsFromText(text) {
  let s = String(text ?? '');
  for (const w of [...STRING_LEVEL_STOPWORDS].sort((a, b) => b.length - a.length)) {
    if (s.includes(w)) s = s.split(w).join(' ');
  }
  return s;
}

/** 查询 token → 剥离停用词后的 token（保序去重不变，仅过滤）。 */
export function stripStopwords(tokens) {
  return (tokens ?? []).filter(t => !STOPWORDS.has(t));
}
