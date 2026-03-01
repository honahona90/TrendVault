const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini API初期化
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// 記事要約関数
async function summarizeArticle(url, title) {
  try {
    const prompt = `以下のIT記事について、3-4行で簡潔に要約してください。難しい専門用語があれば、簡単な言葉で言い換えて説明してください。

タイトル: ${title}
URL: ${url}

要約（3-4行、簡潔に）:`;

    const result = await model.generateContent(prompt);
    const summary = result.response.text().trim();

    // 待機（レート制限対策: 5 RPM）
    await new Promise(resolve => setTimeout(resolve, 13000));

    return summary;
  } catch (error) {
    console.error(`  ⚠️ 要約エラー (${title}):`, error.message);
    return null;
  }
}

// 日付フォーマット
function getDate() {
  // 日本時間（JST = UTC+9）で日付を取得
  const d = new Date();
  const jstOffset = 9 * 60; // 9時間 = 540分
  const jstTime = new Date(d.getTime() + jstOffset * 60 * 1000);

  const year = jstTime.getUTCFullYear();
  const month = String(jstTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstTime.getUTCDate()).padStart(2, '0');

  return {
    yyyymmdd: `${year}${month}${day}`,
    display: `${year}-${month}-${day}`
  };
}

// バッチ翻訳（複数タイトルを1回のAPIコールで翻訳）
async function translateBatch(titles) {
  if (titles.length === 0) return [];
  try {
    const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt = `以下の英語タイトルをそれぞれ自然な日本語に翻訳してください。番号付きリスト形式で翻訳結果のみ出力してください：\n\n${numbered}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const lines = text.split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length > 0);
    return titles.map((t, i) => lines[i] || t);
  } catch (error) {
    console.error('バッチ翻訳エラー:', error.message);
    return titles;
  }
}

// 興味度を分析（キーワードマッチング）
async function analyzeInterest(title, description = '') {
  const keywords = {
    high: ['AI', 'セキュリティ', '脆弱性', 'TypeScript', 'React', 'Next.js', 'OSS', '個人開発'],
    medium: ['JavaScript', 'Web', 'エンジニア', 'プログラミング'],
  };

  const text = (title + ' ' + description).toLowerCase();

  for (const keyword of keywords.high) {
    if (text.includes(keyword.toLowerCase())) {
      return '★★★';
    }
  }

  for (const keyword of keywords.medium) {
    if (text.includes(keyword.toLowerCase())) {
      return '★★';
    }
  }

  return '★';
}

// はてなブックマークIT
async function collectHatebu() {
  console.log('📚 はてなブックマークを収集中...');

  const categories = [
    { url: 'https://b.hatena.ne.jp/hotentry/it', name: 'IT総合' },
    { url: 'https://b.hatena.ne.jp/hotentry/it/プログラミング', name: 'プログラミング' },
    { url: 'https://b.hatena.ne.jp/hotentry/it/AI・機械学習', name: 'AI・機械学習' },
  ];

  const allEntries = [];

  for (const category of categories) {
    try {
      const { data } = await axios.get(category.url, {
        headers: { 'User-Agent': 'TrendBot/1.0' }
      });
      const $ = cheerio.load(data);

      $('.entrylist-contents').slice(0, 10).each((i, elem) => {
        const title = $(elem).find('.entrylist-contents-title a').text().trim();
        const link = $(elem).find('.entrylist-contents-title a').attr('href');
        const users = $(elem).find('.entrylist-contents-users span').text().trim();

        if (title && link) {
          allEntries.push({
            title,
            link,
            users: users.replace(' users', ''),
            category: category.name
          });
        }
      });

      // レート制限回避
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error(`  ❌ ${category.name} エラー:`, error.message);
    }
  }

  console.log(`  ✅ ${allEntries.length}件 収集完了`);
  return allEntries;
}

// Hacker News
async function collectHackerNews() {
  console.log('🔥 Hacker Newsを収集中...');

  try {
    const { data: ids } = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json');
    const entries = [];

    for (const id of ids.slice(0, 20)) {
      try {
        const { data: item } = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);

        if (item && item.title) {
          entries.push({
            title: item.title,
            originalTitle: item.title,
            link: `https://news.ycombinator.com/item?id=${id}`,
            points: item.score || 0
          });
        }

      } catch (error) {
        console.error(`  ⚠️ 記事 ${id} エラー:`, error.message);
      }
    }

    console.log(`  ✅ ${entries.length}件 収集完了`);
    return entries;

  } catch (error) {
    console.error('  ❌ Hacker Newsエラー:', error.message);
    return [];
  }
}

// Reddit
async function collectReddit() {
  console.log('🤖 Redditを収集中...');

  const subreddits = [
    'programming',
    'technology',
    'webdev',
    'javascript',
    'netsec',
    'OpenAI'
  ];

  const allEntries = [];

  for (const subreddit of subreddits) {
    try {
      const { data } = await axios.get(
        `https://old.reddit.com/r/${subreddit}/hot.json?limit=5`,
        {
          headers: {
            'User-Agent': 'TrendBot/1.0 (trend analysis tool)'
          }
        }
      );

      for (const post of data.data.children) {
        const item = post.data;

        allEntries.push({
          title: item.title,
          originalTitle: item.title,
          link: `https://www.reddit.com${item.permalink}`,
          ups: item.ups,
          comments: item.num_comments,
          subreddit: `r/${subreddit}`
        });
      }

      // サブレッド間の待機
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      console.error(`  ❌ r/${subreddit} エラー:`, error.message);
    }
  }

  console.log(`  ✅ ${allEntries.length}件 収集完了`);
  return allEntries;
}

// Markdownファイル生成
async function generateMarkdown() {
  const { yyyymmdd, display } = getDate();

  console.log('\n🚀 トレンド収集開始...\n');

  // データ収集
  const hatebu = await collectHatebu();
  const hn = await collectHackerNews();
  const reddit = await collectReddit();

  console.log('\n🌐 タイトルを一括翻訳中...\n');

  // HNタイトルを一括翻訳
  const hnTranslated = await translateBatch(hn.map(e => e.title));
  hn.forEach((e, i) => { e.title = hnTranslated[i]; });
  await new Promise(resolve => setTimeout(resolve, 13000));

  // Redditタイトルを一括翻訳
  const redditTranslated = await translateBatch(reddit.map(e => e.title));
  reddit.forEach((e, i) => { e.title = redditTranslated[i]; });
  await new Promise(resolve => setTimeout(resolve, 13000));

  console.log('\n📝 Markdownファイル生成中...\n');

  // 興味度分析
  for (const entry of hatebu) {
    entry.interest = await analyzeInterest(entry.title);
  }

  for (const entry of hn) {
    entry.interest = await analyzeInterest(entry.title);
  }

  for (const entry of reddit) {
    entry.interest = await analyzeInterest(entry.title);
  }

  // 注目トピック（★★★）の要約を生成
  console.log('\n📝 注目記事の要約を生成中...\n');

  for (const entry of hatebu) {
    if (entry.interest === '★★★') {
      console.log(`  要約生成中: ${entry.title.substring(0, 30)}...`);
      entry.summary = await summarizeArticle(entry.link, entry.title);
    }
  }

  for (const entry of hn) {
    if (entry.interest === '★★★') {
      console.log(`  要約生成中: ${entry.title.substring(0, 30)}...`);
      entry.summary = await summarizeArticle(entry.link, entry.title);
    }
  }

  for (const entry of reddit) {
    if (entry.interest === '★★★') {
      console.log(`  要約生成中: ${entry.title.substring(0, 30)}...`);
      entry.summary = await summarizeArticle(entry.link, entry.title);
    }
  }

  // Markdown生成
  let markdown = `---
date: ${display}
tags: [trend, daily, auto-generated]
---

# トレンドネタ: ${display}

> 自動収集されたIT業界のトレンド情報

## はてなブックマーク IT

`;

  markdown += '### 注目トピック\n\n';

  // はてブ注目トピック（興味度★★★のみ）
  const hatebuHighInterest = hatebu.filter(e => e.interest === '★★★');
  if (hatebuHighInterest.length > 0) {
    hatebuHighInterest.slice(0, 5).forEach((entry, i) => {
      markdown += `#### ${i + 1}. [${entry.title}](${entry.link})\n\n`;
      markdown += `**ブクマ数:** ${entry.users} | **興味度:** ${entry.interest} | **カテゴリ:** ${entry.category}\n\n`;
      if (entry.summary) {
        markdown += `**要約:**\n${entry.summary}\n\n`;
      }
      markdown += '---\n\n';
    });
  } else {
    markdown += '*高関連度の記事なし*\n\n';
  }

  markdown += '\n### 全エントリー\n\n';
  hatebu.slice(0, 15).forEach((entry, i) => {
    markdown += `${i + 1}. [${entry.title}](${entry.link}) (${entry.users} users) - ${entry.category}\n`;
  });

  markdown += '\n## Hacker News\n\n### 注目トピック\n\n';

  // HN注目トピック
  const hnHighInterest = hn.filter(e => e.interest === '★★★');
  if (hnHighInterest.length > 0) {
    hnHighInterest.slice(0, 5).forEach((entry, i) => {
      markdown += `#### ${i + 1}. [${entry.title}](${entry.link})\n\n`;
      markdown += `**ポイント:** ${entry.points}pt | **興味度:** ${entry.interest}\n\n`;
      if (entry.summary) {
        markdown += `**要約:**\n${entry.summary}\n\n`;
      }
      markdown += '---\n\n';
    });
  } else {
    markdown += '*高関連度の記事なし*\n\n';
  }

  markdown += '\n### 全エントリー\n\n';
  hn.slice(0, 15).forEach((entry, i) => {
    markdown += `${i + 1}. [${entry.title}](${entry.link}) (${entry.points}pt)\n`;
  });

  markdown += '\n## Reddit\n\n### 注目トピック\n\n';

  // Reddit注目トピック
  const redditHighInterest = reddit.filter(e => e.interest === '★★★');
  if (redditHighInterest.length > 0) {
    redditHighInterest.slice(0, 5).forEach((entry, i) => {
      markdown += `#### ${i + 1}. [${entry.title}](${entry.link})\n\n`;
      markdown += `**投票数:** ${entry.ups} | **コメント:** ${entry.comments} | **興味度:** ${entry.interest} | **サブレッド:** ${entry.subreddit}\n\n`;
      if (entry.summary) {
        markdown += `**要約:**\n${entry.summary}\n\n`;
      }
      markdown += '---\n\n';
    });
  } else {
    markdown += '*高関連度の記事なし*\n\n';
  }

  markdown += '\n### 全エントリー\n\n';
  reddit.slice(0, 20).forEach((entry, i) => {
    markdown += `${i + 1}. [${entry.title}](${entry.link}) (${entry.ups} ups, ${entry.comments} comments) - ${entry.subreddit}\n`;
  });

  markdown += `\n---\n\n*Generated by Trend Bot on ${new Date().toISOString()}*\n`;

  // ファイル保存
  const dailyDir = path.join(__dirname, '..', 'daily');
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }

  const filename = `${yyyymmdd}-trend.md`;
  const filepath = path.join(dailyDir, filename);

  fs.writeFileSync(filepath, markdown, 'utf8');
  console.log(`✅ トレンド収集完了: ${filename}`);
  console.log(`   📍 保存場所: ${filepath}`);
  console.log(`\n📊 統計:`);
  console.log(`   はてブ: ${hatebu.length}件`);
  console.log(`   Hacker News: ${hn.length}件`);
  console.log(`   Reddit: ${reddit.length}件`);
  console.log(`   合計: ${hatebu.length + hn.length + reddit.length}件`);
}

// 実行
generateMarkdown().catch(error => {
  console.error('❌ エラー:', error);
  process.exit(1);
});
