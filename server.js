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
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`;

// ── Supabase Storage (رفع الملفات الحقيقية عشان تفضل متاحة من أي جهاز) ──
const SUPABASE_URL = process.env.SUPABASE_URL;          // مثال: https://xxxx.supabase.co
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key
const STORAGE_BUCKET = "lecture-files";

function sanitizeFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9_.\-\u0600-\u06FF]/g, "_");
}

// بيرفع الملف لـSupabase Storage ويرجّع رابطه العام. لو الإعدادات ناقصة
// أو الرفع فشل، بيرجّع null من غير ما يوقف باقي العملية (الاستخراج أهم).
async function uploadFileToStorage(buffer, mimeType, subjectId, lectureNumber, originalName) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn("Supabase Storage env vars missing — skipping file upload");
    return null;
  }
  try {
    const path = `${subjectId}/${lectureNumber}-${Date.now()}-${sanitizeFileName(originalName)}`;
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": mimeType || "application/pdf",
          "x-upsert": "true",
        },
        body: buffer,
      }
    );
    if (!uploadRes.ok) {
      console.warn("Storage upload failed:", uploadRes.status, await uploadRes.text());
      return null;
    }
    return {
      path,
      url: `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`,
    };
  } catch (e) {
    console.warn("Storage upload error:", e);
    return null;
  }
}

async function deleteFilesFromStorage(paths) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || paths.length === 0) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: paths }),
    });
  } catch (e) {
    console.warn("Storage delete error:", e);
  }
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qa_sheets (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      sheet_data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lecture_files (
      id SERIAL PRIMARY KEY,
      subject_id TEXT NOT NULL,
      lecture_number INT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_url TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lecture_files_subject ON lecture_files(subject_id, lecture_number);`);
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
      "You are an expert university exam problem extractor and solver for engineering and science curricula.\n" +
      "Analyze this PDF carefully (which may contain lecture tutorial sheets, questions with solutions, or questions followed by model answers).\n\n" +
      "TASKS:\n" +
      "1. Extract ALL distinct questions/problems along with their full, step-by-step model answers.\n" +
      "2. If answers are provided in the document (either right below each question or in an answer section at the end/separate pages), extract the exact corresponding solution.\n" +
      "3. If any question lacks a solution in the PDF, write a rigorous, complete, step-by-step mathematical/engineering solution for it.\n" +
      "4. Format all mathematical expressions, variables, units, and equations using standard LaTeX enclosed in single dollar signs for inline ($x = 4\\sin\\theta$) or double dollar signs for block ($$\\int ... dx$$).\n" +
      "5. Describe any essential geometry, triangles, or diagram setups clearly in text.\n" +
      "6. Return ONLY a valid JSON array of objects with NO surrounding markdown or commentary:\n" +
      '[{"question": "Problem statement in English/Arabic with $LaTeX$", "answer": "Detailed step-by-step solution with $LaTeX$", "type": "text"}]';

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

    // First delete any previous questions for this lecture to prevent duplicates
    await pool.query(
      `DELETE FROM question_bank WHERE subject_id = $1 AND lecture_number = $2`,
      [subject_id, Number(lecture_number)]
    );

    for (const q of questions) {
      await pool.query(
        `INSERT INTO question_bank (subject_id, lecture_number, question, answer, type)
         VALUES ($1, $2, $3, $4, $5)`,
        [subject_id, Number(lecture_number), q.question || "", q.answer || "", q.type || "text"]
      );
    }

    // ارفع الملف الأصلي لـSupabase Storage عشان يفضل متاح من أي جهاز
    // (لو فشل الرفع، الاستخراج لسه نجح — مبنوقفش العملية بسببه)
    const uploaded = await uploadFileToStorage(
      req.file.buffer,
      mimeType,
      subject_id,
      Number(lecture_number),
      req.file.originalname || "lecture.pdf"
    );
    if (uploaded) {
      await pool.query(
        `DELETE FROM lecture_files WHERE subject_id = $1 AND lecture_number = $2`,
        [subject_id, Number(lecture_number)]
      );
      await pool.query(
        `INSERT INTO lecture_files (subject_id, lecture_number, file_name, file_path, file_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [subject_id, Number(lecture_number), req.file.originalname || "lecture.pdf", uploaded.path, uploaded.url]
      );
    }

    res.json({ status: "ok", questions_extracted: questions.length, file_url: uploaded ? uploaded.url : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: String(err) });
  }
});

// ── 2) توليد امتحان (شامل أو لمحاضرات محددة) ─────────────────────────
app.post("/webhook/generate-exam", async (req, res) => {
  try {
    const { subject_id, subject_name, question_count, selected_lectures } = req.body;
    const qCount = Number(question_count) || 10;

    let query = `SELECT * FROM question_bank WHERE subject_id = $1`;
    let params = [String(subject_id)];

    if (Array.isArray(selected_lectures) && selected_lectures.length > 0) {
      query += ` AND lecture_number = ANY($2::int[])`;
      params.push(selected_lectures.map(Number));
    }
    query += ` ORDER BY lecture_number ASC`;

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return res.status(400).json({ error: "question bank فاضي لسه للمحاضرات المحددة" });

    let selected = [];
    if (!selected_lectures || selected_lectures.length === 0) {
      const lectureCount = Math.max(...rows.map((r) => r.lecture_number));
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

// ── 5) حذف أسئلة محاضرة معينة عند حذف الملف من الموقع ─────────────
app.post("/webhook/delete-lecture", async (req, res) => {
  try {
    const { subject_id, lecture_number } = req.body;
    await pool.query(
      `DELETE FROM question_bank WHERE subject_id = $1 AND lecture_number = $2`,
      [String(subject_id), Number(lecture_number)]
    );

    const { rows } = await pool.query(
      `SELECT file_path FROM lecture_files WHERE subject_id = $1 AND lecture_number = $2`,
      [String(subject_id), Number(lecture_number)]
    );
    if (rows.length > 0) {
      await deleteFilesFromStorage(rows.map((r) => r.file_path));
      await pool.query(
        `DELETE FROM lecture_files WHERE subject_id = $1 AND lecture_number = $2`,
        [String(subject_id), Number(lecture_number)]
      );
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ── 8) روابط الملفات المرفوعة (لعرض/فتح الملف الأصلي من أي جهاز) ────
app.get("/webhook/lecture-files", async (req, res) => {
  try {
    const subjectId = String(req.query.subject_id);
    const { rows } = await pool.query(
      `SELECT lecture_number, file_name, file_url FROM lecture_files
       WHERE subject_id = $1 ORDER BY lecture_number ASC`,
      [subjectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
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

// ── 6) أداة دمج شيتات الأسئلة والإجابات (Q&A Sheet Builder) ─────────
const qaUpload = upload.fields([
  { name: "questions_file", maxCount: 1 },
  { name: "answers_file", maxCount: 1 },
  { name: "single_file", maxCount: 1 },
]);

app.post("/webhook/merge-qa-sheet", qaUpload, async (req, res) => {
  try {
    const qFile = req.files && req.files["questions_file"] ? req.files["questions_file"][0] : (req.files && req.files["single_file"] ? req.files["single_file"][0] : null);
    const aFile = req.files && req.files["answers_file"] ? req.files["answers_file"][0] : null;

    if (!qFile && !aFile) return res.status(400).json({ error: "no files provided" });

    const prompt =
      "You are an expert university tutorial and problem set converter.\n" +
      "You are provided with one or two files (Questions PDF and/or Model Answers PDF which may be handwritten/CamScanner notes or printed).\n\n" +
      "GOAL:\n" +
      "Produce a unified, print-ready, professional problem-by-problem Q&A worksheet matching the provided files.\n\n" +
      "RULES:\n" +
      "1. Identify the Course/Subject Name, Course Code (e.g. PHM112), Term/Year, and Tutorial/Sheet Title from the headers/footers.\n" +
      "2. For each Problem/Question: match it with its exact complete worked solution from the answers file.\n" +
      "3. If any question has no answer in the file, solve it accurately in full mathematical detail in the same pedagogical style.\n" +
      "4. Format all math equations in standard LaTeX using \\( ... \\) for inline math and \\[ ... \\] for display block math.\n" +
      "5. If a solution uses a geometric reference triangle (like in trig substitution), include a small SVG right-triangle diagram with labeled sides and angle \\theta.\n" +
      "6. Wrap the final result/expression in \\boxed{...}.\n" +
      "7. Return ONLY a valid JSON object strictly matching this schema with no markdown formatting:\n" +
      "{\n" +
      '  "course_title": "Tutorial 5 — Integration",\n' +
      '  "course_sub": "Mathematics for Engineers and Scientists 2 (PHM112) · Fall 2025",\n' +
      '  "problems": [\n' +
      "    {\n" +
      '      "problem_label": "Problem 1",\n' +
      '      "question_html": "Find the integral: \\\\[ \\\\int \\\\frac{\\\\sqrt{16-x^2}}{x^2} dx \\\\]",\n' +
      '      "answer_html": "Let \\\\( x = 4 \\\\sin \\\\theta, dx = 4 \\\\cos \\\\theta d\\\\theta \\\\)... \\\\[ \\\\boxed{ I = -\\\\frac{\\\\sqrt{16-x^2}}{x} - \\\\sin^{-1} \\\\frac{x}{4} + C } \\\\]"\n' +
      "    }\n" +
      "  ]\n" +
      "}";

    const parts = [{ text: prompt }];

    if (qFile) {
      parts.push({ text: "FILE 1 (Questions Sheet):" });
      parts.push({
        inline_data: {
          mime_type: qFile.mimetype || "application/pdf",
          data: qFile.buffer.toString("base64"),
        },
      });
    }

    if (aFile) {
      parts.push({ text: "FILE 2 (Model Answers / Handwritten CamScanner Solutions):" });
      parts.push({
        inline_data: {
          mime_type: aFile.mimetype || "application/pdf",
          data: aFile.buffer.toString("base64"),
        },
      });
    }

    const geminiRes = await fetch(`${GEMINI_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }] }),
    });

    if (!geminiRes.ok) throw new Error(`Gemini HTTP ${geminiRes.status}`);
    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const resultObj = JSON.parse(cleaned.substring(start, end + 1));

    // Save to database
    try {
      await pool.query(
        `INSERT INTO qa_sheets (title, subtitle, sheet_data) VALUES ($1, $2, $3)`,
        [resultObj.course_title || "Tutorial Sheet", resultObj.course_sub || "", JSON.stringify(resultObj)]
      );
    } catch (dbErr) {
      console.warn("Could not save QA sheet to DB:", dbErr);
    }

    res.json({ status: "ok", sheet: resultObj });
  } catch (err) {
    console.error("Merge Q&A Error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── 7) سجل الشيتات السابقة (Q&A Sheets History) ────────────────────
app.get("/webhook/qa-sheets", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, subtitle, sheet_data, created_at FROM qa_sheets ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 10000;
ensureTables()
  .then(() => app.listen(PORT, () => console.log(`✓ TermBoard backend listening on ${PORT}`)))
  .catch((e) => { console.error("DB init failed:", e); process.exit(1); });
