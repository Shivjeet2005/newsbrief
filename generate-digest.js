import fetch from 'node-fetch';
import { readFileSync, writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const FIREBASE_URL = process.env.FIREBASE_URL;

const CITIES = JSON.parse(readFileSync('cities.json', 'utf-8'));

const POOL_SIZE = 15;
const STORIES_PER_CITY = 5;

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/` +
  `gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

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

async function rankArticles(articles) {
  const headlineList = articles
    .map((a, i) => `${i + 1}. ${a.title}`)
    .join('\n');

  const promptText =
    `Below are ${articles.length} news headlines. Pick the ${STORIES_PER_CITY} ` +
    `MOST SIGNIFICANT and newsworthy overall. Consider genuine importance and ` +
    `broad relevance. Respond with ONLY the numbers of your chosen headlines, ` +
    `separated by commas, in order of importance. Example: 4, 1, 9, 2, 7\n\n` +
    headlineList;

  const answer = await callGemini(promptText);

  if (!answer) {
    console.log('  Ranking unavailable — falling back to first articles.');
    return articles.slice(0, STORIES_PER_CITY);
  }

  const picks = answer
    .match(/\d+/g)
    ?.map(n => parseInt(n, 10))
    .filter(n => n >= 1 && n <= articles.length)
    .map(n => n - 1);

  if (!picks || picks.length === 0) {
    console.log('  Could not read ranking — falling back to first articles.');
    return articles.slice(0, STORIES_PER_CITY);
  }

  const uniquePicks = [...new Set(picks)].slice(0, STORIES_PER_CITY);
  return uniquePicks.map(i => articles[i]);
}

async function summarize(title, description, content) {
  const promptText =
    `Summarize this news article in 2-3 clear, neutral sentences ` +
    `(under 150 words). Just the summary, no preamble.\n\n` +
    `Title: ${title}\n` +
    `Description: ${description || 'N/A'}\n` +
    `Content: ${content ? content.substring(0, 800) : 'N/A'}`;

  const summary = await callGemini(promptText);
  return summary || 'Summary unavailable.';
}

async function fetchNews(city) {
  const url =
    `https://newsapi.org/v2/everything?q=${encodeURIComponent(city.query)}` +
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

// Escape text so it displays safely inside HTML.
function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the reader-facing webpage (index.html).
function buildWebpage(dateKey, digest) {
  let citySections = '';

  for (const cityName of Object.keys(digest)) {
    const articles = (digest[cityName].articles || [])
      .filter(a => a.summary && a.summary !== 'Summary unavailable.');

    if (articles.length === 0) continue;

    let items = '';
    for (const a of articles) {
      items +=
        `<article class="story">` +
        `<h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>` +
        `<p class="summary">${esc(a.summary)}</p>` +
        `<p class="source">Source: ${esc(a.source)}</p>` +
        `</article>`;
    }

    citySections +=
      `<section class="city"><h2>${esc(cityName)}</h2>${items}</section>`;
  }

  const html =
`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily News Digest — ${esc(dateKey)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.5; }
  header { border-bottom: 2px solid #1a1a1a; margin-bottom: 24px; padding-bottom: 12px; }
  header h1 { margin: 0 0 4px; font-size: 1.6rem; }
  header .date { color: #666; font-size: 0.9rem; }
  .city { margin-bottom: 32px; }
  .city > h2 { font-size: 1.2rem; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  .story { margin-bottom: 20px; }
  .story h3 { margin: 0 0 6px; font-size: 1.05rem; }
  .story h3 a { color: #0b57d0; text-decoration: none; }
  .story h3 a:hover { text-decoration: underline; }
  .summary { margin: 0 0 4px; }
  .source { margin: 0; color: #888; font-size: 0.85rem; }
  footer { border-top: 1px solid #ddd; margin-top: 32px; padding-top: 16px; color: #888; font-size: 0.85rem; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Daily News Digest</h1>
  <div class="date">${esc(dateKey)}</div>
</header>
${citySections}
<footer>Summaries are AI-generated. Click any headline to read the full story at the source.</footer>
</body>
</html>`;

  writeFileSync('index.html', html);
  console.log('Webpage (index.html) written.');
}

async function main() {
  console.log('Starting digest generation...');
  console.log(`Loaded ${CITIES.length} cities from cities.json`);
  const today = new Date().toISOString().split('T')[0];
  const digest = {};

  for (const city of CITIES) {
    console.log(`\nFetching news for ${city.name}...`);
    const pool = await fetchNews(city);
    console.log(`  Fetched ${pool.length} articles, ranking best ${STORIES_PER_CITY}...`);

    const chosen = await rankArticles(pool);

    const summarized = [];
    for (const article of chosen) {
      console.log(`  Summarizing: ${article.title}`);
      const summary = await summarize(
        article.title, article.description, article.content
      );
      summarized.push({
        title: article.title,
        source: article.source?.name || 'Unknown',
        url: article.url,
        summary: summary,
        publishedAt: article.publishedAt
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    digest[city.name] = { articles: summarized };
  }

  await saveDigest(today, digest);
  buildWebpage(today, digest);
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
