// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import * as XLSX from "xlsx";
import excelFile from "./assets/vocab.xlsx?url";
import {
  BookOpen,
  Brain,
  Check,
  FileSpreadsheet,
  Layers,
  Play,
  RotateCcw,
  X,
  BarChart3,
} from "lucide-react";

// ────────────────────────────────────────────────────────────────────────────────
// Minimal UI shims (Tailwind)
// ────────────────────────────────────────────────────────────────────────────────
const Button = ({ className = "", variant = "default", size = "md", ...props }) => (
  <button
    className={
      `inline-flex items-center justify-center gap-2 rounded-2xl border transition shadow-sm ` +
      (variant === "ghost"
        ? "border-transparent hover:bg-gray-100"
        : variant === "outline"
        ? "border-gray-300 hover:bg-gray-50"
        : variant === "destructive"
        ? "bg-red-600 text-white hover:bg-red-700 border-transparent"
        : "bg-black text-white hover:bg-gray-900 border-transparent") +
      " " +
      (size === "sm"
        ? "px-3 py-1.5 text-sm"
        : size === "lg"
        ? "px-5 py-3 text-lg"
        : "px-4 py-2 text-base") +
      " " +
      className
    }
    {...props}
  />
);

const Card = ({ className = "", ...props }) => (
  <div className={`rounded-3xl border border-gray-200 bg-white shadow-sm ${className}`} {...props} />
);
const CardHeader = ({ className = "", ...props }) => <div className={`p-6 border-b ${className}`} {...props} />;
const CardContent = ({ className = "", ...props }) => <div className={`p-6 ${className}`} {...props} />;
const Badge = ({ className = "", children }) => (
  <span className={`inline-flex items-center rounded-full bg-gray-900 text-white px-3 py-1 text-xs ${className}`}>{children}</span>
);
const Toggle = ({ checked, onChange }) => (
  <button onClick={() => onChange(!checked)} className={`w-12 h-7 rounded-full p-1 transition ${checked ? "bg-black" : "bg-gray-300"}`}>
    <div className={`w-5 h-5 bg-white rounded-full transition ${checked ? "translate-x-5" : "translate-x-0"}`} />
  </button>
);

// ────────────────────────────────────────────────────────────────────────────────
// Types & helpers
// ────────────────────────────────────────────────────────────────────────────────
/** @typedef {{ id: string; level: number; hanzi: string; pinyin: string; english: string; }} Word */
/** @typedef {{ box: number; due: number; seen: number; correct: number; incorrect: number; lastSeen?: number; }} CardProgress */

const STORAGE_KEY = "hsk_app_progress_v1";
const DATA_KEY = "hsk_app_vocab_v1";
const SETTINGS_KEY = "hsk_app_settings_v1";

const BOX_INTERVALS_DAYS = [0, 1, 2, 4, 7, 15, 30];
const DEFAULT_NEW_PER_SESSION = 15;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const nowTs = () => Date.now();
const daysToMs = (d) => d * 24 * 60 * 60 * 1000;
const norm = (s) => String(s || "").trim().toLowerCase();
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const wordId = (w) => `${w.level}|${w.hanzi}|${w.pinyin}|${w.english}`;

const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const saveJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

// Daily seed string based on LOCAL date
const localDaySeed = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  return `${y}${m}${dd}`; // YYYYMMDD
};

// Demo fallback
const DEMO = [
  { level: 1, hanzi: "爱", pinyin: "ài", english: "love" },
  { level: 1, hanzi: "谢谢", pinyin: "xièxie", english: "thanks" },
  { level: 2, hanzi: "姐姐", pinyin: "jiějie", english: "older sister" },
  { level: 3, hanzi: "帮助", pinyin: "bāngzhù", english: "help" },
  { level: 4, hanzi: "安排", pinyin: "ānpái", english: "arrange" },
  { level: 5, hanzi: "经济", pinyin: "jīngjì", english: "economy" },
  { level: 6, hanzi: "哲学", pinyin: "zhéxué", english: "philosophy" },
].map((w) => ({ id: wordId(w), ...w }));

// ────────────────────────────────────────────────────────────────────────────────
// Excel parsing & asset loading
// ────────────────────────────────────────────────────────────────────────────────
async function parseArrayBufferToWords(buf) {
  const wb = XLSX.read(buf, { type: "array" });
  const words = [];
  const sheetNames = wb.SheetNames;

  for (let si = 0; si < sheetNames.length; si++) {
    const sheetName = sheetNames[si];
    const m = /hsk\s*(\d)/i.exec(sheetName) || /(\d)/.exec(sheetName);
    const levelFromName = m ? Number(m[1]) : si + 1; // fallback by index 1..6
    const level = Number.isFinite(levelFromName) ? Math.max(1, Math.min(6, levelFromName)) : 1;

    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    if (!rows.length) continue;

    // Try to find a header in the first 5 rows
    let headerRow = rows[0];
    for (let i = 0; i < Math.min(5, rows.length) && (!headerRow || headerRow.length < 2); i++) {
      const candidate = rows[i] || [];
      const cols = candidate.map(norm);
      if (cols.includes("hanzi") || cols.includes("pinyin") || cols.includes("english")) {
        headerRow = rows[i];
        rows.splice(0, i + 1);
        break;
      }
    }

    const headers = (headerRow || []).map(norm);
    const idxHanzi = headers.findIndex((h) => ["hanzi", "汉字", "han zi", "characters"].includes(h));
    const idxPinyin = headers.findIndex((h) => ["pinyin"].includes(h));
    const idxEnglish = headers.findIndex((h) => ["english", "meaning", "definition"].includes(h));

    for (const row of rows) {
      const hanzi = String(row[idxHanzi] ?? "").trim();
      const pinyin = String(row[idxPinyin] ?? "").trim();
      const english = String(row[idxEnglish] ?? "").trim();
      if (!hanzi || !pinyin || !english) continue;
      const w = { id: "", level, hanzi, pinyin, english };
      w.id = wordId(w);
      words.push(w);
    }
  }

  if (!words.length) throw new Error("Bundled file seems empty.");
  return words;
}

async function loadBundledExcel() {
  const res = await fetch(excelFile);
  if (!res.ok) throw new Error("Failed to load bundled vocabulary.");
  const buf = await res.arrayBuffer();
  return parseArrayBufferToWords(buf);
}

// ────────────────────────────────────────────────────────────────────────────────
// SRS
// ────────────────────────────────────────────────────────────────────────────────
function nextOnCorrect(pr) {
  const box = Math.min(6, (pr?.box ?? -1) + 1);
  const due = startOfDay(new Date(Date.now() + daysToMs(BOX_INTERVALS_DAYS[box]))).getTime();
  return { box, due };
}
function nextOnWrong(pr) {
  const box = Math.max(0, (pr?.box ?? 0) - 1);
  const due = startOfDay(new Date()).getTime();
  return { box, due };
}

// ────────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [allWords, setAllWords] = useState(loadJSON(DATA_KEY, DEMO)); /** @type {Word[]} */
  const [progress, setProgress] = useState(loadJSON(STORAGE_KEY, {})); /** @type {Record<string, CardProgress>} */
  const [settings, setSettings] = useState(
    loadJSON(SETTINGS_KEY, { selectedLevel: 1, newPerSession: DEFAULT_NEW_PER_SESSION, includeReviews: true, quizType: "mc" })
  );
  const [tab, setTab] = useState("learn"); // "learn" | "test" | "browse"
  const [sessionQueue, setSessionQueue] = useState([]); /** @type {Word[]} */
  const [current, setCurrent] = useState(null); /** @type {Word|null} */
  const [revealed, setRevealed] = useState(false);
  const [stats, setStats] = useState({ reviewed: 0, correct: 0, wrong: 0 });

  const selectedLevel = useMemo(() => Number(settings.selectedLevel) || 1, [settings.selectedLevel]);

  useEffect(() => saveJSON(DATA_KEY, allWords), [allWords]);
  useEffect(() => saveJSON(STORAGE_KEY, progress), [progress]);
  useEffect(() => saveJSON(SETTINGS_KEY, settings), [settings]);

  // Autoload bundled vocab once (replace demo)
  useEffect(() => {
    const looksLikeDemo =
      allWords.length === DEMO.length && allWords.every((w, i) => w.id === DEMO[i].id);
    if (looksLikeDemo) {
      loadBundledExcel()
        .then((words) => setAllWords(words))
        .catch((err) => console.warn("Bundled vocab not loaded:", err?.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived stats (use local day bounds)
  const now = nowTs();
  const todayStart = startOfDay(new Date()).getTime();
  const todayEnd = endOfDay(new Date()).getTime();

  const totals = useMemo(() => {
    const total = allWords.length;
    let learned = 0;
    let due = 0;
    let dueToday = 0;
    for (const w of allWords) {
      const pr = progress[w.id];
      if (pr?.box >= 3) learned++;
      if (pr?.due != null) {
        if (pr.due <= now) due++;
        if (pr.due >= todayStart && pr.due <= todayEnd) dueToday++;
      }
    }
    return { total, learned, due, dueToday };
  }, [allWords, progress, now, todayStart, todayEnd]);

  const levels = useMemo(() => {
    const by = new Map();
    for (const w of allWords) by.set(w.level, (by.get(w.level) || 0) + 1);
    return Array.from({ length: 6 }, (_, i) => ({ level: i + 1, total: by.get(i + 1) || 0 }));
  }, [allWords]);

  const dueCountByLevel = useMemo(() => {
    const by = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const w of allWords) {
      const pr = progress[w.id];
      if (w.level && pr && pr.due <= now) by[w.level]++;
    }
    return by;
  }, [allWords, progress, now]);

  // Build a queue of exactly N cards (prefer due, then new, then fill with others if needed)
  function buildQueueForLevel(level, targetCount) {
    const pool = allWords.filter((w) => Number(w.level) === level);
    if (!pool.length) return [];

    const due = pool.filter((w) => progress[w.id]?.due <= nowTs());
    const newOnes = pool.filter((w) => !progress[w.id]);
    const others = pool.filter((w) => progress[w.id] && progress[w.id].due > nowTs()); // scheduled in future

    const ordered = [];
    if (settings.includeReviews) ordered.push(...shuffle(due));
    ordered.push(...shuffle(newOnes));

    // complete to target with others if still short
    if (ordered.length < targetCount) {
      const need = targetCount - ordered.length;
      ordered.push(...shuffle(others).slice(0, need));
    }

    return ordered.slice(0, targetCount);
  }

  function startSession(level = selectedLevel, count = settings.newPerSession || DEFAULT_NEW_PER_SESSION) {
    const queue = buildQueueForLevel(level, count);
    if (queue.length === 0) {
      alert("No cards available for this level.");
      return;
    }
    setSessionQueue(queue);
    setCurrent(queue[0] || null);
    setRevealed(false);
    setStats({ reviewed: 0, correct: 0, wrong: 0 });
  }

  function handleAnswer(correct) {
    if (!current) return;
    const id = current.id;
    const prev = progress[id] || { box: -1, due: 0, seen: 0, correct: 0, incorrect: 0 };
    const { box, due } = correct ? nextOnCorrect(prev) : nextOnWrong(prev);
    const upd = { ...prev, box, due, seen: prev.seen + 1, correct: prev.correct + (correct ? 1 : 0), incorrect: prev.incorrect + (!correct ? 1 : 0), lastSeen: nowTs() };
    setProgress((p) => ({ ...p, [id]: upd }));
    setStats((s) => ({ ...s, reviewed: s.reviewed + 1, correct: s.correct + (correct ? 1 : 0), wrong: s.wrong + (!correct ? 1 : 0) }));
    const next = sessionQueue[1];
    setSessionQueue((q) => q.slice(1));
    setCurrent(next || null);
    setRevealed(false);
  }

  const vocabByLevel = useMemo(() => {
    const by = new Map();
    for (const w of allWords) {
      const arr = by.get(w.level) || [];
      arr.push(w);
      by.set(w.level, arr);
    }
    for (const [k, arr] of by.entries()) by.set(k, arr.sort((a, b) => a.hanzi.localeCompare(b.hanzi)));
    return by;
  }, [allWords]);

  // Quiz
  const [quizQueue, setQuizQueue] = useState([]);
  const [quizIdx, setQuizIdx] = useState(0);
  const [quizChoices, setQuizChoices] = useState([]);
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });
  const [quizAnswered, setQuizAnswered] = useState(null);

  function startQuiz(level = selectedLevel) {
    const pool = allWords.filter((w) => Number(w.level) === level);
    const q = shuffle(pool).slice(0, Math.min(30, pool.length));
    setQuizQueue(q);
    setQuizIdx(0);
    setQuizScore({ correct: 0, total: q.length });
    setQuizAnswered(null);
    if (q.length) prepareChoices(q[0], pool);
  }
  function prepareChoices(answer, pool) {
    const others = shuffle(pool.filter((w) => w.id !== answer.id)).slice(0, 3);
    const opts = shuffle([answer, ...others]).map((w) => ({ id: w.id, label: settings.quizType === "mc" ? w.english : w.hanzi }));
    setQuizChoices(opts);
  }
  function answerQuiz(choiceId) {
    const cur = quizQueue[quizIdx];
    const right = cur.id === choiceId;
    setQuizAnswered(right ? "right" : "wrong");
    if (right) setQuizScore((s) => ({ ...s, correct: s.correct + 1 }));
    setTimeout(() => nextQuiz(), 600);
  }
  function nextQuiz() {
    const nextI = quizIdx + 1;
    if (nextI >= quizQueue.length) {
      setQuizAnswered(null);
      return;
    }
    const pool = allWords.filter((w) => Number(w.level) === selectedLevel);
    prepareChoices(quizQueue[nextI], pool);
    setQuizIdx(nextI);
    setQuizAnswered(null);
  }

  // Keyboard shortcuts (SRS) — FIX: ne pas réécraser setRevealed(false) de handleAnswer
  useEffect(() => {
    const onKey = (e) => {
      if (tab !== "learn") return;

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) {
          // 1ère pression : révéler
          setRevealed(true);
        } else {
          // 2ème pression : valider comme "je savais" et passer à la suivante (qui sera masquée)
          handleAnswer(true);
        }
        return;
      }

      if (e.key === "ArrowRight") handleAnswer(true);
      if (e.key === "ArrowLeft") handleAnswer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, revealed, current]);

  // Word of the day (local date seed)
  const wordOfTheDay = useMemo(() => {
    const pool = allWords.filter((w) => Number(w.level) === selectedLevel);
    if (!pool.length) return null;
    const seed = Number(localDaySeed()); // YYYYMMDD (local)
    const idx = seed % pool.length;
    return pool[idx];
  }, [allWords, selectedLevel]);

  // When level changes: auto-start learn/test with defaults
  function handleLevelChange(lv) {
    setSettings((s) => ({ ...s, selectedLevel: lv }));
    if (tab === "learn") {
      startSession(lv, settings.newPerSession || DEFAULT_NEW_PER_SESSION);
    } else if (tab === "test") {
      startQuiz(lv);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // UI
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white via-gray-50 to-gray-100 text-gray-900">
      {/* Header */}
      <header className="sticky top-0 z-30 backdrop-blur bg-white/70 border-b">
        <div className="w-full max-w-[1920px] mx-auto px-10 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Logo 汉 */}
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-black text-white text-2xl font-semibold tracking-tight">汉</span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">HSK Complete</h1>
              <p className="text-xs text-gray-500">Vocabulary • Flashcards • Tests</p>
            </div>
          </div>
          <div />
        </div>
      </header>

      {/* Hero + Dashboard */}
      <section className="w-full max-w-[1920px] mx-auto px-10 pt-6">
        <div className="rounded-3xl border bg-white shadow-sm px-8 py-5">
          <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-5">
            <div>
              <div className="text-2xl font-semibold tracking-tight">Welcome 👋</div>
              <div className="text-gray-600 mt-1">
                Current level <span className="font-semibold">HSK {selectedLevel}</span> — {levels.find(l => l.level === selectedLevel)?.total || 0} words.
              </div>
              {wordOfTheDay && (
                <div className="mt-3 inline-flex items-center gap-3 rounded-2xl border px-4 py-2.5 bg-gray-50">
                  <span className="text-2xl font-semibold tracking-tight">{wordOfTheDay.hanzi}</span>
                  <span className="text-gray-700">{wordOfTheDay.pinyin}</span>
                  <span className="text-gray-500">· {wordOfTheDay.english}</span>
                  <Badge className="ml-2">Word of the day</Badge>
                </div>
              )}
            </div>

            {/* Dashboard cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 xl:gap-5 flex-1">
              <StatCard label="Total words" value={totals.total} />
              <StatCard label="Learned (box ≥ 3)" value={totals.learned} accent="emerald" />
              <StatCard label="Due reviews (≤ now)" value={totals.due} accent="amber" />
              <StatCard label="Due today (local)" value={totals.dueToday} accent="blue" />
            </div>
          </div>
        </div>
      </section>

      {/* Main */}
      <main className="w-full max-w-[1920px] mx-auto px-10 py-6 grid grid-cols-1 xl:grid-cols-[360px,1fr] 2xl:grid-cols-[420px,1fr] gap-8">
        {/* Sidebar / Controls */}
        <section className="lg:col-span-1 space-y-6">
          <Card className="sticky top-[84px]">
            <CardHeader className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                <h2 className="font-semibold">Settings</h2>
              </div>
              <Badge>Beta</Badge>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Level selector */}
              <div>
                <label className="text-sm text-gray-600">HSK level</label>
                <LevelSelector
                  levels={levels}
                  selected={selectedLevel}
                  dueCountByLevel={dueCountByLevel}
                  onSelect={handleLevelChange}
                />
                <div className="mt-2 text-xs text-gray-500">
                  {levels.find(l => l.level === selectedLevel)?.total || 0} words in selected level
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-600">Include due reviews</div>
                <Toggle checked={!!settings.includeReviews} onChange={(v) => setSettings((s) => ({ ...s, includeReviews: v }))} />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">New words per session</span>
                  <span className="text-sm font-mono">{settings.newPerSession}</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={1}
                  value={settings.newPerSession}
                  onChange={(e) => setSettings((s) => ({ ...s, newPerSession: Number(e.target.value) }))}
                  className="w-full"
                />
              </div>

              {/* Big animated buttons with active styling */}
              <div className="grid grid-cols-2 gap-2">
                <motion.button
                  whileHover={{ scale: 1.02, rotate: -0.4 }}
                  whileTap={{ scale: 0.97, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  className={
                    "min-w-[160px] inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2.5 shadow-sm hover:shadow-md border " +
                    (tab === "learn"
                      ? "bg-black text-white border-transparent"
                      : "bg-white text-gray-900 border-gray-300")
                  }
                  onClick={() => { setTab("learn"); startSession(selectedLevel, settings.newPerSession || DEFAULT_NEW_PER_SESSION); }}
                >
                  <Play className="h-4 w-4" /> Learn
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.02, rotate: 0.4 }}
                  whileTap={{ scale: 0.97, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  className={
                    "min-w-[160px] inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2.5 shadow-sm hover:shadow-md border " +
                    (tab === "test"
                      ? "bg-black text-white border-transparent"
                      : "bg-white text-gray-900 border-gray-300")
                  }
                  onClick={() => { setTab("test"); startQuiz(selectedLevel); }}
                >
                  <Brain className="h-4 w-4" /> Test
                </motion.button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              <h2 className="font-semibold">Session stats</h2>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold">{stats.reviewed}</div>
                  <div className="text-xs text-gray-500">Reviewed</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-600">{stats.correct}</div>
                  <div className="text-xs text-gray-500">Correct</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-600">{stats.wrong}</div>
                  <div className="text-xs text-gray-500">Wrong</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Workspace */}
        <section className="lg:col-span-1 space-y-6">
          {/* Segmented tabs with animated pill */}
          <LayoutGroup id="main-tabs">
            <div className="relative inline-flex rounded-2xl border border-gray-300 bg-white p-1">
              {[
                { id: "learn", label: "Learn" },
                { id: "test", label: "Test" },
                { id: "browse", label: "Browse" },
              ].map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={
                      "relative px-4 py-2 rounded-xl text-sm font-medium transition " +
                      (active ? "text-white" : "text-gray-700 hover:text-black")
                    }
                    style={{ WebkitTapHighlightColor: "transparent" }}
                  >
                    {active && (
                      <motion.span
                        layoutId="tabPill"
                        className="absolute inset-0 rounded-xl bg-black"
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}
                    <span className="relative z-10">{t.label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>

          {/* Content with transitions — cards slightly higher */}
          <AnimatePresence mode="wait">
            {tab === "learn" && (
              <motion.div
                key="tab-learn"
                initial={{ opacity: 0, y: 8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.995 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <Card className="min-h-[520px] flex flex-col max-w-5xl 2xl:max-w-6xl mx-auto w-full">
                  <CardHeader className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-2">
                      <BookOpen className="h-5 w-5" />
                      <h2 className="font-semibold">SRS flashcards</h2>
                    </div>
                    <div className="text-sm text-gray-600 flex flex-wrap gap-1">
                      HSK {selectedLevel} • {sessionQueue.length + (current ? 1 : 0)} cards
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col items-center justify-start pt-6">
                    {current ? (
                      <div className="w-full max-w-2xl">
                        <AnimatePresence mode="wait">
                          <motion.div
                            key={current.id + String(revealed)}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            className="rounded-3xl border bg-white p-8 shadow-sm"
                          >
                            <div className="text-center space-y-6">
                              <div className="text-5xl md:text-7xl font-semibold tracking-tight">{current.hanzi}</div>
                              {revealed ? (
                                <div className="space-y-2">
                                  <div className="text-2xl md:text-3xl">{current.pinyin}</div>
                                  <div className="text-gray-600 text-lg">{current.english}</div>
                                </div>
                              ) : (
                                <div className="text-sm text-gray-400">
                                  Press <kbd className="px-1.5 py-0.5 rounded border">Space</kbd> to reveal
                                </div>
                              )}
                            </div>
                          </motion.div>
                        </AnimatePresence>

                        <div className="mt-6 flex items-center justify-center gap-4">
                          {!revealed ? (
                            <Button size="lg" onClick={() => setRevealed(true)} className="min-w-[200px]">
                              <EyeIcon className="h-5 w-5" /> Reveal
                            </Button>
                          ) : (
                            <>
                              {/* Inverted order: I knew it first, then Wrong */}
                              <Button size="lg" onClick={() => handleAnswer(true)} className="min-w-[160px]">
                                <Check className="h-5 w-5" /> I knew it
                              </Button>
                              <Button size="lg" variant="destructive" onClick={() => handleAnswer(false)} className="min-w-[160px]">
                                <X className="h-5 w-5" /> Wrong
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center text-gray-600">
                        <p className="mb-3">No active card.</p>
                        <Button onClick={() => startSession(selectedLevel, settings.newPerSession || DEFAULT_NEW_PER_SESSION)}>
                          <Play className="h-4 w-4" /> Start a session
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {tab === "test" && (
              <motion.div
                key="tab-test"
                initial={{ opacity: 0, y: 8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.995 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <Card className="min-h-[520px] max-w-5xl 2xl:max-w-6xl mx-auto w-full">
                  <CardHeader className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-2">
                      <Brain className="h-5 w-5" />
                      <h2 className="font-semibold">Test (level {selectedLevel})</h2>
                    </div>
                    <div className="text-sm text-gray-600">
                      Score: {quizScore.correct}/{quizScore.total}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-6">
                    {quizQueue.length ? (
                      <div className="max-w-3xl mx-auto">
                        <div className="mb-6 text-center">
                          <div className="text-4xl md:text-5xl font-semibold">
                            {settings.quizType === "mc" ? quizQueue[quizIdx].hanzi : quizQueue[quizIdx].english}
                          </div>
                          <div className="text-xs text-gray-500 mt-2">
                            Question {quizIdx + 1}/{quizQueue.length}
                          </div>
                        </div>

                        {settings.quizType === "mc" ? (
                          <div className="grid md:grid-cols-2 gap-4">
                            {quizChoices.map((ch) => (
                              <button
                                key={ch.id}
                                onClick={() => answerQuiz(ch.id)}
                                className={`rounded-2xl border p-4 text-left hover:bg-gray-50 transition ${
                                  quizAnswered && (quizQueue[quizIdx].id === ch.id ? "border-emerald-500" : "")
                                }`}
                              >
                                {ch.label}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <TypingQuiz
                            key={quizQueue[quizIdx].id + "-" + quizIdx}
                            answer={quizQueue[quizIdx]}
                            onSubmit={(ok) => {
                              setQuizAnswered(ok ? "right" : "wrong");
                              if (ok) setQuizScore((s) => ({ ...s, correct: s.correct + 1 }));
                              setTimeout(() => nextQuiz(), 600);
                            }}
                          />
                        )}

                        {!quizAnswered && (
                          <div className="mt-6 text-center">
                            <Button variant="outline" onClick={() => startQuiz(selectedLevel)}>
                              <RotateCcw className="h-4 w-4" /> Restart
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-center text-gray-600">
                        <p className="mb-3">No active test.</p>
                        <Button onClick={() => startQuiz(selectedLevel)}>
                          <Brain className="h-4 w-4" /> Start a test
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {tab === "browse" && (
              <motion.div
                key="tab-browse"
                initial={{ opacity: 0, y: 8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.995 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <Card>
                  <CardHeader className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileSpreadsheet className="h-5 w-5" />
                      <h2 className="font-semibold">Vocabulary (level {selectedLevel})</h2>
                    </div>
                    <div className="text-sm text-gray-600">
                      {(vocabByLevel.get(selectedLevel) || []).length} entries
                    </div>
                  </CardHeader>
                  <CardContent>
                    <VocabTable rows={vocabByLevel.get(selectedLevel) || []} getProgress={(id) => progress[id]} />
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>

      <footer className="w-full max-w-[1920px] mx-auto px-10 py-8 text-center text-sm text-gray-500">
        <p>© 2025 HSK Complete - All rights reserved.</p>
      </footer>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Secondary components
// ────────────────────────────────────────────────────────────────────────────────
function LevelSelector({ levels, selected, onSelect, dueCountByLevel }) {
  return (
    <div className="mt-3 grid grid-cols-6 gap-2">
      {levels.map(({ level }) => {
        const isActive = selected === level;
        const due = dueCountByLevel[level] || 0;
        return (
          <button
            key={level}
            onClick={() => onSelect(level)}
            className={
              "relative h-12 rounded-xl border flex items-center justify-center " +
              "transition shadow-sm select-none font-semibold leading-none " +
              "tracking-tight [font-variant-numeric:tabular-nums] " +
              (isActive
                ? "bg-black text-white border-transparent"
                : "bg-white text-gray-900 hover:bg-gray-50 border-gray-300")
            }
          >
            <span className="text-base">{level}</span>
            {due > 0 && (
              <span
                title={`${due} due`}
                className="absolute -top-1 -right-1 inline-flex items-center justify-center
                           h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-medium
                           bg-amber-500 text-black border border-black/10"
              >
                {due}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, accent }) {
  const accentMap = {
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    blue: "text-blue-600",
  };
  return (
    <div className="rounded-2xl border bg-white p-4">
      <div className={`text-2xl md:text-3xl font-bold ${accentMap[accent] || ""}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function VocabTable({ rows, getProgress }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = norm(q);
    if (!n) return rows;
    return rows.filter((r) => norm(r.hanzi).includes(n) || norm(r.pinyin).includes(n) || norm(r.english).includes(n));
  }, [q, rows]);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <input
          className="w-full rounded-2xl border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-black"
          placeholder="Search hanzi / pinyin / English"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="overflow-auto max-h-[70vh]">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-gray-50">
            <tr className="text-gray-600">
              <th className="text-left p-3 font-medium">汉字</th>
              <th className="text-left p-3 font-medium">Pinyin</th>
              <th className="text-left p-3 font-medium">English</th>
              <th className="text-left p-3 font-medium">Box</th>
              <th className="text-left p-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const pr = getProgress(r.id);
              return (
                <tr key={r.id} className={i % 2 ? "bg-white" : "bg-gray-50/60"}>
                  <td className="p-3 text-base">{r.hanzi}</td>
                  <td className="p-3">{r.pinyin}</td>
                  <td className="p-3 text-gray-700">{r.english}</td>
                  <td className="p-3 font-mono">{pr ? pr.box : "—"}</td>
                  <td className="p-3 text-xs text-gray-500">{pr?.due ? new Date(pr.due).toLocaleDateString() : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TypingQuiz({ answer, onSubmit }) {
  const [val, setVal] = useState("");
  const [state, setState] = useState("idle");
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    setVal("");
    setState("idle");
  }, [answer?.id]);

  function submit() {
    const ok = norm(val) === norm(answer.hanzi);
    setState(ok ? "right" : "wrong");
    onSubmit(ok);
  }

  return (
    <div className="text-center">
      <div className="mb-4 text-gray-600">Type the matching hanzi</div>
      <input
        ref={inputRef}
        className={`w-full md:w-2/3 rounded-2xl border px-4 py-3 text-center text-xl ${state === "right" ? "border-emerald-500" : state === "wrong" ? "border-red-500" : ""}`}
        placeholder="输入汉字"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <div className="mt-3">
        <Button onClick={submit}>Submit</Button>
      </div>
    </div>
  );
}

function EyeIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={"h-5 w-5"} {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  );
}
