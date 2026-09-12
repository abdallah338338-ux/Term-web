-- ==============================================================================
-- TermBoard Database Schema for Supabase PostgreSQL
-- ==============================================================================
-- قم بنسخ هذا الكود بالكامل ولصقه في Supabase -> SQL Editor ثم اضغط "RUN"

-- 1. جدول بنك الأسئلة (question_bank)
CREATE TABLE IF NOT EXISTS question_bank (
    id BIGSERIAL PRIMARY KEY,
    subject_id TEXT NOT NULL,
    subject_name TEXT,
    lecture_number INT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    type TEXT DEFAULT 'text', -- 'text' / 'equation' / 'diagram'
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- فهارس لتسريع الاستعلام والفلترة
CREATE INDEX IF NOT EXISTS idx_question_bank_subject ON question_bank(subject_id);
CREATE INDEX IF NOT EXISTS idx_question_bank_subject_lecture ON question_bank(subject_id, lecture_number);
CREATE INDEX IF NOT EXISTS idx_question_bank_used ON question_bank(subject_id, used);

-- 2. جدول سجل الامتحانات السابقة (exam_history)
CREATE TABLE IF NOT EXISTS exam_history (
    id BIGSERIAL PRIMARY KEY,
    subject_id TEXT NOT NULL,
    subject_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    questions_html TEXT NOT NULL,
    answers_html TEXT NOT NULL
);

-- فهرس لترتيب واسترجاع الامتحانات السابقة بسرعة
CREATE INDEX IF NOT EXISTS idx_exam_history_subject ON exam_history(subject_id, created_at DESC);

-- 3. جدول الملفات المرفوعة الحقيقية (lecture_files)
-- بيربط كل محاضرة برابط ملف الـPDF الأصلي المحفوظ في Supabase Storage
-- (bucket اسمه lecture-files، لازم تعمله يدوي من Storage → New bucket → Public)
CREATE TABLE IF NOT EXISTS lecture_files (
    id BIGSERIAL PRIMARY KEY,
    subject_id TEXT NOT NULL,
    lecture_number INT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_url TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lecture_files_subject ON lecture_files(subject_id, lecture_number);

-- 4. جدول بيانات المواد (subjects) — الاسم/الأيقونة/اللون متزامنين
-- بين كل الأجهزة (بدل ما يتخزنوا محليًا بس في كل متصفح)
CREATE TABLE IF NOT EXISTS subjects (
    subject_id TEXT PRIMARY KEY,
    name TEXT,
    icon TEXT,
    color TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
