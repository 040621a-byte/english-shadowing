// 跟读打分：纯函数，不依赖任何浏览器 API，可在 Node 中直接测试。
//
// 流程：归一化（小写 / 去标点 / 展开缩写）→ 词级动态规划对齐 → 统计匹配情况。

const CONTRACTIONS = [
  ['cannot', 'can not'],
  ["i'm", 'i am'],
  ["i've", 'i have'],
  ["i'll", 'i will'],
  ["i'd", 'i would'],
  ["you're", 'you are'],
  ["you've", 'you have'],
  ["you'll", 'you will'],
  ["you'd", 'you would'],
  ["he's", 'he is'],
  ["she's", 'she is'],
  ["it's", 'it is'],
  ["we're", 'we are'],
  ["we've", 'we have'],
  ["we'll", 'we will'],
  ["they're", 'they are'],
  ["they've", 'they have'],
  ["that's", 'that is'],
  ["there's", 'there is'],
  ["what's", 'what is'],
  ["how's", 'how is'],
  ["where's", 'where is'],
  ["when's", 'when is'],
  ["why's", 'why is'],
  ["let's", 'let us'],
  ["who's", 'who is'],
  ["here's", 'here is'],
  ["he'd", 'he would'],
  ["she'd", 'she would'],
  ["we'd", 'we would'],
  ["they'd", 'they would'],
  ["don't", 'do not'],
  ["doesn't", 'does not'],
  ["didn't", 'did not'],
  ["can't", 'can not'],
  ["couldn't", 'could not'],
  ["won't", 'will not'],
  ["wouldn't", 'would not'],
  ["shouldn't", 'should not'],
  ["isn't", 'is not'],
  ["aren't", 'are not'],
  ["wasn't", 'was not'],
  ["weren't", 'were not'],
  ["haven't", 'have not'],
  ["hasn't", 'has not'],
  ["hadn't", 'had not'],
  ["mustn't", 'must not'],
  ["needn't", 'need not'],
  ["mightn't", 'might not'],
];

/**
 * 归一化文本为小写单词数组。
 * 统一撇号、去掉标点、展开常见缩写。
 * @param {string} text
 * @returns {string[]}
 */
export function normalize(text) {
  let s = String(text ?? '').toLowerCase();
  // 各种撇号统一成半角 '
  s = s.replace(/[\u2018\u2019\u02bc\u2032`]/g, "'");
  // 非字母数字撇号一律变空格（连字符、逗号、句号等）
  s = s.replace(/[^a-z0-9'\s]/g, ' ');
  // 展开缩写
  for (const [from, to] of CONTRACTIONS) {
    s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  // 剩余撇号（如 Anna's）直接去掉，避免把 s 当成独立单词
  s = s.replace(/'/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s ? s.split(' ') : [];
}

/**
 * 词级对齐（编辑距离 + 回溯）。
 * 回溯时优先走对角线，避免把「一个替换」拆成「漏读 + 多读」。
 * @param {string[]} target
 * @param {string[]} heard
 */
function align(target, heard) {
  const n = target.length;
  const m = heard.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = target[i - 1] === heard[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + cost,
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
      );
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = target[i - 1] === heard[j - 1] ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        ops.push({
          type: cost === 0 ? 'match' : 'sub',
          target: target[i - 1],
          heard: heard[j - 1],
        });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'del', target: target[i - 1] });
      i -= 1;
      continue;
    }
    ops.push({ type: 'ins', heard: heard[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
}

/**
 * 对一次跟读打分。
 * @param {string} targetText 原句
 * @param {string} recognizedText 语音识别结果
 * @returns {{
 *   score: number,
 *   total: number,
 *   matched: string[],
 *   missed: string[],
 *   wrong: Array<{ expected: string, heard: string }>,
 *   extra: string[],
 *   words: Array<{ text: string, status: 'ok' | 'miss' | 'wrong', heard?: string }>
 * }}
 */
export function scorePronunciation(targetText, recognizedText) {
  const target = normalize(targetText);
  const heard = normalize(recognizedText);

  if (target.length === 0) {
    return { score: 0, total: 0, matched: [], missed: [], wrong: [], extra: [], words: [] };
  }

  const ops = align(target, heard);
  const matched = [];
  const missed = [];
  const wrong = [];
  const extra = [];
  const words = [];

  for (const op of ops) {
    if (op.type === 'match') {
      matched.push(op.target);
      words.push({ text: op.target, status: 'ok' });
    } else if (op.type === 'del') {
      missed.push(op.target);
      words.push({ text: op.target, status: 'miss' });
    } else if (op.type === 'sub') {
      wrong.push({ expected: op.target, heard: op.heard });
      words.push({ text: op.target, status: 'wrong', heard: op.heard });
    } else {
      extra.push(op.heard);
    }
  }

  const score = Math.round((matched.length / target.length) * 100);
  return { score, total: target.length, matched, missed, wrong, extra, words };
}

/**
 * 分数对应的中文评语。
 * @param {number} score
 */
export function verdictFor(score) {
  if (score >= 90) return '非常地道，发音很到位';
  if (score >= 75) return '不错，再顺一点就完美了';
  if (score >= 60) return '基本读对了，再跟一遍更稳';
  return '再听一遍原声，慢速跟读会更轻松';
}
