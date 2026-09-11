# TermBoard Backend (خفيف — بديل n8n)

## التشغيل على Render

1. ارفع الفولدر ده (server.js, package.json) على GitHub repo جديد.
2. Render → New → **Web Service** → اربطه بالـrepo (مش Docker Image
   هالمرة — اختار "Node" كـEnvironment العادي).
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment variables:
```
DB_HOST=<host من Supabase>
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=<password من Supabase>
GEMINI_API_KEY=<مفتاحك من aistudio.google.com>
```
6. Deploy. أول تشغيل هيعمل الجداول (`question_bank`, `exam_history`)
   في Supabase تلقائيًا.

## الروابط النهائية (حطّها في term-tracker.html)

```
N8N_EXTRACT_URL      = https://<اسم-الخدمة>.onrender.com/webhook/extract-questions
N8N_GENERATE_URL     = https://<اسم-الخدمة>.onrender.com/webhook/generate-exam
N8N_BANK_INFO_URL    = https://<اسم-الخدمة>.onrender.com/webhook/bank-info
N8N_EXAM_HISTORY_URL = https://<اسم-الخدمة>.onrender.com/webhook/exam-history
```

## اختبار سريع محليًا

```
npm install
DB_HOST=... DB_PORT=5432 DB_NAME=postgres DB_USER=postgres DB_PASSWORD=... GEMINI_API_KEY=... npm start
```
افتح `http://localhost:10000` — المفروض يظهر "TermBoard backend is running ✅".

## ملاحظة مهمة

n8n بقى مش جزء من الاستضافة الدائمة خالص — ده سيرفر Node.js عادي بيعمل
بالظبط نفس الوظائف الأربعة، بس أخف بكتير على الرام (50-100MB بدل
300-500MB+)، فبيشتغل مريح على خطة Render المجانية (512MB).
