import fetch from 'node-fetch';
import { readFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const FIREBASE_URL = process.env.FIREBASE_URL;

const CITIES = JSON.parse(readFileSync('cities.json', 'utf-8'));
const STORIES_PER_CITY = 5;

async function summarize(title, description, content) {
  const promptText =
    `Summarize this news article in 2-3 clear, neutral sentences ` +
    `(under 150 words). Just the summary, no preamble.\n\n` +
    `Title: ${title}\n` +
    `Description: ${description || 'N/A'}\n` +
    `Content: ${content ? content.substring(0, 800) : 'N/A'}`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, {
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

    console.error('Summarization failed:', JSON.stringify(data));
    return 'Summary unavailable.';
  }

  console.error('Summarization failed after retries (model stayed busy).');
  return 'Summary unavailable.';
}

async function fetchNews(city) {
  const url =
    `https://newsapi.org/v2/everything?q=${encodeURIComponent(city.query)}` +
    `&language=en&sortBy=publishedAt&pageSize=${STORIES_PER_CITY}` +
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

function printSocialPosts(digest) {
  console.log('\n\n');
  console.log('==================================================');
  console.log('   COPY-PASTE-READY SOCIAL POSTS BELOW');
  console.log('==================================================\n');

  for (const cityName of Object.keys(digest)) {
    const articles = digest[cityName].articles || [];

    for (const article of articles) {
      if (!article.summary || article.summary === 'Summary unavailable.') {
        continue;
      }

      console.log(`📍 ${cityName}`);
      console.log(article.title);
      console.log('');
      console.log(article.summary);
      console.log('');
      console.log(`🔗 ${article.source}: ${article.url}`);
      console.log('─────────────────────────');
      console.log('');
    }
  }

  console.log('==================================================');
  console.log('   END OF SOCIAL POSTS');
  console.log('==================================================\n');
}

async function main() {
  console.log('Starting digest generation...');
  console.log(`Loaded ${CITIES.length} cities from cities.json`);
  const today = new Date().toISOString().split('T')[0];
  const digest = {};

  for (const city of CITIES) {
    console.log(`\nFetching news for ${city.name}...`);
    const articles = await fetchNews(city);
    const summarized = [];

    for (const article of articles) {
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
  printSocialPosts(digest);
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
