import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as XLSX from "xlsx";
import { v4 as uuidv4 } from "uuid";
import {
  BookOpen,
  Brain,
  Check,
  Clock,
  Download,
  FileSpreadsheet,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
  BarChart3,
  HelpCircle,
} from "lucide-react";

// ────────────────────────────────────────────────────────────────────────────────
// Minimal shadcn/ui shims — if the host already provides shadcn, these are unused
// but having light inline components guarantees the preview won't crash.
// Use Tailwind classes for styling.
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
const CardHeader = ({ className = "", ...props }) => (
  <div className={`p-5 border-b ${className}`} {...props} />
);
const CardContent = ({ className = "", ...props }) => (
  <div className={`p-5 ${className}`} {...props} />
);
const Badge = ({ className = "", children }) => (
  <span className={`inline-flex items-center rounded-full bg-gray-900 text-white px-3 py-1 text-xs ${className}`}>{children}</span>
);
const Toggle = ({ checked, onChange }) => (
  <button
    onClick={() => onChange(!checked)}
    className={`w-12 h-7 rounded-full p-1 transition ${checked ? "bg-black" : "bg-gray-300"}`}
  >
    <div className={`w-5 h-5 bg-white rounded-full transition ${checked ? "translate-x-5" : "translate-x-0"}`} />
  </button>
);

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────
/** @typedef {{ id: string; level: number; hanzi: string; pinyin: string; english: string; }} Word */
/** @typedef {{ box: number; due: number; seen: number; correct: number; incorrect: number; lastSeen?: number; }} CardProgress */

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "hsk_app_progress_v1";
const DATA_KEY = "hsk_app_vocab_v1";
const SETTINGS_KEY = "hsk_app_settings_v1";

const BOX_INTERVALS_DAYS = [0, 1, 2, 4, 7, 15, 30]; // Leitner-like

/** @param {Date} d */
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const nowTs = () => Date.now();
const daysToMs = (d) => d * 24 * 60 * 60 * 1000;
const randomInt = (n) => Math.floor(Math.random() * n);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Robust column name matching */
const norm = (s) => String(s || "").trim().toLowerCase();

/** Build a stable id from word content */
const wordId = (w) => `${w.level}|${w.hanzi}|${w.pinyin}|${w.english}`;

// ────────────────────────────────────────────────────────────────────────────────
// Local storage
// ────────────────────────────────────────────────────────────────────────────────
const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const saveJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};

// ────────────────────────────────────────────────────────────────────────────────
// Demo data (small) used before import
// ────────────────────────────────────────────────────────────────────────────────
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
// Excel parsing
// ────────────────────────────────────────────────────────────────────────────────
/**
 * Reads a user-provided .xlsx file with 6 sheets (HSK1..HSK6) and columns A/B/C = hanzi/pinyin/english.
 * Returns an array of Word
 */
async function parseWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const words = [];
  const sheetNames = wb.SheetNames;

  for (const sheetName of sheetNames) {
    // level detection: try to parse the trailing digit(s)
    const m = /hsk\s*(\d)/i.exec(sheetName) || /(\d)/.exec(sheetName);
    const level = m ? Number(m[1]) : undefined;
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    if (!rows.length) continue;

    // find header row
    let headerRow = rows[0];
    // sometimes the first row can be blank; search first 5 rows for headers
    for (let i = 0; i < Math.min(5, rows.length) && (!headerRow || headerRow.length < 2); i++) {
      const candidate = rows[i] || [];
      const cols = candidate.map(norm);
      if (cols.includes("hanzi") || cols.includes("pinyin") || cols.includes("english")) {
        headerRow = rows[i];
        rows.splice(0, i + 1); // remove header and rows before it
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
      const w = /** @type {Word} */ ({
        id: "",
        level: level ?? 0,
        hanzi,
        pinyin,
        english,
      });
      w.id = wordId(w);
      words.push(w);
    }
  }

  if (!words.length) throw new Error("Le fichier ne contient pas de données valides.");
  return words;
}

// ────────────────────────────────────────────────────────────────────────────────
// Core SRS logic
// ────────────────────────────────────────────────────────────────────────────────
/** @param {CardProgress|undefined} pr */
function nextOnCorrect(pr) {
  const box = Math.min(6, (pr?.box ?? -1) + 1); // -1 for brand new -> 0
  const due = startOfDay(new Date(Date.now() + daysToMs(BOX_INTERVALS_DAYS[box]))).getTime();
  return { box, due };
}
/** @param {CardProgress|undefined} pr */
function nextOnWrong(pr) {
  const box = Math.max(0, (pr?.box ?? 0) - 1);
  const due = startOfDay(new Date()).getTime();
  return { box, due };
}

// ────────────────────────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [allWords, setAllWords] = useState(/** @type {Word[]} */ (loadJSON(DATA_KEY, DEMO)));
  const [progress, setProgress] = useState(/** @type {Record<string, CardProgress>} */ (loadJSON(STORAGE_KEY, {})));
  const [settings, setSettings] = useState(loadJSON(SETTINGS_KEY, { selectedLevel: 1, newPerSession: 15, includeReviews: true, quizType: "mc" }));
  const [tab, setTab] = useState("learn");
  const [sessionQueue, setSessionQueue] = useState(/** @type {Word[]} */ ([]));
  const [current, setCurrent] = useState(/** @type {Word|null} */ (null));
  const [revealed, setRevealed] = useState(false);
  const [stats, setStats] = useState({ reviewed: 0, correct: 0, wrong: 0 });
  const fileInputRef = useRef(null);

  useEffect(() => { saveJSON(DATA_KEY, allWords); }, [allWords]);
  useEffect(() => { saveJSON(STORAGE_KEY, progress); }, [progress]);
  useEffect(() => { saveJSON(SETTINGS_KEY, settings); }, [settings]);

  const levels = useMemo(() => {
    const by = new Map();
    for (const w of allWords) {
      by.set(w.level, (by.get(w.level) || 0) + 1);
    }
    return Array.from({ length: 6 }, (_, i) => ({ level: i + 1, total: by.get(i + 1) || 0 }));
  }, [allWords]);

  const dueCountByLevel = useMemo(() => {
    const now = nowTs();
    const by = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const w of allWords) {
      if (!w.level) continue;
      const pr = progress[w.id];
      if (pr && pr.due <= now) by[w.level]++;
    }
    return by;
  }, [allWords, progress]);

  function startSession() {
    const now = nowTs();
    // filter by chosen level
    const pool = allWords.filter((w) => w.level === Number(settings.selectedLevel));
    const due = pool.filter((w) => progress[w.id]?.due <= now);
    const newOnes = pool.filter((w) => !progress[w.id]);

    const takeNew = Math.min(settings.newPerSession, newOnes.length);
    const review = settings.includeReviews ? due : [];

    const queue = shuffle([...review, ...shuffle(newOnes).slice(0, takeNew)]);

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
    const upd = {
      ...prev,
      box,
      due,
      seen: prev.seen + 1,
      correct: prev.correct + (correct ? 1 : 0),
      incorrect: prev.incorrect + (!correct ? 1 : 0),
      lastSeen: nowTs(),
    };
    setProgress((p) => ({ ...p, [id]: upd }));

    setStats((s) => ({ ...s, reviewed: s.reviewed + 1, correct: s.correct + (correct ? 1 : 0), wrong: s.wrong + (!correct ? 1 : 0) }));

    const next = sessionQueue[1];
    setSessionQueue((q) => q.slice(1));
    setCurrent(next || null);
    setRevealed(false);
  }

  function importExcel(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    parseWorkbook(file)
      .then((words) => {
        // normalize ids
        const normalized = words.map((w) => ({ ...w, id: wordId(w) }));
        setAllWords(normalized);
      })
      .catch((err) => alert("Import échoué: " + err.message));
  }

  function exportProgress() {
    const payload = { progress, exportedAt: new Date().toISOString(), version: 1 };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hsk-progress.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importProgress(evt) {
    const file = evt.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        if (data && data.progress) setProgress(data.progress);
      } catch (e) {
        alert("Fichier invalide.");
      }
    });
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

  // ────────────────────────────────────────────────────────────────────────────
  // Quiz logic
  // ────────────────────────────────────────────────────────────────────────────
  const [quizQueue, setQuizQueue] = useState([]);
  const [quizIdx, setQuizIdx] = useState(0);
  const [quizChoices, setQuizChoices] = useState([]);
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });
  const [quizAnswered, setQuizAnswered] = useState(null);

  function startQuiz() {
    const pool = allWords.filter((w) => w.level === Number(settings.selectedLevel));
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
      return; // finished
    }
    const pool = allWords.filter((w) => w.level === Number(settings.selectedLevel));
    prepareChoices(quizQueue[nextI], pool);
    setQuizIdx(nextI);
    setQuizAnswered(null);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Keyboard shortcuts for flashcards
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (tab !== "learn") return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); setRevealed((r) => !r); }
      if (e.key === "ArrowRight") handleAnswer(true);
      if (e.key === "ArrowLeft") handleAnswer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, current]);

  // ────────────────────────────────────────────────────────────────────────────
  // UI
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 text-gray-900">
      {/* Header */}
      <header className="sticky top-0 z-30 backdrop-blur bg-white/70 border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-black text-white font-bold">HSK</span>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">HSK All‑in‑One</h1>
              <p className="text-xs text-gray-500">Vocab • Flashcards (SRS) • Tests</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => (fileInputRef.current?.click())}>
              <Upload className="h-4 w-4" /> Importer Excel
            </Button>
            <input ref={fileInputRef} type="file" accept=".xlsx" onChange={importExcel} className="hidden" />
            <Button variant="outline" onClick={exportProgress}>
              <Download className="h-4 w-4" /> Exporter progrès
            </Button>
            <label className="cursor-pointer">
              <input type="file" accept="application/json" className="hidden" onChange={importProgress} />
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl border border-gray-300 hover:bg-gray-50">
                <Upload className="h-4 w-4" /> Importer progrès
              </span>
            </label>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[360px,1fr] gap-8">
        {/* Controls */}
        <section className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                <h2 className="font-semibold">Paramètres</h2>
              </div>
              <Badge>Beta</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm text-gray-600">Niveau HSK</label>
                <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {levels.map(({ level, total }) => (
                    <Button
                      key={level}
                      variant={settings.selectedLevel === level ? "default" : "outline"}
                      className="w-full flex flex-col items-center text-sm"
                      onClick={() => setSettings((s) => ({ ...s, selectedLevel: level }))}
                    >
                      <span className="font-medium">{level}</span>
                      <span className="text-xs opacity-70">{total}</span>
                       {dueCountByLevel[level] ? (
                        <span className="mt-1 text-[10px] rounded-full bg-yellow-400 text-black px-2 py-0.5">
			  {dueCountByLevel[level]} dûs
			</span>
                      ) : null}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-600">Inclure révisions dues</div>
                </div>
                <Toggle
                  checked={!!settings.includeReviews}
                  onChange={(v) => setSettings((s) => ({ ...s, includeReviews: v }))}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Nouveaux mots / session</span>
                  <span className="text-sm font-mono">{settings.newPerSession}</span>
                </div>
                <input
                  type="range" min={5} max={50} step={1}
                  value={settings.newPerSession}
                  onChange={(e) => setSettings((s) => ({ ...s, newPerSession: Number(e.target.value) }))}
                  className="w-full"
                />
              </div>

              <div>
                <div className="text-sm text-gray-600 mb-1">Type de quiz</div>
                <div className="flex flex-wrap gap-2">
                  <Button variant={settings.quizType === "mc" ? "default" : "outline"} onClick={() => setSettings((s) => ({ ...s, quizType: "mc" }))}>QCM</Button>
                  <Button variant={settings.quizType === "typing" ? "default" : "outline"} onClick={() => setSettings((s) => ({ ...s, quizType: "typing" }))}>Saisie</Button>
                </div>
              </div>

              <div className="flex gap-2">
                <Button className="flex-1 min-w-[160px]" onClick={() => { setTab("learn"); startSession(); }}>
                  <Play className="h-4 w-4" /> Démarrer apprentissage
                </Button>
                <Button className="flex-1 min-w-[160px]" variant="outline" onClick={() => { setTab("test"); startQuiz(); }}>
                  <Brain className="h-4 w-4" /> Démarrer test
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              <h2 className="font-semibold">Statistiques</h2>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold">{stats.reviewed}</div>
                  <div className="text-xs text-gray-500">Révisés</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-600">{stats.correct}</div>
                  <div className="text-xs text-gray-500">Justes</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-600">{stats.wrong}</div>
                  <div className="text-xs text-gray-500">Faux</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5" />
              <h2 className="font-semibold">Comment importer ?</h2>
            </CardHeader>
            <CardContent className="text-sm text-gray-600 space-y-2">
              <p>Votre fichier est local (<code>C:\\Users\\...\\Chinese Voc.xlsx</code>). Une app web <strong>ne peut pas</strong> lire ce chemin directement. Utilisez le bouton « Importer Excel » ci‑dessus et sélectionnez le fichier.</p>
              <p>Attendu : 6 onglets (HSK1…HSK6), colonnes A=hanzi, B=pinyin, C=english avec une ligne d’en‑tête.</p>
              <p>Vos progrès sont enregistrés en local (navigateur). Vous pouvez les exporter/importer.</p>
            </CardContent>
          </Card>
        </section>

        {/* Workspace */}
        <section className="lg:col-span-1 space-y-6">
          {/* Tabs */}
          <div className="flex gap-2">
            <Button variant={tab === "learn" ? "default" : "outline"} onClick={() => setTab("learn")}>Apprentissage</Button>
            <Button variant={tab === "test" ? "default" : "outline"} onClick={() => setTab("test")}>Test</Button>
            <Button variant={tab === "browse" ? "default" : "outline"} onClick={() => setTab("browse")}>Vocabulaire</Button>
          </div>

          {/* Learn Tab */}
          {tab === "learn" && (
            <Card className="min-h-[440px] flex flex-col">
              <CardHeader className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5" />
                  <h2 className="font-semibold">Cartes mémoire (SRS)</h2>
                </div>
                <div className="text-sm text-gray-600 flex flex-wrap gap-1">Niveau HSK {settings.selectedLevel} • {sessionQueue.length + (current ? 1 : 0)} cartes</div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col items-center justify-center">
                {current ? (
                  <div className="w-full max-w-xl">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={current.id + String(revealed)}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="rounded-3xl border bg-white p-8 shadow-sm"
                      >
                        <div className="text-center space-y-6">
                          <div className="text-4xl md:text-6xl font-semibold tracking-tight">
                            {current.hanzi}
                          </div>
                          {revealed ? (
                            <div className="space-y-2">
                              <div className="text-xl md:text-2xl">{current.pinyin}</div>
                              <div className="text-gray-600">{current.english}</div>
                            </div>
                          ) : (
                            <div className="text-sm text-gray-400">Appuyer sur <kbd className="px-1.5 py-0.5 rounded border">Espace</kbd> pour révéler</div>
                          )}
                        </div>
                      </motion.div>
                    </AnimatePresence>

                    <div className="mt-6 flex items-center justify-center gap-3">
                      {!revealed ? (
                        <Button size="lg" onClick={() => setRevealed(true)} className="min-w-[180px]">
                          <EyeIcon className="h-5 w-5" /> Révéler
                        </Button>
                      ) : (
                        <>
                          <Button size="lg" variant="destructive" onClick={() => handleAnswer(false)} className="min-w-[140px]">
                            <X className="h-5 w-5" /> Faux
                          </Button>
                          <Button size="lg" onClick={() => handleAnswer(true)} className="min-w-[140px]">
                            <Check className="h-5 w-5" /> Je savais
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-gray-600">
                    <p className="mb-4">Aucune carte en cours.</p>
                    <Button onClick={startSession}><Play className="h-4 w-4" /> Lancer une session</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Test Tab */}
          {tab === "test" && (
            <Card className="min-h-[440px]">
              <CardHeader className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain className="h-5 w-5" />
                  <h2 className="font-semibold">Test (niveau {settings.selectedLevel})</h2>
                </div>
                <div className="text-sm text-gray-600">Score : {quizScore.correct}/{quizScore.total}</div>
              </CardHeader>
              <CardContent>
                {quizQueue.length ? (
                  <div className="max-w-2xl mx-auto">
                    <div className="mb-6 text-center">
                      <div className="text-4xl font-semibold">
                        {settings.quizType === "mc" ? quizQueue[quizIdx].hanzi : quizQueue[quizIdx].english}
                      </div>
                      <div className="text-xs text-gray-500 mt-2">Question {quizIdx + 1}/{quizQueue.length}</div>
                    </div>

                    {settings.quizType === "mc" ? (
                      <div className="grid md:grid-cols-2 gap-3">
                        {quizChoices.map((ch) => (
                          <button
                            key={ch.id}
                            onClick={() => answerQuiz(ch.id)}
                            className={`rounded-2xl border p-4 text-left hover:bg-gray-50 transition ${quizAnswered && (quizQueue[quizIdx].id === ch.id ? "border-emerald-500" : "")}`}
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
                        <Button variant="outline" onClick={startQuiz}><RotateCcw className="h-4 w-4" /> Relancer</Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center text-gray-600">
                    <p className="mb-4">Aucun quiz actif.</p>
                    <Button onClick={startQuiz}><Brain className="h-4 w-4" /> Démarrer un test</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Browse Tab */}
          {tab === "browse" && (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-5 w-5" />
                  <h2 className="font-semibold">Vocabulaire (niveau {settings.selectedLevel})</h2>
                </div>
                <div className="text-sm text-gray-600">{(vocabByLevel.get(Number(settings.selectedLevel)) || []).length} entrées</div>
              </CardHeader>
              <CardContent>
                <VocabTable
                  rows={vocabByLevel.get(Number(settings.selectedLevel)) || []}
                  getProgress={(id) => progress[id]}
                />
              </CardContent>
            </Card>
          )}
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-8 text-center text-sm text-gray-500">
        <p>
          Conçu pour un usage personnel et prêt à être étendu (compte utilisateur, sync cloud, paiements). Code 100% client‑side pour l’instant.
        </p>
      </footer>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Small components
// ────────────────────────────────────────────────────────────────────────────────
function VocabTable({ rows, getProgress }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = norm(q);
    if (!n) return rows;
    return rows.filter((r) => norm(r.hanzi).includes(n) || norm(r.pinyin).includes(n) || norm(r.english).includes(n));
  }, [q, rows]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input
          className="w-full rounded-2xl border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-black"
          placeholder="Rechercher hanzi / pinyin / anglais"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-600">
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
  const [state, setState] = useState("idle"); // idle | right | wrong
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); setVal(""); setState("idle"); }, [answer?.id]);

  function submit() {
    const ok = norm(val) === norm(answer.hanzi);
    setState(ok ? "right" : "wrong");
    onSubmit(ok);
  }

  return (
    <div className="text-center">
      <div className="mb-4 text-gray-600">Tapez le hanzi correspondant</div>
      <input
        ref={inputRef}
        className={`w-full md:w-2/3 rounded-2xl border px-4 py-3 text-center text-xl ${state === "right" ? "border-emerald-500" : state === "wrong" ? "border-red-500" : ""}`}
        placeholder="输入汉字"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <div className="mt-3">
        <Button onClick={submit}>Valider</Button>
      </div>
    </div>
  );
}

// simple Eye icon fallback
function EyeIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={"h-5 w-5"} {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  );
}
