import fetch from 'node-fetch';
import { readFileSync, writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const FIREBASE_URL = process.env.FIREBASE_URL;

const CITIES = JSON.parse(readFileSync('cities.json', 'utf-8'));
const CONFIG = JSON.parse(readFileSync('config.json', 'utf-8'));

const POOL_SIZE = 20;
const STORIES_PER_CITY = 5;

const SITE_URL = CONFIG.siteUrl.endsWith('/') ? CONFIG.siteUrl : CONFIG.siteUrl + '/';
const CATEGORIES = CONFIG.categories || ['Other'];
const SIGNUP_URL = CONFIG.signupUrl || '';
const TELEGRAM_CHANNEL = CONFIG.telegramChannel || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/` +
  `gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

function slug(cityName) {
  return cityName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cityUrl(cityName) {
  return SITE_URL + slug(cityName) + '.html';
}

async function callGemini(promptText) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
      })
    });

    const data = await response.json();

    if (data.candidates && data.candidates[0]) {
      return data.candidates[0].content.parts[0].text.trim();
    }

    const code = data.error?.code;
    if (code === 503 || code === 429) {
      const waitSeconds = attempt * 5;
      console.log(`  Model busy (attempt ${attempt}), waiting ${waitSeconds}s...`);
      await new Promise(r => setTimeout(r, waitSeconds * 1000));
      continue;
    }

    console.error('Gemini call failed:', JSON.stringify(data));
    return null;
  }
  console.error('Gemini call failed after retries (model stayed busy).');
  return null;
}

function cleanPool(articles) {
  return articles.filter(a => {
    if (!a || !a.title || !a.url) return false;
    const t = a.title.trim();
    if (t === '' || t === '[Removed]') return false;
    if (a.url === 'https://removed.com') return false;
    return true;
  });
}

async function clusterArticles(articles, cityName) {
  const headlineList = articles
    .map((a, i) => `${i + 1}. ${a.title}`)
    .join('\n');

  const promptText =
    `Below are ${articles.length} news headlines for ${cityName}. Some cover the ` +
    `SAME underlying story or event (even if worded differently). Group them.\n\n` +
    `Return ONLY groups of numbers, one group per line, numbers separated by commas. ` +
    `Each headline number must appear in exactly one group. A headline with no match ` +
    `is its own group of one.\n` +
    `Example:\n3, 9, 13\n1\n7, 15\n2\n\n` +
    headlineList;

  const answer = await callGemini(promptText);

  if (!answer) {
    console.log('  Clustering unavailable — treating each article separately.');
    return articles.map(a => ({ ...a, sourceCount: 1 }));
  }

  const seen = new Set();
  const reps = [];
  const lines = answer.split('\n');

  for (const line of lines) {
    const nums = line.match(/\d+/g);
    if (!nums) continue;
    const idxs = nums
      .map(n => parseInt(n, 10) - 1)
      .filter(i => i >= 0 && i < articles.length && !seen.has(i));
    if (idxs.length === 0) continue;
    idxs.forEach(i => seen.add(i));
    reps.push({ ...articles[idxs[0]], sourceCount: idxs.length });
  }

  articles.forEach((a, i) => {
    if (!seen.has(i)) reps.push({ ...a, sourceCount: 1 });
  });

  console.log(`  Clustered ${articles.length} articles into ${reps.length} stories.`);
  return reps;
}

async function rankArticles(articles, cityName) {
  const headlineList = articles
    .map((a, i) => `${i + 1}. [${a.sourceCount} source(s)] ${a.title}`)
    .join('\n');

  const promptText =
    `You are curating a local news digest for ${cityName}. Below are ${articles.length} ` +
    `distinct stories (duplicates already merged). Choose the ${STORIES_PER_CITY} most ` +
    `valuable for a ${cityName} resident.\n\n` +
    `Selection criteria:\n` +
    `- Prioritize genuine local impact: civic decisions, local business, community, ` +
    `public safety, local development — over stories that only mention ${cityName} in passing.\n` +
    `- The "[N source(s)]" tag shows how many outlets covered a story; more sources is ` +
    `a signal of importance, but weigh it alongside genuine local relevance.\n` +
    `- Favor substance over clickbait or celebrity/entertainment filler.\n\n` +
    `Respond with ONLY the numbers of your chosen stories, separated by commas, ` +
    `in order of importance. Example: 4, 1, 9, 2, 7\n\n` +
    headlineList;

  const answer = await callGemini(promptText);

  let chosenIdx;
  if (!answer) {
    console.log('  Ranking unavailable — falling back to first stories.');
    chosenIdx = articles.map((_, i) => i).slice(0, STORIES_PER_CITY);
  } else {
    const picks = answer
      .match(/\d+/g)
      ?.map(n => parseInt(n, 10))
      .filter(n => n >= 1 && n <= articles.length)
      .map(n => n - 1);

    if (!picks || picks.length === 0) {
      console.log('  Could not read ranking — falling back to first stories.');
      chosenIdx = articles.map((_, i) => i).slice(0, STORIES_PER_CITY);
    } else {
      chosenIdx = [...new Set(picks)].slice(0, STORIES_PER_CITY);
    }
  }

  return {
    chosen: chosenIdx.map(i => articles[i]),
    chosenIdx: new Set(chosenIdx)
  };
}

// Returns { summary, category } in one call. Category comes from CATEGORIES.
async function summarizeAndCategorize(title, description, content) {
  const catList = CATEGORIES.join(', ');
  const promptText =
    `Summarize and categorize this news article.\n\n` +
    `Respond in EXACTLY this format:\n` +
    `CATEGORY: <one of: ${catList}>\n` +
    `SUMMARY: <2 concise, neutral sentences, strictly under 100 words>\n\n` +
    `Title: ${title}\n` +
    `Description: ${description || 'N/A'}\n` +
    `Content: ${content ? content.substring(0, 800) : 'N/A'}`;

  const answer = await callGemini(promptText);

  if (!answer) {
    return { summary: 'Summary unavailable.', category: 'Other' };
  }

  // Parse the two labelled parts.
  let category = 'Other';
  let summary = answer;

  const catMatch = answer.match(/CATEGORY:\s*(.+)/i);
  const sumMatch = answer.match(/SUMMARY:\s*([\s\S]+)/i);

  if (catMatch) {
    const raw = catMatch[1].trim();
    // Only accept a category that's in our list (case-insensitive); else "Other".
    const found = CATEGORIES.find(c => c.toLowerCase() === raw.toLowerCase());
    category = found || 'Other';
  }
  if (sumMatch) {
    summary = sumMatch[1].trim();
  }

  return { summary, category };
}

async function fetchNews(city) {
  const url =
    `https://newsapi.org/v2/everything?qInTitle=${encodeURIComponent(city.query)}` +
    `&language=en&sortBy=publishedAt&pageSize=${POOL_SIZE}` +
    `&apiKey=${NEWSAPI_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'ok') {
    console.error(`News fetch failed for ${city.name}:`, data.message);
    return [];
  }
  return data.articles || [];
}

async function saveDigest(dateKey, digest) {
  const url = `${FIREBASE_URL}/digests/${dateKey}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(digest)
  });
  if (response.ok) {
    console.log('Digest saved to Firebase.');
  } else {
    console.error('Firebase save failed:', await response.text());
  }
}

// Save one city's fresh digest to latest/<city> — the source of truth for fallback.
async function saveLatest(cityName, cityData) {
  const url = `${FIREBASE_URL}/latest/${encodeURIComponent(slug(cityName))}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cityData)
  });
  if (!response.ok) {
    console.error(`saveLatest failed for ${cityName}:`, await response.text());
  }
}

// Read one city's last-good digest from latest/<city>.
async function readLatest(cityName) {
  const url = `${FIREBASE_URL}/latest/${encodeURIComponent(slug(cityName))}.json`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data || null;   // { date, articles } or null
  } catch {
    return null;
  }
}

async function savePool(dateKey, poolData) {
  const payload = {};

  for (const cityName of Object.keys(poolData)) {
    const { stories, chosenIdx } = poolData[cityName];
    payload[cityName] = stories.map((a, i) => ({
      title: a.title,
      source: a.source?.name || 'Unknown',
      url: a.url,
      sourceCount: a.sourceCount || 1,
      publishedAt: a.publishedAt,
      selected: chosenIdx.has(i)
    }));
  }

  const url = `${FIREBASE_URL}/pool/${dateKey}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (response.ok) {
    console.log('Story pool saved to Firebase.');
  } else {
    console.error('Pool save failed:', await response.text());
  }
}

function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageShell(title, dateKey, bodyContent, backLink, staleNote) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(dateKey)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.5; }
  header { border-bottom: 2px solid #1a1a1a; margin-bottom: 24px; padding-bottom: 12px; }
  header h1 { margin: 0 0 4px; font-size: 1.6rem; }
  header .date { color: #666; font-size: 0.9rem; }
  .backlink { display: inline-block; margin-bottom: 16px; color: #0b57d0; text-decoration: none; font-size: 0.9rem; }
  .backlink:hover { text-decoration: underline; }
  .stale { background: #fff4e5; border: 1px solid #ffcc80; color: #8a5a00; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; margin-bottom: 16px; }
  .city-list { list-style: none; padding: 0; }
  .city-list li { margin-bottom: 12px; font-size: 1.15rem; }
  .city-list a { color: #0b57d0; text-decoration: none; }
  .city-list a:hover { text-decoration: underline; }
  .story { margin-bottom: 20px; }
  .story h3 { margin: 0 0 6px; font-size: 1.05rem; }
  .story h3 a { color: #0b57d0; text-decoration: none; }
  .story h3 a:hover { text-decoration: underline; }
  .cat { display: inline-block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; background: #0b57d0; padding: 2px 8px; border-radius: 10px; margin-bottom: 6px; }
  .summary { margin: 0 0 4px; }
  .source { margin: 0; color: #888; font-size: 0.85rem; }
  footer { border-top: 1px solid #ddd; margin-top: 32px; padding-top: 16px; color: #888; font-size: 0.85rem; text-align: center; }
  .signup { text-align: center; margin: 24px 0; padding: 18px; background: #f0f6ff; border-radius: 12px; }
  .signup a { display: inline-block; background: #0b57d0; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="date">${esc(dateKey)}</div>
</header>
${backLink ? `<a class="backlink" href="${esc(SITE_URL)}">← All cities</a>` : ''}
${staleNote ? `<div class="stale">📅 ${esc(staleNote)}</div>` : ''}
${SIGNUP_URL ? `<div class="signup">📬 Free daily local news in your inbox — <a href="${esc(SIGNUP_URL)}" target="_blank" rel="noopener">Subscribe</a></div>` : ''}
${bodyContent}
<footer>Summaries are AI-generated. Click any headline to read the full story at the source.</footer>
</body>
</html>`;
}

function buildCityPage(cityName, todayKey, cityData) {
  const articles = (cityData.articles || [])
    .filter(a => a.summary && a.summary !== 'Summary unavailable.');

  let items = '';
  for (const a of articles) {
    items +=
      `<article class="story">` +
      `<span class="cat">${esc(a.category || 'Other')}</span>` +
      `<h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>` +
      `<p class="summary">${esc(a.summary)}</p>` +
      `<p class="source">Source: ${esc(a.source)}</p>` +
      `</article>`;
  }

  const stale = (cityData.date && cityData.date !== todayKey)
    ? `As of ${cityData.date} — couldn't refresh today, showing the latest available.`
    : '';

  const html = pageShell(`${cityName} News`, cityData.date || todayKey, items, true, stale);
  writeFileSync(slug(cityName) + '.html', html);
}

function buildHomePage(todayKey, displayData) {
  let list = '<ul class="city-list">';
  for (const cityName of Object.keys(displayData)) {
    const hasArticles = (displayData[cityName].articles || [])
      .some(a => a.summary && a.summary !== 'Summary unavailable.');
    if (!hasArticles) continue;
    list += `<li><a href="${esc(cityUrl(cityName))}">${esc(cityName)} →</a></li>`;
  }
  list += '</ul>';

  const html = pageShell('Daily News Digest', todayKey, list, false, '');
  writeFileSync('index.html', html);
}

function buildAllPages(todayKey, displayData) {
  buildHomePage(todayKey, displayData);
  for (const cityName of Object.keys(displayData)) {
    const hasArticles = (displayData[cityName].articles || [])
      .some(a => a.summary && a.summary !== 'Summary unavailable.');
    if (!hasArticles) continue;
    buildCityPage(cityName, todayKey, displayData[cityName]);
  }
  console.log('Webpages written (home + one per city).');
}

function buildCityPost(cityName, digest) {
  const articles = (digest[cityName].articles || [])
    .filter(a => a.summary && a.summary !== 'Summary unavailable.');

  if (articles.length === 0) return null;

  const hashtag = '#' + cityName.replace(/\s+/g, '') + 'News';

  let post = `📍 ${cityName} — Today's top stories\n\n`;
  for (const a of articles) {
    post += `• [${a.category || 'Other'}] ${a.title}\n`;
  }
  post += `\n📰 Full summaries: ${cityUrl(cityName)}\n\n${hashtag}`;
  return post;
}

async function saveSocialPosts(dateKey, digest) {
  const postsByCity = {};
  let fileText =
    `SOCIAL POSTS — ${dateKey}\n` +
    `(Copy any city's post below and paste to social media.)\n\n`;

  for (const cityName of Object.keys(digest)) {
    const post = buildCityPost(cityName, digest);
    if (!post) continue;

    postsByCity[cityName] = { text: post };

    fileText +=
      `==================================================\n` +
      `${cityName}\n` +
      `==================================================\n` +
      post + `\n\n`;
  }

  writeFileSync('social-posts.txt', fileText);
  console.log('Social posts written to social-posts.txt');

  const url = `${FIREBASE_URL}/social_posts/${dateKey}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postsByCity)
  });
  if (response.ok) {
    console.log('Social posts saved to Firebase (by city).');
  } else {
    console.error('Social posts save failed:', await response.text());
  }
}

function buildFeedbackTemplate(dateKey, feedbackData) {
  let out =
    `DAILY FEEDBACK TEMPLATE — ${dateKey}\n` +
    `Fill in each field with: good / bad / (or a short note).\n` +
    `Rate every story — both SELECTED picks and the ones not chosen.\n` +
    `When done, save this as feedback/${dateKey}.txt and commit it.\n\n`;

  for (const cityName of Object.keys(feedbackData)) {
    const { stories, chosenIdx, summaries, categories } = feedbackData[cityName];

    out += `##################################################\n`;
    out += `CITY: ${cityName}\n`;
    out += `##################################################\n\n`;

    stories.forEach((article, i) => {
      const selected = chosenIdx.has(i);
      out += `--- ${cityName} | Story ${i + 1} --- ` +
             (selected ? `[✓ SELECTED]` : `[not selected]`) +
             `  (${article.sourceCount} source(s))\n`;
      out += `Headline: ${article.title}\n`;
      out += `URL: ${article.url}\n`;
      if (selected && categories[i]) {
        out += `Category: ${categories[i]}\n`;
      }
      if (selected && summaries[i]) {
        out += `Summary: ${summaries[i]}\n`;
      }
      out += `  Selection (good / bad / missed): \n`;
      out += `  Headline  (good / bad / note):   \n`;
      if (selected) {
        out += `  Category  (good / bad / note):   \n`;
        out += `  Summary   (good / bad / note):   \n`;
      }
      out += `  Notes:                            \n\n`;
    });
  }

  writeFileSync('feedback-template.txt', out);
  console.log('Feedback template written to feedback-template.txt');
}
// Post the digest to the Telegram channel via the bot.
async function postToTelegram(digest) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL) {
    console.log('Telegram not configured — skipping.');
    return;
  }

  // Build the message (Telegram supports basic HTML formatting).
  let msg = `<b>📰 The Daily Local</b>\n<i>Your City. Your News. Every Day.</i>\n\n`;

  for (const cityName of Object.keys(digest)) {
    const articles = (digest[cityName].articles || [])
      .filter(a => a.summary && a.summary !== 'Summary unavailable.');
    if (articles.length === 0) continue;

    msg += `<b>📍 ${cityName}</b>\n`;
    for (const a of articles) {
      // Headline links to the source; keep each line compact.
      msg += `• <a href="${a.url}">${a.title}</a>\n`;
    }
    msg += `\n`;
  }

  // Footer: website + email signup links.
  msg += `———\n`;
  if (SITE_URL) msg += `🌐 Full summaries: ${SITE_URL}\n`;
  if (SIGNUP_URL) msg += `📬 Get it by email: ${SIGNUP_URL}\n`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await response.json();
    if (data.ok) {
      console.log('Posted to Telegram.');
    } else {
      console.error('Telegram post failed:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('Telegram post error:', err);
  }
}
// Build tailored, ready-to-post text for each platform, per city.
// Saves to platform-posts.txt AND Firebase (platform_posts/<date>/<city>/<platform>).
async function savePlatformPosts(dateKey, digest) {
  const byCity = {};   // for Firebase
  let fileText =
    `PLATFORM-READY POSTS — ${dateKey}\n` +
    `Copy the version for each platform. Reddit needs a human touch before posting.\n\n`;

  for (const cityName of Object.keys(digest)) {
    const articles = (digest[cityName].articles || [])
      .filter(a => a.summary && a.summary !== 'Summary unavailable.');
    if (articles.length === 0) continue;

    const cityLink = cityUrl(cityName);
    const tag = cityName.replace(/\s+/g, '');
    const headlines = articles.map(a => a.title);

    // --- Twitter/X: short, top 3 headlines ---
    let twitter = `📍 ${cityName} — today's top local news:\n\n`;
    headlines.slice(0, 3).forEach(h => { twitter += `• ${h}\n`; });
    twitter += `\nFull summaries 👇\n${cityLink}\n#${tag}`;

    // --- LinkedIn: professional framing ---
    let linkedin = `Today's ${cityName} news, summarized in two minutes:\n\n`;
    headlines.forEach(h => { linkedin += `• ${h}\n`; });
    linkedin += `\nRead the full local roundup here: ${cityLink}\n\n` +
                `Prefer it by email? ${SIGNUP_URL}\n\n#${tag} #LocalNews`;

    // --- Facebook: conversational ---
    let facebook = `📰 Your ${cityName} daily roundup — here's what's happening today:\n\n`;
    headlines.forEach(h => { facebook += `• ${h}\n`; });
    facebook += `\nFull two-minute summaries: ${cityLink}\n` +
                `Get it free by email: ${SIGNUP_URL}`;

    // --- Reddit: plain, minimal promo, with a caution note ---
    let reddit =
      `[NOTE TO YOU: Reddit dislikes self-promo. Add genuine context, ` +
      `pick the RIGHT subreddit, and consider posting headlines as discussion ` +
      `rather than just a link. Use sparingly.]\n\n` +
      `Today's ${cityName} local news roundup:\n\n`;
    headlines.forEach(h => { reddit += `- ${h}\n`; });
    reddit += `\n(Summaries + sources: ${cityLink})`;

    byCity[cityName] = { twitter, linkedin, facebook, reddit };

    fileText +=
      `==================================================\n` +
      `CITY: ${cityName}\n` +
      `==================================================\n\n` +
      `----- TWITTER / X -----\n${twitter}\n\n` +
      `----- LINKEDIN -----\n${linkedin}\n\n` +
      `----- FACEBOOK -----\n${facebook}\n\n` +
      `----- REDDIT -----\n${reddit}\n\n\n`;
  }

  writeFileSync('platform-posts.txt', fileText);
  console.log('Platform posts written to platform-posts.txt');

  const url = `${FIREBASE_URL}/platform_posts/${dateKey}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(byCity)
  });
  if (response.ok) {
    console.log('Platform posts saved to Firebase (by city + platform).');
  } else {
    console.error('Platform posts save failed:', await response.text());
  }
}

async function main() {
  console.log('Starting digest generation...');
  console.log(`Loaded ${CITIES.length} cities from cities.json`);
  const today = new Date().toISOString().split('T')[0];
  const digest = {};          // fresh cities only (drives social/telegram/platform/pool/feedback)
  const displayData = {};     // what the pages show: fresh OR last-good fallback
  const feedbackData = {};
  const poolData = {};
  const freshCities = [];
  const staleCities = [];

  for (const city of CITIES) {
    console.log(`\nFetching news for ${city.name}...`);
    const rawPool = await fetchNews(city);
    const cleaned = cleanPool(rawPool);
    console.log(`  Fetched ${rawPool.length}, ${cleaned.length} after cleaning.`);

    if (cleaned.length === 0) {
      // No fresh news — fall back to last-good data so the page never goes blank.
      const last = await readLatest(city.name);
      if (last && last.articles && last.articles.length > 0) {
        displayData[city.name] = last;
        staleCities.push(`${city.name} (showing ${last.date || 'previous'})`);
        console.log(`  No fresh news — using last-good data from ${last.date || 'previous run'}.`);
      } else {
        console.log(`  No fresh news and no cached data — ${city.name} omitted.`);
      }
      continue;
    }

    const stories = await clusterArticles(cleaned, city.name);
    const { chosen, chosenIdx } = await rankArticles(stories, city.name);

    const summariesByStoryIndex = {};
    const categoriesByStoryIndex = {};
    const summarized = [];
    for (const article of chosen) {
      console.log(`  Summarizing: ${article.title}`);
      const { summary, category } = await summarizeAndCategorize(
        article.title, article.description, article.content
      );
      summarized.push({
        title: article.title,
        source: article.source?.name || 'Unknown',
        url: article.url,
        summary: summary,
        category: category,
        sourceCount: article.sourceCount || 1,
        publishedAt: article.publishedAt
      });
      const storyIndex = stories.indexOf(article);
      if (storyIndex !== -1) {
        summariesByStoryIndex[storyIndex] = summary;
        categoriesByStoryIndex[storyIndex] = category;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const cityData = { date: today, articles: summarized };
    digest[city.name] = cityData;
    displayData[city.name] = cityData;
    freshCities.push(city.name);
    await saveLatest(city.name, cityData);   // update source-of-truth for fallback

    feedbackData[city.name] = {
      stories, chosenIdx,
      summaries: summariesByStoryIndex,
      categories: categoriesByStoryIndex
    };
    poolData[city.name] = { stories, chosenIdx };
  }

  // Firebase digest + pool + social/telegram/platform/feedback use FRESH cities only.
  if (Object.keys(digest).length > 0) {
    await saveDigest(today, digest);
    await savePool(today, poolData);
    await saveSocialPosts(today, digest);
    await postToTelegram(digest);
    await savePlatformPosts(today, digest);
    buildFeedbackTemplate(today, feedbackData);
  } else {
    console.log('No cities updated today — skipping digest/pool/social/telegram/platform/feedback writes.');
  }

  // Pages are built from displayData (fresh + last-good), so nothing goes blank.
  if (Object.keys(displayData).length > 0) {
    buildAllPages(today, displayData);
  } else {
    console.log('No data at all (fresh or cached) — leaving existing pages untouched.');
  }

  // --- Run summary in the log ---
  console.log('\n==================================================');
  console.log('   RUN SUMMARY');
  console.log('==================================================');
  console.log(`Updated today (${freshCities.length}): ${freshCities.join(', ') || 'none'}`);
  console.log(`Showing older data (${staleCities.length}): ${staleCities.join(', ') || 'none'}`);
  console.log('==================================================\n');

  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
