/**
 * TermBoard Lightweight Backend
 * ==============================
 * بديل خفيف لـn8n — بيعمل بالظبط نفس الأربع وظائف اللي كانت الورشات
 * بتعملها، بس باستهلاك رام أقل بكتير (50-100MB بدل 300-500MB+).
 *
 * الأربع نقاط:
 *   POST /webhook/extract-questions   — استخراج أسئلة من PDF
 *   POST /webhook/generate-exam       — توليد امتحان
 *   GET  /webhook/bank-info           — إحصائيات البنك
 *   GET  /webhook/exam-history        — الامتحانات السابقة
 *
 * التشغيل محليًا: npm install && npm start
 * على Render: اربط الريبو، الأمر start موجود في package.json
 */

const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── قاعدة البيانات (Supabase Postgres) ─────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "postgres",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, // مطلوب لـSupabase
  max: 3, // قلّة اتصالات عشان نفضل في حدود الرام
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

// ── جداول قاعدة البيانات (تتعمل أول مرة تلقائيًا) ───────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS question_bank (
      id SERIAL PRIMARY KEY,
      subject_id TEXT NOT NULL,
      lecture_number INT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_history (
      id SERIAL PRIMARY KEY,
      subject_id TEXT NOT NULL,
      subject_name TEXT,
      questions_html TEXT NOT NULL,
      answers_html TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log("✓ tables ready");
}

// ── 1) استخراج الأسئلة من PDF ───────────────────────────────────────
app.post("/webhook/extract-questions", upload.single("file"), async (req, res) => {
  try {
    const { subject_id, lecture_number } = req.body;
    if (!req.file) return res.status(400).json({ error: "no file" });

    const base64Data = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "application/pdf";

    const prompt =
      "Extract all questions, formulas, and solutions from this file. " +
      "IMPORTANT INSTRUCTIONS:\n" +
      "1. Format all math expressions using proper LaTeX (e.g. \\int, \\frac, \\sqrt).\n" +
      "2. Describe any diagrams/figures precisely in text.\n" +
      "3. Include full solution steps, not just the final answer.\n" +
      "4. Return ONLY a valid JSON array, no explanation: " +
      '[{"question":"...","answer":"...","type":"text|diagram|formula"}]';

    const geminiRes = await fetch(`${GEMINI_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }] }],
      }),
    });
    if (!geminiRes.ok) throw new Error(`Gemini HTTP ${geminiRes.status}`);
    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    const questions = JSON.parse(cleaned.substring(start, end + 1));

    for (const q of questions) {
      await pool.query(
        `INSERT INTO question_bank (subject_id, lecture_number, question, answer, type)
         VALUES ($1, $2, $3, $4, $5)`,
        [subject_id, Number(lecture_number), q.question || "", q.answer || "", q.type || "text"]
      );
    }

    res.json({ status: "ok", questions_extracted: questions.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: String(err) });
  }
});

// ── 2) توليد امتحان ─────────────────────────────────────────────────
app.post("/webhook/generate-exam", async (req, res) => {
  try {
    const { subject_id, subject_name, question_count } = req.body;
    const qCount = Number(question_count) || 10;

    const { rows } = await pool.query(
      `SELECT * FROM question_bank WHERE subject_id = $1 ORDER BY lecture_number ASC`,
      [String(subject_id)]
    );
    if (rows.length === 0) return res.status(400).json({ error: "question bank فاضي لسه" });

    const lectureCount = Math.max(...rows.map((r) => r.lecture_number));
    let selected = [];

    if (lectureCount > 3) {
      const recentLectures = [lectureCount - 2, lectureCount - 1, lectureCount];
      const recentPool = shuffle(rows.filter((r) => recentLectures.includes(r.lecture_number)));
      const olderPool = shuffle(rows.filter((r) => !recentLectures.includes(r.lecture_number)));
      selected = [
        ...pickPreferUnused(recentPool, Math.ceil(qCount / 2)),
        ...pickPreferUnused(olderPool, Math.floor(qCount / 2)),
      ];
    } else {
      selected = pickPreferUnused(shuffle(rows), qCount);
    }
    selected = selected.slice(0, qCount);

    if (selected.length > 0) {
      await pool.query(`UPDATE question_bank SET used = TRUE WHERE id = ANY($1::int[])`, [
        selected.map((s) => s.id),
      ]);
    }

    const questions_html = `<ol>${selected.map((s) => `<li>${escapeHtml(s.question)}</li>`).join("")}</ol>`;
    const answers_html = `<ol>${selected.map((s) => `<li>${escapeHtml(s.answer)}</li>`).join("")}</ol>`;

    await pool.query(
      `INSERT INTO exam_history (subject_id, subject_name, questions_html, answers_html)
       VALUES ($1, $2, $3, $4)`,
      [String(subject_id), subject_name || "", questions_html, answers_html]
    );

    res.json({ questions_html, answers_html });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: String(err) });
  }
});

// ── 3) إحصائيات البنك ───────────────────────────────────────────────
app.get("/webhook/bank-info", async (req, res) => {
  try {
    const subjectId = String(req.query.subject_id);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(MAX(lecture_number),0)::int AS max_lecture
       FROM question_bank WHERE subject_id = $1`,
      [subjectId]
    );
    res.json({ lecture_count: rows[0].max_lecture, total_questions: rows[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ── 4) الامتحانات السابقة ───────────────────────────────────────────
app.get("/webhook/exam-history", async (req, res) => {
  try {
    const subjectId = String(req.query.subject_id);
    const { rows } = await pool.query(
      `SELECT id, created_at, questions_html, answers_html FROM exam_history
       WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [subjectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/", (req, res) => res.send("TermBoard backend is running ✅"));

// ── Helpers ──────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickPreferUnused(pool, n) {
  const unused = pool.filter((r) => !r.used);
  const used = pool.filter((r) => r.used);
  return [...unused, ...used].slice(0, n);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const PORT = process.env.PORT || 10000;
ensureTables()
  .then(() => app.listen(PORT, () => console.log(`✓ TermBoard backend listening on ${PORT}`)))
  .catch((e) => { console.error("DB init failed:", e); process.exit(1); });
