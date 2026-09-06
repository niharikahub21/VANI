// server.js
// VoiceLayer Backend Server
// This server handles voice commands from the Chrome extension:
// classifies intent (search/note/reminder), calls external APIs, and returns a spoken response.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Gemini client using the API key from .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

// Initialize Supabase client using the URL and key from .env
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ------------------------
// History function - fetches the last 20 rows from the "history" table,
// ordered by created_at descending (most recent first).
// ------------------------
async function getHistory() {
  const { data, error } = await supabase
    .from('history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Supabase error fetching history: ${error.message}`);
  }

  return data;
}

// ------------------------
// Helper: Call Gemini to classify the user's intent
// ------------------------
async function classifyIntent(userText) {
  const prompt = `You are an intent classifier for a voice assistant called VoiceLayer.
Classify the user's command into one of: "search", "note", or "reminder".
Extract the relevant content from their command.
If the action is "reminder", also extract a time/date if mentioned (otherwise null).
Respond ONLY with valid JSON in this exact format, no extra text, no markdown code blocks:
{"action": "search"|"note"|"reminder", "content": "extracted text", "reminder_time": "extracted time or null", "spoken_response": "short natural spoken text"}

User command: "${userText}"`;

  const result = await model.generateContent(prompt);
  let rawText = result.response.text().trim();

  // Remove markdown code fences if Gemini adds them
  rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

  return JSON.parse(rawText);
}

// ------------------------
// Helper: Call Serper API to search the web
// ------------------------
async function searchWeb(query) {
  const response = await axios.post(
    'https://google.serper.dev/search',
    { q: query },
    {
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  const organicResults = response.data.organic || [];
  const topTwo = organicResults.slice(0, 2);
  return topTwo.map((r) => r.snippet).join(' ');
}

// ------------------------
// Helper: Ask Gemini to generate a spoken answer from search snippets
// ------------------------
async function generateSearchAnswer(query, snippets) {
  const prompt = `Answer this question in 2-3 short, natural spoken sentences based on the given search info. Do not mention "snippets" or "search results" - just answer naturally like a voice assistant.

Question: ${query}

Search info: ${snippets}`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// ------------------------
// Helper: Convert text to speech using Rime API
// ------------------------
async function generateSpeech(text) {
  const response = await axios.post(
    'https://users.rime.ai/v1/rime-tts',
    {
      text: text,
      speaker: 'astra',
      modelId: 'arcana',
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RIME_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mp3',
      },
      responseType: 'arraybuffer',
    }
  );

  const audioBase64 = Buffer.from(response.data, 'binary').toString('base64');
  return audioBase64;
}

// ------------------------
// Helper: Save a row to the "history" table for every processed command
// ------------------------
async function saveHistory(userText, action, responseText) {
  const { error } = await supabase
    .from('history')
    .insert([{ user_text: userText, action: action, response_text: responseText }]);

  if (error) {
    throw new Error(`Supabase error saving history: ${error.message}`);
  }
}

// ------------------------
// Helper: Save a note to the "notes" table
// ------------------------
async function saveNote(content) {
  const { error } = await supabase.from('notes').insert([{ content: content }]);

  if (error) {
    throw new Error(`Supabase error saving note: ${error.message}`);
  }
}

// ------------------------
// Helper: Save a reminder to the "reminders" table
// ------------------------
async function saveReminder(content, reminderTime) {
  const { error } = await supabase
    .from('reminders')
    .insert([{ content: content, reminder_time: reminderTime }]);

  if (error) {
    throw new Error(`Supabase error saving reminder: ${error.message}`);
  }
}

// ------------------------
// ROUTES
// ------------------------

app.get('/', (req, res) => {
  res.send('VoiceLayer backend is running');
});

app.post('/api/process', async (req, res) => {
  try {
    const userText = req.body.text;

    if (!userText) {
      return res.status(400).json({ error: 'Missing "text" in request body' });
    }

    const classification = await classifyIntent(userText);
    const { action, content, reminder_time } = classification;
    let spoken_response = classification.spoken_response;

    if (action === 'search') {
      const snippets = await searchWeb(content);
      spoken_response = await generateSearchAnswer(content, snippets);
    } else if (action === 'note') {
      spoken_response = 'Note saved.';
    } else if (action === 'reminder') {
      spoken_response = `Reminder set for ${reminder_time}.`;
    }

    const audio_base64 = await generateSpeech(spoken_response);

    // Save this interaction to the "history" table
    await saveHistory(userText, action, spoken_response);

    // Save to the action-specific table as well
    if (action === 'note') {
      await saveNote(content);
    } else if (action === 'reminder') {
      await saveReminder(content, reminder_time);
    }

    res.json({
      action,
      content,
      reminder_time,
      spoken_response,
      audio_base64,
    });
  } catch (error) {
    console.error('Error in /api/process:',error.response?.data || error.message);
    res.status(500).json({ error: 'Something went wrong processing your request.' });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const history = await getHistory();
    res.json(history);
  } catch (error) {
    console.error('Error in /api/history:', error.message);
    res.status(500).json({ error: 'Could not fetch history.' });
  }
});

// ------------------------
// Start the server
// ------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VoiceLayer backend is running on port ${PORT}`);
});