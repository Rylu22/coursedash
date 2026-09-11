import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plus, X, Play, Download, Users, ClipboardList, ListOrdered, Upload,
  AlertTriangle, LogOut, Copy, ArrowLeft, RefreshCw, Check, KeyRound, GripVertical, ArrowLeftRight, Link2, Sliders,
  ShieldCheck, Trash2, Pencil, Info, Mail, Sparkles, Lock, CheckSquare, Search, LogIn, Compass, ChevronRight, ChevronLeft, MessageCircle, Key, Bell, GraduationCap, Eye, LayoutGrid, Undo2, Redo2,
} from "lucide-react";
import { supabase } from "./lib/supabaseClient.js";

// Only this exact email gets routed to the admin dashboard on login — change it to
// your own address. It isn't shown anywhere in the UI; someone would have to guess
// it exactly. This is convention-level gating, not real security — see the note in
// the login screen about this app's auth not being production-grade.
const ADMIN_EMAIL = "ryanlv1110@gmail.com";

// ---------- palette / type ----------
const paper = "#F3F6FB"; // cool paper — dashboard, not parchment
const ink = "#132238"; // deep navy ink
const inkSoft = "#5A6B85"; // slate blue-gray
const line = "#D9E1EC"; // cool hairline
const green = "#2954E5"; // primary tech blue (kept the name "green" internally to avoid a risky mass rename)
const greenSoft = "#E8EEFC";
const gold = "#C08A1E"; // campus-crest gold — the "school" half of the pairing
const goldSoft = "#FBF0DA";
const clay = "#D0483F"; // alert red
const claySoft = "#FBE8E6";
const serif = "Georgia, 'Times New Roman', serif";
const sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const mono = "ui-monospace, 'SF Mono', Menlo, monospace";

const genId = () =>
  window.crypto?.randomUUID ? window.crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const genCode = () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};
const safeKey = (email) => email.trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
// Spreadsheet-style column labels for naming test accounts: 0 -> A, 1 -> B, ... 25 -> Z, 26 -> AA...
function indexToLetters(n) {
  let s = "";
  let num = n + 1;
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

// Creates a new instant test account (teacher or student), picking the next free
// spreadsheet-style label among existing test accounts of that role. `existingTestUsers`
// should be every current isTest user record, of any role, so labels never collide.
async function createTestAccount(role, existingTestUsers) {
  const used = new Set(existingTestUsers.filter((u) => u.role === role).map((u) => u.testLabel));
  let i = 0;
  let label = indexToLetters(0);
  while (used.has(label)) {
    i++;
    label = indexToLetters(i);
  }
  const roleName = role === "teacher" ? "Teacher" : "Student";
  const email = `test-${role}-${label.toLowerCase()}@coursedash.test`;
  const record = { email, name: `${roleName} ${label}`, role, tutorialSeen: true, isTest: true, testLabel: label };
  await storeSet(`user:${safeKey(email)}`, record, true);
  return record;
}

// Data model: everything lives in one Postgres table, `kv_store(key text primary
// key, value jsonb)`, mirroring the original window.storage key/value shape so the
// ~140 call sites elsewhere in this file didn't need to change. `shared` mirrors the
// old window.storage flag: true = shared Postgres row (visible to any logged-in
// user, per the table's RLS policies), false = this-browser-only (localStorage).
async function storeGet(key, shared) {
  if (!shared) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }
  try {
    const { data, error } = await supabase.from("kv_store").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return data ? data.value : null;
  } catch {
    return null;
  }
}
async function storeSet(key, value, shared) {
  if (!shared) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return null;
    }
  }
  try {
    const { error } = await supabase.from("kv_store").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  } catch {
    return null;
  }
}
async function storeDelete(key, shared) {
  if (!shared) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch {
      return null;
    }
  }
  try {
    const { error } = await supabase.from("kv_store").delete().eq("key", key);
    if (error) throw error;
    return true;
  } catch {
    return null;
  }
}
async function storeList(prefix, shared) {
  if (!shared) return [];
  try {
    const { data, error } = await supabase.from("kv_store").select("key").like("key", `${prefix}%`);
    if (error) throw error;
    return (data || []).map((r) => r.key);
  } catch {
    return [];
  }
}
// Backward-compat: groups saved before the clubs→courses rename only have `clubs`,
// and groups saved before the activation feature have no `status` — treat those as
// already active so existing groups don't suddenly lock students out.
function normalizeGroup(g) {
  if (!g) return g;
  return {
    ...g,
    courses: g.courses || g.clubs || [],
    status: g.status || "active",
    resultsFinalized: !!g.resultsFinalized,
    publishedAt: g.publishedAt || null,
    extraQuestions: g.extraQuestions || [],
  };
}

// Backward-compat: a previous version of manual drag-to-reassign always stored
// choiceRank: null regardless of whether the target course actually matched one of
// the student's real preferences. Recompute it correctly from their prefs whenever
// a group's saved results are loaded, so old manual moves display the right badge
// without needing to be re-dragged.
function reconcileManualRanks(results) {
  if (!results) return results;
  let changed = false;
  const assignments = {};
  Object.entries(results.assignments).forEach(([courseId, list]) => {
    assignments[courseId] = list.map((s) => {
      if (!s.manual) return s;
      const idx = (s.prefs || []).indexOf(courseId);
      const correctRank = idx >= 0 ? idx + 1 : null;
      if (correctRank === s.choiceRank) return s;
      changed = true;
      return { ...s, choiceRank: correctRank };
    });
  });
  return changed ? { ...results, assignments } : results;
}

// Finds which course (or null for Unassigned, or undefined if not present at all) a
// student currently sits in within a results object.
function findCurrentCourseId(results, studentId) {
  if (!results) return undefined;
  for (const [courseId, list] of Object.entries(results.assignments)) {
    if (list.some((s) => s.id === studentId)) return courseId;
  }
  if (results.unassigned?.some((s) => s.id === studentId)) return null;
  return undefined;
}

// Pure move: relocates a student from one course (or Unassigned, null) to another
// within a results object, recomputing their choice-rank badge from their real
// preferences. Used by manual drag-and-drop, and by accepting/smart-fitting requests.
// Returns the same `results` reference if the student wasn't found (no-op).
function moveStudentInResults(results, studentId, fromCourseId, toCourseId) {
  if (fromCourseId === toCourseId) return results;
  const assignments = { ...results.assignments };
  let unassigned = [...results.unassigned];
  let studentObj = null;
  if (fromCourseId) {
    assignments[fromCourseId] = (assignments[fromCourseId] || []).filter((s) => {
      if (s.id === studentId) {
        studentObj = s;
        return false;
      }
      return true;
    });
  } else {
    unassigned = unassigned.filter((s) => {
      if (s.id === studentId) {
        studentObj = s;
        return false;
      }
      return true;
    });
  }
  if (!studentObj) return results;
  const rankForCourse = toCourseId ? (studentObj.prefs || []).indexOf(toCourseId) : -1;
  const moved = { ...studentObj, choiceRank: rankForCourse >= 0 ? rankForCourse + 1 : null, manual: true };
  if (toCourseId) assignments[toCourseId] = [...(assignments[toCourseId] || []), moved];
  else unassigned = [...unassigned, moved];
  return { ...results, assignments, unassigned };
}

// Finds one closed rotation among a set of pending switch requests — a cycle of any
// size where each request's desired course is the next request's current course, so
// everyone in the ring can move at once without changing any course's headcount. A
// plain reciprocal swap (Bob wants John's course, John wants Bob's) is just the
// smallest case, size 2; a 3-way rotation (Bob wants John's, John wants Steve's,
// Steve wants Bob's) works the same way, and so does any larger ring. Each request
// needs a `key`, `currentCourseId`, and `toCourseId`. Returns the cycle as an
// ordered array of requests (apply them in that order), or null if no cycle exists.
function findRotationCycle(requests) {
  const byCourse = {};
  requests.forEach((r) => {
    if (!byCourse[r.currentCourseId]) byCourse[r.currentCourseId] = [];
    byCourse[r.currentCourseId].push(r);
  });

  for (const start of requests) {
    const startCourse = start.currentCourseId;
    const visitedKeys = new Set([start.key]);
    const visitedCourses = new Set([start.currentCourseId, start.toCourseId]);
    const path = [start];

    const dfs = (currentCourseId) => {
      const options = byCourse[currentCourseId] || [];
      for (const r of options) {
        if (visitedKeys.has(r.key)) continue;
        if (r.toCourseId === startCourse) {
          path.push(r);
          return true;
        }
        if (visitedCourses.has(r.toCourseId)) continue;
        visitedKeys.add(r.key);
        visitedCourses.add(r.toCourseId);
        path.push(r);
        if (dfs(r.toCourseId)) return true;
        path.pop();
        visitedKeys.delete(r.key);
        visitedCourses.delete(r.toCourseId);
      }
      return false;
    };

    if (dfs(start.toCourseId)) return path;
  }
  return null;
}

// Builds a plain-language breakdown of how a specific student ended up where they did —
// their ranked choices, whether it was a manual override, which logic settings were
// active, and (for automatic placements into a real course) how much competition that
// course had, based on what everyone else ranked.
function explainPlacement({ student, courseId, courses, allStudents, priority, settings, capacity }) {
  const courseNameById = {};
  courses.forEach((c) => (courseNameById[c.id] = c.name));
  const course = courseId ? courses.find((c) => c.id === courseId) : null;

  const rankedChoices = (student.prefs || []).map((pid, i) => ({ rank: i + 1, name: courseNameById[pid] || "(removed course)", id: pid }));
  const matchedRank = courseId ? (student.prefs || []).indexOf(courseId) + 1 || null : null;
  const historyScore = courseId ? priority[student.id]?.[courseNameById[courseId]] || 0 : 0;

  let demand = null;
  if (courseId && settings.usePreference !== false && matchedRank) {
    const countAtRank = allStudents.filter((s2) => s2.prefs?.[matchedRank - 1] === courseId).length;
    demand = { seats: capacity?.[courseId] ?? course?.target, countAtRank, rank: matchedRank };
  }

  return { course, rankedChoices, matchedRank, historyScore, demand };
}

// How long a teacher has to restore a deleted group before it's gone for good.
const TEACHER_DELETE_UNDO_MS = 5 * 60 * 1000;

const DEFAULT_LOGIC_SETTINGS = {
  useGrade: true,
  usePreference: true,
  useHistory: true,
  gradeDirection: "higher", // "higher" | "lower" | "custom"
  customGradeOrder: [], // "custom" mode only: [[gradeA, gradeB], [gradeC], ...] most-favored tier first
  order: ["history", "grade"], // tie-break priority order
  historyMode: "boost", // "boost" | "sameCourse" | "differentCourse" | "smartWeight"
  allowRequests: true,
  requestWindowDays: 3,
  useSuccessScore: false,
  successPrioritizeQuantity: false,
  successAvoidLows: false,
};
// Settings live per-series (shared by every group in a chain) or per-group for standalone groups.
function logicSettingsKey(group) {
  return group.chainId ? `series-settings:${group.chainId}` : `group-settings:${group.code}`;
}
async function loadLogicSettingsForGroup(group) {
  const s = await storeGet(logicSettingsKey(group), true);
  return { ...DEFAULT_LOGIC_SETTINGS, ...(s || {}) };
}
async function saveLogicSettingsForGroup(group, next) {
  await storeSet(logicSettingsKey(group), next, true);
}

// Scales each course's `target` proportionally so the capacities sum to exactly
// `totalStudents`, using largest-remainder apportionment (Hamilton method) so the
// rounding is as fair as possible. E.g. targets 1,1,2 with 20 students → 5,5,10.
//
// When targets tie exactly (e.g. 1/1/1 with 1 student), the leftover seat(s) can't be
// split, so a tiebreak is unavoidable — but it should go to the course students actually
// want, not be decided at random before preferences are even considered. `demandWeight`
// lets the caller break remainder ties by real, rank-weighted demand: a course that's
// someone's #1 choice outranks one nobody asked for.
function computeEffectiveCapacity(courses, totalStudents, demandWeight = {}) {
  const capacity = {};
  const totalTarget = courses.reduce((sum, c) => sum + c.target, 0);
  if (totalTarget <= 0 || totalStudents <= 0) {
    courses.forEach((c) => (capacity[c.id] = 0));
    return capacity;
  }
  const shares = courses.map((c) => {
    const ideal = (c.target / totalTarget) * totalStudents;
    return { id: c.id, floor: Math.floor(ideal), remainder: ideal - Math.floor(ideal) };
  });
  shares.forEach((s) => (capacity[s.id] = s.floor));
  let leftover = totalStudents - shares.reduce((sum, s) => sum + s.floor, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || (demandWeight[b.id] || 0) - (demandWeight[a.id] || 0) || Math.random() - 0.5
  );
  for (let i = 0; i < leftover && i < byRemainder.length; i++) capacity[byRemainder[i].id]++;
  return capacity;
}

// Rank-weighted demand per course: a #1 ranking counts for more than a #2, which counts
// for more than a #3 — used only to break capacity ties sensibly, never to decide who
// actually gets a seat.
function computeDemandWeight(courses, students) {
  const weight = {};
  courses.forEach((c) => (weight[c.id] = 0));
  students.forEach((s) => {
    (s.prefs || []).forEach((courseId, i) => {
      if (courseId in weight) weight[courseId] += 3 - i; // choice 1 → +3, choice 2 → +2, choice 3 → +1
    });
  });
  return weight;
}

// ---- Success score ----
// Ranks the distinct grade levels among respondents lowest→highest (1, 2, 3, ...);
// a student's "1st-choice" score is 3 × their grade's rank. Since that's always a
// multiple of 3, their 2nd-choice score (exactly 2/3 of it) and 3rd-choice score
// (exactly 1/3 of it) are always whole numbers too. Landing outside a student's
// ranked top 3 scores 0.
//
// This mirrors the Grade priority setting rather than always favoring higher grades:
// with Grade priority off, grade doesn't factor in at all — every student scores a
// flat 3/2/1. With it on and set to "lower grade first," the ranking flips so the
// lowest grade earns the highest score instead of the highest grade. With "custom",
// it follows the teacher's hand-arranged tiers instead of a simple high/low sort.
//
// Maps a grade level to a priority value — higher value = more favored. Shared by the
// round-based assignment ordering and the success-score ranker so "Grade priority"
// behaves identically everywhere it's consulted. In "custom" mode, tiers are ordered
// most-favored first; every grade in the same tier gets the same value (tied, by design),
// and a grade the teacher hasn't dragged into any tier yet ranks below all of them.
function buildGradeValueFn(students, settings = {}) {
  if (settings.gradeDirection === "custom") {
    const tiers = settings.customGradeOrder || [];
    const rankByGrade = {};
    tiers.forEach((tier, i) => {
      tier.forEach((g) => (rankByGrade[g] = tiers.length - i));
    });
    return (grade) => rankByGrade[grade] || 0;
  }
  const descending = settings.gradeDirection === "lower";
  const grades = [...new Set(students.map((s) => s.grade))].sort((a, b) => (descending ? b - a : a - b));
  const rankByGrade = {};
  grades.forEach((g, i) => (rankByGrade[g] = i + 1));
  return (grade) => rankByGrade[grade] || 1;
}
function buildGradeScoreFn(students, settings = {}) {
  if (settings.useGrade === false) return () => 3;
  const gradeValueFn = buildGradeValueFn(students, settings);
  return (grade) => 3 * gradeValueFn(grade);
}
// Short phrase describing the active grade-priority direction, for status/explanation text.
function gradeDirectionLabel(settings) {
  if (settings.gradeDirection === "custom") return "custom order";
  return `${settings.gradeDirection} grade first`;
}
// Key-order-independent equality check for two settings objects — used to detect whether
// the Logic tab has changed since a result's settings snapshot was taken, without false
// positives from object keys simply having been inserted in a different order.
function settingsEqual(a, b) {
  const stable = (obj) => JSON.stringify(obj, Object.keys(obj || {}).sort());
  return stable(a) === stable(b);
}
function successScoreFor(student, courseId, gradeScoreFn) {
  const rank = (student.prefs || []).indexOf(courseId) + 1; // 0 when courseId isn't a ranked choice
  if (rank < 1 || rank > 3) return 0;
  const first = gradeScoreFn(student.grade);
  if (rank === 1) return first;
  if (rank === 2) return (first * 2) / 3;
  return first / 3;
}
// Total success score of an already-computed result — used to display the score
// regardless of whether it drove the assignment or is just being checked.
function computeSuccessScore(students, assignments, settings = {}) {
  const gradeScoreFn = buildGradeScoreFn(students, settings);
  let total = 0;
  Object.entries(assignments).forEach(([courseId, list]) => {
    list.forEach((s) => {
      total += successScoreFor(s, courseId, gradeScoreFn);
    });
  });
  return total;
}
// Same total, split out by grade level — lets a teacher see which grades' matches are
// actually driving the number shown for computeSuccessScore.
function computeSuccessScoreBreakdown(students, assignments, settings = {}) {
  const gradeScoreFn = buildGradeScoreFn(students, settings);
  const byGrade = {};
  Object.entries(assignments).forEach(([courseId, list]) => {
    list.forEach((s) => {
      if (!byGrade[s.grade]) byGrade[s.grade] = { grade: s.grade, points: 0, students: 0 };
      byGrade[s.grade].points += successScoreFor(s, courseId, gradeScoreFn);
      byGrade[s.grade].students += 1;
    });
  });
  return Object.values(byGrade).sort((a, b) => b.points - a.points || a.grade - b.grade);
}

// Generic min-cost max-flow via SPFA-based successive shortest augmenting paths (handles
// negative edge costs, which we need since maximizing score = minimizing negative score;
// there are no negative cycles here, just a source → students → courses → sink DAG plus
// reverse edges). `edgeDefs` is [from, to, capacity, cost]. Returns the internal `to`/`cap`
// arrays so the caller can tell which original edges carried flow (their cap drops to 0).
function minCostMaxFlow(nodeCount, edgeDefs, source, sink) {
  const graph = Array.from({ length: nodeCount }, () => []);
  const to = [];
  const cap = [];
  const cost = [];
  const addEdge = (u, v, c, w) => {
    graph[u].push(to.length);
    to.push(v);
    cap.push(c);
    cost.push(w);
    graph[v].push(to.length);
    to.push(u);
    cap.push(0);
    cost.push(-w);
  };
  edgeDefs.forEach(([u, v, c, w]) => addEdge(u, v, c, w));

  while (true) {
    const dist = new Array(nodeCount).fill(Infinity);
    const inQueue = new Array(nodeCount).fill(false);
    const prevEdge = new Array(nodeCount).fill(-1);
    dist[source] = 0;
    const queue = [source];
    inQueue[source] = true;
    while (queue.length) {
      const u = queue.shift();
      inQueue[u] = false;
      for (const eid of graph[u]) {
        if (cap[eid] > 0 && dist[u] + cost[eid] < dist[to[eid]]) {
          dist[to[eid]] = dist[u] + cost[eid];
          prevEdge[to[eid]] = eid;
          if (!inQueue[to[eid]]) {
            queue.push(to[eid]);
            inQueue[to[eid]] = true;
          }
        }
      }
    }
    if (dist[sink] === Infinity) break;
    let aug = Infinity;
    for (let v = sink; v !== source; v = to[prevEdge[v] ^ 1]) aug = Math.min(aug, cap[prevEdge[v]]);
    for (let v = sink; v !== source; v = to[prevEdge[v] ^ 1]) {
      cap[prevEdge[v]] -= aug;
      cap[prevEdge[v] ^ 1] += aug;
    }
  }
  return { cap };
}

// Reassigns students to courses to maximize total success score, subject to each course's
// already-computed capacity (headcounts are never changed by this — it only decides WHO
// fills each seat). When `avoidLows` is set, a student can only be matched to one of their
// own ranked top-3 courses, so nobody the optimizer places ever lands outside their
// preferences; anyone that constraint leaves unmatched comes back in `leftover` for the
// caller to backfill the normal way.
function optimizeAssignmentForScore(courses, students, capacity, avoidLows, settings) {
  const gradeScoreFn = buildGradeScoreFn(students, settings);
  const source = 0;
  const studentBase = 1;
  const courseBase = studentBase + students.length;
  const sink = courseBase + courses.length;

  const edgeDefs = [];
  students.forEach((s, i) => edgeDefs.push([source, studentBase + i, 1, 0]));
  courses.forEach((c, j) => edgeDefs.push([courseBase + j, sink, Math.max(0, capacity[c.id] || 0), 0]));

  // One bipartite edge per eligible (student, course) pair. Its position in edgeDefs is
  // recorded so the flow result can be read back afterward — minCostMaxFlow adds each
  // edgeDefs entry as exactly 2 internal edges (forward, then reverse) in the same order,
  // so edgeDefs[k] is always at internal index k*2.
  const bipartite = [];
  students.forEach((s, i) => {
    courses.forEach((c, j) => {
      const rank = (s.prefs || []).indexOf(c.id) + 1;
      if (avoidLows && (rank < 1 || rank > 3)) return;
      const score = rank >= 1 && rank <= 3 ? successScoreFor(s, c.id, gradeScoreFn) : 0;
      bipartite.push({ edgeDefIndex: edgeDefs.length, studentIdx: i, courseIdx: j });
      edgeDefs.push([studentBase + i, courseBase + j, 1, -score]);
    });
  });

  const { cap } = minCostMaxFlow(sink + 1, edgeDefs, source, sink);

  const courseIdxByStudent = new Map();
  bipartite.forEach(({ edgeDefIndex, studentIdx, courseIdx }) => {
    if (cap[edgeDefIndex * 2] === 0) courseIdxByStudent.set(studentIdx, courseIdx);
  });

  const assignments = {};
  courses.forEach((c) => (assignments[c.id] = []));
  const leftover = [];
  students.forEach((s, i) => {
    const courseIdx = courseIdxByStudent.get(i);
    if (courseIdx === undefined) {
      leftover.push(s);
      return;
    }
    const course = courses[courseIdx];
    const rank = (s.prefs || []).indexOf(course.id) + 1;
    assignments[course.id].push({ ...s, choiceRank: rank >= 1 && rank <= 3 ? rank : null });
  });
  return { assignments, leftover };
}

function assignStudents(courses, students, priority = {}, settings = {}) {
  const {
    useGrade = true,
    usePreference = true,
    useHistory = true,
    order = ["history", "grade"], // tie-break priority order
    useSuccessScore = false,
    successPrioritizeQuantity = false,
    successAvoidLows = false,
  } = settings;
  const activeFactors = order.filter((f) => (f === "history" ? useHistory : f === "grade" ? useGrade : true));

  const courseNameById = {};
  courses.forEach((c) => (courseNameById[c.id] = c.name));

  // Targets are treated as relative weights, scaled to fit however many students there
  // actually are — not hard caps — so the whole roster gets placed as close to those
  // proportions as possible rather than leaving seats and students both unmatched.
  const capacity = computeEffectiveCapacity(courses, students.length, usePreference ? computeDemandWeight(courses, students) : {});
  const assignments = {};
  courses.forEach((c) => (assignments[c.id] = []));
  const remaining = students.map((s) => ({ ...s, choiceRank: null }));

  const gradeValueFn = buildGradeValueFn(students, settings);
  const gradeValue = (s) => gradeValueFn(s.grade);
  const historyValueFor = (s, courseId) => (priority[s.id]?.[courseNameById[courseId]] || 0);
  const historyValueFlat = (s) => {
    const vals = Object.values(priority[s.id] || {});
    return vals.length ? Math.max(...vals) : 0;
  };

  // Used for round-based matching, where the course being filled is known.
  const compareForCourse = (courseId) => (a, b) => {
    for (const f of activeFactors) {
      const diff = f === "history" ? historyValueFor(b, courseId) - historyValueFor(a, courseId) : gradeValue(b) - gradeValue(a);
      if (diff) return diff;
    }
    return Math.random() - 0.5;
  };
  // Used when there's no single course context (preference off, or backfill) — falls
  // back to each student's best historical boost across any course.
  const compareFlat = (a, b) => {
    for (const f of activeFactors) {
      const diff = f === "history" ? historyValueFlat(b) - historyValueFlat(a) : gradeValue(b) - gradeValue(a);
      if (diff) return diff;
    }
    return Math.random() - 0.5;
  };

  // Picks whichever open course is currently furthest below its scaled capacity, so
  // backfilling — or the no-preference pool — spreads students toward the target
  // proportions instead of just the first course with any room at all.
  const pickNeediestCourse = (openCourses) => {
    if (openCourses.length === 0) return null;
    let bestGap = -Infinity;
    let candidates = [];
    openCourses.forEach((c) => {
      const gap = capacity[c.id] - assignments[c.id].length;
      if (gap > bestGap) {
        bestGap = gap;
        candidates = [c];
      } else if (gap === bestGap) {
        candidates.push(c);
      }
    });
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  if (useSuccessScore && (successPrioritizeQuantity || successAvoidLows)) {
    // Success score check: instead of the round-based placement below, directly solve for
    // the assignment that maximizes total success score. "Prioritize quantity" keeps every
    // course's headcount exactly at its scaled capacity (same `capacity` as always) and just
    // decides who fills each seat; "avoid lows" additionally restricts every match to one of
    // that student's own top-3 ranked courses, so nobody optimized ever lands outside their
    // preferences (avoidLows wins if both are somehow on, since it's the stricter guarantee).
    const { assignments: optimized, leftover } = optimizeAssignmentForScore(courses, remaining, capacity, successAvoidLows, settings);
    Object.keys(assignments).forEach((cid) => {
      assignments[cid] = optimized[cid] || [];
    });
    // Anyone the optimizer couldn't place (only possible under "avoid lows", when there isn't
    // enough top-3 capacity for everyone) gets backfilled the same way any other leftover
    // student would be, so the group still ends up fully placed wherever there's room.
    [...leftover].sort(compareFlat).forEach((s) => {
      const open = courses.filter((c) => assignments[c.id].length < capacity[c.id]);
      const choice = pickNeediestCourse(open);
      if (!choice) return;
      assignments[choice.id].push(s);
    });
  } else if (!usePreference) {
    // Preference order ignored entirely: pool everyone, sort by whatever logic remains on
    // (history / grade / random), then place each into whichever open course needs
    // students most, to land as close as possible to the scaled targets.
    const pool = [...remaining].sort(compareFlat);
    pool.forEach((s) => {
      const open = courses.filter((c) => assignments[c.id].length < capacity[c.id]);
      const choice = pickNeediestCourse(open);
      if (!choice) return;
      assignments[choice.id].push(s);
    });
  } else {
    for (let round = 0; round < 3; round++) {
      const assignedIds = new Set(Object.values(assignments).flat().map((s) => s.id));
      const groups = {};
      remaining.forEach((s) => {
        if (assignedIds.has(s.id)) return;
        const courseId = s.prefs[round];
        if (!courseId) return;
        groups[courseId] = groups[courseId] || [];
        groups[courseId].push(s);
      });
      Object.entries(groups).forEach(([courseId, group]) => {
        const capLeft = capacity[courseId] - assignments[courseId].length;
        if (capLeft <= 0) return;
        const sorted = [...group].sort(compareForCourse(courseId));
        sorted.slice(0, capLeft).forEach((s) => {
          s.choiceRank = round + 1;
          assignments[courseId].push(s);
        });
      });
    }
    // Backfill: anyone whose choices all filled up gets placed into whichever course
    // still has room, prioritizing the course furthest below its scaled target — so
    // actual counts land as close as possible even when preferences don't line up.
    const assignedAfterRounds = new Set(Object.values(assignments).flat().map((s) => s.id));
    const leftover = [...remaining.filter((s) => !assignedAfterRounds.has(s.id))].sort(compareFlat);
    leftover.forEach((s) => {
      const open = courses.filter((c) => assignments[c.id].length < capacity[c.id]);
      const choice = pickNeediestCourse(open);
      if (!choice) return;
      assignments[choice.id].push(s); // choiceRank stays null — backfilled, not a real choice match
    });
  }

  const assignedIds = new Set(Object.values(assignments).flat().map((s) => s.id));
  return { assignments, unassigned: remaining.filter((s) => !assignedIds.has(s.id)), capacity };
}

// Walk a chain's prior groups (most recent first) and build, for each student, a per-course-name
// priority score depending on the chosen history mode:
//  - "boost": a flat "years since last getting #1 choice" streak, applied to any course this year.
//  - "sameCourse": priority for the specific course they were placed in previously (continuity),
//    counting consecutive years spent in that same course.
//  - "differentCourse": priority for a specific course they ranked before but did NOT get,
//    encouraging rotation into something they wanted but missed.
//  - "smartWeight": an accumulated "how far from their top choice have they landed" score,
//    summed across every prior group in the series (not just a streak) — 1st choice adds 1,
//    2nd adds 4, 3rd adds 6, anything else (an unranked course, or no course at all) adds 10.
//    A student who's never been in a prior group of this series scores 0. Whoever has
//    accumulated the highest total gets priority this year.
async function computeHistoryPriority(group, students, mode = "boost") {
  const priority = {};
  if (!group.chainId) return priority;
  const chain = await storeGet(`chain:${group.chainId}`, true);
  if (!chain) return priority;
  const idx = chain.groupCodes.indexOf(group.code);
  if (idx <= 0) return priority;
  const priorCodes = chain.groupCodes.slice(0, idx).reverse(); // most recent first
  const priorGroups = await Promise.all(priorCodes.map((c) => storeGet(`group:${c}`, true).then(normalizeGroup)));

  const nameById = (g) => {
    const m = {};
    (g?.courses || []).forEach((c) => (m[c.id] = c.name));
    return m;
  };
  const assignedCourseName = (g, studentId) => {
    if (!g?.results) return undefined; // no assignment run that year — no data
    const map = nameById(g);
    for (const [cid, arr] of Object.entries(g.results.assignments)) {
      if (arr.find((s) => s.id === studentId)) return map[cid];
    }
    if (g.results.unassigned.some((s) => s.id === studentId)) return null; // present, but got nothing
    return undefined; // wasn't part of this group at all
  };

  if (mode === "sameCourse") {
    for (const student of students) {
      let targetName = null;
      let streak = 0;
      for (const pg of priorGroups) {
        const name = assignedCourseName(pg, student.id);
        if (name === undefined) break; // no data for this year, stop
        if (name === null) break; // they got nothing that year, continuity broken
        if (targetName === null) {
          targetName = name;
          streak = 1;
        } else if (name === targetName) {
          streak++;
        } else break;
      }
      if (targetName && streak > 0) priority[student.id] = { [targetName]: streak };
    }
  } else if (mode === "differentCourse") {
    // Need to know what each student actually ranked in prior years, not just what they got.
    const subsByGroup = {};
    for (const pg of priorGroups) {
      if (!pg) continue;
      const subs = await Promise.all(students.map((s) => storeGet(`submission:${pg.code}:${s.id}`, true)));
      subsByGroup[pg.code] = {};
      students.forEach((s, i) => {
        if (subs[i]) subsByGroup[pg.code][s.id] = subs[i];
      });
    }
    const allCourseNames = new Set();
    priorGroups.forEach((pg) => (pg?.courses || []).forEach((c) => allCourseNames.add(c.name)));

    for (const student of students) {
      const scores = {};
      allCourseNames.forEach((cname) => {
        let streak = 0;
        for (const pg of priorGroups) {
          if (!pg) break;
          const sub = subsByGroup[pg.code]?.[student.id];
          if (!sub) break; // student wasn't part of that year, stop
          const map = nameById(pg);
          const ranked = (sub.prefs || []).some((pid) => map[pid] === cname);
          if (!ranked) break; // didn't want it that year — no further signal
          const gotName = assignedCourseName(pg, student.id);
          if (gotName === cname) break; // they got it — continuity, not a "miss" anymore
          streak++;
        }
        if (streak > 0) scores[cname] = streak;
      });
      if (Object.keys(scores).length) priority[student.id] = scores;
    }
  } else if (mode === "smartWeight") {
    const POINTS = { 1: 1, 2: 4, 3: 6 };
    for (const student of students) {
      let total = 0;
      for (const pg of priorGroups) {
        if (!pg?.results) continue; // no assignment run that year — no signal, skip it
        let found = null;
        for (const arr of Object.values(pg.results.assignments)) {
          const match = arr.find((s) => s.id === student.id);
          if (match) {
            found = match;
            break;
          }
        }
        if (!found) {
          const missed = pg.results.unassigned.find((s) => s.id === student.id);
          if (missed) found = { choiceRank: null };
        }
        if (!found) continue; // wasn't part of this particular prior group at all
        total += POINTS[found.choiceRank] ?? 10; // unranked course, or unassigned, or 4th+ choice
      }
      if (total > 0) {
        const scores = {};
        (group.courses || []).forEach((c) => (scores[c.name] = total));
        priority[student.id] = scores;
      }
    }
  } else {
    // "boost": flat streak of missing #1 choice, applied broadly to any course this year.
    for (const student of students) {
      let streak = 0;
      for (const pg of priorGroups) {
        if (!pg?.results) break;
        let found = null;
        for (const arr of Object.values(pg.results.assignments)) {
          const match = arr.find((s) => s.id === student.id);
          if (match) {
            found = match;
            break;
          }
        }
        if (!found) {
          const missed = pg.results.unassigned.find((s) => s.id === student.id);
          if (missed) found = { choiceRank: null };
        }
        if (!found) break;
        if (found.choiceRank === 1) break;
        streak += 1;
      }
      if (streak > 0) {
        const scores = {};
        (group.courses || []).forEach((c) => (scores[c.name] = streak));
        priority[student.id] = scores;
      }
    }
  }
  return priority;
}

// ---------- shared little components ----------
function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: inkSoft, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      {children}
    </label>
  );
}
const inputStyle = {
  width: "100%",
  border: `1px solid ${line}`,
  borderRadius: 7,
  padding: "9px 11px",
  fontSize: 14,
  fontFamily: sans,
  boxSizing: "border-box",
  background: "#fff",
};
function Btn({ onClick, children, tone = "green", full, disabled }) {
  const bg = { green, clay, ghost: "#fff" }[tone];
  return (
    <button
      type="button"
      className="btn-pop"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? "#B7C0D1" : bg,
        color: tone === "ghost" ? ink : "#fff",
        border: tone === "ghost" ? `1px solid ${line}` : "none",
        borderRadius: 8,
        padding: "10px 18px",
        fontFamily: sans,
        fontWeight: 700,
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        cursor: disabled ? "not-allowed" : "pointer",
        width: full ? "100%" : "auto",
      }}
    >
      {children}
    </button>
  );
}
function IconBtn({ onClick, children, tone = "ink", title, disabled }) {
  const colors = { ink, green, clay };
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={{
        border: `1px solid ${line}`,
        background: "#fff",
        color: disabled ? inkSoft : colors[tone] || ink,
        borderRadius: 7,
        padding: "6px 10px",
        fontSize: 13,
        fontFamily: sans,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 14,
        padding: "12px 0",
        borderBottom: `1px solid ${line}`,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 13.5, fontFamily: sans }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>{description}</div>}
      </div>
      <button
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={{
          width: 42,
          height: 24,
          borderRadius: 12,
          border: "none",
          background: checked ? green : "#CDD6E3",
          position: "relative",
          cursor: disabled ? "not-allowed" : "pointer",
          flexShrink: 0,
          padding: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 20 : 2,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
          }}
        />
      </button>
    </div>
  );
}

// Drag-to-order grade tiers for the "Custom ordering" grade priority mode. Each tier is a
// row of grade chips treated as equally biased; tiers run most-favored (top) to
// least-favored (bottom). A grade nobody has dragged into a tier yet sits in the "not yet
// placed" pool above and is treated as the lowest priority until it's moved into one.
//
// Dropping ON a layer box ties the grade with whatever's already there (equal priority).
// Dropping in the gap BETWEEN layers creates a new priority level instead. Those gaps used
// to be a near-invisible sliver, so most drags landed on a layer by accident and silently
// tied grades the teacher meant to rank separately — they're now large, always visible, and
// light up with their own "+ New layer" label while something's being dragged so the two
// outcomes are impossible to confuse.
function CustomGradeOrder({ grades, tiers, onChange }) {
  const [dragGrade, setDragGrade] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { type: "gap" | "tier" | "unassign", index }
  const safeTiers = tiers || [];
  const placed = new Set(safeTiers.flat());
  const unplaced = grades.filter((g) => !placed.has(g));

  const moveGrade = (grade, target) => {
    let next = safeTiers.map((t) => t.filter((g) => g !== grade));
    if (target.type === "tier") {
      next = next.map((t, i) => (i === target.index ? [...t, grade] : t));
    } else if (target.type === "gap") {
      next = [...next.slice(0, target.index), [grade], ...next.slice(target.index)];
    }
    onChange(next.filter((t) => t.length > 0));
  };

  const clearDrag = () => {
    setDragGrade(null);
    setDropTarget(null);
  };

  const chip = (g) => (
    <div
      key={g}
      draggable
      onDragStart={(e) => {
        setDragGrade(g);
        // Firefox/Safari won't complete a drag without data set on it, even though we
        // actually read the payload back out of React state, not dataTransfer.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(g));
      }}
      onDragEnd={clearDrag}
      style={{
        padding: "5px 10px",
        borderRadius: 6,
        border: `1px solid ${line}`,
        background: "#fff",
        fontFamily: mono,
        fontSize: 12.5,
        fontWeight: 700,
        cursor: "grab",
        userSelect: "none",
      }}
    >
      Grade {g}
    </div>
  );

  const gap = (index) => {
    const active = dropTarget?.type === "gap" && dropTarget.index === index;
    return (
      <div
        key={`gap-${index}`}
        onDragOver={(e) => {
          if (dragGrade !== null) e.preventDefault();
        }}
        onDragEnter={(e) => {
          if (dragGrade === null) return;
          e.preventDefault();
          setDropTarget({ type: "gap", index });
        }}
        onDragLeave={() => setDropTarget((t) => (t?.type === "gap" && t.index === index ? null : t))}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dragGrade !== null) moveGrade(dragGrade, { type: "gap", index });
          clearDrag();
        }}
        style={{
          height: dragGrade !== null ? (active ? 36 : 18) : 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "2px 0",
          borderRadius: 6,
          border: dragGrade !== null ? `2px dashed ${active ? green : line}` : "none",
          background: active ? greenSoft : "transparent",
          color: green,
          fontSize: 11,
          fontWeight: 700,
          fontFamily: sans,
          transition: "height .12s, background .12s, border-color .12s",
        }}
      >
        {active && "+ New layer here"}
      </div>
    );
  };

  return (
    <div style={{ padding: "0 0 12px 0" }}>
      <p style={{ fontSize: 11, color: inkSoft, margin: "0 0 8px" }}>
        Drop a grade <strong>onto</strong> a layer to tie it with that layer (equal priority), or into the{" "}
        <strong>gap</strong> between layers to give it its own priority level.
      </p>
      {unplaced.length > 0 && (
        <div
          onDragOver={(e) => {
            if (dragGrade !== null) e.preventDefault();
          }}
          onDragEnter={(e) => {
            if (dragGrade === null) return;
            e.preventDefault();
            setDropTarget({ type: "unassign" });
          }}
          onDragLeave={() => setDropTarget((t) => (t?.type === "unassign" ? null : t))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragGrade !== null) moveGrade(dragGrade, { type: "unassign" });
            clearDrag();
          }}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            padding: 8,
            borderRadius: 8,
            border: `1px dashed ${dropTarget?.type === "unassign" ? green : line}`,
            background: dropTarget?.type === "unassign" ? greenSoft : "transparent",
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 11, color: inkSoft, width: "100%" }}>
            Not yet placed (lowest priority until dragged into a layer below):
          </span>
          {unplaced.map(chip)}
        </div>
      )}
      {/* Catches any drop that lands in this section but misses a specific tier/gap
          target underneath it (the specific ones stopPropagation so this only fires as
          a fallback) — treats it as "add to the end" so the whole area is droppable,
          not just the gap strips. */}
      <div
        onDragOver={(e) => {
          if (dragGrade !== null) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragGrade !== null) moveGrade(dragGrade, { type: "gap", index: safeTiers.length });
          clearDrag();
        }}
        style={
          safeTiers.length === 0
            ? { border: `1px dashed ${line}`, borderRadius: 8, padding: 16, textAlign: "center" }
            : undefined
        }
      >
        {gap(0)}
        {safeTiers.map((tier, i) => {
          const tierActive = dropTarget?.type === "tier" && dropTarget.index === i;
          return (
            <React.Fragment key={i}>
              <div
                onDragOver={(e) => {
                  if (dragGrade !== null) e.preventDefault();
                }}
                onDragEnter={(e) => {
                  if (dragGrade === null) return;
                  e.preventDefault();
                  setDropTarget({ type: "tier", index: i });
                }}
                onDragLeave={() => setDropTarget((t) => (t?.type === "tier" && t.index === i ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragGrade !== null) moveGrade(dragGrade, { type: "tier", index: i });
                  clearDrag();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                  padding: 8,
                  borderRadius: 8,
                  border: `2px solid ${tierActive ? green : "transparent"}`,
                  outline: `1px solid ${line}`,
                  outlineOffset: -1,
                  background: greenSoft,
                  minHeight: 22,
                  transition: "border-color .12s",
                }}
              >
                <span style={{ fontSize: 11, color: inkSoft, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {i === 0 ? "Most favored" : i === safeTiers.length - 1 ? "Least favored" : `Layer ${i + 1}`}
                </span>
                {tier.map(chip)}
                {tierActive && <span style={{ fontSize: 11, color: green, fontWeight: 700 }}>+ tie with this layer</span>}
              </div>
              {gap(i + 1)}
            </React.Fragment>
          );
        })}
        {safeTiers.length === 0 && (
          <span style={{ fontSize: 11.5, color: inkSoft }}>Drag a grade here to start ordering.</span>
        )}
      </div>
    </div>
  );
}
const TEACHER_TUTORIAL_STEPS = [
  {
    title: "Groups tab",
    body: "Your home screen. Every sorting group you've created lives here, grouped by series where relevant. Click any group to open it.",
    preview: (
      <div style={{ display: "flex", gap: 4 }}>
        <FolderTab active={true} onClick={() => {}} icon={ClipboardList} label="Groups" />
        <FolderTab active={false} onClick={() => {}} icon={Mail} label="Mailbox" />
      </div>
    ),
  },
  {
    title: "Create group",
    body: "Start a new standalone group, or link it into a series with previous years so history can carry forward. New groups start as a Draft.",
    preview: (
      <Btn onClick={() => {}}>
        <Plus size={14} /> Create group
      </Btn>
    ),
  },
  {
    title: "Duplicate",
    body: "The copy icon on any group makes a fresh copy with the same courses and logic settings, but none of the original's student responses or results — handy for reusing a setup next term.",
    preview: (
      <IconBtn onClick={() => {}} title="Duplicate group">
        <Copy size={13} />
      </IconBtn>
    ),
  },
  {
    title: "Courses tab",
    body: "Inside a group, name each course and set its target size. You need at least 2 before students can respond.",
    preview: (
      <div style={{ display: "flex", gap: 4 }}>
        <FolderTab active={true} onClick={() => {}} icon={ClipboardList} label="Courses" />
        <FolderTab active={false} onClick={() => {}} icon={Users} label="Students" />
        <FolderTab active={false} onClick={() => {}} icon={Sliders} label="Logic" />
        <FolderTab active={false} onClick={() => {}} icon={ListOrdered} label="Results" />
      </div>
    ),
  },
  {
    title: "Activate Group",
    body: "Nothing is visible to students until you click this. It flips the group live so they can join with its code and submit their choices.",
    preview: (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, textTransform: "uppercase", padding: "3px 9px", borderRadius: 5, background: "#E4E9F1", color: inkSoft }}>
          Draft
        </span>
        <Btn onClick={() => {}}>
          <Play size={14} /> Activate Group
        </Btn>
      </div>
    ),
  },
  {
    title: "Logic tab",
    body: "Turn preference order, grade priority, and history priority on or off, choose which one wins ties, and control whether — and for how long — students can request a switch after results are published.",
    preview: (
      <div style={{ width: 220 }}>
        <Toggle label="Grade priority" checked={true} onChange={() => {}} />
      </div>
    ),
  },
  {
    title: "Run assignment",
    body: "Sorts every response using your Logic settings. You can re-run it as many times as you like before publishing.",
    preview: (
      <Btn onClick={() => {}}>
        <Play size={15} /> Run assignment
      </Btn>
    ),
  },
  {
    title: "Results tab",
    body: "Drag any student to a different course to override the algorithm by hand. The Why button on each student explains exactly how they landed where they did.",
    preview: (
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: `1px solid ${line}`, borderRadius: 6, padding: "6px 10px", fontFamily: mono, fontSize: 12.5 }}>
        <GripVertical size={12} style={{ opacity: 0.5 }} />
        Ada Lin
        <span style={{ background: goldSoft, color: gold, borderRadius: 4, padding: "2px 6px", fontSize: 10.5, fontWeight: 700 }}>choice 1</span>
        <span style={{ border: `1px solid ${line}`, borderRadius: 6, padding: "3px 5px", color: inkSoft, display: "inline-flex" }}>
          <Info size={11} />
        </span>
      </div>
    ),
  },
  {
    title: "Upload Results",
    body: "Publishes the results and closes the survey. Students can now see their placement in their Active Groups tab.",
    preview: (
      <Btn onClick={() => {}}>
        <Upload size={14} /> Upload Results
      </Btn>
    ),
  },
  {
    title: "Mailbox",
    body: "If you've allowed switch requests, they collect here from every group. Accommodate or Dismiss them one at a time or in bulk, or use Smart Fit to auto-match students into closed rotations — pairs or larger — where everyone wants what someone else in the loop already has.",
    preview: (
      <FolderTab
        active={true}
        onClick={() => {}}
        icon={Mail}
        label={
          <span style={{ position: "relative" }}>
            Mailbox
            <span style={{ position: "absolute", top: -3, right: -9, width: 7, height: 7, borderRadius: "50%", background: clay }} />
          </span>
        }
      />
    ),
  },
  {
    title: "Finalize Results",
    body: "Locks a group's results for good — no more manual moves, no more requests. Use it once you're done making changes.",
    preview: (
      <Btn tone="clay" onClick={() => {}}>
        <Lock size={14} /> Finalize Results
      </Btn>
    ),
  },
];

const STUDENT_TUTORIAL_STEPS = [
  {
    title: "Join tab",
    body: "Enter the 6-character code your teacher shares to find their sorting group.",
    preview: (
      <div style={{ display: "flex", gap: 4 }}>
        <FolderTab active={true} onClick={() => {}} icon={KeyRound} label="Join" />
        <FolderTab active={false} onClick={() => {}} icon={ListOrdered} label="Active Groups" />
      </div>
    ),
  },
  {
    title: "Ranking your choices",
    body: "Once you're in, rank the courses in order of preference — your favorite first. Submitting sends your choices straight to your teacher.",
    preview: (
      <div style={{ width: 200 }}>
        <Field label="Choice 1">
          <select style={inputStyle} onChange={() => {}}>
            <option>Chess Club</option>
          </select>
        </Field>
      </div>
    ),
  },
  {
    title: "Active Groups tab",
    body: "Every group you've responded to shows up here, with its current status: still open, waiting on results, or published.",
    preview: (
      <div style={{ display: "flex", gap: 4 }}>
        <FolderTab active={false} onClick={() => {}} icon={KeyRound} label="Join" />
        <FolderTab active={true} onClick={() => {}} icon={ListOrdered} label="Active Groups" />
      </div>
    ),
  },
  {
    title: "Your result",
    body: "Once a teacher publishes results, this tab shows exactly which course you were placed into.",
    preview: (
      <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: "10px 14px", width: 220 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: serif, fontSize: 15, fontWeight: 700 }}>5th Period Clubs</span>
          <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "3px 7px", borderRadius: 5, background: goldSoft, color: gold }}>
            Published
          </span>
        </div>
        <div style={{ fontSize: 12, color: inkSoft, marginTop: 4 }}>
          Placed in <strong style={{ color: ink }}>Chess Club</strong>
        </div>
      </div>
    ),
  },
  {
    title: "Request switch",
    body: "If your teacher allows it, you'll have a limited window after results are published to request a different course here.",
    preview: (
      <Btn tone="ghost" onClick={() => {}}>
        <ArrowLeftRight size={13} /> Request switch
      </Btn>
    ),
  },
];

function Tutorial({ steps, onDone }) {
  const [i, setI] = useState(0);
  const step = steps[i];
  const last = i === steps.length - 1;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}>
      <div style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 22, width: 380, maxWidth: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase" }}>
            <Compass size={13} /> Quick tour · {i + 1} of {steps.length}
          </span>
          <button onClick={onDone} style={{ background: "none", border: "none", color: inkSoft, cursor: "pointer", fontSize: 12, fontFamily: sans }}>
            Skip
          </button>
        </div>
        <h3 style={{ fontFamily: serif, fontSize: 19, margin: "0 0 12px" }}>{step.title}</h3>
        {step.preview && (
          <div
            style={{
              border: `1px dashed ${line}`,
              borderRadius: 8,
              padding: 16,
              marginBottom: 14,
              background: "#fff",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              pointerEvents: "none",
            }}
          >
            {step.preview}
          </div>
        )}
        <p style={{ fontSize: 13.5, color: inkSoft, lineHeight: 1.6, margin: "0 0 18px" }}>{step.body}</p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Btn tone="ghost" onClick={() => setI((n) => Math.max(0, n - 1))} disabled={i === 0}>
            <ChevronLeft size={14} /> Back
          </Btn>
          {last ? (
            <Btn onClick={onDone}>Done</Btn>
          ) : (
            <Btn onClick={() => setI((n) => n + 1)}>
              Next <ChevronRight size={14} />
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function PasswordBadge({ user, onPasswordChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [revealDraft, setRevealDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  if (!onPasswordChange) return null;

  const start = () => {
    setDraft(user.password || "");
    setRevealDraft(false);
    setErr("");
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setErr("");
  };
  const save = async () => {
    if (draft.trim().length < 6) return setErr("At least 6 characters.");
    setSaving(true);
    const errMsg = await onPasswordChange(draft.trim());
    setSaving(false);
    if (errMsg) return setErr(errMsg);
    setEditing(false);
  };

  if (editing) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          autoFocus
          type={revealDraft ? "text" : "password"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          placeholder="New password"
          style={{ border: `1px solid ${line}`, borderRadius: 6, padding: "3px 7px", fontSize: 12.5, fontFamily: mono, width: 130 }}
        />
        <button
          onMouseDown={() => setRevealDraft(true)}
          onMouseUp={() => setRevealDraft(false)}
          onMouseLeave={() => setRevealDraft(false)}
          onTouchStart={() => setRevealDraft(true)}
          onTouchEnd={() => setRevealDraft(false)}
          title="Hold to reveal"
          style={{ background: "none", border: "none", color: inkSoft, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}
        >
          <Eye size={13} />
        </button>
        <button onClick={save} disabled={saving} style={{ background: "none", border: "none", color: green, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }} title="Save">
          <Check size={14} />
        </button>
        <button onClick={cancel} disabled={saving} style={{ background: "none", border: "none", color: clay, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }} title="Cancel">
          <X size={14} />
        </button>
        {err && <span style={{ color: clay, fontSize: 11 }}>{err}</span>}
      </span>
    );
  }

  if (user.password) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        CourseDash password: <strong style={{ color: ink, fontFamily: mono, letterSpacing: 1 }}>{"•".repeat(user.password.length)}</strong>
        <button onClick={start} title="Change password" style={{ background: "none", border: "none", color: inkSoft, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}>
          <Pencil size={12} />
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={start}
      style={{ background: "none", border: "none", color: green, cursor: "pointer", fontWeight: 700, fontFamily: sans, fontSize: 12.5, display: "flex", alignItems: "center", gap: 4, padding: 0 }}
    >
      <Key size={12} /> Set a CourseDash password
    </button>
  );
}

function TopBar({ user, onLogout, onBack, onNameChange, onPasswordChange, onReturnToAdmin }) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraftName(user.name);
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);
  const saveEdit = async () => {
    const trimmed = draftName.trim();
    if (!trimmed || !onNameChange) {
      setEditing(false);
      return;
    }
    setSaving(true);
    await onNameChange(trimmed);
    setSaving(false);
    setEditing(false);
  };

  return (
    <>
      {onReturnToAdmin && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: goldSoft, border: `1px solid ${gold}55`, borderRadius: 8, padding: "7px 12px", marginBottom: 10, fontSize: 12, color: gold }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ShieldCheck size={13} /> Viewing this account as admin
          </span>
          <button
            onClick={onReturnToAdmin}
            style={{ background: "none", border: "none", color: gold, cursor: "pointer", fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", gap: 4, padding: 0 }}
          >
            <ArrowLeft size={12} /> Return to Admin
          </button>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          {onBack && (
            <button onClick={onBack} style={{ background: "none", border: "none", color: green, fontFamily: sans, fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 5, cursor: "pointer", padding: 0 }}>
              <ArrowLeft size={14} /> Back
            </button>
          )}
        </div>
        {user && (
          <div style={{ fontSize: 12.5, color: inkSoft, fontFamily: sans, display: "flex", alignItems: "center", gap: 10 }}>
            {editing ? (
              <>
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit();
                    if (e.key === "Escape") cancelEdit();
                  }}
                  style={{ border: `1px solid ${line}`, borderRadius: 6, padding: "3px 7px", fontSize: 12.5, fontFamily: sans, width: 140 }}
                />
                <button onClick={saveEdit} disabled={saving} style={{ background: "none", border: "none", color: green, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }} title="Save">
                  <Check size={14} />
                </button>
                <button onClick={cancelEdit} disabled={saving} style={{ background: "none", border: "none", color: clay, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }} title="Cancel">
                  <X size={14} />
                </button>
              </>
            ) : (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                Signed in as <strong style={{ color: ink }}>{user.name}</strong> · {user.role}
                {onNameChange && (
                  <button onClick={startEdit} title="Edit name" style={{ background: "none", border: "none", color: inkSoft, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}>
                    <Pencil size={12} />
                  </button>
                )}
              </span>
            )}
            {!editing && <PasswordBadge user={user} onPasswordChange={onPasswordChange} />}
            <button onClick={onLogout} style={{ background: "none", border: "none", color: clay, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontFamily: sans, fontSize: 12.5, fontWeight: 700, padding: 0 }}>
              <LogOut size={13} /> Log out
            </button>
          </div>
        )}
      </div>
    </>
  );
}
function Header({ eyebrow, title, sub }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 2, color: inkSoft, textTransform: "uppercase" }}>{eyebrow}</div>
      <h1 style={{ fontFamily: serif, fontSize: 28, margin: "4px 0 0", fontWeight: 700 }}>{title}</h1>
      {sub && <p style={{ color: inkSoft, fontSize: 13.5, marginTop: 6, maxWidth: 560 }}>{sub}</p>}
    </div>
  );
}

// Shown only while the admin is viewing a test account. Lists every other test
// account (teachers and students) so the admin can jump straight from one tester
// to another without stepping back through the admin dashboard each time.
function TestAccountSidebar({ currentUser, onSwitch }) {
  const [testUsers, setTestUsers] = useState(null);

  const load = useCallback(async () => {
    const keys = await storeList("user:", true);
    const recs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
    setTestUsers(recs.filter((u) => u.isTest));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const teachers = (testUsers || []).filter((u) => u.role === "teacher");
  const students = (testUsers || []).filter((u) => u.role === "student");

  const renderGroup = (title, users) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10.5, fontFamily: mono, letterSpacing: 1, textTransform: "uppercase", color: inkSoft, marginBottom: 6 }}>{title}</div>
      {users.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 12, margin: 0 }}>None yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 5 }}>
          {users.map((u) => {
            const active = u.email === currentUser?.email;
            return (
              <button
                key={u.email}
                onClick={() => !active && onSwitch(u)}
                disabled={active}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  textAlign: "left",
                  fontFamily: sans,
                  fontSize: 12.5,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: active ? `1px solid ${gold}55` : `1px solid transparent`,
                  background: active ? goldSoft : "transparent",
                  color: active ? gold : ink,
                  fontWeight: active ? 700 : 500,
                  cursor: active ? "default" : "pointer",
                }}
              >
                {active ? <ShieldCheck size={12} /> : <ArrowLeftRight size={12} />}
                {u.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        width: 190,
        flexShrink: 0,
        position: "sticky",
        top: 20,
        background: "#fff",
        border: `1px solid ${line}`,
        borderRadius: 10,
        padding: "12px 10px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: inkSoft, marginBottom: 10 }}>
        <Users size={13} /> TEST ACCOUNTS
      </div>
      {testUsers === null ? (
        <p style={{ color: inkSoft, fontSize: 12 }}>Loading…</p>
      ) : (
        <div style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto", paddingRight: 2 }}>
          {renderGroup("Teachers", teachers)}
          {renderGroup("Students", students)}
        </div>
      )}
    </div>
  );
}

// =========================================================
export default function App() {
  const [view, setView] = useState("home"); // home | about | login | signup | admin-dashboard | admin-quickfill | teacher-dashboard | teacher-group | teacher-grid | student-home | student-survey | student-done
  const [user, setUser] = useState(null);
  const [adminUser, setAdminUser] = useState(null); // holds the real admin's record while viewing another account
  const [activeCode, setActiveCode] = useState(null);
  const [quickFillCode, setQuickFillCode] = useState(null); // group code currently open in the admin's quick-fill grid
  const [checkingSession, setCheckingSession] = useState(true);

  const isAdmin = (u) => u?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const goHome = (u) => setView(isAdmin(u) ? "admin-dashboard" : u.role === "teacher" ? "teacher-home" : "student-home");

  // Restore the logged-in session (Supabase Auth persists its own session in this
  // browser's localStorage) so a reload doesn't force everyone to log in again.
  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const email = session?.user?.email;
        if (email) {
          const rec = await storeGet(`user:${safeKey(email)}`, true);
          if (rec) {
            setUser(rec);
            goHome(rec);
          }
        }
      } catch {
        // no saved session — stay on the home screen
      }
      setCheckingSession(false);
    })();
  }, []);

  const logout = () => {
    setUser(null);
    setAdminUser(null);
    setActiveCode(null);
    setView("login");
    supabase.auth.signOut().catch(() => {});
  };
  const updateUserName = async (newName) => {
    if (!user) return;
    const key = `user:${safeKey(user.email)}`;
    const rec = await storeGet(key, true);
    if (!rec) return;
    const updated = { ...rec, name: newName };
    await storeSet(key, updated, true);
    setUser(updated);
  };
  // Sets (or replaces) this account's real Supabase Auth password, which is also
  // what "logging in with a CourseDash password" checks against — the plaintext
  // copy saved alongside it is only so it can be shown back to the user, since
  // Supabase itself never returns a password once set.
  const updateUserPassword = async (newPassword) => {
    if (!user) return "Not signed in.";
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return error.message;
    const key = `user:${safeKey(user.email)}`;
    const rec = await storeGet(key, true);
    const updated = { ...(rec || user), password: newPassword };
    await storeSet(key, updated, true);
    setUser(updated);
    return null;
  };
  const markTutorialSeen = async () => {
    if (!user) return;
    const key = `user:${safeKey(user.email)}`;
    const rec = await storeGet(key, true);
    const updated = { ...(rec || user), tutorialSeen: true };
    await storeSet(key, updated, true);
    setUser(updated);
  };
  const enterAccount = (account) => {
    setAdminUser(user);
    setUser(account);
    setView(account.role === "teacher" ? "teacher-home" : "student-home");
  };
  const returnToAdmin = () => {
    setUser(adminUser);
    setAdminUser(null);
    setActiveCode(null);
    setView("admin-dashboard");
  };
  // Jump directly from one test account to another without returning to the
  // admin dashboard in between — adminUser (the real admin) stays put.
  const switchTestAccount = (account) => {
    setActiveCode(null);
    setUser(account);
    setView(account.role === "teacher" ? "teacher-home" : "student-home");
  };
  const showTestSidebar = !!(adminUser && user?.isTest);
  const openQuickFill = (code) => {
    setQuickFillCode(code);
    setView("admin-quickfill");
  };

  return (
    <div
      style={{
        background: paper,
        backgroundImage: `radial-gradient(${line} 1px, transparent 1px)`,
        backgroundSize: "22px 22px",
        minHeight: "100vh",
        // Extra bottom padding beyond the normal 28px — on some phones/tablets the
        // OS's on-screen navigation/taskbar overlaps the very bottom of the page and
        // covers whatever's last on it, so give it room to scroll clear.
        padding: "28px 20px 100px",
        fontFamily: sans,
        color: ink,
      }}
    >
      {(view === "home" || view === "about" || view === "teacher-home" || view === "student-home") && <LeaderLines />}
      <div style={{ maxWidth: showTestSidebar ? 1400 : 1180, margin: "0 auto", display: showTestSidebar ? "flex" : "block", alignItems: "flex-start", gap: 20 }}>
        {showTestSidebar && <TestAccountSidebar currentUser={user} onSwitch={switchTestAccount} />}
        <div style={{ flex: 1, minWidth: 0 }}>
        {checkingSession ? (
          <p style={{ color: inkSoft, fontSize: 13, textAlign: "center", marginTop: 60 }}>Loading…</p>
        ) : (
          <>
        {(view === "home" || view === "about" || view === "login" || view === "signup") && <PublicNav view={view} setView={setView} />}

        {view === "home" && <HomeScreen onGetStarted={() => setView("signup")} />}
        {view === "about" && <AboutScreen />}

        {(view === "login" || view === "signup") && (
          <AuthScreen
            mode={view}
            setMode={setView}
            onAuthed={(u) => {
              setUser(u);
              goHome(u);
            }}
          />
        )}

        {view === "admin-dashboard" && user && (
          <>
            <TopBar user={{ ...user, role: "admin" }} onLogout={logout} onNameChange={updateUserName} onPasswordChange={updateUserPassword} />
            <AdminHome user={user} onEnterAccount={enterAccount} onOpenQuickFill={openQuickFill} />
          </>
        )}

        {view === "admin-quickfill" && user && quickFillCode && (
          <>
            <TopBar
              user={{ ...user, role: "admin" }}
              onLogout={logout}
              onBack={() => setView("admin-dashboard")}
              onNameChange={updateUserName}
              onPasswordChange={updateUserPassword}
            />
            <QuickFillGrid code={quickFillCode} />
          </>
        )}

        {view === "teacher-home" && user && (
          <>
            <TopBar user={user} onLogout={logout} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <TeacherHome
              user={user}
              onOpenGroup={(code) => {
                setActiveCode(code);
                setView("teacher-group");
              }}
              onOpenGrid={(code) => {
                setActiveCode(code);
                setView("teacher-grid");
              }}
              showTutorial={!adminUser && !user.tutorialSeen}
              onTutorialDone={markTutorialSeen}
            />
          </>
        )}

        {view === "teacher-group" && user && activeCode && (
          <>
            <TopBar user={user} onLogout={logout} onBack={() => setView("teacher-home")} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <GroupEditor code={activeCode} onOpenGrid={() => setView("teacher-grid")} />
          </>
        )}

        {view === "teacher-grid" && user && activeCode && (
          <>
            <TopBar user={user} onLogout={logout} onBack={() => setView("teacher-home")} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <TeacherResponsesGrid code={activeCode} />
          </>
        )}

        {view === "student-home" && user && (
          <>
            <TopBar user={user} onLogout={logout} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <StudentHome
              user={user}
              onJoined={(code) => {
                setActiveCode(code);
                setView("student-survey");
              }}
              showTutorial={!adminUser && !user.tutorialSeen}
              onTutorialDone={markTutorialSeen}
            />
          </>
        )}

        {view === "student-survey" && user && activeCode && (
          <>
            <TopBar user={user} onLogout={logout} onBack={() => setView("student-home")} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <StudentSurvey code={activeCode} user={user} onDone={() => setView("student-done")} />
          </>
        )}

        {view === "student-done" && user && (
          <>
            <TopBar user={user} onLogout={logout} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <div style={{ textAlign: "center", padding: "50px 10px" }}>
              <Check size={34} color={green} style={{ marginBottom: 10 }} />
              <h2 style={{ fontFamily: serif, fontSize: 22, margin: 0 }}>Your choices are recorded</h2>
              <p style={{ color: inkSoft, fontSize: 13.5, marginTop: 8 }}>
                Your teacher will run the assignment. Check the Active Groups tab once results are published to see where you landed.
              </p>
              <div style={{ marginTop: 18 }}>
                <Btn tone="ghost" onClick={() => setView("student-home")}>
                  <KeyRound size={14} /> Back to your groups
                </Btn>
              </div>
            </div>
          </>
        )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

// Purely decorative technical-drawing-style marks (a thin leader line ending in a
// small ring terminus) anchored near the viewport edges. Fixed position + zero size
// wrapper keeps them out of normal layout flow so they can never push or overlap
// real content; hidden below 1860px where there's no gutter space to put them.
//
// Deterministic PRNG (not Math.random) so the layout is stable across re-renders
// instead of reshuffling every time unrelated app state changes.
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function next() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Rounds the interior corners of an axis-aligned polyline by pulling back `r` units
// before each corner and pushing `r` units past it, joined with a quadratic bezier
// using the corner itself as the control point.
function roundedPathFromWaypoints(points, r) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [cx, cy] = points[i];
    if (i === points.length - 1) {
      d += ` L${cx},${cy}`;
      continue;
    }
    const [px, py] = points[i - 1];
    const [nx, ny] = points[i + 1];
    const len1 = Math.hypot(cx - px, cy - py) || 1;
    const len2 = Math.hypot(nx - cx, ny - cy) || 1;
    const rr = Math.min(r, len1 / 2, len2 / 2);
    const beforeX = cx - ((cx - px) / len1) * rr;
    const beforeY = cy - ((cy - py) / len1) * rr;
    const afterX = cx + ((nx - cx) / len2) * rr;
    const afterY = cy + ((ny - cy) / len2) * rr;
    d += ` L${beforeX},${beforeY} Q${cx},${cy} ${afterX},${afterY}`;
  }
  return d;
}

const LEADER_MARK_COUNT = 30;
const LEADER_CORNER_RADIUS = 14;

// Each mark is drawn once assuming it hugs the LEFT edge and reaches inward (+x);
// right-side copies mirror the same drawing with a horizontal flip. Every mark is
// confined to its own vertical "lane" (a slice of the real, measured viewport
// height) so marks can never overlap one another, and within a mark the path only
// ever moves inward and, when it turns, only ever in one consistent vertical
// direction — a monotonic staircase that can never cross itself. Lines are either
// straight or have one or two rounded 90-degree turns, always ending in the same
// ring terminus.
function buildLeaderMarks(laneHeight, seed) {
  const rand = seededRandom(seed);
  const marks = [];
  for (let i = 0; i < LEADER_MARK_COUNT; i++) {
    const pad = 4;
    const maxV = laneHeight / 2 - pad;
    const canTurn = maxV >= 10;
    const roll = rand();
    const turns = !canTurn ? 0 : roll < 0.4 ? 0 : roll < 0.75 ? 1 : 2;
    const dir = rand() < 0.5 ? 1 : -1;
    const baseY = turns === 0 ? laneHeight / 2 : dir === 1 ? pad + 3 : laneHeight - pad - 3;

    const points = [[0, baseY]];
    let x = 0;
    let y = baseY;
    let remainingV = turns > 0 ? Math.max(8, maxV - 3) : 0;
    for (let t = 0; t < turns; t++) {
      x += t === 0 ? 100 + rand() * 50 : 35 + rand() * 25;
      points.push([x, y]);
      const vLen = t === turns - 1 ? remainingV : remainingV * (0.35 + rand() * 0.3);
      remainingV -= vLen;
      y += dir * vLen;
      points.push([x, y]);
    }
    x += turns === 0 ? 200 + rand() * 80 : 25 + rand() * 30;
    points.push([x, y]);

    marks.push({ d: roundedPathFromWaypoints(points, LEADER_CORNER_RADIUS), width: x + 20, cx: x, cy: y });
  }
  return marks;
}

function useViewportHeight() {
  const [h, setH] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 900));
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return h;
}

function LeaderLines() {
  const viewportH = useViewportHeight();
  const laneHeight = Math.max(24, viewportH / LEADER_MARK_COUNT);
  const leftMarks = useMemo(() => buildLeaderMarks(laneHeight, 1337), [laneHeight]);
  const rightMarks = useMemo(() => buildLeaderMarks(laneHeight, 7331), [laneHeight]);

  const renderMarks = (marks, keyPrefix) =>
    marks.map((m, i) => (
      <svg
        key={`${keyPrefix}${i}`}
        width={m.width}
        height={laneHeight}
        style={{ position: "absolute", top: i * laneHeight, left: 0, overflow: "visible", display: "block" }}
      >
        <path d={m.d} fill="none" stroke={line} strokeWidth={1} strokeLinecap="round" />
        <circle cx={m.cx} cy={m.cy} r={4.5} fill={paper} stroke={inkSoft} strokeWidth={1.2} />
      </svg>
    ));

  return (
    <div className="leader-lines">
      <div style={{ position: "absolute", inset: 0 }}>{renderMarks(leftMarks, "l")}</div>
      <div style={{ position: "absolute", inset: 0, transform: "scaleX(-1)" }}>{renderMarks(rightMarks, "r")}</div>
    </div>
  );
}

// ---------------- PUBLIC (pre-login) ----------------
function BrandMark({ size = 22 }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: `linear-gradient(135deg, ${green}, #16255E)`,
        color: gold,
        flexShrink: 0,
      }}
    >
      <GraduationCap size={size * 0.62} strokeWidth={2.25} />
    </span>
  );
}

function PublicNav({ view, setView }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 30 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <button
          onClick={() => setView("home")}
          style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: serif, fontWeight: 700, fontSize: 19, color: ink, padding: 0 }}
        >
          <BrandMark size={24} />
          CourseDash
        </button>
        <button
          onClick={() => setView("about")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: sans,
            fontWeight: 600,
            fontSize: 13.5,
            color: view === "about" ? green : inkSoft,
            padding: 0,
          }}
        >
          About Us
        </button>
      </div>
      <Btn tone={view === "login" ? "ghost" : "green"} onClick={() => setView(view === "login" ? "signup" : "login")}>
        {view === "login" ? "Sign up" : "Log in"}
      </Btn>
    </div>
  );
}

function HomeScreen({ onGetStarted }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "70px 20px 40px",
        maxWidth: 540,
        margin: "0 auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
        <BrandMark size={52} />
      </div>
      <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 3, color: inkSoft, textTransform: "uppercase", marginBottom: 10 }}>
        Welcome to
      </div>
      <h1 style={{ fontFamily: serif, fontSize: 42, margin: 0, fontWeight: 700, color: ink }}>CourseDash</h1>
      <p style={{ fontSize: 15.5, color: inkSoft, margin: "18px 0 26px", lineHeight: 1.55 }}>
        Fair, transparent course placement — built on real student preference, not guesswork. Set it up once, share a code, and let CourseDash handle the rest.
      </p>
      <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap", marginBottom: 30 }}>
        {["Preference-based", "Grade-aware", "Live results"].map((label) => (
          <span
            key={label}
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              padding: "4px 10px",
              borderRadius: 20,
              background: greenSoft,
              color: green,
              border: `1px solid ${green}22`,
            }}
          >
            {label}
          </span>
        ))}
      </div>
      <Btn onClick={onGetStarted}>Get started</Btn>
    </div>
  );
}

function AboutScreen() {
  const paragraphs = [
    {
      title: "For teachers",
      body: "Create a sorting group, add courses with a target size for each, and click Activate Group when you're ready for responses to start coming in. Every response arrives through a student's own account, so there's nothing to collect or re-enter by hand.",
    },
    {
      title: "For students",
      body: "Enter the code your teacher shares, rank courses in order of preference, and submit. Your Active Groups tab tracks every group you've responded to — its status, and your result once it's published.",
    },
    {
      title: "How assignment works",
      body: "Courses fill from students' top choices first. When a course has more interest than seats, you choose what breaks the tie — grade (in either direction), a student's history from past years, or both, in whichever order you prefer. Targets scale proportionally to however many students actually respond, and anyone left over gets backfilled into whichever course is furthest below its share, so seats and students end up matched as closely as possible.",
    },
    {
      title: "Multi-year series",
      body: "Link a group to previous years the same class ran, and CourseDash can give returning students priority — either for the exact course they missed before, for continuing in the course they were placed in last time, or as a general boost, whichever fits how you want repeat years to work.",
    },
    {
      title: "Publishing, requests & the mailbox",
      body: "Run the assignment, then Upload Results to publish it and lock the survey. If you allow it, students get a limited window to request a different course. Every request lands in your Mailbox, where you can Accommodate or Dismiss them individually or in bulk, or let Smart Fit automatically resolve closed rotations among them — a reciprocal pair, or a larger ring where each student wants what the next one in the loop already has — a true swap that never changes any course's headcount.",
    },
    {
      title: "Full control over results",
      body: "Drag any student into a different course by hand at any point before you finalize — the app relabels their result to reflect whether that course was actually one of their choices. A Why button on every student shows exactly how they ended up where they did. Finalizing a group locks everything in for good.",
    },
  ];
  return (
    <div style={{ maxWidth: 620, margin: "0 auto 40px" }}>
      <Header eyebrow="About Us" title="What CourseDash does" />
      <p style={{ fontSize: 14.5, color: inkSoft, lineHeight: 1.7, margin: "-6px 0 30px" }}>
        Course placement has long been a manual, error-prone process — spreadsheets passed
        between staff, preferences collected on paper, and seats filled by whoever asked first
        rather than by any consistent standard. CourseDash replaces that with a transparent,
        rules-based system that treats every student's voice as data: preferences are captured
        directly, priority is applied consistently, and outcomes can be explained rather than
        guessed at. For institutions, that means less administrative overhead and fewer disputes
        over how a seat was filled. For students, it means a fairer shot at the courses they
        actually want, and a process they can trust produced the result it did for a reason.
      </p>
      <h2 style={{ fontFamily: serif, fontSize: 22, fontWeight: 700, margin: "0 0 16px" }}>How It Works</h2>
      <div style={{ display: "grid", gap: 20 }}>
        {paragraphs.map((p) => (
          <div key={p.title}>
            <div style={{ fontFamily: serif, fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{p.title}</div>
            <p style={{ fontSize: 14, color: inkSoft, lineHeight: 1.6, margin: 0 }}>{p.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- AUTH ----------------
function AuthScreen({ mode, setMode, onAuthed }) {
  // step: form | code — the OTP flow, used for all of signup and for login when
  // loginMethod is "otp". loginMethod only matters in "login" mode; login defaults
  // to password, with "Try another way" switching it to the OTP flow.
  const [step, setStep] = useState("form");
  const [loginMethod, setLoginMethod] = useState("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("student");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const cleanEmail = () => email.trim().toLowerCase();
  const resetToStart = (nextMode) => {
    setMode(nextMode);
    setStep("form");
    setLoginMethod("password");
    setPassword("");
    setCode("");
    setError("");
  };

  const loadProfile = async () => {
    const record = await storeGet(`user:${safeKey(email)}`, true);
    if (!record) return setError("No profile found for this account — contact an admin.");
    onAuthed(record);
  };

  const passwordLogin = async () => {
    setError("");
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: cleanEmail(), password });
      if (signInError) return setError("Incorrect email or password — or you haven't set a CourseDash password yet. Try a verification code instead.");
      await loadProfile();
    } catch (err) {
      console.error("Password login error:", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    setError("");
    if (!email.trim()) return setError("Enter your email.");
    if (mode === "signup") {
      if (!name.trim()) return setError("Enter your name.");
      if (password.trim().length < 6) return setError("Choose a CourseDash password of at least 6 characters.");
    }
    setBusy(true);
    try {
      const key = `user:${safeKey(email)}`;
      if (mode === "signup") {
        const existing = await storeGet(key, true);
        if (existing) return setError("An account with that email already exists — log in instead.");
      }
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail(),
        options: { shouldCreateUser: mode === "signup" },
      });
      if (otpError) return setError(mode === "login" ? "No account found with that email." : otpError.message);
      setStep("code");
    } catch (err) {
      console.error("Send code error:", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setError("");
    if (!code.trim()) return setError("Enter the code from your email.");
    setBusy(true);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({ email: cleanEmail(), token: code.trim(), type: "email" });
      if (verifyError) return setError("That code is incorrect or expired.");
      const key = `user:${safeKey(email)}`;
      if (mode === "signup") {
        // Best-effort: also set this as their real Supabase Auth password, so
        // future logins can use it directly instead of requesting a new code each
        // time. If it fails, they still get in (OTP already verified them) — they
        // can set a password later from their dashboard.
        const { error: pwError } = await supabase.auth.updateUser({ password: password.trim() });
        const record = { email: cleanEmail(), name: name.trim(), role, tutorialSeen: false, ...(pwError ? {} : { password: password.trim() }) };
        const saved = await storeSet(key, record, true);
        if (!saved) return setError("Couldn't save your account — check your connection and try again.");
        onAuthed(record);
      } else {
        await loadProfile();
      }
    } catch (err) {
      console.error("Verify code error:", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 380, margin: "40px auto 0" }}>
      <Header eyebrow="Course Assignment Roster" title={mode === "login" ? "Log in" : "Create an account"} />
      <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 10, padding: 20 }}>
        {mode === "login" && loginMethod === "password" ? (
          <>
            <Field label="Email">
              <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
            </Field>
            <Field label="CourseDash password">
              <input
                style={inputStyle}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={(e) => e.key === "Enter" && passwordLogin()}
              />
            </Field>
            {error && (
              <div style={{ color: clay, fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
                <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
              </div>
            )}
            <Btn onClick={passwordLogin} full disabled={busy}>
              {busy ? "Logging in…" : "Log in"}
            </Btn>
            <button
              type="button"
              onClick={() => {
                setLoginMethod("otp");
                setPassword("");
                setError("");
              }}
              style={{ background: "none", border: "none", color: inkSoft, fontSize: 12.5, cursor: "pointer", fontFamily: sans, marginTop: 10, display: "block", width: "100%", textAlign: "center" }}
            >
              Try another way — use a verification code
            </button>
          </>
        ) : step === "form" ? (
          <>
            {mode === "signup" && (
              <Field label="Name">
                <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lin" />
              </Field>
            )}
            <Field label="Email">
              <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
            </Field>
            {mode === "signup" && (
              <Field label="Create a CourseDash password">
                <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
              </Field>
            )}
            {mode === "signup" && (
              <Field label="I am a...">
                <div style={{ display: "flex", gap: 8 }}>
                  {["student", "teacher"].map((r) => (
                    <button
                      type="button"
                      key={r}
                      onClick={() => setRole(r)}
                      style={{
                        flex: 1,
                        padding: "9px 0",
                        borderRadius: 7,
                        border: `1px solid ${role === r ? green : line}`,
                        background: role === r ? greenSoft : "#fff",
                        color: role === r ? green : inkSoft,
                        fontWeight: 700,
                        fontSize: 13.5,
                        fontFamily: sans,
                        cursor: "pointer",
                        textTransform: "capitalize",
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {error && (
              <div style={{ color: clay, fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
                <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
              </div>
            )}
            <Btn onClick={sendCode} full disabled={busy}>
              {busy ? "Sending…" : "Send me a code"}
            </Btn>
            {mode === "login" && (
              <button
                type="button"
                onClick={() => {
                  setLoginMethod("password");
                  setError("");
                }}
                style={{ background: "none", border: "none", color: inkSoft, fontSize: 12.5, cursor: "pointer", fontFamily: sans, marginTop: 10, display: "block", width: "100%", textAlign: "center" }}
              >
                Use my CourseDash password instead
              </button>
            )}
          </>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: inkSoft, marginTop: -4, marginBottom: 14 }}>
              We sent an 8-digit code to <strong style={{ color: ink }}>{cleanEmail()}</strong>. Enter it below.
            </p>
            <Field label="Code">
              <input
                style={{ ...inputStyle, fontFamily: mono, letterSpacing: 2, textAlign: "center" }}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345678"
                inputMode="numeric"
                autoFocus
              />
            </Field>
            {error && (
              <div style={{ color: clay, fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
                <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
              </div>
            )}
            <Btn onClick={verifyCode} full disabled={busy}>
              {busy ? "Verifying…" : "Verify & continue"}
            </Btn>
            <button
              type="button"
              onClick={() => {
                setStep("form");
                setCode("");
                setError("");
              }}
              style={{ background: "none", border: "none", color: inkSoft, fontSize: 12.5, cursor: "pointer", fontFamily: sans, marginTop: 10, display: "block", width: "100%", textAlign: "center" }}
            >
              Use a different email
            </button>
          </>
        )}
      </div>
      <p style={{ textAlign: "center", fontSize: 13, color: inkSoft, marginTop: 14 }}>
        {mode === "login" ? (
          <>
            No account?{" "}
            <button onClick={() => resetToStart("signup")} style={{ background: "none", border: "none", color: green, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>
              Sign up
            </button>
          </>
        ) : (
          <>
            Have an account?{" "}
            <button onClick={() => resetToStart("login")} style={{ background: "none", border: "none", color: green, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>
              Log in
            </button>
          </>
        )}
      </p>
      <p style={{ textAlign: "center", fontSize: 11, color: inkSoft, marginTop: 10 }}>
        For classroom use — account data is stored for this app only and isn't hardened like a production login system.
      </p>
    </div>
  );
}

// ---------------- TEACHER DASHBOARD ----------------
function PriorityBadge({ scores, courseName }) {
  if (!scores) return null;
  const value = courseName ? scores[courseName] || 0 : Math.max(0, ...Object.values(scores));
  if (!value) return null;
  const title = courseName ? `Priority +${value} for ${courseName} from past years` : `Carries priority +${value} from past years`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: claySoft,
        color: clay,
        borderRadius: 4,
        minWidth: 18,
        height: 18,
        padding: "0 3px",
        fontSize: 10.5,
        fontWeight: 700,
        fontFamily: mono,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
      title={title}
    >
      +{value}
    </span>
  );
}

// Fully, irreversibly removes a group and everything under it — submissions, its
// slot in the owning teacher's group list, and its slot in a chain (deleting the
// chain too if this was its last group). Shared by the admin's group delete and by
// a teacher's soft-deleted group once its undo window expires.
async function permanentlyDeleteGroup(group) {
  const subKeys = await storeList(`submission:${group.code}:`, true);
  await Promise.all(subKeys.map((k) => storeDelete(k, true)));

  if (group.teacherEmail) {
    const tgKey = `teacher-groups:${safeKey(group.teacherEmail)}`;
    const tgList = (await storeGet(tgKey, true)) || [];
    await storeSet(tgKey, tgList.filter((c) => c !== group.code), true);
  }

  if (group.chainId) {
    const chain = await storeGet(`chain:${group.chainId}`, true);
    if (chain) {
      const remainingCodes = chain.groupCodes.filter((c) => c !== group.code);
      if (remainingCodes.length === 0) {
        await storeDelete(`chain:${group.chainId}`, true);
        if (chain.teacherEmail) {
          const tcKey = `teacher-chains:${safeKey(chain.teacherEmail)}`;
          const tcList = (await storeGet(tcKey, true)) || [];
          await storeSet(tcKey, tcList.filter((id) => id !== group.chainId), true);
        }
        await storeDelete(`series-settings:${group.chainId}`, true);
      } else {
        await storeSet(`chain:${group.chainId}`, { ...chain, groupCodes: remainingCodes }, true);
      }
    }
  } else {
    await storeDelete(`group-settings:${group.code}`, true);
  }

  await storeDelete(`group:${group.code}`, true);
}

// ---------------- ADMIN HOME (Accounts & Groups / Messages) ----------------
function AdminHome({ user, onEnterAccount, onOpenQuickFill }) {
  const [subTab, setSubTab] = useState("accounts");
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnread = useCallback(async () => {
    const keys = await storeList("message:", true);
    const msgs = await Promise.all(keys.map((k) => storeGet(k, true)));
    setUnreadCount(msgs.filter((m) => m && m.fromRole !== "admin" && !m.read).length);
  }, []);

  useEffect(() => {
    refreshUnread();
  }, [refreshUnread]);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${line}` }}>
        <FolderTab active={subTab === "accounts"} onClick={() => setSubTab("accounts")} icon={ShieldCheck} label="Accounts & Groups" />
        <FolderTab
          active={subTab === "messages"}
          onClick={() => setSubTab("messages")}
          icon={MessageCircle}
          label={
            <span style={{ position: "relative" }}>
              Messages
              <TabBadge count={unreadCount} />
            </span>
          }
        />
        <FolderTab active={subTab === "testing"} onClick={() => setSubTab("testing")} icon={Sparkles} label="Testing" />
      </div>
      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22 }}>
        {subTab === "accounts" && <AdminDashboard onEnterAccount={onEnterAccount} />}
        {subTab === "messages" && <AdminMessages adminUser={user} onViewed={refreshUnread} />}
        {subTab === "testing" && <AdminTesting onEnterAccount={onEnterAccount} onOpenQuickFill={onOpenQuickFill} />}
      </div>
    </div>
  );
}

function AdminTesting({ onEnterAccount, onOpenQuickFill }) {
  const [testUsers, setTestUsers] = useState(null);
  const [testGroups, setTestGroups] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set()); // test teacher/student emails
  const [selectedGroups, setSelectedGroups] = useState(new Set()); // test group codes
  const [confirm, setConfirm] = useState(null); // { emails, codes, label }

  const load = useCallback(async () => {
    const keys = await storeList("user:", true);
    const recs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
    const tUsers = recs.filter((u) => u.isTest);
    setTestUsers(tUsers);

    const teacherNameByEmail = {};
    tUsers.filter((u) => u.role === "teacher").forEach((t) => {
      teacherNameByEmail[t.email] = t.name;
    });
    const groupKeys = await storeList("group:", true);
    const groupRecs = (await Promise.all(groupKeys.map((k) => storeGet(k, true).then(normalizeGroup)))).filter(Boolean);
    setTestGroups(
      groupRecs.filter((g) => g.teacherEmail in teacherNameByEmail).map((g) => ({ ...g, teacherName: teacherNameByEmail[g.teacherEmail] }))
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateTestAccount = async (role) => {
    setBusy(true);
    await createTestAccount(role, testUsers);
    await load();
    setBusy(false);
  };

  const toggleAccount = (email) =>
    setSelectedAccounts((prev) => {
      const next = new Set(prev);
      next.has(email) ? next.delete(email) : next.add(email);
      return next;
    });
  const toggleAccountsInList = (emails) =>
    setSelectedAccounts((prev) => {
      const allSelected = emails.length > 0 && emails.every((e) => prev.has(e));
      const next = new Set(prev);
      emails.forEach((e) => (allSelected ? next.delete(e) : next.add(e)));
      return next;
    });
  const toggleGroup = (code) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  const toggleAllGroups = () => {
    const codes = (testGroups || []).map((g) => g.code);
    setSelectedGroups((prev) => (codes.every((c) => prev.has(c)) && codes.length > 0 ? new Set() : new Set(codes)));
  };

  const buildConfirmation = (emails, codes, label) => setConfirm({ emails, codes, label });

  const runDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    for (const code of confirm.codes) {
      const g = (testGroups || []).find((gr) => gr.code === code);
      if (g) await permanentlyDeleteGroup(g);
    }
    for (const email of confirm.emails) {
      await storeDelete(`user:${safeKey(email)}`, true);
    }
    setBusy(false);
    setConfirm(null);
    setSelectedAccounts(new Set());
    setSelectedGroups(new Set());
    load();
  };

  const teachers = (testUsers || []).filter((u) => u.role === "teacher");
  const students = (testUsers || []).filter((u) => u.role === "student");
  const selectedCount = selectedAccounts.size + selectedGroups.size;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: inkSoft, marginTop: -4, marginBottom: 16 }}>
        Instant test accounts for trying things out — no email or sign-in needed. Click "Enter" to view the app as that account. These are kept separate from real accounts and can be deleted anytime.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <Btn onClick={() => handleCreateTestAccount("teacher")} disabled={busy || testUsers === null}>
          <Plus size={14} /> New test teacher
        </Btn>
        <Btn onClick={() => handleCreateTestAccount("student")} disabled={busy || testUsers === null}>
          <Plus size={14} /> New test student
        </Btn>
      </div>

      {selectedCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: claySoft, border: `1px solid ${clay}55`, borderRadius: 8, padding: "9px 14px", marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: clay, fontWeight: 700, flex: 1 }}>
            {selectedCount} selected ({selectedAccounts.size} account{selectedAccounts.size === 1 ? "" : "s"}, {selectedGroups.size} group{selectedGroups.size === 1 ? "" : "s"})
          </span>
          <IconBtn
            tone="clay"
            onClick={() => buildConfirmation([...selectedAccounts], [...selectedGroups], `${selectedCount} selected item${selectedCount === 1 ? "" : "s"}`)}
          >
            <Trash2 size={13} /> Delete selected
          </IconBtn>
          <button
            onClick={() => {
              setSelectedAccounts(new Set());
              setSelectedGroups(new Set());
            }}
            style={{ background: "none", border: "none", color: inkSoft, cursor: "pointer", fontSize: 12.5, fontFamily: sans }}
          >
            Clear
          </button>
        </div>
      )}

      {confirm && (
        <div
          onClick={() => !busy && setConfirm(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 360, maxWidth: "100%" }}>
            <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 10px" }}>Delete {confirm.label}?</h3>
            <p style={{ fontSize: 12.5, color: inkSoft, marginBottom: 14 }}>This only removes test data — it doesn't affect any real accounts or groups.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn tone="clay" onClick={runDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </Btn>
              <Btn tone="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Btn>
            </div>
          </div>
        </div>
      )}

      {testUsers === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <TestAccountGroup
            title="Teachers"
            users={teachers}
            selected={selectedAccounts}
            onToggle={toggleAccount}
            onToggleAll={toggleAccountsInList}
            onEnterAccount={onEnterAccount}
            onDelete={(u) => buildConfirmation([u.email], [], `the test account "${u.name}"`)}
          />
          <TestAccountGroup
            title="Students"
            users={students}
            selected={selectedAccounts}
            onToggle={toggleAccount}
            onToggleAll={toggleAccountsInList}
            onEnterAccount={onEnterAccount}
            onDelete={(u) => buildConfirmation([u.email], [], `the test account "${u.name}"`)}
          />
          <TestGroupsSection
            groups={testGroups || []}
            selected={selectedGroups}
            onToggle={toggleGroup}
            onToggleAll={toggleAllGroups}
            onOpenQuickFill={onOpenQuickFill}
            onDelete={(g) => buildConfirmation([], [g.code], `the group "${g.name}" (${g.code})`)}
          />
        </>
      )}
    </div>
  );
}

function TestAccountGroup({ title, users, selected, onToggle, onToggleAll, onEnterAccount, onDelete }) {
  const emails = users.map((u) => u.email);
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontFamily: mono, letterSpacing: 1, textTransform: "uppercase", color: inkSoft, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
        {title}
        {users.length > 0 && (
          <button
            onClick={() => onToggleAll(emails)}
            style={{ background: "none", border: "none", color: green, cursor: "pointer", fontSize: 11, fontFamily: sans, fontWeight: 700, textTransform: "none", letterSpacing: 0 }}
          >
            Select all
          </button>
        )}
      </div>
      {users.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>None yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {users.map((u) => (
            <div key={u.email} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={selected.has(u.email)}
                onChange={() => onToggle(u.email)}
                style={{ width: 15, height: 15, cursor: "pointer" }}
              />
              <span style={{ flex: 1, fontWeight: 600 }}>{u.name}</span>
              <IconBtn tone="green" title="Enter this account" onClick={() => onEnterAccount?.(u)}>
                <LogIn size={13} /> Enter
              </IconBtn>
              <IconBtn tone="clay" title="Delete test account" onClick={() => onDelete(u)}>
                <Trash2 size={13} />
              </IconBtn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Every group belonging to a test teacher, moved here out of the main Accounts &
// Groups tab so test data stays fully separate from real accounts and groups.
function TestGroupsSection({ groups, selected, onToggle, onToggleAll, onOpenQuickFill, onDelete }) {
  return (
    <div>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <LayoutGrid size={16} color={green} />
        <span style={{ fontWeight: 700, fontSize: 14, fontFamily: sans }}>Test groups</span>
        {groups.length > 0 && (
          <button onClick={onToggleAll} style={{ background: "none", border: "none", color: green, cursor: "pointer", fontSize: 12, fontFamily: sans, fontWeight: 700 }}>
            Select all
          </button>
        )}
      </div>
      {groups.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>None yet — groups a test teacher creates will show up here.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {groups.map((g) => (
            <div key={g.code} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13.5 }}>
              <input type="checkbox" checked={selected.has(g.code)} onChange={() => onToggle(g.code)} style={{ width: 15, height: 15, cursor: "pointer" }} />
              <span style={{ flex: 1, fontWeight: 600 }}>{g.name}</span>
              <span style={{ fontFamily: mono, fontSize: 11, color: gold, background: goldSoft, padding: "2px 7px", borderRadius: 4 }}>{g.code}</span>
              <span style={{ color: inkSoft, fontSize: 12.5 }}>{g.teacherName || g.teacherEmail}</span>
              <IconBtn tone="ink" title="Quick fill test responses for this group" onClick={() => onOpenQuickFill?.(g.code)}>
                <LayoutGrid size={13} /> Quick fill
              </IconBtn>
              <IconBtn tone="clay" title="Delete group" onClick={() => onDelete(g)}>
                <Trash2 size={13} />
              </IconBtn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- ADMIN QUICK FILL GRID ----------------
// Lets the admin populate a testing group's survey responses without clicking
// through each test student's real join-and-rank flow. Rows are test students,
// columns are the group's courses; dragging a "Choice N" token onto a (student,
// course) cell records that as the student's Nth-ranked pick. On submit, each
// fully-filled row is written as a normal `submission:{code}:{studentId}` record
// — identical in shape to what StudentSurvey writes — so it shows up for the
// teacher exactly like a real response.
function QuickFillGrid({ code }) {
  const [group, setGroup] = useState(null);
  const [rows, setRows] = useState([]);
  const [allTestStudents, setAllTestStudents] = useState([]);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [creatingStudent, setCreatingStudent] = useState(false);
  // { rank, origin: {studentId, courseId} | null } while a box is being dragged —
  // origin is set when the drag started from an already-placed box on the grid
  // (so its old cell gets cleared on drop), and null when dragged from the corner palette.
  const [dragPayload, setDragPayload] = useState(null);
  const [dragOverCell, setDragOverCell] = useState(null); // `${studentId}:${courseId}`
  // Click-to-place mode: while a rank is selected here, clicking any cell places
  // it there (selection stays active so several cells can be filled in a row).
  const [selectedRank, setSelectedRank] = useState(null);
  // Snapshots of `rows` for undo/redo — every row-changing edit (a move, a clear, a
  // grade change, adding/removing a student) pushes the pre-edit rows here first.
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const g = normalizeGroup(await storeGet(`group:${code}`, true));
    setGroup(g);
    const userKeys = await storeList("user:", true);
    const users = (await Promise.all(userKeys.map((k) => storeGet(k, true)))).filter(Boolean);
    const testStudents = users.filter((u) => u.isTest && u.role === "student");
    setAllTestStudents(testStudents);

    // Prefill rows from any responses test students have already submitted to
    // this group, so reopening the tool picks up where it left off.
    const subKeys = await storeList(`submission:${code}:`, true);
    const subs = (await Promise.all(subKeys.map((k) => storeGet(k, true)))).filter(Boolean);
    const testStudentById = {};
    testStudents.forEach((u) => {
      testStudentById[safeKey(u.email)] = u;
    });
    const existingRows = subs
      .filter((s) => testStudentById[s.id])
      .map((s) => ({
        studentId: s.id,
        name: s.name,
        email: s.email,
        grade: s.grade != null ? String(s.grade) : "",
        assignments: Object.fromEntries((s.prefs || []).filter(Boolean).map((courseId, i) => [courseId, i + 1])),
        extraAnswers: s.extraAnswers || {},
        createdAt: s.createdAt || null,
      }));
    setRows(existingRows);
    setUndoStack([]);
    setRedoStack([]);
    setLoading(false);
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  const courses = group?.courses || [];
  const choiceCount = group ? Math.max(2, Math.min(3, courses.length)) : 3;
  const addedIds = new Set(rows.map((r) => r.studentId));
  const availableStudents = allTestStudents.filter((u) => !addedIds.has(safeKey(u.email)));

  // Every row-changing action goes through here instead of setRows directly, so it
  // can be undone. Caps history at 50 steps so the stack can't grow unbounded.
  const updateRows = (updater) => {
    const next = typeof updater === "function" ? updater(rows) : updater;
    setUndoStack((prev) => [...prev.slice(-49), rows]);
    setRedoStack([]);
    setRows(next);
  };
  const undo = () => {
    if (undoStack.length === 0) return;
    const prevRows = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack((prev) => [...prev, rows]);
    setRows(prevRows);
  };
  const redo = () => {
    if (redoStack.length === 0) return;
    const nextRows = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack((prev) => [...prev, rows]);
    setRows(nextRows);
  };

  const addStudentRow = (student) => {
    const studentId = safeKey(student.email);
    if (addedIds.has(studentId)) return;
    updateRows((prev) => [...prev, { studentId, name: student.name, email: student.email, grade: "", assignments: {}, extraAnswers: {} }]);
    setShowAddPicker(false);
  };

  const addNewStudent = async () => {
    setCreatingStudent(true);
    const record = await createTestAccount("student", allTestStudents);
    setAllTestStudents((prev) => [...prev, record]);
    addStudentRow(record);
    setCreatingStudent(false);
  };

  const removeRow = (studentId) => updateRows((prev) => prev.filter((r) => r.studentId !== studentId));
  const setGradeFor = (studentId, v) => updateRows((prev) => prev.map((r) => (r.studentId === studentId ? { ...r, grade: v } : r)));
  const setExtraAnswerFor = (studentId, questionId, v) =>
    updateRows((prev) => prev.map((r) => (r.studentId === studentId ? { ...r, extraAnswers: { ...r.extraAnswers, [questionId]: v } } : r)));

  // Places `rank` at `target` ({studentId, courseId}). If `origin` is given (the box
  // was dragged off an already-filled cell rather than the corner palette) and it's
  // in a different row than the target, that origin cell is cleared too — so a box
  // can be dragged anywhere on the grid and it simply moves rather than duplicates.
  // Within the target row, whatever previously held this rank is removed (a rank
  // appears at most once per row) and whatever previously sat in the target cell is
  // overwritten — matching "the same choice on that row is removed and replaced."
  const moveChoice = (rank, origin, target) => {
    updateRows((prev) =>
      prev.map((r) => {
        if (origin && r.studentId === origin.studentId && r.studentId !== target.studentId) {
          if (r.assignments[origin.courseId] !== rank) return r;
          const next = { ...r.assignments };
          delete next[origin.courseId];
          return { ...r, assignments: next };
        }
        if (r.studentId !== target.studentId) return r;
        const next = {};
        Object.entries(r.assignments).forEach(([cid, rk]) => {
          if (rk === rank || cid === target.courseId) return;
          next[cid] = rk;
        });
        next[target.courseId] = rank;
        return { ...r, assignments: next };
      })
    );
  };
  const clearCell = (studentId, courseId) => {
    updateRows((prev) =>
      prev.map((r) => {
        if (r.studentId !== studentId) return r;
        const next = { ...r.assignments };
        delete next[courseId];
        return { ...r, assignments: next };
      })
    );
  };

  const extraQuestions = group?.extraQuestions || [];
  const requiredQuestions = extraQuestions.filter((q) => q.required);

  const rowStatus = (row) => {
    const assignedCount = Object.keys(row.assignments).length;
    const hasGrade = row.grade !== "" && row.grade != null;
    const anyExtraAnswered = Object.values(row.extraAnswers || {}).some((v) => (v || "").trim());
    const missingRequired = requiredQuestions.some((q) => !(row.extraAnswers?.[q.id] || "").trim());
    if (assignedCount === 0 && !hasGrade && !anyExtraAnswered) return "empty";
    if (assignedCount === choiceCount && hasGrade && !missingRequired) return "full";
    return "partial";
  };

  const canSubmit = rows.length > 0 && rows.every((r) => rowStatus(r) !== "partial") && rows.some((r) => rowStatus(r) === "full");

  const submit = async () => {
    setSubmitting(true);
    setSubmitMessage("");
    const fullRows = rows.filter((r) => rowStatus(r) === "full");
    await Promise.all(
      fullRows.map(async (r) => {
        const prefs = Array.from({ length: choiceCount }, (_, i) => Object.entries(r.assignments).find(([, rank]) => rank === i + 1)?.[0]);
        const key = `submission:${code}:${r.studentId}`;
        await storeSet(
          key,
          { id: r.studentId, name: r.name, email: r.email, grade: Number(r.grade), prefs, extraAnswers: r.extraAnswers || {}, createdAt: r.createdAt || Date.now() },
          true
        );
        // Same index StudentSurvey maintains, so this shows up in the student's own Active Groups tab too.
        const indexKey = `student-groups:${r.studentId}`;
        const existing = (await storeGet(indexKey, true)) || [];
        if (!existing.includes(code)) await storeSet(indexKey, [...existing, code], true);
      })
    );
    setSubmitting(false);
    setSubmitMessage(`Submitted ${fullRows.length} response${fullRows.length === 1 ? "" : "s"}.`);
    load();
  };

  const rankColorMap = { 1: gold, 2: green, 3: clay };
  const rankSoftMap = { 1: goldSoft, 2: greenSoft, 3: claySoft };

  if (loading || !group) return <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      <Header
        eyebrow={group.name}
        title="Quick fill test responses"
        sub="Drag a Choice box from the sidebar (or an already-placed box) onto a cell, or click a box then click cells to fill them. A row must be completely filled or completely empty before submitting."
      />

      {courses.length < 2 ? (
        <p style={{ fontSize: 13, color: clay }}>This group needs at least 2 courses before responses can be filled in.</p>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
          {/* Sticky sidebar — scrolls with the page until it hits the top, then stays
              put, but never overlaps the grid the way a fixed corner panel would. */}
          <div
            style={{
              width: 200,
              flexShrink: 0,
              position: "sticky",
              top: 20,
              background: "#fff",
              border: `1px solid ${line}`,
              borderRadius: 10,
              padding: "14px 12px",
              display: "grid",
              gap: 14,
            }}
          >
            <div>
              <p style={{ fontSize: 11, color: inkSoft, margin: "0 0 10px", display: "flex", alignItems: "flex-start", gap: 5 }}>
                <GripVertical size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                Drag a box onto the grid, or click one then click cells to fill them.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Array.from({ length: choiceCount }, (_, i) => i + 1).map((rank) => {
                  const selected = selectedRank === rank;
                  return (
                    <div key={rank} style={{ position: "relative", width: 82, height: 38 }}>
                      <div style={{ position: "absolute", inset: 0, top: 6, left: 6, borderRadius: 8, border: `1px solid ${line}`, background: "#fff" }} />
                      <div style={{ position: "absolute", inset: 0, top: 3, left: 3, borderRadius: 8, border: `1px solid ${line}`, background: "#fff" }} />
                      <div
                        draggable
                        onDragStart={() => setDragPayload({ rank, origin: null })}
                        onDragEnd={() => {
                          setDragPayload(null);
                          setDragOverCell(null);
                        }}
                        onClick={() => setSelectedRank((prev) => (prev === rank ? null : rank))}
                        title={selected ? "Selected — click cells to fill them, or click again to deselect" : "Click to select, or drag onto a cell"}
                        style={{
                          position: "absolute",
                          inset: 0,
                          borderRadius: 8,
                          border: `1px solid ${rankColorMap[rank]}55`,
                          boxShadow: selected ? `0 0 0 2px ${green}` : "none",
                          background: rankSoftMap[rank],
                          color: rankColorMap[rank],
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: mono,
                          fontWeight: 700,
                          fontSize: 12.5,
                          cursor: "pointer",
                        }}
                      >
                        Choice {rank}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ borderTop: `1px solid ${line}`, paddingTop: 12, display: "flex", gap: 8 }}>
              <IconBtn title="Undo" onClick={undo} disabled={undoStack.length === 0}>
                <Undo2 size={14} />
              </IconBtn>
              <IconBtn title="Redo" onClick={redo} disabled={redoStack.length === 0}>
                <Redo2 size={14} />
              </IconBtn>
            </div>

            <div style={{ borderTop: `1px solid ${line}`, paddingTop: 12, position: "relative" }}>
              <Btn tone="ghost" onClick={() => setShowAddPicker((o) => !o)} full>
                <Plus size={14} /> Add test student
              </Btn>
              {showAddPicker && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    marginTop: 6,
                    zIndex: 20,
                    background: "#fff",
                    border: `1px solid ${line}`,
                    borderRadius: 8,
                    padding: 10,
                    boxShadow: "0 4px 14px rgba(19,34,56,0.12)",
                  }}
                >
                  <Btn onClick={addNewStudent} disabled={creatingStudent} full>
                    <Plus size={13} /> {creatingStudent ? "Creating…" : "New test student"}
                  </Btn>
                  {availableStudents.length > 0 && (
                    <div style={{ marginTop: 8, display: "grid", gap: 2, maxHeight: 220, overflowY: "auto" }}>
                      {availableStudents.map((u) => (
                        <button
                          key={u.email}
                          onClick={() => addStudentRow(u)}
                          style={{ textAlign: "left", background: "none", border: "none", padding: "6px 6px", fontSize: 13, fontFamily: sans, cursor: "pointer", borderRadius: 5, color: ink }}
                        >
                          {u.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ borderTop: `1px solid ${line}`, paddingTop: 12, display: "grid", gap: 8 }}>
              <Btn onClick={submit} disabled={!canSubmit || submitting} full>
                {submitting ? "Submitting…" : "Submit Responses"}
              </Btn>
              {rows.some((r) => rowStatus(r) === "partial") && (
                <span style={{ fontSize: 11.5, color: clay, display: "flex", alignItems: "flex-start", gap: 5 }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} /> Every row needs to be completely filled or completely empty before submitting.
                </span>
              )}
              {submitMessage && (
                <span style={{ fontSize: 12, color: green, display: "flex", alignItems: "flex-start", gap: 5 }}>
                  <Check size={13} style={{ flexShrink: 0, marginTop: 1 }} /> {submitMessage}
                </span>
              )}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflowX: "auto", background: "#fff", border: `1px solid ${line}`, borderRadius: 10 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 380 + courses.length * 110 + extraQuestions.length * 160 }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, background: "#fff", borderBottom: `1px solid ${line}`, padding: "10px 12px", textAlign: "left", minWidth: 200 }}>
                    Student
                  </th>
                  <th style={{ borderBottom: `1px solid ${line}`, padding: "10px 12px", textAlign: "left", minWidth: 70 }}>Grade</th>
                  {courses.map((c) => (
                    <th
                      key={c.id}
                      style={{ borderBottom: `1px solid ${line}`, borderLeft: `1px solid ${line}`, padding: "10px 12px", fontFamily: serif, fontSize: 14.5, minWidth: 110 }}
                    >
                      {c.name || "(unnamed)"}
                    </th>
                  ))}
                  {extraQuestions.map((q) => (
                    <th
                      key={q.id}
                      style={{ borderBottom: `1px solid ${line}`, borderLeft: `1px solid ${line}`, padding: "10px 12px", fontFamily: sans, fontSize: 12.5, fontWeight: 700, minWidth: 160, textAlign: "left" }}
                    >
                      {q.text || "(untitled question)"}
                      {q.required && <span style={{ color: clay }}> *</span>}
                    </th>
                  ))}
                  <th style={{ borderBottom: `1px solid ${line}`, width: 36 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status = rowStatus(r);
                  return (
                    <tr key={r.studentId}>
                      <td style={{ position: "sticky", left: 0, background: "#fff", borderBottom: `1px solid ${line}`, padding: "8px 12px", fontSize: 13 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {status === "full" && <Check size={13} color={green} />}
                          {status === "partial" && <AlertTriangle size={13} color={clay} />}
                          <span style={{ fontWeight: 600 }}>{r.name}</span>
                        </span>
                      </td>
                      <td style={{ borderBottom: `1px solid ${line}`, padding: "8px 12px" }}>
                        <input
                          type="number"
                          value={r.grade}
                          onChange={(e) => setGradeFor(r.studentId, e.target.value)}
                          placeholder="9"
                          style={{ width: 48, border: `1px solid ${line}`, borderRadius: 6, padding: "4px 6px", fontFamily: mono, fontSize: 13, textAlign: "center" }}
                        />
                      </td>
                      {courses.map((c) => {
                        const rank = r.assignments[c.id];
                        const cellKey = `${r.studentId}:${c.id}`;
                        const isOver = dragOverCell === cellKey;
                        return (
                          <td
                            key={c.id}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (dragPayload) setDragOverCell(cellKey);
                            }}
                            onDragLeave={() => setDragOverCell((id) => (id === cellKey ? null : id))}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (dragPayload) moveChoice(dragPayload.rank, dragPayload.origin, { studentId: r.studentId, courseId: c.id });
                              setDragPayload(null);
                              setDragOverCell(null);
                            }}
                            onClick={() => {
                              if (selectedRank != null) moveChoice(selectedRank, null, { studentId: r.studentId, courseId: c.id });
                              else if (rank) clearCell(r.studentId, c.id);
                            }}
                            title={selectedRank != null ? "Click to place the selected choice" : rank ? "Click to clear, or drag to move" : undefined}
                            style={{
                              borderBottom: `1px solid ${line}`,
                              borderLeft: `1px solid ${line}`,
                              padding: 8,
                              textAlign: "center",
                              background: isOver ? goldSoft : "transparent",
                              cursor: selectedRank != null || rank ? "pointer" : "default",
                              transition: "background .1s",
                            }}
                          >
                            {rank && (
                              <span
                                draggable
                                onDragStart={() => setDragPayload({ rank, origin: { studentId: r.studentId, courseId: c.id } })}
                                onDragEnd={() => {
                                  setDragPayload(null);
                                  setDragOverCell(null);
                                }}
                                style={{
                                  display: "inline-block",
                                  minWidth: 64,
                                  padding: "5px 0",
                                  borderRadius: 6,
                                  background: rankSoftMap[rank],
                                  color: rankColorMap[rank],
                                  fontWeight: 700,
                                  fontSize: 12,
                                  fontFamily: mono,
                                  cursor: "grab",
                                }}
                              >
                                Choice {rank}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {extraQuestions.map((q) => (
                        <td key={q.id} style={{ borderBottom: `1px solid ${line}`, borderLeft: `1px solid ${line}`, padding: "8px 10px" }}>
                          <input
                            value={r.extraAnswers?.[q.id] || ""}
                            onChange={(e) => setExtraAnswerFor(r.studentId, q.id, e.target.value)}
                            placeholder={q.required ? "Required" : "Answer"}
                            style={{ width: "100%", minWidth: 130, border: `1px solid ${line}`, borderRadius: 6, padding: "4px 6px", fontFamily: sans, fontSize: 12.5, boxSizing: "border-box" }}
                          />
                        </td>
                      ))}
                      <td style={{ borderBottom: `1px solid ${line}`, textAlign: "center" }}>
                        <IconBtn tone="clay" title="Remove row" onClick={() => removeRow(r.studentId)}>
                          <X size={12} />
                        </IconBtn>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={courses.length + extraQuestions.length + 3} style={{ padding: "18px 12px", color: inkSoft, fontSize: 13 }}>
                      No students added yet — use "Add test student" in the sidebar.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- TEACHER RESPONSES GRID (read-only) ----------------
// Same visual layout as the admin's quick-fill grid — students down the side,
// courses and extra questions across the top — but for a teacher looking at
// their own group's real responses. Nothing here is editable: no drag-and-drop,
// no inputs, no add/remove, no submit. Purely a read-only snapshot.
function TeacherResponsesGrid({ code }) {
  const [group, setGroup] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const g = normalizeGroup(await storeGet(`group:${code}`, true));
    setGroup(g);
    const subKeys = await storeList(`submission:${code}:`, true);
    const subs = (await Promise.all(subKeys.map((k) => storeGet(k, true)))).filter(Boolean);
    const loadedRows = subs
      .map((s) => ({
        studentId: s.id,
        name: s.name,
        grade: s.grade,
        assignments: Object.fromEntries((s.prefs || []).filter(Boolean).map((courseId, i) => [courseId, i + 1])),
        extraAnswers: s.extraAnswers || {},
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setRows(loadedRows);
    setLoading(false);
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  const courses = group?.courses || [];
  const extraQuestions = group?.extraQuestions || [];
  const rankColorMap = { 1: gold, 2: green, 3: clay };
  const rankSoftMap = { 1: goldSoft, 2: greenSoft, 3: claySoft };

  // Which course each student was actually placed into, once an assignment has been
  // run — independent of their ranked choices, so a backfilled placement (outside their
  // top 3) still shows up shaded even though it has no "Choice N" badge.
  const landedCourseByStudent = {};
  if (group?.results) {
    Object.entries(group.results.assignments || {}).forEach(([courseId, list]) => {
      list.forEach((s) => {
        landedCourseByStudent[s.id] = courseId;
      });
    });
  }

  if (loading || !group) return <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      <Header
        eyebrow={group.name}
        title="Responses grid"
        sub={
          group.results
            ? "A read-only view of every response — students down the side, courses and questions across the top. The course each student landed in is shaded green."
            : "A read-only view of every response — students down the side, courses and questions across the top. Run an assignment to see who landed where."
        }
      />

      {courses.length < 2 ? (
        <p style={{ fontSize: 13, color: inkSoft }}>This group doesn't have enough courses set up yet.</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: inkSoft }}>No responses yet.</p>
      ) : (
        <div style={{ overflowX: "auto", background: "#fff", border: `1px solid ${line}`, borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 380 + courses.length * 110 + extraQuestions.length * 160 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: "#fff", borderBottom: `1px solid ${line}`, padding: "10px 12px", textAlign: "left", minWidth: 200 }}>
                  Student
                </th>
                <th style={{ borderBottom: `1px solid ${line}`, padding: "10px 12px", textAlign: "left", minWidth: 70 }}>Grade</th>
                {courses.map((c) => (
                  <th
                    key={c.id}
                    style={{ borderBottom: `1px solid ${line}`, borderLeft: `1px solid ${line}`, padding: "10px 12px", fontFamily: serif, fontSize: 14.5, minWidth: 110 }}
                  >
                    {c.name || "(unnamed)"}
                  </th>
                ))}
                {extraQuestions.map((q) => (
                  <th
                    key={q.id}
                    style={{ borderBottom: `1px solid ${line}`, borderLeft: `1px solid ${line}`, padding: "10px 12px", fontFamily: sans, fontSize: 12.5, fontWeight: 700, minWidth: 160, textAlign: "left" }}
                  >
                    {q.text || "(untitled question)"}
                    {q.required && <span style={{ color: clay }}> *</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId}>
                  <td style={{ position: "sticky", left: 0, background: "#fff", borderBottom: `1px solid ${line}`, padding: "8px 12px", fontSize: 13, fontWeight: 600 }}>
                    {r.name}
                  </td>
                  <td style={{ borderBottom: `1px solid ${line}`, padding: "8px 12px", fontFamily: mono, fontSize: 13, color: inkSoft }}>{r.grade}</td>
                  {courses.map((c) => {
                    const rank = r.assignments[c.id];
                    const landed = landedCourseByStudent[r.studentId] === c.id;
                    return (
                      <td
                        key={c.id}
                        style={{
                          borderBottom: `1px solid ${line}`,
                          borderLeft: `1px solid ${line}`,
                          padding: 8,
                          textAlign: "center",
                          background: landed ? greenSoft : "transparent",
                        }}
                      >
                        {rank && (
                          <span
                            style={{
                              display: "inline-block",
                              minWidth: 64,
                              padding: "5px 0",
                              borderRadius: 6,
                              background: landed ? "#fff" : rankSoftMap[rank],
                              color: rankColorMap[rank],
                              fontWeight: 700,
                              fontSize: 12,
                              fontFamily: mono,
                              border: landed ? `1px solid ${green}55` : "none",
                            }}
                          >
                            Choice {rank}
                          </span>
                        )}
                        {landed && !rank && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: green, fontFamily: mono }}>
                            <Check size={11} /> Placed
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {extraQuestions.map((q) => (
                    <td key={q.id} style={{ borderBottom: `1px solid ${line}`, borderLeft: `1px solid ${line}`, padding: "8px 10px", fontSize: 12.5 }}>
                      {r.extraAnswers?.[q.id] || <span style={{ color: inkSoft }}>—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Message shape: { id, subject, body, fromEmail, fromName, fromRole, toEmail,
// toName, createdAt, read }. Every message — whether started by a user or by
// admin, and whether it's a fresh message or a reply — is stored the same way,
// keyed under the non-admin participant's email so their Contact Admin tab picks
// up the whole thread regardless of who sent which message.
// A conversation with no new messages sitting untouched this long gets permanently
// deleted the next time the admin's Messages list loads.
const MESSAGE_INACTIVITY_DELETE_MS = 30 * 24 * 60 * 60 * 1000;

function AdminMessages({ adminUser, onViewed }) {
  const [conversations, setConversations] = useState(null); // [{ otherEmail, otherName, otherRole, messages, lastMessageAt, subject, unreadCount }]
  const [subTab, setSubTab] = useState("new"); // new | old
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [newTo, setNewTo] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [composeError, setComposeError] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const keys = await storeList("message:", true);
    const msgs = (
      await Promise.all(
        keys.map(async (k) => {
          const m = await storeGet(k, true);
          return m ? { ...m, _key: k } : null;
        })
      )
    ).filter(Boolean);

    // Group into one conversation per non-admin participant — regardless of which
    // side sent which message, since they're all keyed under that person's email.
    const byOther = {};
    msgs.forEach((m) => {
      const otherEmail = (m.fromRole === "admin" ? m.toEmail : m.fromEmail) || "unknown";
      if (!byOther[otherEmail])
        byOther[otherEmail] = { otherEmail, otherName: (m.fromRole === "admin" ? m.toName : m.fromName) || "Unknown", otherRole: null, messages: [] };
      byOther[otherEmail].messages.push(m);
      if (m.fromRole !== "admin") {
        byOther[otherEmail].otherName = m.fromName || "Unknown"; // keep this fresh from the user's own messages
        byOther[otherEmail].otherRole = m.fromRole;
      }
    });

    // A conversation that's fully read and hasn't seen a new message in over a
    // month gets permanently deleted right here — there's no background job, so
    // "gone" happens lazily, the next time anyone looks at this list.
    const kept = [];
    await Promise.all(
      Object.values(byOther).map(async (c) => {
        c.messages.sort((a, b) => a.createdAt - b.createdAt);
        c.lastMessageAt = c.messages[c.messages.length - 1].createdAt;
        c.subject = c.messages[c.messages.length - 1].subject || "(no subject)";
        c.unreadCount = c.messages.filter((m) => m.fromRole !== "admin" && !m.read).length;
        if (c.unreadCount === 0 && Date.now() - c.lastMessageAt > MESSAGE_INACTIVITY_DELETE_MS) {
          await Promise.all(c.messages.map((m) => storeDelete(m._key, true)));
        } else {
          kept.push(c);
        }
      })
    );
    kept.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    setConversations(kept);
    onViewed?.();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Opening a conversation is what moves it from New to Old — every unread message
  // in it gets marked read at once, not just the one that was clicked.
  const openConversation = async (c) => {
    if (expandedEmail === c.otherEmail) {
      setExpandedEmail(null);
      return;
    }
    setExpandedEmail(c.otherEmail);
    setReplySubject(c.subject);
    setReplyBody("");
    const unread = c.messages.filter((m) => m.fromRole !== "admin" && !m.read);
    if (unread.length) {
      await Promise.all(unread.map((m) => storeSet(m._key, { ...m, read: true }, true)));
      load();
    }
  };

  const sendReply = async (c) => {
    if (!replySubject.trim() || !replyBody.trim()) return;
    setReplyBusy(true);
    const id = genId();
    await storeSet(
      `message:${safeKey(c.otherEmail)}:${id}`,
      {
        id,
        subject: replySubject.trim(),
        body: replyBody.trim(),
        fromEmail: ADMIN_EMAIL,
        fromName: adminUser?.name || "Admin",
        fromRole: "admin",
        toEmail: c.otherEmail,
        toName: c.otherName,
        createdAt: Date.now(),
        read: false,
      },
      true
    );
    setReplyBusy(false);
    setReplyBody("");
    load();
  };

  const sendNew = async () => {
    setComposeError("");
    if (!newTo.trim() || !newSubject.trim() || !newBody.trim()) return setComposeError("Fill in the recipient, subject, and message.");
    setComposeBusy(true);
    const recipient = await storeGet(`user:${safeKey(newTo)}`, true);
    if (!recipient) {
      setComposeBusy(false);
      return setComposeError("No account found with that email.");
    }
    const id = genId();
    await storeSet(
      `message:${safeKey(recipient.email)}:${id}`,
      {
        id,
        subject: newSubject.trim(),
        body: newBody.trim(),
        fromEmail: ADMIN_EMAIL,
        fromName: adminUser?.name || "Admin",
        fromRole: "admin",
        toEmail: recipient.email,
        toName: recipient.name,
        createdAt: Date.now(),
        read: false,
      },
      true
    );
    setComposeBusy(false);
    setComposing(false);
    setNewTo("");
    setNewSubject("");
    setNewBody("");
    load();
  };

  const newConvos = (conversations || []).filter((c) => c.unreadCount > 0);
  const oldConvos = (conversations || []).filter((c) => c.unreadCount === 0);
  // Opening a conversation marks it read right away, which would otherwise yank it
  // out of the New tab mid-read as soon as that happens. Keep whatever's currently
  // expanded visible in whichever tab it was opened from until it's closed again.
  const q = search.trim().toLowerCase();
  const shown = (conversations || [])
    .filter((c) => c.otherEmail === expandedEmail || (subTab === "new" ? c.unreadCount > 0 : c.unreadCount === 0))
    .filter((c) => !q || (c.otherName || "").toLowerCase().includes(q) || (c.otherEmail || "").toLowerCase().includes(q) || (c.subject || "").toLowerCase().includes(q));

  return (
    <div>
      <Header eyebrow="Admin" title="Messages" sub="Every message between admin and a teacher or student, in one place." />

      <div style={{ marginBottom: 16 }}>
        {!composing ? (
          <Btn onClick={() => setComposing(true)}>
            <Plus size={14} /> New message
          </Btn>
        ) : (
          <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: 14 }}>
            <Field label="To (email)">
              <input style={inputStyle} value={newTo} onChange={(e) => setNewTo(e.target.value)} placeholder="student@school.edu" />
            </Field>
            <Field label="Subject">
              <input style={inputStyle} value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="Subject" />
            </Field>
            <Field label="Message">
              <textarea style={{ ...inputStyle, minHeight: 72, resize: "vertical" }} rows={3} value={newBody} onChange={(e) => setNewBody(e.target.value)} />
            </Field>
            {composeError && (
              <div style={{ color: clay, fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
                <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {composeError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={sendNew} disabled={composeBusy || !newTo.trim() || !newSubject.trim() || !newBody.trim()}>
                {composeBusy ? "Sending…" : "Send"}
              </Btn>
              <Btn
                tone="ghost"
                onClick={() => {
                  setComposing(false);
                  setComposeError("");
                }}
                disabled={composeBusy}
              >
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${line}`, marginBottom: 14 }}>
        <FolderTab active={subTab === "new"} onClick={() => setSubTab("new")} icon={Mail} label={`New${newConvos.length ? ` (${newConvos.length})` : ""}`} />
        <FolderTab active={subTab === "old"} onClick={() => setSubTab("old")} icon={ClipboardList} label="Old" />
      </div>

      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: inkSoft }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or subject…"
          style={{ ...inputStyle, paddingLeft: 34 }}
        />
      </div>

      {conversations === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : shown.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>{q ? "No messages match your search." : subTab === "new" ? "No new messages." : "Nothing here."}</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {shown.map((c) => {
            const expanded = expandedEmail === c.otherEmail;
            return (
              <div key={c.otherEmail} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: 14 }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => openConversation(c)}
                  onKeyDown={(e) => e.key === "Enter" && openConversation(c)}
                  style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}
                >
                  <span style={{ fontWeight: 700, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                    {c.subject}
                    {c.unreadCount > 0 && (
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: 10,
                          fontWeight: 700,
                          background: clay,
                          color: "#fff",
                          borderRadius: 8,
                          padding: "1px 6px",
                        }}
                      >
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: inkSoft, fontFamily: mono, whiteSpace: "nowrap" }}>
                    {c.otherName} · {c.otherEmail}
                  </span>
                </div>
                {expanded && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${line}` }}>
                    <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
                      {c.messages.map((m) => (
                        <div key={m.id} style={{ background: m.fromRole === "admin" ? greenSoft : "#F6F9FC", borderRadius: 7, padding: "8px 10px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: inkSoft, marginBottom: 3 }}>
                            <span style={{ fontWeight: 700, color: m.fromRole === "admin" ? green : ink }}>{m.fromRole === "admin" ? "You" : m.fromName}</span>
                            <span>{new Date(m.createdAt).toLocaleString()}</span>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{m.subject}</div>
                          <p style={{ fontSize: 13, color: ink, margin: 0, lineHeight: 1.5 }}>{m.body}</p>
                        </div>
                      ))}
                    </div>
                    <Field label="Subject">
                      <input style={inputStyle} value={replySubject} onChange={(e) => setReplySubject(e.target.value)} />
                    </Field>
                    <Field label="Reply">
                      <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} rows={2} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
                    </Field>
                    <Btn onClick={() => sendReply(c)} disabled={replyBusy || !replySubject.trim() || !replyBody.trim()}>
                      {replyBusy ? "Sending…" : "Send reply"}
                    </Btn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AdminDashboard({ onEnterAccount }) {
  const [users, setUsers] = useState(null);
  const [groups, setGroups] = useState(null);
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [selectedGroups, setSelectedGroups] = useState(new Set());
  const [confirm, setConfirm] = useState(null); // { userEmails: [...], groupCodes: [...], cascadeCount }
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const userKeys = await storeList("user:", true);
    const userRecs = (await Promise.all(userKeys.map((k) => storeGet(k, true)))).filter(Boolean);
    setUsers(userRecs.filter((u) => !u.isTest));
    // Test teachers' groups live in the Testing tab's "Test groups" section instead.
    const testTeacherEmails = new Set(userRecs.filter((u) => u.isTest && u.role === "teacher").map((u) => u.email));

    const groupKeys = await storeList("group:", true);
    const groupRecs = (await Promise.all(groupKeys.map((k) => storeGet(k, true).then(normalizeGroup)))).filter(Boolean);
    setGroups(groupRecs.filter((g) => !testTeacherEmails.has(g.teacherEmail)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const q = search.trim().toLowerCase();
  const filteredUsers = users ? users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)) : null;
  const filteredGroups = groups
    ? groups.filter((g) => !q || g.name.toLowerCase().includes(q) || g.code.toLowerCase().includes(q) || g.teacherEmail.toLowerCase().includes(q))
    : null;

  const toggleUser = (email) =>
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      next.has(email) ? next.delete(email) : next.add(email);
      return next;
    });
  const toggleGroup = (code) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  const toggleAllUsers = () => {
    const selectable = filteredUsers.filter((u) => u.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()).map((u) => u.email);
    setSelectedUsers((prev) => (selectable.every((e) => prev.has(e)) && selectable.length > 0 ? new Set() : new Set(selectable)));
  };
  const toggleAllGroups = () => {
    const codes = filteredGroups.map((g) => g.code);
    setSelectedGroups((prev) => (codes.every((c) => prev.has(c)) && codes.length > 0 ? new Set() : new Set(codes)));
  };

  // Deleting a teacher cascades to every group they own — used for both single-row
  // and bulk deletes so the behavior is consistent either way.
  const buildConfirmation = (userEmails, groupCodes, label) => {
    const explicit = new Set(groupCodes);
    const cascaded = new Set();
    groups.forEach((g) => {
      if (userEmails.includes(g.teacherEmail) && !explicit.has(g.code)) cascaded.add(g.code);
    });
    setConfirm({ userEmails, groupCodes: [...explicit, ...cascaded], cascadeCount: cascaded.size, label });
  };

  const runDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    for (const code of confirm.groupCodes) {
      const g = groups.find((gr) => gr.code === code);
      if (g) await permanentlyDeleteGroup(g);
    }
    for (const email of confirm.userEmails) {
      await storeDelete(`user:${safeKey(email)}`, true);
    }
    setBusy(false);
    setConfirm(null);
    setSelectedUsers(new Set());
    setSelectedGroups(new Set());
    load();
  };

  const selectedCount = selectedUsers.size + selectedGroups.size;

  return (
    <div>
      <Header
        eyebrow="Admin"
        title="Accounts & groups"
        sub="Only visible to the admin account. Deleting a group also removes its student responses and any saved results. Deleting a teacher's account deletes all of their groups too."
      />

      <div style={{ position: "relative", marginBottom: 16 }}>
        <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: inkSoft }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search accounts or groups by name, email, code…"
          style={{ ...inputStyle, paddingLeft: 34 }}
        />
      </div>

      {selectedCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: claySoft, border: `1px solid ${clay}55`, borderRadius: 8, padding: "9px 14px", marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: clay, fontWeight: 700, flex: 1 }}>
            {selectedCount} selected ({selectedUsers.size} account{selectedUsers.size === 1 ? "" : "s"}, {selectedGroups.size} group{selectedGroups.size === 1 ? "" : "s"})
          </span>
          <IconBtn
            tone="clay"
            onClick={() => buildConfirmation([...selectedUsers], [...selectedGroups], `${selectedCount} selected item${selectedCount === 1 ? "" : "s"}`)}
          >
            <Trash2 size={13} /> Delete selected
          </IconBtn>
          <button
            onClick={() => {
              setSelectedUsers(new Set());
              setSelectedGroups(new Set());
            }}
            style={{ background: "none", border: "none", color: inkSoft, cursor: "pointer", fontSize: 12.5, fontFamily: sans }}
          >
            Clear
          </button>
        </div>
      )}

      {confirm && (
        <div onClick={() => !busy && setConfirm(null)} style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 360, maxWidth: "100%" }}>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: clay, textTransform: "uppercase" }}>This can't be undone</div>
            <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 8px" }}>Delete {confirm.label}?</h3>
            {confirm.cascadeCount > 0 && (
              <p style={{ fontSize: 12.5, color: clay, marginBottom: 14 }}>
                Includes {confirm.cascadeCount} group{confirm.cascadeCount === 1 ? "" : "s"} that will be removed because {confirm.cascadeCount === 1 ? "its" : "their"} teacher is being deleted.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: confirm.cascadeCount > 0 ? 0 : 14 }}>
              <Btn tone="clay" onClick={runDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </Btn>
              <Btn tone="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <ShieldCheck size={16} color={green} />
        <span style={{ fontWeight: 700, fontSize: 14, fontFamily: sans }}>Accounts</span>
        {filteredUsers && filteredUsers.length > 0 && (
          <button onClick={toggleAllUsers} style={{ background: "none", border: "none", color: green, cursor: "pointer", fontSize: 12, fontFamily: sans, fontWeight: 700 }}>
            Select all
          </button>
        )}
      </div>
      {filteredUsers === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: "grid", gap: 8, marginBottom: 24 }}>
          {filteredUsers.map((u) => {
            const isSelf = u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
            return (
              <div key={u.email} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={selectedUsers.has(u.email)}
                  onChange={() => toggleUser(u.email)}
                  disabled={isSelf}
                  style={{ width: 15, height: 15, cursor: isSelf ? "not-allowed" : "pointer" }}
                />
                <span style={{ flex: 1, fontWeight: 600 }}>{u.name}</span>
                <span style={{ color: inkSoft, fontSize: 12.5 }}>{u.email}</span>
                <span style={{ fontFamily: mono, fontSize: 11, color: inkSoft, textTransform: "uppercase", background: greenSoft, padding: "2px 7px", borderRadius: 4 }}>
                  {isSelf ? "admin" : u.role}
                </span>
                {isSelf ? (
                  <span style={{ fontSize: 11.5, color: inkSoft }}>you</span>
                ) : (
                  <>
                    <IconBtn tone="green" title="Enter this account" onClick={() => onEnterAccount?.(u)}>
                      <LogIn size={13} /> Enter
                    </IconBtn>
                    <IconBtn
                      tone="clay"
                      title="Delete account"
                      onClick={() => buildConfirmation([u.email], [], `the account "${u.name}" (${u.email})`)}
                    >
                      <Trash2 size={13} />
                    </IconBtn>
                  </>
                )}
              </div>
            );
          })}
          {filteredUsers.length === 0 && <p style={{ color: inkSoft, fontSize: 13 }}>{q ? "No accounts match your search." : "No accounts yet."}</p>}
        </div>
      )}

      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <ClipboardList size={16} color={green} />
        <span style={{ fontWeight: 700, fontSize: 14, fontFamily: sans }}>Groups</span>
        {filteredGroups && filteredGroups.length > 0 && (
          <button onClick={toggleAllGroups} style={{ background: "none", border: "none", color: green, cursor: "pointer", fontSize: 12, fontFamily: sans, fontWeight: 700 }}>
            Select all
          </button>
        )}
      </div>
      {filteredGroups === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {filteredGroups.map((g) => (
            <div key={g.code} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={selectedGroups.has(g.code)}
                onChange={() => toggleGroup(g.code)}
                style={{ width: 15, height: 15, cursor: "pointer" }}
              />
              <span style={{ flex: 1, fontWeight: 600 }}>{g.name}</span>
              <span style={{ fontFamily: mono, fontSize: 11, color: gold, background: goldSoft, padding: "2px 7px", borderRadius: 4 }}>{g.code}</span>
              <span style={{ color: inkSoft, fontSize: 12.5 }}>{g.teacherEmail}</span>
              {g.chainId && <span style={{ fontSize: 11, color: inkSoft }}>in a series</span>}
              <IconBtn tone="clay" title="Delete group" onClick={() => buildConfirmation([], [g.code], `the group "${g.name}" (${g.code})`)}>
                <Trash2 size={13} />
              </IconBtn>
            </div>
          ))}
          {filteredGroups.length === 0 && <p style={{ color: inkSoft, fontSize: 13 }}>{q ? "No groups match your search." : "No groups yet."}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------- CONTACT ADMIN ----------------
// Counts messages admin has sent to this user that they haven't opened their
// Contact Admin tab to see yet — drives the notification badge on that tab.
async function countUnreadFromAdmin(email) {
  const keys = await storeList(`message:${safeKey(email)}:`, true);
  const msgs = await Promise.all(keys.map((k) => storeGet(k, true)));
  return msgs.filter((m) => m && m.fromRole === "admin" && !m.read).length;
}

function ContactAdmin({ user, onViewed }) {
  const [messages, setMessages] = useState(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [replyingTo, setReplyingTo] = useState(null); // the admin message being replied to, or null for a fresh message
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const keys = await storeList(`message:${safeKey(user.email)}:`, true);
    const msgs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
    msgs.sort((a, b) => b.createdAt - a.createdAt);
    setMessages(msgs);
    const unread = msgs.filter((m) => m.fromRole === "admin" && !m.read);
    if (unread.length) {
      await Promise.all(unread.map((m) => storeSet(`message:${safeKey(user.email)}:${m.id}`, { ...m, read: true }, true)));
    }
    onViewed?.();
  }, [user.email]);

  useEffect(() => {
    load();
  }, [load]);

  const startReply = (m) => {
    setReplyingTo(m);
    setSubject(m.subject);
    setBody("");
  };
  const cancelReply = () => {
    setReplyingTo(null);
    setSubject("");
    setBody("");
  };

  const send = async () => {
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    const id = genId();
    await storeSet(
      `message:${safeKey(user.email)}:${id}`,
      {
        id,
        subject: subject.trim(),
        body: body.trim(),
        fromEmail: user.email,
        fromName: user.name,
        fromRole: user.role,
        toEmail: ADMIN_EMAIL,
        toName: "Admin",
        createdAt: Date.now(),
        read: false,
      },
      true
    );
    setBusy(false);
    setSubject("");
    setBody("");
    setReplyingTo(null);
    load();
  };

  return (
    <div>
      <Header eyebrow="Support" title="Message admin" sub="Send a note straight to the site admin — replies show up here." />
      <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        {replyingTo && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: greenSoft, borderRadius: 6, padding: "6px 10px", marginBottom: 10, fontSize: 12, color: green }}>
            <span>Replying to "{replyingTo.subject}"</span>
            <button onClick={cancelReply} style={{ background: "none", border: "none", color: green, cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}>
              <X size={13} />
            </button>
          </div>
        )}
        <Field label="Subject">
          <input style={inputStyle} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What's this about?" />
        </Field>
        <Field label="Message">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What's going on?" rows={3} style={{ ...inputStyle, minHeight: 72, resize: "vertical" }} />
        </Field>
        <Btn onClick={send} disabled={busy || !subject.trim() || !body.trim()}>
          {busy ? "Sending…" : "Send message"}
        </Btn>
      </div>
      {messages === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : messages.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>No messages yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {messages.map((m) => (
            <div key={m.id} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: "10px 14px" }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{m.subject}</div>
              <p style={{ fontSize: 13, color: ink, margin: "0 0 8px", lineHeight: 1.5 }}>{m.body}</p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11.5, color: inkSoft, fontStyle: "italic" }}>
                  {m.fromRole === "admin" ? "From Admin" : "You"}
                </span>
                {m.fromRole === "admin" && (
                  <Btn tone="ghost" onClick={() => startReply(m)}>
                    <MessageCircle size={12} /> Reply
                  </Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- TEACHER HOME (Groups / Mailbox) ----------------
async function collectTeacherGroupCodes(user) {
  const groupCodes = (await storeGet(`teacher-groups:${safeKey(user.email)}`, true)) || [];
  const chainIds = (await storeGet(`teacher-chains:${safeKey(user.email)}`, true)) || [];
  const chains = (await Promise.all(chainIds.map((id) => storeGet(`chain:${id}`, true)))).filter(Boolean);
  const codes = new Set(groupCodes);
  chains.forEach((c) => c.groupCodes.forEach((code) => codes.add(code)));
  return [...codes];
}

// Small numbered pill for a FolderTab label, matching the admin Messages badge.
function TabBadge({ count }) {
  if (!count) return null;
  return (
    <span
      style={{
        position: "absolute",
        top: -9,
        right: -16,
        minWidth: 15,
        height: 15,
        padding: "0 4px",
        borderRadius: 8,
        background: clay,
        color: "#fff",
        fontSize: 9.5,
        fontWeight: 700,
        lineHeight: "15px",
        textAlign: "center",
        fontFamily: mono,
      }}
    >
      {count}
    </span>
  );
}

function TeacherHome({ user, onOpenGroup, onOpenGrid, showTutorial, onTutorialDone }) {
  const [subTab, setSubTab] = useState("groups");
  const [pendingCount, setPendingCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);

  const refreshPending = useCallback(async () => {
    const codes = await collectTeacherGroupCodes(user);
    const counts = await Promise.all(codes.map((code) => storeList(`request:${code}:`, true).then((keys) => keys.length)));
    setPendingCount(counts.reduce((a, b) => a + b, 0));
  }, [user.email]);

  const refreshUnreadMessages = useCallback(async () => {
    setUnreadMessages(await countUnreadFromAdmin(user.email));
  }, [user.email]);

  useEffect(() => {
    refreshPending();
    refreshUnreadMessages();
  }, [refreshPending, refreshUnreadMessages]);

  return (
    <div>
      {showTutorial && <Tutorial steps={TEACHER_TUTORIAL_STEPS} onDone={onTutorialDone} />}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${line}` }}>
        <FolderTab active={subTab === "groups"} onClick={() => setSubTab("groups")} icon={ClipboardList} label="Groups" />
        <FolderTab
          active={subTab === "mailbox"}
          onClick={() => setSubTab("mailbox")}
          icon={Mail}
          label={
            <span style={{ position: "relative" }}>
              Mailbox
              <TabBadge count={pendingCount} />
            </span>
          }
        />
        <FolderTab
          active={subTab === "contact"}
          onClick={() => setSubTab("contact")}
          icon={MessageCircle}
          label={
            <span style={{ position: "relative" }}>
              Contact Admin
              <TabBadge count={unreadMessages} />
            </span>
          }
        />
      </div>
      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22 }}>
        {subTab === "groups" && <TeacherDashboard user={user} onOpenGroup={onOpenGroup} onOpenGrid={onOpenGrid} />}
        {subTab === "mailbox" && <Mailbox user={user} onResolved={refreshPending} />}
        {subTab === "contact" && <ContactAdmin user={user} onViewed={refreshUnreadMessages} />}
      </div>
    </div>
  );
}

function Mailbox({ user, onResolved }) {
  const [requests, setRequests] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const codes = await collectTeacherGroupCodes(user);
    const groups = (await Promise.all(codes.map((c) => storeGet(`group:${c}`, true).then(normalizeGroup)))).filter(Boolean);
    const all = [];
    await Promise.all(
      groups.map(async (g) => {
        const keys = await storeList(`request:${g.code}:`, true);
        const reqs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
        reqs.forEach((r) => {
          all.push({
            key: `request:${g.code}:${r.id}`,
            code: g.code,
            groupName: g.name,
            studentId: r.id,
            studentName: r.name,
            fromCourseId: r.fromCourseId,
            toCourseId: r.toCourseId,
            fromName: (g.courses || []).find((c) => c.id === r.fromCourseId)?.name || "Unassigned",
            toName: (g.courses || []).find((c) => c.id === r.toCourseId)?.name || "(removed course)",
            createdAt: r.createdAt || 0,
          });
        });
      })
    );
    all.sort((a, b) => a.createdAt - b.createdAt);
    setRequests(all);
    setSelected(new Set());
  }, [user.email]);

  useEffect(() => {
    load();
  }, [load]);

  const q = search.trim().toLowerCase();
  const filteredRequests = requests
    ? requests.filter((r) => !q || r.studentName.toLowerCase().includes(q) || r.groupName.toLowerCase().includes(q))
    : null;

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleAll = () => {
    const codes = filteredRequests.map((r) => r.key);
    setSelected((prev) => (codes.every((k) => prev.has(k)) && codes.length > 0 ? new Set() : new Set(codes)));
  };
  const groupByCode = (list) => {
    const m = {};
    list.forEach((r) => {
      m[r.code] = m[r.code] || [];
      m[r.code].push(r);
    });
    return m;
  };

  const finishUp = async (msg) => {
    setBusy(false);
    setMessage(msg);
    await load();
    onResolved?.();
  };

  const accommodate = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    const chosen = requests.filter((r) => selected.has(r.key));
    const byCode = groupByCode(chosen);
    for (const [code, reqs] of Object.entries(byCode)) {
      const g = normalizeGroup(await storeGet(`group:${code}`, true));
      if (!g || !g.results) continue;
      let results = g.results;
      reqs.forEach((r) => {
        const currentCourseId = findCurrentCourseId(results, r.studentId);
        if (currentCourseId === undefined) return;
        results = moveStudentInResults(results, r.studentId, currentCourseId, r.toCourseId);
      });
      await storeSet(`group:${code}`, { ...g, results }, true);
      await Promise.all(reqs.map((r) => storeDelete(r.key, true)));
    }
    await finishUp(`Accommodated ${chosen.length} request${chosen.length === 1 ? "" : "s"}.`);
  };

  const dismiss = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    const chosen = requests.filter((r) => selected.has(r.key));
    await Promise.all(chosen.map((r) => storeDelete(r.key, true)));
    await finishUp(`Dismissed ${chosen.length} request${chosen.length === 1 ? "" : "s"}.`);
  };

  // Finds reciprocal pairs — student A wants student B's current course, and B wants
  // A's — so both can swap without changing any course's headcount. Operates on every
  // pending request, not just the checked ones, since a matching pair might not both
  // be selected.
  const smartFit = async () => {
    if (!requests || requests.length === 0) return;
    setBusy(true);
    const byCode = groupByCode(requests);
    let rotationCount = 0;
    const resolvedKeys = [];
    for (const [code, reqs] of Object.entries(byCode)) {
      const g = normalizeGroup(await storeGet(`group:${code}`, true));
      if (!g || !g.results) continue;
      let results = g.results;
      let touched = false;

      // currentCourseId is captured once up front (not recomputed mid-rotation) so
      // that moves within the same closed loop don't interfere with each other.
      let pool = reqs
        .map((r) => ({ ...r, currentCourseId: findCurrentCourseId(results, r.studentId) }))
        .filter((r) => r.currentCourseId !== undefined && r.currentCourseId !== r.toCourseId);

      let cycle;
      while ((cycle = findRotationCycle(pool))) {
        cycle.forEach((r) => {
          results = moveStudentInResults(results, r.studentId, r.currentCourseId, r.toCourseId);
        });
        const usedKeys = new Set(cycle.map((r) => r.key));
        resolvedKeys.push(...usedKeys);
        pool = pool.filter((r) => !usedKeys.has(r.key));
        rotationCount++;
        touched = true;
      }

      if (touched) await storeSet(`group:${code}`, { ...g, results }, true);
    }
    await Promise.all(resolvedKeys.map((k) => storeDelete(k, true)));
    await finishUp(
      rotationCount > 0 ? `Smart Fit matched ${rotationCount} rotation${rotationCount === 1 ? "" : "s"}.` : "No reciprocal swaps were found among pending requests."
    );
  };

  return (
    <div>
      <Header eyebrow="Mailbox" title="Switch requests" sub="Every pending request from your groups, in one place. A group must have switch requests turned on (Logic tab) for students to send these." />

      {message && (
        <div style={{ background: greenSoft, borderRadius: 8, padding: "9px 12px", marginBottom: 14, fontSize: 12.5, color: green, display: "flex", justifyContent: "space-between" }}>
          <span>{message}</span>
          <button onClick={() => setMessage("")} style={{ background: "none", border: "none", color: green, cursor: "pointer" }}>
            <X size={13} />
          </button>
        </div>
      )}

      {requests === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : requests.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>No pending requests.</p>
      ) : (
        <>
          {requests.length > 5 && (
            <div style={{ position: "relative", marginBottom: 12 }}>
              <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: inkSoft }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by student or group…"
                style={{ ...inputStyle, paddingLeft: 30, fontSize: 13 }}
              />
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
            <IconBtn onClick={toggleAll}>
              <CheckSquare size={13} /> {filteredRequests.length > 0 && filteredRequests.every((r) => selected.has(r.key)) ? "Deselect all" : "Select all"}
            </IconBtn>
            <IconBtn tone="green" onClick={accommodate} disabled={busy || selected.size === 0}>
              <Check size={13} /> Accommodate
            </IconBtn>
            <IconBtn tone="clay" onClick={dismiss} disabled={busy || selected.size === 0}>
              <X size={13} /> Dismiss
            </IconBtn>
            <IconBtn tone="green" onClick={smartFit} disabled={busy}>
              <Sparkles size={13} /> Smart Fit
            </IconBtn>
            {selected.size > 0 && <span style={{ fontSize: 12, color: inkSoft }}>{selected.size} selected</span>}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {filteredRequests.map((r) => (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13 }}>
                <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} style={{ width: 15, height: 15, cursor: "pointer" }} />
                <span style={{ fontFamily: mono, fontSize: 10.5, color: gold, background: goldSoft, padding: "2px 7px", borderRadius: 4 }}>{r.groupName}</span>
                <span style={{ fontWeight: 600, flex: 1 }}>{r.studentName}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: inkSoft, fontFamily: mono }}>
                  {r.fromName} <ArrowLeftRight size={11} /> {r.toName}
                </span>
              </div>
            ))}
            {filteredRequests.length === 0 && <p style={{ color: inkSoft, fontSize: 13 }}>No requests match "{search}".</p>}
          </div>
        </>
      )}
    </div>
  );
}

function TeacherDashboard({ user, onOpenGroup, onOpenGrid }) {
  const [chains, setChains] = useState(null); // [{...chain, groups: [group,...]}]
  const [standalone, setStandalone] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createMode, setCreateMode] = useState("standalone"); // standalone | new-series | existing-series
  const [newName, setNewName] = useState("");
  const [seriesName, setSeriesName] = useState("");
  const [existingChainId, setExistingChainId] = useState("");
  const [addYearFor, setAddYearFor] = useState(null); // chainId currently adding a year to
  const [yearLabel, setYearLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const [allGroups, setAllGroups] = useState({});
  const [dragSourceCode, setDragSourceCode] = useState(null);
  const [dragOverCode, setDragOverCode] = useState(null);
  const [dropInfo, setDropInfo] = useState(null); // {mode:'new-series', codes:[a,b]} | {mode:'add-existing', sourceCode, chainId, chainName}
  const [seriesNameForDrop, setSeriesNameForDrop] = useState("");
  const [dropError, setDropError] = useState("");
  const [dropBusy, setDropBusy] = useState(false);
  const [recentlyDeleted, setRecentlyDeleted] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(null); // the group pending a delete confirmation
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const groupCodes = (await storeGet(`teacher-groups:${safeKey(user.email)}`, true)) || [];
    const chainIds = (await storeGet(`teacher-chains:${safeKey(user.email)}`, true)) || [];

    const groupObjs = await Promise.all(
      groupCodes.map(async (code) => {
        const g = normalizeGroup(await storeGet(`group:${code}`, true));
        const subs = await storeList(`submission:${code}:`, true);
        return g ? { ...g, studentCount: subs.length } : null;
      })
    );

    // Groups past their undo window get permanently cleaned up right here, the next
    // time this list loads — there's no background job, so "gone for good" happens
    // lazily, the next time anyone looks. Anything still inside the window shows up
    // in "Recently deleted" instead of the normal group lists below.
    const stillDeleted = [];
    const active = [];
    await Promise.all(
      groupObjs.filter(Boolean).map(async (g) => {
        if (g.deletedAt) {
          if (Date.now() - g.deletedAt > TEACHER_DELETE_UNDO_MS) {
            await permanentlyDeleteGroup(g);
          } else {
            stillDeleted.push(g);
          }
        } else {
          active.push(g);
        }
      })
    );
    setRecentlyDeleted(stillDeleted.sort((a, b) => b.deletedAt - a.deletedAt));

    const byCode = {};
    active.forEach((g) => (byCode[g.code] = g));
    setAllGroups(byCode);

    const chainObjs = await Promise.all(chainIds.map((id) => storeGet(`chain:${id}`, true)));
    const chainsLoaded = chainObjs
      .filter(Boolean)
      .map((chain) => ({ ...chain, groups: chain.groupCodes.map((c) => byCode[c]).filter(Boolean) }));

    const chainedCodes = new Set(chainsLoaded.flatMap((c) => c.groupCodes));
    setStandalone(Object.values(byCode).filter((g) => !chainedCodes.has(g.code)));
    setChains(chainsLoaded);
  }, [user.email]);

  useEffect(() => {
    load();
  }, [load]);

  // A slow poll (so an expired group actually disappears even if the teacher just
  // leaves this tab open) plus a fast local tick purely to keep the "time left"
  // countdown moving between polls.
  useEffect(() => {
    const poll = setInterval(load, 20000);
    return () => clearInterval(poll);
  }, [load]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const deleteGroup = async (group) => {
    setDeleteBusy(true);
    const fresh = normalizeGroup(await storeGet(`group:${group.code}`, true));
    if (fresh) await storeSet(`group:${group.code}`, { ...fresh, deletedAt: Date.now() }, true);
    setConfirmDelete(null);
    setDeleteBusy(false);
    await load();
  };

  const restoreGroup = async (group) => {
    setDeleteBusy(true);
    const fresh = normalizeGroup(await storeGet(`group:${group.code}`, true));
    if (fresh) {
      const { deletedAt, ...rest } = fresh;
      await storeSet(`group:${group.code}`, rest, true);
    }
    setDeleteBusy(false);
    await load();
  };

  const addGroupCode = async (code) => {
    const codes = (await storeGet(`teacher-groups:${safeKey(user.email)}`, true)) || [];
    await storeSet(`teacher-groups:${safeKey(user.email)}`, [...codes, code], true);
  };

  const createStandalone = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    let code = genCode();
    while (await storeGet(`group:${code}`, true)) code = genCode();
    const group = { code, teacherEmail: user.email, name: newName.trim(), chainId: null, courses: [], results: null, status: "draft", publishedAt: null, resultsFinalized: false, createdAt: Date.now() };
    await storeSet(`group:${code}`, group, true);
    await addGroupCode(code);
    setBusy(false);
    resetCreate();
    load();
    onOpenGroup(code);
  };

  const createSeriesAndGroup = async () => {
    if (!seriesName.trim() || !yearLabel.trim()) return;
    setBusy(true);
    let code = genCode();
    while (await storeGet(`group:${code}`, true)) code = genCode();
    const chainId = genId();
    const group = { code, teacherEmail: user.email, name: yearLabel.trim(), chainId, courses: [], results: null, status: "draft", publishedAt: null, resultsFinalized: false, createdAt: Date.now() };
    await storeSet(`group:${code}`, group, true);
    await addGroupCode(code);
    const chain = { id: chainId, teacherEmail: user.email, name: seriesName.trim(), groupCodes: [code] };
    await storeSet(`chain:${chainId}`, chain, true);
    const chainIds = (await storeGet(`teacher-chains:${safeKey(user.email)}`, true)) || [];
    await storeSet(`teacher-chains:${safeKey(user.email)}`, [...chainIds, chainId], true);
    setBusy(false);
    resetCreate();
    load();
    onOpenGroup(code);
  };

  const addToExistingSeries = async () => {
    if (!existingChainId || !yearLabel.trim()) return;
    setBusy(true);
    const chain = await storeGet(`chain:${existingChainId}`, true);
    if (!chain) {
      setBusy(false);
      return;
    }
    let code = genCode();
    while (await storeGet(`group:${code}`, true)) code = genCode();
    const group = { code, teacherEmail: user.email, name: yearLabel.trim(), chainId: existingChainId, courses: [], results: null, status: "draft", publishedAt: null, resultsFinalized: false, createdAt: Date.now() };
    await storeSet(`group:${code}`, group, true);
    await addGroupCode(code);
    await storeSet(`chain:${existingChainId}`, { ...chain, groupCodes: [...chain.groupCodes, code] }, true);
    setBusy(false);
    resetCreate();
    setAddYearFor(null);
    load();
    onOpenGroup(code);
  };

  const resetCreate = () => {
    setCreating(false);
    setCreateMode("standalone");
    setNewName("");
    setSeriesName("");
    setExistingChainId("");
    setYearLabel("");
  };

  const [duplicating, setDuplicating] = useState(null); // code currently being duplicated
  const duplicateGroup = async (g) => {
    setDuplicating(g.code);
    let code = genCode();
    while (await storeGet(`group:${code}`, true)) code = genCode();
    const newCourses = (g.courses || []).map((c) => ({ ...c, id: genId() }));
    const newGroup = {
      code,
      teacherEmail: user.email,
      name: `${g.name} (Copy)`,
      chainId: null, // duplicates start standalone, even if the original was in a series
      courses: newCourses,
      results: null,
      status: "draft",
      publishedAt: null,
      resultsFinalized: false,
      createdAt: Date.now(),
    };
    await storeSet(`group:${code}`, newGroup, true);
    await addGroupCode(code);
    // carry over the original's logic settings as a starting point
    const settings = await loadLogicSettingsForGroup(g);
    await saveLogicSettingsForGroup(newGroup, settings);
    setDuplicating(null);
    load();
    onOpenGroup(code);
  };

  // ---------- drag to form / extend a series ----------
  const handleDrop = (targetCode) => {
    const sourceCode = dragSourceCode;
    setDragSourceCode(null);
    setDragOverCode(null);
    setDropError("");
    if (!sourceCode || sourceCode === targetCode) return;
    const source = allGroups[sourceCode];
    const target = allGroups[targetCode];
    if (!source || !target) return;

    if (source.chainId && target.chainId) {
      if (source.chainId !== target.chainId) {
        setDropError("Both groups already belong to different series — merging series isn't supported yet.");
      }
      return;
    }
    if (source.chainId) {
      const chain = chains.find((c) => c.id === source.chainId);
      setDropInfo({ mode: "add-existing", sourceCode: targetCode, chainId: source.chainId, chainName: chain?.name || "" });
    } else if (target.chainId) {
      const chain = chains.find((c) => c.id === target.chainId);
      setDropInfo({ mode: "add-existing", sourceCode, chainId: target.chainId, chainName: chain?.name || "" });
    } else {
      setDropInfo({ mode: "new-series", codes: [sourceCode, targetCode] });
      setSeriesNameForDrop("");
    }
  };

  const cancelDrop = () => {
    setDropInfo(null);
    setSeriesNameForDrop("");
  };

  const confirmNewSeries = async () => {
    if (!seriesNameForDrop.trim() || !dropInfo) return;
    setDropBusy(true);
    const [codeA, codeB] = dropInfo.codes;
    const gA = allGroups[codeA];
    const gB = allGroups[codeB];
    const chainId = genId();
    const ordered = [gA, gB].sort((a, b) => a.createdAt - b.createdAt).map((g) => g.code);
    const chain = { id: chainId, teacherEmail: user.email, name: seriesNameForDrop.trim(), groupCodes: ordered };
    await storeSet(`chain:${chainId}`, chain, true);
    const chainIds = (await storeGet(`teacher-chains:${safeKey(user.email)}`, true)) || [];
    await storeSet(`teacher-chains:${safeKey(user.email)}`, [...chainIds, chainId], true);
    await storeSet(`group:${codeA}`, { ...gA, chainId }, true);
    await storeSet(`group:${codeB}`, { ...gB, chainId }, true);
    setDropBusy(false);
    setDropInfo(null);
    setSeriesNameForDrop("");
    load();
  };

  const confirmAddExisting = async () => {
    if (!dropInfo) return;
    setDropBusy(true);
    const { sourceCode, chainId } = dropInfo;
    const chain = await storeGet(`chain:${chainId}`, true);
    const g = allGroups[sourceCode];
    if (chain && g) {
      const nextCodes = Array.from(new Set([...chain.groupCodes, sourceCode])).sort(
        (a, b) => (allGroups[a]?.createdAt || 0) - (allGroups[b]?.createdAt || 0)
      );
      await storeSet(`chain:${chainId}`, { ...chain, groupCodes: nextCodes }, true);
      await storeSet(`group:${sourceCode}`, { ...g, chainId }, true);
    }
    setDropBusy(false);
    setDropInfo(null);
    load();
  };

  const dragHandlers = (g) => ({
    draggable: true,
    onDragStart: () => setDragSourceCode(g.code),
    onDragOver: (e) => e.preventDefault(),
    onDragEnter: (e) => {
      e.preventDefault();
      if (dragSourceCode && dragSourceCode !== g.code) setDragOverCode(g.code);
    },
    onDragLeave: () => setDragOverCode((c) => (c === g.code ? null : c)),
    onDrop: (e) => {
      e.preventDefault();
      handleDrop(g.code);
    },
  });

  const modeBtn = (mode, label) => (
    <button
      type="button"
      onClick={() => setCreateMode(mode)}
      style={{
        flex: 1,
        padding: "8px 4px",
        borderRadius: 7,
        border: `1px solid ${createMode === mode ? green : line}`,
        background: createMode === mode ? greenSoft : "#fff",
        color: createMode === mode ? green : inkSoft,
        fontWeight: 700,
        fontSize: 12.5,
        fontFamily: sans,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <Header
        eyebrow="Teacher dashboard"
        title="Your sorting groups"
        sub="Link groups into a series to carry priority for students who missed their top choice in past years. Drag one group onto another to link them. Open a group and use its Logic tab to set assignment rules — shared by every group in the same series."
      />

      {dropError && (
        <div style={{ background: claySoft, border: `1px solid ${clay}55`, borderRadius: 8, padding: "9px 12px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: clay, display: "flex", alignItems: "center", gap: 6 }}>
            <AlertTriangle size={13} /> {dropError}
          </span>
          <button onClick={() => setDropError("")} style={{ background: "none", border: "none", cursor: "pointer", color: clay }}>
            <X size={14} />
          </button>
        </div>
      )}
      {chains === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: "grid", gap: 18 }}>
          {chains.map((chain) => (
            <div key={chain.id}>
              <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
                Series · {chain.name}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {chain.groups.map((g, i) => (
                  <div
                    key={g.code}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenGroup(g.code)}
                    onKeyDown={(e) => e.key === "Enter" && onOpenGroup(g.code)}
                    {...dragHandlers(g)}
                    style={{
                      textAlign: "left",
                      background: dragOverCode === g.code ? goldSoft : "#fff",
                      border: `1px solid ${dragOverCode === g.code ? gold : line}`,
                      borderLeft: `4px solid ${green}`,
                      borderRadius: 9,
                      padding: "12px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "grab",
                    }}
                  >
                    <div>
                      <div style={{ fontFamily: serif, fontSize: 16, fontWeight: 700 }}>
                        {g.name} <span style={{ fontWeight: 400, color: inkSoft, fontSize: 14 }}>({g.studentCount})</span>
                      </div>
                      <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>
                        {g.courses.length} courses · {g.studentCount} responses {i === chain.groups.length - 1 && "· most recent"}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <IconBtn
                        title="View responses grid (read-only)"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenGrid?.(g.code);
                        }}
                      >
                        <LayoutGrid size={13} />
                      </IconBtn>
                      <IconBtn
                        title="Duplicate group"
                        onClick={(e) => {
                          e.stopPropagation();
                          duplicateGroup(g);
                        }}
                        disabled={duplicating === g.code}
                      >
                        <Copy size={13} />
                      </IconBtn>
                      <IconBtn
                        tone="clay"
                        title="Delete group"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(g);
                        }}
                      >
                        <Trash2 size={13} />
                      </IconBtn>
                      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 13, letterSpacing: 2, background: goldSoft, color: gold, padding: "5px 10px", borderRadius: 6 }}>
                        {g.code}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {addYearFor === chain.id ? (
                <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: 12, display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder="Label for this year, e.g. 2026-27"
                    value={yearLabel}
                    onChange={(e) => setYearLabel(e.target.value)}
                  />
                  <Btn
                    onClick={async () => {
                      setExistingChainId(chain.id);
                      await addToExistingSeries();
                    }}
                    disabled={busy || !yearLabel.trim()}
                  >
                    {busy ? "Adding…" : "Add"}
                  </Btn>
                  <Btn tone="ghost" onClick={() => { setAddYearFor(null); setYearLabel(""); }}>
                    Cancel
                  </Btn>
                </div>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <IconBtn tone="green" onClick={() => { setAddYearFor(chain.id); setYearLabel(""); }}>
                    <Plus size={13} /> Add new year to this series
                  </IconBtn>
                </div>
              )}
            </div>
          ))}

          {standalone.length > 0 && (
            <div>
              {chains.length > 0 && (
                <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
                  Standalone groups
                </div>
              )}
              <div style={{ display: "grid", gap: 8 }}>
                {standalone.map((g) => (
                  <div
                    key={g.code}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenGroup(g.code)}
                    onKeyDown={(e) => e.key === "Enter" && onOpenGroup(g.code)}
                    {...dragHandlers(g)}
                    style={{
                      textAlign: "left",
                      background: dragOverCode === g.code ? goldSoft : "#fff",
                      border: `1px solid ${dragOverCode === g.code ? gold : line}`,
                      borderRadius: 9,
                      padding: "14px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "grab",
                    }}
                  >
                    <div>
                      <div style={{ fontFamily: serif, fontSize: 17, fontWeight: 700 }}>
                        {g.name} <span style={{ fontWeight: 400, color: inkSoft, fontSize: 14 }}>({g.studentCount})</span>
                      </div>
                      <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>
                        {g.courses.length} courses · {g.studentCount} responses
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <IconBtn
                        title="View responses grid (read-only)"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenGrid?.(g.code);
                        }}
                      >
                        <LayoutGrid size={13} />
                      </IconBtn>
                      <IconBtn
                        title="Duplicate group"
                        onClick={(e) => {
                          e.stopPropagation();
                          duplicateGroup(g);
                        }}
                        disabled={duplicating === g.code}
                      >
                        <Copy size={13} />
                      </IconBtn>
                      <IconBtn
                        tone="clay"
                        title="Delete group"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(g);
                        }}
                      >
                        <Trash2 size={13} />
                      </IconBtn>
                      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, letterSpacing: 2, background: goldSoft, color: gold, padding: "6px 12px", borderRadius: 6 }}>
                        {g.code}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {chains.length === 0 && standalone.length === 0 && <p style={{ color: inkSoft, fontSize: 13 }}>No groups yet — create your first one below.</p>}
        </div>
      )}

      {recentlyDeleted.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: clay, textTransform: "uppercase", marginBottom: 6 }}>Recently deleted</div>
          <div style={{ display: "grid", gap: 8 }}>
            {recentlyDeleted.map((g) => {
              const remainingMs = Math.max(0, TEACHER_DELETE_UNDO_MS - (now - g.deletedAt));
              const mins = Math.floor(remainingMs / 60000);
              const secs = Math.floor((remainingMs % 60000) / 1000);
              return (
                <div
                  key={g.code}
                  style={{
                    background: claySoft,
                    border: `1px solid ${clay}55`,
                    borderRadius: 9,
                    padding: "12px 16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontFamily: serif, fontSize: 16, fontWeight: 700 }}>{g.name}</div>
                    <div style={{ fontSize: 12, color: clay, marginTop: 2 }}>
                      {remainingMs > 0 ? `Gone for good in ${mins}m ${secs.toString().padStart(2, "0")}s` : "Deleting…"}
                    </div>
                  </div>
                  <Btn tone="ghost" onClick={() => restoreGroup(g)} disabled={deleteBusy}>
                    <RefreshCw size={13} /> Restore
                  </Btn>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          onClick={() => !deleteBusy && setConfirmDelete(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 360, maxWidth: "100%" }}>
            <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 8px" }}>Delete "{confirmDelete.name}"?</h3>
            <p style={{ fontSize: 12.5, color: inkSoft, marginBottom: 14 }}>
              It'll move to Recently Deleted, where you can restore it for the next 5 minutes. After that, it's deleted for good — including its courses, responses, and results.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn tone="clay" onClick={() => deleteGroup(confirmDelete)} disabled={deleteBusy}>
                {deleteBusy ? "Deleting…" : "Delete"}
              </Btn>
              <Btn tone="ghost" onClick={() => setConfirmDelete(null)} disabled={deleteBusy}>
                Cancel
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {!creating ? (
          <Btn onClick={() => setCreating(true)}>
            <Plus size={14} /> Create group
          </Btn>
        ) : (
          <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: 14 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {modeBtn("standalone", "Standalone")}
              {modeBtn("new-series", "Start a series")}
              {modeBtn("existing-series", "Add to a series")}
            </div>

            {createMode === "standalone" && (
              <Field label="Group name">
                <input style={inputStyle} placeholder="e.g. 5th Period Courses" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
            )}

            {createMode === "new-series" && (
              <>
                <Field label="Series name">
                  <input style={inputStyle} placeholder="e.g. Chess Course Roster" value={seriesName} onChange={(e) => setSeriesName(e.target.value)} />
                </Field>
                <Field label="This year's label">
                  <input style={inputStyle} placeholder="e.g. 2026-27" value={yearLabel} onChange={(e) => setYearLabel(e.target.value)} />
                </Field>
              </>
            )}

            {createMode === "existing-series" && (
              <>
                <Field label="Series">
                  <select style={inputStyle} value={existingChainId} onChange={(e) => setExistingChainId(e.target.value)}>
                    <option value="">Select a series</option>
                    {chains?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="This year's label">
                  <input style={inputStyle} placeholder="e.g. 2026-27" value={yearLabel} onChange={(e) => setYearLabel(e.target.value)} />
                </Field>
              </>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <Btn
                onClick={createMode === "standalone" ? createStandalone : createMode === "new-series" ? createSeriesAndGroup : addToExistingSeries}
                disabled={
                  busy ||
                  (createMode === "standalone" && !newName.trim()) ||
                  (createMode === "new-series" && (!seriesName.trim() || !yearLabel.trim())) ||
                  (createMode === "existing-series" && (!existingChainId || !yearLabel.trim()))
                }
              >
                {busy ? "Creating…" : "Create"}
              </Btn>
              <Btn tone="ghost" onClick={resetCreate}>
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </div>

      {dropInfo && (
        <div
          onClick={cancelDrop}
          style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 340, maxWidth: "100%" }}>
            {dropInfo.mode === "new-series" ? (
              <>
                <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase" }}>Form a series</div>
                <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 10px" }}>
                  Link "{allGroups[dropInfo.codes[0]]?.name}" and "{allGroups[dropInfo.codes[1]]?.name}"
                </h3>
                <p style={{ fontSize: 12.5, color: inkSoft, marginTop: -4, marginBottom: 12 }}>
                  They'll be ordered automatically by when each was created, so history carries forward correctly.
                </p>
                <Field label="Series name">
                  <input
                    style={inputStyle}
                    autoFocus
                    placeholder="e.g. 5th Period Courses"
                    value={seriesNameForDrop}
                    onChange={(e) => setSeriesNameForDrop(e.target.value)}
                  />
                </Field>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <Btn onClick={confirmNewSeries} disabled={dropBusy || !seriesNameForDrop.trim()}>
                    {dropBusy ? "Linking…" : "Create series"}
                  </Btn>
                  <Btn tone="ghost" onClick={cancelDrop}>
                    Cancel
                  </Btn>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase" }}>Add to series</div>
                <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 10px" }}>
                  Add "{allGroups[dropInfo.sourceCode]?.name}" to "{dropInfo.chainName}"?
                </h3>
                <p style={{ fontSize: 12.5, color: inkSoft, marginTop: -4, marginBottom: 14 }}>
                  It'll slot into the series based on when it was created, and start carrying priority history from the rest of the series.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={confirmAddExisting} disabled={dropBusy}>
                    {dropBusy ? "Adding…" : "Add to series"}
                  </Btn>
                  <Btn tone="ghost" onClick={cancelDrop}>
                    Cancel
                  </Btn>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- TEACHER GROUP EDITOR ----------------
function FolderTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: sans,
        background: active ? paper : "#E7ECF4",
        color: active ? ink : inkSoft,
        border: `1px solid ${line}`,
        borderBottom: active ? `1px solid ${paper}` : `1px solid ${line}`,
        borderRadius: "10px 10px 0 0",
        padding: "10px 18px",
        marginBottom: -1,
        fontSize: 14,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        gap: 7,
        cursor: "pointer",
        position: "relative",
        top: active ? 0 : 2,
      }}
    >
      <Icon size={15} strokeWidth={2} />
      {label}
    </button>
  );
}

function GroupEditor({ code, onOpenGrid }) {
  const [group, setGroup] = useState(null);
  const [chain, setChain] = useState(null);
  const [tab, setTab] = useState("courses");
  const [courses, setCourses] = useState([]);
  const [extraQuestions, setExtraQuestions] = useState([]);
  const [savingQuestions, setSavingQuestions] = useState(false);
  const [expandedStudent, setExpandedStudent] = useState(null); // student id currently expanded in the Students list
  const [students, setStudents] = useState([]);
  const [result, setResult] = useState(null);
  const [priority, setPriority] = useState({});
  const [loadingPriority, setLoadingPriority] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savingCourses, setSavingCourses] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [studentSort, setStudentSort] = useState("name"); // name | grade | choice1 | choice2 | choice3 | submitted
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_LOGIC_SETTINGS);
  const [dragStudent, setDragStudent] = useState(null); // { studentId, fromCourseId } — fromCourseId null = from Unassigned
  const [dragOverId, setDragOverId] = useState(null); // course id, or "unassigned", currently hovered
  const [explainFor, setExplainFor] = useState(null); // { student, courseId }
  const [showScoreBreakdown, setShowScoreBreakdown] = useState(false);

  const loadGroup = useCallback(async () => {
    let g = normalizeGroup(await storeGet(`group:${code}`, true));
    // Backward-compat: a group published before switch requests existed has no
    // publishedAt, which would silently block the request window forever. Backfill
    // it to now the first time this group is opened again.
    if (g && g.status === "published" && !g.publishedAt) {
      g = { ...g, publishedAt: Date.now() };
      await storeSet(`group:${code}`, g, true);
    }
    setGroup(g);
    setCourses(g?.courses || []);
    setExtraQuestions(g?.extraQuestions || []);
    const fixedResults = reconcileManualRanks(g?.results || null);
    setResult(fixedResults);
    if (g && fixedResults && fixedResults !== g.results) {
      // Persist the corrected badges so they don't need re-fixing on every load.
      await storeSet(`group:${code}`, { ...g, results: fixedResults }, true);
    }
    if (g?.chainId) setChain(await storeGet(`chain:${g.chainId}`, true));
    else setChain(null);
    if (g) setSettings(await loadLogicSettingsForGroup(g));
    return g;
  }, [code]);

  const loadStudents = useCallback(async () => {
    setLoadingStudents(true);
    const keys = await storeList(`submission:${code}:`, true);
    const subs = await Promise.all(keys.map((k) => storeGet(k, true)));
    setStudents(subs.filter(Boolean));
    setLoadingStudents(false);
    return subs.filter(Boolean);
  }, [code]);

  useEffect(() => {
    (async () => {
      const g = await loadGroup();
      const s = g ? await loadLogicSettingsForGroup(g) : DEFAULT_LOGIC_SETTINGS;
      setSettings(s);
      const subs = await loadStudents();
      if (g?.chainId && subs.length && s.useHistory) {
        setLoadingPriority(true);
        setPriority(await computeHistoryPriority(g, subs, s.historyMode));
        setLoadingPriority(false);
      } else {
        setPriority({});
      }
    })();
  }, [loadGroup, loadStudents]);

  // Results can change from outside this screen entirely — e.g. a teacher running
  // Smart Fit or Accommodate from the Mailbox, which writes straight to storage
  // without this already-mounted component knowing. Re-fetch every time the
  // Results tab is opened so it can never show stale data.
  useEffect(() => {
    if (tab === "results") loadGroup();
  }, [tab, loadGroup]);

  const updateSetting = async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (group) await saveLogicSettingsForGroup(group, next);
    if (group?.chainId && students.length && ("useHistory" in patch || "historyMode" in patch)) {
      if (next.useHistory) {
        setLoadingPriority(true);
        setPriority(await computeHistoryPriority(group, students, next.historyMode));
        setLoadingPriority(false);
      } else {
        setPriority({});
      }
    }
  };

  const saveCourses = async (next) => {
    setCourses(next);
    setSavingCourses(true);
    await storeSet(`group:${code}`, { ...group, courses: next, extraQuestions }, true);
    setSavingCourses(false);
  };

  const saveQuestions = async (next) => {
    setExtraQuestions(next);
    setSavingQuestions(true);
    await storeSet(`group:${code}`, { ...group, courses, extraQuestions: next }, true);
    setSavingQuestions(false);
  };
  const addQuestion = () => saveQuestions([...extraQuestions, { id: genId(), text: "", required: false }]);
  const updateQuestionLocal = (id, patch) => setExtraQuestions(extraQuestions.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const commitQuestion = () => saveQuestions(extraQuestions);
  const toggleQuestionRequired = (id) => saveQuestions(extraQuestions.map((q) => (q.id === id ? { ...q, required: !q.required } : q)));
  const removeQuestion = (id) => saveQuestions(extraQuestions.filter((q) => q.id !== id));

  const updateStatus = async (status) => {
    const updated = { ...group, courses, extraQuestions, status, publishedAt: status === "published" && !group.publishedAt ? Date.now() : group.publishedAt };
    setGroup(updated);
    await storeSet(`group:${code}`, updated, true);
  };

  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const finalizeResults = async () => {
    setFinalizing(true);
    const updated = { ...group, courses, extraQuestions, resultsFinalized: true };
    setGroup(updated);
    await storeSet(`group:${code}`, updated, true);
    // Any pending switch requests for this group can no longer be acted on — clear them.
    const reqKeys = await storeList(`request:${code}:`, true);
    await Promise.all(reqKeys.map((k) => storeDelete(k, true)));
    setFinalizing(false);
    setConfirmFinalize(false);
  };
  const addCourse = () => saveCourses([...courses, { id: genId(), name: "", target: 10 }]);
  const applyBulkCourses = () => {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    const added = lines
      .map((line) => {
        const [namePart, targetPart] = line.split(",");
        const name = (namePart || "").trim();
        const target = Math.max(1, Number((targetPart || "").trim()) || 10);
        return name ? { id: genId(), name, target } : null;
      })
      .filter(Boolean);
    if (!added.length) return;
    saveCourses([...courses, ...added]);
    setBulkText("");
    setBulkOpen(false);
  };
  const updateCourseLocal = (id, patch) => setCourses(courses.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const commitCourse = () => saveCourses(courses);
  const removeCourse = (id) => {
    if (courses.length <= 2) return;
    saveCourses(courses.filter((c) => c.id !== id));
  };

  const removeStudent = async (studentId) => {
    await storeDelete(`submission:${code}:${studentId}`, true);
    setStudents(students.filter((s) => s.id !== studentId));
  };

  // Course name a student picked as their Nth choice (idx is 0-based), for sorting
  // the Students list by choice — students without that many ranked choices sort last.
  const choiceNameAt = (s, idx) => courses.find((c) => c.id === s.prefs?.[idx])?.name || "";
  const sortStudents = (list) => {
    const sorted = [...list];
    switch (studentSort) {
      case "grade":
        sorted.sort((a, b) => (a.grade ?? 0) - (b.grade ?? 0) || a.name.localeCompare(b.name));
        break;
      case "choice1":
      case "choice2":
      case "choice3": {
        const idx = Number(studentSort.slice(-1)) - 1;
        sorted.sort((a, b) => {
          const an = choiceNameAt(a, idx);
          const bn = choiceNameAt(b, idx);
          if (!an && bn) return 1;
          if (an && !bn) return -1;
          return an.localeCompare(bn) || a.name.localeCompare(b.name);
        });
        break;
      }
      case "submitted":
        sorted.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        break;
      case "name":
      default:
        sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  };

  const canRun = courses.length >= 2 && courses.every((c) => c.name.trim()) && students.length > 0;
  const runAssignment = async () => {
    // Snapshot the Logic settings that actually produced this placement. Editing the
    // Logic tab afterward (e.g. dragging grades into a new custom order) doesn't move
    // anyone by itself — only "Run assignment" does — so scoring and explanations must
    // keep using the settings from this run, not whatever the tab shows later, or the
    // numbers stop matching the placement they're supposedly describing.
    const res = { ...assignStudents(courses, students, priority, settings), settingsSnapshot: settings };
    setResult(res);
    await storeSet(`group:${code}`, { ...group, courses, extraQuestions, results: res }, true);
    setTab("results");
  };
  // Falls back to the live settings for a result saved before this snapshot existed.
  const runSettings = result?.settingsSnapshot || settings;

  const exportCSV = () => {
    if (!result) return;
    const rows = [["Course", "Scaled Seats", "Target (entered)", "Student", "Grade", "Choice Granted", "History Priority"]];
    courses.forEach((c) => {
      const seats = result.capacity?.[c.id] ?? c.target;
      (result.assignments[c.id] || [])
        .slice()
        .sort((a, b) => b.grade - a.grade || a.name.localeCompare(b.name))
        .forEach((s) => rows.push([c.name, seats, c.target, s.name, s.grade, s.choiceRank, priority[s.id]?.[c.name] || 0]));
    });
    result.unassigned.forEach((s) =>
      rows.push(["Unassigned", "", "", s.name, s.grade, "", Math.max(0, ...Object.values(priority[s.id] || {}))])
    );
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${group?.name || "group"}-assignments.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Manual drag-to-reassign: move a student between courses (or to/from Unassigned)
  // after an assignment has already run. Marks them `manual` so it's visible it was
  // a hand override rather than a real preference match.
  const moveStudent = async (toCourseId) => {
    const drag = dragStudent;
    setDragStudent(null);
    setDragOverId(null);
    if (!drag || !result || group.resultsFinalized) return;
    const { studentId, fromCourseId } = drag;
    const nextResult = moveStudentInResults(result, studentId, fromCourseId, toCourseId);
    if (nextResult === result) return; // no-op: same course, or student not found
    setResult(nextResult);
    await storeSet(`group:${code}`, { ...group, courses, extraQuestions, results: nextResult }, true);
  };

  const rankColor = { 1: gold, 2: green, 3: clay };
  const rankSoft = { 1: goldSoft, 2: greenSoft, 3: claySoft };

  if (!group) return <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      <Header eyebrow={chain ? `Sorting group · ${chain.name} series` : "Sorting group"} title={group.name} />
      {chain && (
        <p style={{ color: inkSoft, fontSize: 12.5, marginTop: -14, marginBottom: 14 }}>
          {loadingPriority
            ? "Checking this series' past years for returning students…"
            : Object.keys(priority).length > 0
            ? `${Object.keys(priority).length} student(s) carry priority from missing their #1 choice in a prior year of this series.`
            : "No carried-over priority yet — this is either the first year, or everyone got their #1 choice last time."}
        </p>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: goldSoft,
          border: `1px solid ${line}`,
          borderRadius: 9,
          padding: "10px 14px",
          marginBottom: 18,
        }}
      >
        <div style={{ fontSize: 12.5, color: inkSoft }}>Share this code with students so they can find this group</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 18, letterSpacing: 3, color: gold }}>{code}</span>
          <IconBtn
            tone="green"
            onClick={() => {
              navigator.clipboard?.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={13} /> {copied ? "Copied" : "Copy"}
          </IconBtn>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "#fff",
          border: `1px solid ${line}`,
          borderRadius: 9,
          padding: "10px 14px",
          marginBottom: 18,
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              padding: "3px 9px",
              borderRadius: 5,
              background: group.resultsFinalized ? "#E4E9F1" : group.status === "active" ? greenSoft : group.status === "published" ? goldSoft : "#E4E9F1",
              color: group.resultsFinalized ? ink : group.status === "active" ? green : group.status === "published" ? gold : inkSoft,
            }}
          >
            {group.resultsFinalized ? "Finalized" : group.status === "active" ? "Active" : group.status === "published" ? "Results published" : "Draft"}
          </span>
          <span style={{ fontSize: 12.5, color: inkSoft }}>
            {group.resultsFinalized && "Results are locked — no further edits or requests are possible."}
            {!group.resultsFinalized && group.status === "draft" && "Students can't join or respond until this is activated."}
            {!group.resultsFinalized && group.status === "active" && "Students can join and submit responses."}
            {!group.resultsFinalized && group.status === "published" && "Survey closed — students can see their result in Active Groups."}
          </span>
        </div>
        {!group.resultsFinalized && group.status === "draft" && (
          <Btn onClick={() => updateStatus("active")}>
            <Play size={14} /> Activate Group
          </Btn>
        )}
        {!group.resultsFinalized && group.status === "active" && (
          <Btn onClick={() => updateStatus("published")} disabled={!result} tone={result ? "green" : "ghost"}>
            <Upload size={14} /> Upload Results
          </Btn>
        )}
        {!group.resultsFinalized && group.status === "published" && (
          <Btn tone="clay" onClick={() => setConfirmFinalize(true)}>
            <Lock size={14} /> Finalize Results
          </Btn>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          background: "#fff",
          border: `1px solid ${line}`,
          borderRadius: 9,
          padding: "14px 14px",
          marginBottom: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Btn tone="green" onClick={runAssignment} disabled={!canRun}>
            <Play size={15} /> Run assignment
          </Btn>
          <IconBtn title="View responses grid (read-only)" onClick={() => onOpenGrid?.(code)}>
            <LayoutGrid size={14} />
          </IconBtn>
        </div>
        <p style={{ fontSize: 11, color: inkSoft, fontFamily: mono, margin: 0, textAlign: "center", maxWidth: 380 }}>
          preference {settings.usePreference ? "on" : "off"} · grade {settings.useGrade ? `on (${gradeDirectionLabel(settings)})` : "off"} · history{" "}
          {settings.useHistory ? `on (${settings.historyMode})` : "off"}
          {settings.useGrade && settings.useHistory ? ` · ties: ${settings.order[0]} first` : ""} — edit in the Logic tab
        </p>
      </div>

      {confirmFinalize && (
        <div onClick={() => !finalizing && setConfirmFinalize(false)} style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 360, maxWidth: "100%" }}>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: clay, textTransform: "uppercase" }}>This can't be undone</div>
            <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 8px" }}>Are you sure you want to finalize these results?</h3>
            <p style={{ fontSize: 12.5, color: inkSoft, marginBottom: 14 }}>
              Finalizing permanently locks this group's results. No more manual drag adjustments will be possible, any pending switch requests for this group will be cleared without being acted on, and switch requests can no longer be submitted or accommodated. Students keep seeing their result in Active Groups, but nothing about it can change afterward.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn tone="clay" onClick={finalizeResults} disabled={finalizing}>
                {finalizing ? "Finalizing…" : "Confirm Finalize"}
              </Btn>
              <Btn tone="ghost" onClick={() => setConfirmFinalize(false)} disabled={finalizing}>
                Decline - Go Back
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${line}` }}>
        <FolderTab active={tab === "courses"} onClick={() => setTab("courses")} icon={ClipboardList} label="Courses" />
        <FolderTab active={tab === "students"} onClick={() => setTab("students")} icon={Users} label="Students" />
        <FolderTab active={tab === "logic"} onClick={() => setTab("logic")} icon={Sliders} label="Logic" />
        <FolderTab active={tab === "results"} onClick={() => setTab("results")} icon={ListOrdered} label="Results" />
      </div>

      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22 }}>
        {tab === "courses" && (
          <div>
            {(() => {
              const nameCounts = {};
              courses.forEach((c) => {
                const n = c.name.trim().toLowerCase();
                if (n) nameCounts[n] = (nameCounts[n] || 0) + 1;
              });
              const hasDuplicates = Object.values(nameCounts).some((n) => n > 1);
              return (
                <>
                  {hasDuplicates && (
                    <p style={{ fontSize: 12.5, color: clay, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                      <AlertTriangle size={13} /> Two or more courses share the same name — this can make manual moves and results confusing to read.
                    </p>
                  )}
                  <div style={{ display: "grid", gap: 10 }}>
                    {courses.map((c) => {
                      const n = c.name.trim().toLowerCase();
                      const isDup = n && nameCounts[n] > 1;
                      return (
                        <div
                          key={c.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            background: isDup ? claySoft : "#fff",
                            border: `1px solid ${isDup ? clay + "55" : line}`,
                            borderRadius: 8,
                            padding: "10px 12px",
                          }}
                        >
                          <input
                            value={c.name}
                            onChange={(e) => updateCourseLocal(c.id, { name: e.target.value })}
                            onBlur={commitCourse}
                            placeholder="Course name"
                            style={{ flex: 1, border: "none", outline: "none", fontFamily: serif, fontSize: 16, background: "transparent", color: ink }}
                          />
                          <label style={{ fontSize: 12, color: inkSoft, fontFamily: mono }}>target</label>
                          <input
                            type="number"
                            min={1}
                            value={c.target}
                            onChange={(e) => updateCourseLocal(c.id, { target: Math.max(1, Number(e.target.value) || 1) })}
                            onBlur={commitCourse}
                            style={{ width: 60, border: `1px solid ${line}`, borderRadius: 6, padding: "5px 8px", fontFamily: mono, fontSize: 14, textAlign: "center" }}
                          />
                          <IconBtn tone="clay" onClick={() => removeCourse(c.id)} title="Remove course" disabled={courses.length <= 2}>
                            <X size={14} />
                          </IconBtn>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
            {courses.length < 2 && (
              <p style={{ fontSize: 12.5, color: clay, marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={13} /> You need at least 2 courses before students can join or an assignment can run.
              </p>
            )}
            <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
              <IconBtn onClick={addCourse} tone="green">
                <Plus size={14} /> Add course
              </IconBtn>
              <IconBtn onClick={() => setBulkOpen((o) => !o)}>
                <Upload size={14} /> Bulk add
              </IconBtn>
              {savingCourses && <span style={{ fontSize: 12, color: inkSoft }}>Saving…</span>}
            </div>
            {bulkOpen && (
              <div style={{ marginTop: 12, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: 14 }}>
                <p style={{ fontSize: 12.5, color: inkSoft, margin: "0 0 8px" }}>
                  One course per line: <code style={{ fontFamily: mono }}>Name, Target</code> — target is optional and defaults to 10.
                </p>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={`Robotics, 12\nArt Studio, 15\nDebate`}
                  rows={4}
                  style={{ width: "100%", fontFamily: mono, fontSize: 12.5, border: `1px solid ${line}`, borderRadius: 6, padding: 8, resize: "vertical", boxSizing: "border-box" }}
                />
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <Btn onClick={applyBulkCourses} disabled={!bulkText.trim()}>
                    Add courses
                  </Btn>
                  <Btn tone="ghost" onClick={() => setBulkOpen(false)}>
                    Cancel
                  </Btn>
                </div>
              </div>
            )}

            <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${line}` }}>
              <div style={{ fontFamily: serif, fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Extra survey questions</div>
              <p style={{ fontSize: 12.5, color: inkSoft, marginBottom: 12 }}>
                Free-response questions shown to students under their course choices when they join. They don't affect placement. Mark one required to block submission until it's answered.
              </p>
              <div style={{ display: "grid", gap: 10 }}>
                {extraQuestions.map((q, i) => (
                  <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "10px 12px" }}>
                    <span style={{ fontFamily: mono, fontSize: 12, color: inkSoft }}>{i + 1}</span>
                    <input
                      value={q.text}
                      onChange={(e) => updateQuestionLocal(q.id, { text: e.target.value })}
                      onBlur={commitQuestion}
                      placeholder="Question for students"
                      style={{ flex: 1, border: "none", outline: "none", fontFamily: sans, fontSize: 13.5, background: "transparent", color: ink }}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: inkSoft, whiteSpace: "nowrap", cursor: "pointer" }}>
                      <input type="checkbox" checked={!!q.required} onChange={() => toggleQuestionRequired(q.id)} style={{ width: 14, height: 14, cursor: "pointer" }} />
                      Required
                    </label>
                    <IconBtn tone="clay" onClick={() => removeQuestion(q.id)} title="Remove question">
                      <X size={14} />
                    </IconBtn>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
                <IconBtn onClick={addQuestion} tone="green">
                  <Plus size={14} /> Add question
                </IconBtn>
                {savingQuestions && <span style={{ fontSize: 12, color: inkSoft }}>Saving…</span>}
              </div>
            </div>
          </div>
        )}

        {tab === "students" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10 }}>
              <p style={{ fontSize: 12.5, color: inkSoft, margin: 0 }}>
                Students submit their own choices from the join screen. This list refreshes from their responses.
              </p>
              <IconBtn onClick={loadStudents} tone="green">
                <RefreshCw size={13} /> {loadingStudents ? "Loading…" : "Refresh"}
              </IconBtn>
            </div>
            {students.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: inkSoft }} />
                  <input
                    value={studentSearch}
                    onChange={(e) => setStudentSearch(e.target.value)}
                    placeholder="Search students by name or email…"
                    style={{ ...inputStyle, paddingLeft: 30, fontSize: 13 }}
                  />
                </div>
                <select value={studentSort} onChange={(e) => setStudentSort(e.target.value)} style={{ ...inputStyle, width: "auto", fontSize: 13 }}>
                  <option value="name">Sort: Name (A–Z)</option>
                  <option value="grade">Sort: Grade</option>
                  <option value="choice1">Sort: 1st choice</option>
                  <option value="choice2">Sort: 2nd choice</option>
                  <option value="choice3">Sort: 3rd choice</option>
                  <option value="submitted">Sort: Submission order</option>
                </select>
              </div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {sortStudents(
                students.filter((s) => {
                  const q = studentSearch.trim().toLowerCase();
                  return !q || s.name.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q);
                })
              )
                .map((s) => {
                  const expanded = expandedStudent === s.id;
                  return (
                    <div key={s.id} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13.5 }}>
                      <div
                        onClick={() => setExpandedStudent(expanded ? null : s.id)}
                        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
                      >
                        <ChevronRight
                          size={13}
                          style={{ color: inkSoft, flexShrink: 0, transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "none" }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontWeight: 600 }}>{s.name}</span>
                          {s.email && (
                            <span style={{ display: "block", fontSize: 11.5, color: inkSoft, fontFamily: mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {s.email}
                            </span>
                          )}
                        </span>
                        <PriorityBadge scores={priority[s.id]} />
                        <span style={{ fontFamily: mono, color: inkSoft, fontSize: 12 }}>Grade {s.grade}</span>
                        <span style={{ fontSize: 11.5, color: inkSoft, fontFamily: mono }}>
                          {s.prefs.map((p, i) => courses.find((c) => c.id === p)?.name || "—").join("  →  ")}
                        </span>
                        <IconBtn
                          tone="clay"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeStudent(s.id);
                          }}
                          title="Remove response"
                        >
                          <X size={13} />
                        </IconBtn>
                      </div>
                      {expanded && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${line}`, display: "grid", gap: 8 }}>
                          <div style={{ fontSize: 12.5 }}>
                            <strong>Grade:</strong> {s.grade}
                          </div>
                          <div style={{ fontSize: 12.5 }}>
                            <strong>Ranked choices:</strong>
                            <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                              {s.prefs.map((p, i) => (
                                <li key={i}>{courses.find((c) => c.id === p)?.name || "(removed course)"}</li>
                              ))}
                            </ol>
                          </div>
                          {extraQuestions.length > 0 && (
                            <div style={{ fontSize: 12.5 }}>
                              <strong>Extra questions:</strong>
                              <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
                                {extraQuestions.map((q) => (
                                  <div key={q.id}>
                                    <span style={{ color: inkSoft }}>{q.text || "(untitled question)"}:</span>{" "}
                                    {s.extraAnswers?.[q.id] ? s.extraAnswers[q.id] : <em style={{ color: inkSoft }}>No answer</em>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              {students.length === 0 && <p style={{ color: inkSoft, fontSize: 13 }}>No responses yet.</p>}
              {students.length > 0 &&
                studentSearch.trim() &&
                !students.some((s) => {
                  const q = studentSearch.trim().toLowerCase();
                  return s.name.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q);
                }) && <p style={{ color: inkSoft, fontSize: 13 }}>No students match "{studentSearch}".</p>}
            </div>
          </div>
        )}

        {tab === "logic" && (
          <div>
            <p style={{ fontSize: 12.5, color: inkSoft, marginTop: -4, marginBottom: 14 }}>
              {chain
                ? `Shared by every group in the "${chain.name}" series — changing this here updates it everywhere in the series.`
                : "Applies to this group only. Link it into a series from the dashboard to share settings across years."}
            </p>

            <Toggle
              label="Preference order"
              description="Fill courses using students' ranked choices. Off = ignore rankings and place students into any open course."
              checked={settings.usePreference}
              onChange={(v) => updateSetting({ usePreference: v })}
            />

            <Toggle
              label="Grade priority"
              description="When a course has more applicants than seats, one grade level gets priority."
              checked={settings.useGrade}
              onChange={(v) => updateSetting({ useGrade: v })}
            />
            {settings.useGrade && (
              <div style={{ display: "flex", gap: 8, padding: "0 0 12px 0" }}>
                {[
                  { key: "higher", label: "Higher grade first" },
                  { key: "lower", label: "Lower grade first" },
                  { key: "custom", label: "Custom ordering" },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => updateSetting({ gradeDirection: opt.key })}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      borderRadius: 7,
                      border: `1px solid ${settings.gradeDirection === opt.key ? green : line}`,
                      background: settings.gradeDirection === opt.key ? greenSoft : "#fff",
                      color: settings.gradeDirection === opt.key ? green : inkSoft,
                      fontWeight: 700,
                      fontSize: 12.5,
                      fontFamily: sans,
                      cursor: "pointer",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            {settings.useGrade && settings.gradeDirection === "custom" && (
              <CustomGradeOrder
                grades={[...new Set(students.map((s) => s.grade))].sort((a, b) => a - b)}
                tiers={settings.customGradeOrder}
                onChange={(next) => updateSetting({ customGradeOrder: next })}
              />
            )}

            <Toggle
              label="Success score check"
              description="Scores each result by how well students' preferences were matched, weighted so a higher grade's #1 choice is worth more. Turn on one of the two settings below to actually optimize for it — on its own this only measures the score."
              checked={settings.useSuccessScore}
              onChange={(v) => updateSetting({ useSuccessScore: v })}
            />
            {settings.useSuccessScore && (
              <div style={{ paddingLeft: 14 }}>
                <Toggle
                  label="Prioritize quantity"
                  description="Maximizes the total score without changing any course's headcount — only decides who fills each seat."
                  checked={settings.successPrioritizeQuantity}
                  onChange={(v) => updateSetting({ successPrioritizeQuantity: v })}
                />
                <Toggle
                  label="Avoid lows"
                  description="Maximizes the score, but only among assignments where every student lands in one of their top 3 choices (headcounts may shift to make that possible)."
                  checked={settings.successAvoidLows}
                  onChange={(v) => updateSetting({ successAvoidLows: v })}
                />
              </div>
            )}

            <Toggle
              label="Previous results priority"
              description="In a series, past outcomes give students priority this time."
              checked={settings.useHistory}
              onChange={(v) => updateSetting({ useHistory: v })}
              disabled={!chain}
            />
            {settings.useHistory && chain && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 0 12px 0" }}>
                {[
                  { key: "boost", label: "Boost generally", desc: "Missing #1 choice in past years gives priority for whatever they rank this year." },
                  { key: "sameCourse", label: "Same course as before", desc: "Priority for the specific course they were placed in previously, if they rank it again." },
                  { key: "differentCourse", label: "A course they missed before", desc: "Priority for a specific course they ranked before but didn't get, if they rank it again." },
                  {
                    key: "smartWeight",
                    label: "Smart Weight Analysis",
                    desc: "Adds up how far from their top choice they've landed across every past year in this series (1st = 1, 2nd = 4, 3rd = 6, unranked = 10) — highest total gets priority this year.",
                  },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => updateSetting({ historyMode: opt.key })}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 7,
                      border: `1px solid ${settings.historyMode === opt.key ? green : line}`,
                      background: settings.historyMode === opt.key ? greenSoft : "#fff",
                      cursor: "pointer",
                      fontFamily: sans,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 12.5,
                        color: settings.historyMode === opt.key ? green : ink,
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      {opt.key === "smartWeight" && <Sparkles size={12} />}
                      {opt.label}
                    </div>
                    <div style={{ fontSize: 11.5, color: inkSoft, marginTop: 1 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            )}
            {settings.useHistory && !chain && (
              <p style={{ fontSize: 12, color: inkSoft, marginTop: -4, marginBottom: 12 }}>
                This toggle has no effect until the group is part of a series.
              </p>
            )}

            {settings.useGrade && settings.useHistory && chain && (
              <div style={{ paddingTop: 6, borderTop: `1px solid ${line}` }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, fontFamily: sans, margin: "12px 0 8px" }}>Tie-break order</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { key: "history-first", order: ["history", "grade"], label: "History decides ties first" },
                    { key: "grade-first", order: ["grade", "history"], label: "Grade decides ties first" },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => updateSetting({ order: opt.order })}
                      style={{
                        flex: 1,
                        padding: "7px 0",
                        borderRadius: 7,
                        border: `1px solid ${settings.order[0] === opt.order[0] ? green : line}`,
                        background: settings.order[0] === opt.order[0] ? greenSoft : "#fff",
                        color: settings.order[0] === opt.order[0] ? green : inkSoft,
                        fontWeight: 700,
                        fontSize: 12.5,
                        fontFamily: sans,
                        cursor: "pointer",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 11.5, color: inkSoft, marginTop: 6 }}>
                  Whichever is listed first decides overflow seats; the other only breaks a tie. Random chance always breaks any remaining tie.
                </p>
              </div>
            )}

            <div style={{ borderTop: `1px solid ${line}`, marginTop: 6, paddingTop: 4 }}>
              <Toggle
                label="Switch requests"
                description="After results are published, let students request a different course for a limited time."
                checked={settings.allowRequests}
                onChange={(v) => updateSetting({ allowRequests: v })}
              />
              {settings.allowRequests && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0" }}>
                  <span style={{ fontSize: 12.5, color: inkSoft }}>Window:</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.requestWindowDays}
                    onChange={(e) => updateSetting({ requestWindowDays: Math.max(1, Number(e.target.value) || 1) })}
                    style={{ width: 56, border: `1px solid ${line}`, borderRadius: 6, padding: "5px 8px", fontFamily: mono, fontSize: 13, textAlign: "center" }}
                  />
                  <span style={{ fontSize: 12.5, color: inkSoft }}>day{settings.requestWindowDays === 1 ? "" : "s"} after results are published</span>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "results" && (
          <div>
            {!result ? (
              <p style={{ color: inkSoft, fontSize: 13, textAlign: "center", padding: "20px 0" }}>No assignment has been run yet.</p>
            ) : (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 10 }}>
                  <p style={{ fontSize: 12, color: inkSoft, margin: 0 }}>
                    Targets are scaled proportionally to the {students.length} student{students.length === 1 ? "" : "s"} who responded — counts below show scaled seats vs. your entered target.
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {settings.useSuccessScore && (
                      <button
                        onClick={() => setShowScoreBreakdown(true)}
                        title={
                          !settingsEqual(runSettings, settings)
                            ? "Based on the settings from your last run, not the Logic tab's current settings — click for details"
                            : "Click for a breakdown of how many points each grade contributed"
                        }
                        style={{
                          fontFamily: mono,
                          fontSize: 12,
                          fontWeight: 700,
                          color: green,
                          background: greenSoft,
                          padding: "5px 10px",
                          borderRadius: 6,
                          whiteSpace: "nowrap",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        Success score: {computeSuccessScore(students, result.assignments, runSettings)}
                      </button>
                    )}
                    <IconBtn onClick={loadGroup}>
                      <RefreshCw size={14} /> Refresh
                    </IconBtn>
                    <IconBtn onClick={exportCSV} tone="green">
                      <Download size={14} /> Export CSV
                    </IconBtn>
                  </div>
                </div>
                {!group.resultsFinalized && (
                  <p style={{ fontSize: 12, color: inkSoft, margin: "0 0 14px", display: "flex", alignItems: "center", gap: 5 }}>
                    <GripVertical size={13} /> Drag a student onto a different course (or onto Unassigned) to move them by hand.
                  </p>
                )}
                <div style={{ display: "grid", gap: 16 }}>
                  {courses.map((c) => {
                    const list = (result.assignments[c.id] || []).slice().sort((a, b) => b.grade - a.grade || a.name.localeCompare(b.name));
                    const seats = result.capacity?.[c.id] ?? c.target;
                    const isOver = dragOverId === c.id;
                    return (
                      <div
                        key={c.id}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (dragStudent) setDragOverId(c.id);
                        }}
                        onDragLeave={() => setDragOverId((id) => (id === c.id ? null : id))}
                        onDrop={(e) => {
                          e.preventDefault();
                          moveStudent(c.id);
                        }}
                        style={{
                          border: `1px solid ${isOver ? gold : line}`,
                          borderRadius: 8,
                          overflow: "hidden",
                          background: isOver ? goldSoft : "transparent",
                          transition: "background .1s",
                        }}
                      >
                        <div style={{ background: isOver ? "transparent" : greenSoft, padding: "8px 14px", display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontFamily: serif, fontSize: 16, fontWeight: 700 }}>{c.name}</span>
                          <span style={{ fontFamily: mono, fontSize: 12, color: inkSoft }}>
                            {list.length} / {seats} <span style={{ opacity: 0.6 }}>(target {c.target})</span>
                          </span>
                        </div>
                        {list.length === 0 ? (
                          <div style={{ padding: "10px 14px", fontSize: 12.5, color: inkSoft }}>No students assigned. Drop one here to add.</div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 12.5 }}>
                            <tbody>
                              {list.map((s, i) => (
                                <tr
                                  key={s.id}
                                  draggable={!group.resultsFinalized}
                                  onDragStart={() => setDragStudent({ studentId: s.id, fromCourseId: c.id })}
                                  onDragEnd={() => {
                                    setDragStudent(null);
                                    setDragOverId(null);
                                  }}
                                  style={{ background: i % 2 ? "#fff" : "#F6F9FC", cursor: group.resultsFinalized ? "default" : "grab" }}
                                >
                                  <td style={{ padding: "6px 14px", width: "50%" }}>
                                    {!group.resultsFinalized && <GripVertical size={11} style={{ opacity: 0.4, marginRight: 4, verticalAlign: "-1px" }} />}
                                    {s.name} <PriorityBadge scores={priority[s.id]} courseName={c.name} />
                                  </td>
                                  <td style={{ padding: "6px 8px", color: inkSoft }}>Grade {s.grade}</td>
                                  <td style={{ padding: "6px 14px", textAlign: "right" }}>
                                    <span
                                      style={{
                                        background: s.choiceRank ? rankSoft[s.choiceRank] : "#E4E9F1",
                                        color: s.choiceRank ? rankColor[s.choiceRank] : inkSoft,
                                        borderRadius: 4,
                                        padding: "2px 7px",
                                        fontSize: 11,
                                        fontWeight: 700,
                                      }}
                                    >
                                      {s.choiceRank ? `choice ${s.choiceRank}` : s.manual ? "not chosen" : "assigned"}
                                    </span>
                                  </td>
                                  <td style={{ padding: "6px 10px 6px 0", textAlign: "right" }}>
                                    <button
                                      onClick={() => setExplainFor({ student: s, courseId: c.id })}
                                      title="Why did they end up here?"
                                      style={{ background: "none", border: `1px solid ${line}`, borderRadius: 6, padding: "3px 5px", cursor: "pointer", color: inkSoft, display: "inline-flex" }}
                                    >
                                      <Info size={12} />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    );
                  })}
                  {(result.unassigned.length > 0 || dragStudent) && (
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragStudent) setDragOverId("unassigned");
                      }}
                      onDragLeave={() => setDragOverId((id) => (id === "unassigned" ? null : id))}
                      onDrop={(e) => {
                        e.preventDefault();
                        moveStudent(null);
                      }}
                      style={{
                        border: `1px solid ${dragOverId === "unassigned" ? gold : `${clay}55`}`,
                        borderRadius: 8,
                        overflow: "hidden",
                        background: dragOverId === "unassigned" ? goldSoft : "transparent",
                      }}
                    >
                      <div style={{ background: dragOverId === "unassigned" ? "transparent" : claySoft, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}>
                        <AlertTriangle size={14} color={clay} />
                        <span style={{ fontFamily: serif, fontSize: 16, fontWeight: 700, color: clay }}>Unassigned ({result.unassigned.length})</span>
                      </div>
                      {result.unassigned.length === 0 ? (
                        <div style={{ padding: "10px 14px", fontSize: 12.5, color: inkSoft }}>Drop a student here to unassign them.</div>
                      ) : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 12.5 }}>
                          <tbody>
                            {result.unassigned.map((s, i) => (
                              <tr
                                key={s.id}
                                draggable={!group.resultsFinalized}
                                onDragStart={() => setDragStudent({ studentId: s.id, fromCourseId: null })}
                                onDragEnd={() => {
                                  setDragStudent(null);
                                  setDragOverId(null);
                                }}
                                style={{ background: i % 2 ? "#fff" : "#F6F9FC", cursor: group.resultsFinalized ? "default" : "grab" }}
                              >
                                <td style={{ padding: "6px 14px", width: "50%" }}>
                                  {!group.resultsFinalized && <GripVertical size={11} style={{ opacity: 0.4, marginRight: 4, verticalAlign: "-1px" }} />}
                                  {s.name} <PriorityBadge scores={priority[s.id]} />
                                </td>
                                <td style={{ padding: "6px 8px", color: inkSoft }}>Grade {s.grade}</td>
                                <td style={{ padding: "6px 14px", textAlign: "right", color: inkSoft }}>
                                  {s.manual ? "manually unassigned" : "no room in any of their choices"}
                                </td>
                                <td style={{ padding: "6px 10px 6px 0", textAlign: "right" }}>
                                  <button
                                    onClick={() => setExplainFor({ student: s, courseId: null })}
                                    title="Why did they end up unassigned?"
                                    style={{ background: "none", border: `1px solid ${line}`, borderRadius: 6, padding: "3px 5px", cursor: "pointer", color: inkSoft, display: "inline-flex" }}
                                  >
                                    <Info size={12} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {explainFor && (
        <div
          onClick={() => setExplainFor(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
        >
          {(() => {
            const info = explainPlacement({
              student: explainFor.student,
              courseId: explainFor.courseId,
              courses,
              allStudents: students,
              priority,
              settings: runSettings,
              capacity: result?.capacity || {},
            });
            const s = explainFor.student;
            return (
              <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 380, maxWidth: "100%" }}>
                <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase" }}>How this result happened</div>
                <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 14px" }}>
                  {s.name} → {info.course ? info.course.name : "Unassigned"}
                </h3>

                <div style={{ fontSize: 13, color: ink, lineHeight: 1.6, display: "grid", gap: 10 }}>
                  <div>
                    <strong>Ranked choices:</strong>{" "}
                    {info.rankedChoices.length === 0
                      ? "none submitted"
                      : info.rankedChoices.map((c) => `${c.rank}. ${c.name}`).join("  ·  ")}
                  </div>

                  {s.manual ? (
                    <div style={{ background: greenSoft, borderRadius: 7, padding: "8px 10px" }}>
                      A teacher manually {info.course ? "moved them here" : "removed them from their assignment"}.{" "}
                      {info.course
                        ? info.matchedRank
                          ? `This happens to be their choice ${info.matchedRank}.`
                          : "This wasn't one of their ranked choices."
                        : ""}
                    </div>
                  ) : !info.course ? (
                    <div>No open seats were found for them anywhere during backfill after all rounds ran.</div>
                  ) : runSettings.usePreference === false ? (
                    <div>
                      Preference order was turned off for this run, so students were pooled and placed into whichever
                      open course needed students most — this course wasn't necessarily one of their choices.
                    </div>
                  ) : info.matchedRank ? (
                    <div>
                      They ranked this course as <strong>choice {info.matchedRank}</strong>
                      {info.demand ? (
                        <>
                          , which {info.demand.countAtRank} student{info.demand.countAtRank === 1 ? "" : "s"} in total ranked at that same
                          position, competing for {info.demand.seats} scaled seat{info.demand.seats === 1 ? "" : "s"}.
                        </>
                      ) : (
                        "."
                      )}
                    </div>
                  ) : (
                    <div>None of their ranked choices had room left, so they were backfilled into the course furthest below its scaled target.</div>
                  )}

                  {!s.manual && (
                    <div style={{ borderTop: `1px solid ${line}`, paddingTop: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Tie-break logic active this run</div>
                      <div style={{ color: inkSoft, fontSize: 12.5 }}>
                        Grade priority: {runSettings.useGrade ? `on (${gradeDirectionLabel(runSettings)})` : "off"} — this student is grade {s.grade}
                        <br />
                        History priority: {runSettings.useHistory ? `on (${runSettings.historyMode})` : "off"}
                        {runSettings.useHistory && info.course ? ` — worth +${info.historyScore} for this course` : ""}
                        {runSettings.useGrade && runSettings.useHistory && <><br />Order: {runSettings.order[0]} decided ties before {runSettings.order[1]}</>}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 16 }}>
                  <Btn tone="ghost" onClick={() => setExplainFor(null)}>
                    Close
                  </Btn>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {showScoreBreakdown && result && (
        <div
          onClick={() => setShowScoreBreakdown(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
        >
          {(() => {
            const breakdown = computeSuccessScoreBreakdown(students, result.assignments, runSettings);
            const total = breakdown.reduce((sum, b) => sum + b.points, 0);
            const stale = !settingsEqual(runSettings, settings);
            return (
              <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 380, maxWidth: "100%" }}>
                <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: inkSoft, textTransform: "uppercase" }}>Success score breakdown</div>
                <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 14px" }}>Total: {total} point{total === 1 ? "" : "s"}</h3>
                {stale && (
                  <p style={{ fontSize: 11.5, color: gold, background: goldSoft, borderRadius: 7, padding: "8px 10px", margin: "0 0 12px" }}>
                    The Logic tab has changed since this was run — this reflects the grade priority, preference, and history settings active
                    when you last clicked "Run assignment," not what's shown there now. Run it again to apply the new settings.
                  </p>
                )}
                <div style={{ display: "grid", gap: 6 }}>
                  {breakdown.map((b) => (
                    <div
                      key={b.grade}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 7,
                        background: greenSoft,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700 }}>Grade {b.grade}</span>
                      <span style={{ fontSize: 11.5, color: inkSoft }}>
                        {b.students} student{b.students === 1 ? "" : "s"}
                      </span>
                      <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: green, whiteSpace: "nowrap" }}>
                        {b.points} pt{b.points === 1 ? "" : "s"}
                        {total > 0 ? ` (${Math.round((b.points / total) * 100)}%)` : ""}
                      </span>
                    </div>
                  ))}
                  {breakdown.length === 0 && <p style={{ fontSize: 12.5, color: inkSoft, margin: 0 }}>No scored placements yet.</p>}
                </div>
                <div style={{ marginTop: 16 }}>
                  <Btn tone="ghost" onClick={() => setShowScoreBreakdown(false)}>
                    Close
                  </Btn>
                </div>
              </div>
            );
          })()}
        </div>
      )}

    </div>
  );
}

// ---------------- STUDENT HOME ----------------
// Lightweight, read-only count of published results this student hasn't seen yet —
// used for the notification dot, kept separate from ActiveGroupsList's own load so
// opening the tab (which marks things seen) is what clears it, not just visiting home.
async function countNewResults(user) {
  const codes = (await storeGet(`student-groups:${safeKey(user.email)}`, true)) || [];
  const groups = (await Promise.all(codes.map((c) => storeGet(`group:${c}`, true).then(normalizeGroup)))).filter(Boolean);
  const flags = await Promise.all(
    groups.map(async (g) => {
      if (g.status !== "published") return false;
      const seen = await storeGet(`seen-result:${g.code}:${safeKey(user.email)}`, true);
      return !seen;
    })
  );
  return flags.filter(Boolean).length;
}

function StudentHome({ user, onJoined, showTutorial, onTutorialDone }) {
  const [subTab, setSubTab] = useState("join");
  const [newResultCount, setNewResultCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);

  const refreshNewResults = useCallback(async () => {
    setNewResultCount(await countNewResults(user));
  }, [user.email]);

  const refreshUnreadMessages = useCallback(async () => {
    setUnreadMessages(await countUnreadFromAdmin(user.email));
  }, [user.email]);

  useEffect(() => {
    refreshNewResults();
    refreshUnreadMessages();
  }, [refreshNewResults, refreshUnreadMessages]);

  return (
    <div>
      {showTutorial && <Tutorial steps={STUDENT_TUTORIAL_STEPS} onDone={onTutorialDone} />}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${line}`, maxWidth: 420, margin: "0 auto" }}>
        <FolderTab active={subTab === "join"} onClick={() => setSubTab("join")} icon={KeyRound} label="Join" />
        <FolderTab
          active={subTab === "active"}
          onClick={() => setSubTab("active")}
          icon={ListOrdered}
          label={
            <span style={{ position: "relative" }}>
              Active Groups
              <TabBadge count={newResultCount} />
            </span>
          }
        />
        <FolderTab
          active={subTab === "contact"}
          onClick={() => setSubTab("contact")}
          icon={MessageCircle}
          label={
            <span style={{ position: "relative" }}>
              Contact Admin
              <TabBadge count={unreadMessages} />
            </span>
          }
        />
      </div>
      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22, maxWidth: 420, margin: "0 auto" }}>
        {subTab === "join" && <StudentJoin onJoined={onJoined} />}
        {subTab === "active" && <ActiveGroupsList user={user} onEditGroup={onJoined} onViewed={refreshNewResults} />}
        {subTab === "contact" && <ContactAdmin user={user} onViewed={refreshUnreadMessages} />}
      </div>
    </div>
  );
}

// For every other course in the group, estimates how likely a student currently
// placed there would be to switch into `targetCourseId` — based on how each of
// them ranked their current course and the target course on their own submission
// (not the possibly teacher-edited `choiceRank` on the result, so a manual
// placement outside their ranked choices correctly falls into the "not a choice"
// bucket below). Ranks that can't occur together (e.g. current = choice 1) fall
// back to 0% since there's no rule for them.
function switchInProbability(prefs, currentCourseId, targetCourseId) {
  const rankOf = (courseId) => {
    const idx = (prefs || []).indexOf(courseId);
    return idx === -1 ? null : idx + 1;
  };
  const rankCurrent = rankOf(currentCourseId);
  const rankTarget = rankOf(targetCourseId);
  if (rankCurrent === 1) return 0;
  if (rankCurrent === 2) return rankTarget === 1 ? 10 : rankTarget === 3 ? 1 : 0;
  if (rankCurrent === 3) return rankTarget === 1 ? 10 : rankTarget === 2 ? 5 : 0;
  // Current course wasn't one of their ranked choices at all (backfilled).
  return rankTarget === 1 ? 50 : rankTarget === 2 ? 5 : rankTarget === 3 ? 1 : 0;
}

// Averages switchInProbability across everyone currently placed in each other
// course, giving one "chance someone switches here" percentage per club.
async function computeSwitchLikelihood(g, targetCourseId) {
  const keys = await storeList(`submission:${g.code}:`, true);
  const subs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
  const subsById = {};
  subs.forEach((s) => {
    subsById[s.id] = s;
  });
  const assignments = g.results?.assignments || {};
  return (g.courses || [])
    .filter((c) => c.id !== targetCourseId)
    .map((c) => {
      const students = assignments[c.id] || [];
      const probs = students.map((s) => switchInProbability(subsById[s.id]?.prefs, c.id, targetCourseId));
      const percent = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
      return { courseId: c.id, courseName: c.name, count: students.length, percent };
    });
}

function ActiveGroupsList({ user, onEditGroup, onViewed }) {
  const [entries, setEntries] = useState(null);
  const [openRequestFor, setOpenRequestFor] = useState(null); // group code currently showing the request form
  const [requestTarget, setRequestTarget] = useState("");
  const [switchStats, setSwitchStats] = useState({}); // group code -> per-club switch-likelihood rows
  const [statsLoading, setStatsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(null); // group code pending withdraw confirmation

  const load = useCallback(async () => {
    const codes = (await storeGet(`student-groups:${safeKey(user.email)}`, true)) || [];
    const groups = (await Promise.all(codes.map((c) => storeGet(`group:${c}`, true).then(normalizeGroup)))).filter(Boolean);
    const loaded = await Promise.all(
      groups.map(async (g0) => {
        let g = g0;
        // Backward-compat: a group published before switch requests existed has no
        // publishedAt, which would silently block the request window forever. Backfill
        // it to now the first time anyone (teacher or student) loads it again.
        if (g.status === "published" && !g.publishedAt) {
          g = { ...g, publishedAt: Date.now() };
          await storeSet(`group:${g.code}`, g, true);
        }
        const settings = await loadLogicSettingsForGroup(g);
        const myReq = await storeGet(`request:${g.code}:${safeKey(user.email)}`, true);
        const mySubmission = await storeGet(`submission:${g.code}:${safeKey(user.email)}`, true);
        let isNew = false;
        if (g.status === "published") {
          const seen = await storeGet(`seen-result:${g.code}:${safeKey(user.email)}`, true);
          isNew = !seen;
        }
        return { ...g, _settings: settings, _pendingRequest: myReq, _mySubmission: mySubmission, _isNew: isNew };
      })
    );
    setEntries(loaded);
    // Mark any newly-published results as seen now that the student has looked at
    // this tab — clears the "New" badge and the notification dot on the tab itself.
    const toMark = loaded.filter((g) => g._isNew);
    if (toMark.length) {
      await Promise.all(toMark.map((g) => storeSet(`seen-result:${g.code}:${safeKey(user.email)}`, { seenAt: Date.now() }, true)));
      onViewed?.();
    }
  }, [user.email]);

  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async (g) => {
    setBusy(true);
    await storeDelete(`submission:${g.code}:${safeKey(user.email)}`, true);
    const codes = (await storeGet(`student-groups:${safeKey(user.email)}`, true)) || [];
    await storeSet(`student-groups:${safeKey(user.email)}`, codes.filter((c) => c !== g.code), true);
    setBusy(false);
    setConfirmWithdraw(null);
    load();
  };

  const myResult = (g) => {
    if (!g.results) return null;
    const myId = safeKey(user.email);
    for (const [courseId, list] of Object.entries(g.results.assignments)) {
      const found = list.find((s) => s.id === myId);
      if (found) return { courseId, courseName: (g.courses || []).find((c) => c.id === courseId)?.name || "(removed course)" };
    }
    if (g.results.unassigned?.some((s) => s.id === myId)) return { courseId: null, courseName: null };
    return null;
  };

  const requestEligible = (g) => {
    if (g.status !== "published" || g.resultsFinalized || !g._settings.allowRequests) return false;
    if (!g.publishedAt) return false;
    const deadline = g.publishedAt + g._settings.requestWindowDays * 24 * 60 * 60 * 1000;
    return Date.now() <= deadline;
  };

  const submitRequest = async (g, result) => {
    if (!requestTarget) return;
    setBusy(true);
    const key = `request:${g.code}:${safeKey(user.email)}`;
    await storeSet(key, { id: safeKey(user.email), name: user.name, fromCourseId: result.courseId, toCourseId: requestTarget, createdAt: Date.now() }, true);
    setBusy(false);
    setOpenRequestFor(null);
    setRequestTarget("");
    load();
  };

  const ineligibleReason = (g, result) => {
    if (g.status !== "published") return null;
    if (g.resultsFinalized) return "Results have been finalized — switching is closed.";
    if (!g._settings.allowRequests) return "Your teacher has switch requests turned off for this group.";
    if (!result) return null; // "no record found" text already covers this case
    if (g.publishedAt) {
      const deadline = g.publishedAt + g._settings.requestWindowDays * 24 * 60 * 60 * 1000;
      if (Date.now() > deadline) return "The request window has closed.";
    }
    return null;
  };

  return (
    <div>
      {entries === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>You haven't joined any groups yet — use the Join tab with a code from your teacher.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {entries.map((g) => {
            const result = g.status === "published" ? myResult(g) : null;
            const eligible = requestEligible(g) && result;
            const reason = !eligible && !g._pendingRequest ? ineligibleReason(g, result) : null;
            return (
              <div key={g.code} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: serif, fontSize: 16, fontWeight: 700 }}>{g.name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {g._isNew && (
                      <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "3px 7px", borderRadius: 5, background: claySoft, color: clay }}>
                        New
                      </span>
                    )}
                    <span
                      style={{
                        fontFamily: mono,
                        fontSize: 10.5,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        padding: "3px 8px",
                        borderRadius: 5,
                        background: g.status === "active" ? greenSoft : g.status === "published" ? goldSoft : "#E4E9F1",
                        color: g.status === "active" ? green : g.status === "published" ? gold : inkSoft,
                      }}
                    >
                      {g.status === "active" ? "Open" : g.status === "published" ? "Published" : "Draft"}
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 12.5, color: inkSoft, marginTop: 4 }}>
                  {g.status !== "published" && "Waiting on results — check back after your teacher publishes them."}
                  {g.status === "published" && result === null && "Results are published, but no record was found for you."}
                  {g.status === "published" && result && result.courseName && (
                    <>
                      Placed in <strong style={{ color: ink }}>{result.courseName}</strong>
                    </>
                  )}
                  {g.status === "published" && result && !result.courseName && "You were not placed in a course this round."}
                </div>

                {reason && <div style={{ marginTop: 6, fontSize: 11.5, color: inkSoft, fontStyle: "italic" }}>{reason}</div>}

                {g.status === "active" && g._mySubmission && confirmWithdraw !== g.code && (
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <Btn tone="ghost" onClick={() => onEditGroup?.(g.code)}>
                      <Pencil size={13} /> Edit response
                    </Btn>
                    <Btn tone="ghost" onClick={() => setConfirmWithdraw(g.code)}>
                      <X size={13} /> Withdraw
                    </Btn>
                  </div>
                )}

                {confirmWithdraw === g.code && (
                  <div style={{ marginTop: 8, background: claySoft, borderRadius: 7, padding: "8px 10px" }}>
                    <p style={{ fontSize: 12.5, color: clay, margin: "0 0 8px" }}>Withdraw your response from this group? You can rejoin with the code later.</p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn tone="clay" onClick={() => withdraw(g)} disabled={busy}>
                        {busy ? "Withdrawing…" : "Withdraw"}
                      </Btn>
                      <Btn tone="ghost" onClick={() => setConfirmWithdraw(null)} disabled={busy}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                )}

                {g._pendingRequest && (
                  <div style={{ marginTop: 8, fontSize: 12, color: gold, background: goldSoft, borderRadius: 6, padding: "6px 9px" }}>
                    Switch requested — waiting on your teacher.
                  </div>
                )}

                {eligible && !g._pendingRequest && openRequestFor !== g.code && (
                  <div style={{ marginTop: 8 }}>
                    <Btn
                      tone="ghost"
                      onClick={async () => {
                        setOpenRequestFor(g.code);
                        setStatsLoading(true);
                        const stats = await computeSwitchLikelihood(g, result.courseId);
                        setSwitchStats((prev) => ({ ...prev, [g.code]: stats }));
                        setStatsLoading(false);
                      }}
                    >
                      <ArrowLeftRight size={13} /> Request switch
                    </Btn>
                  </div>
                )}

                {eligible && openRequestFor === g.code && (
                  <div style={{ marginTop: 10, borderTop: `1px solid ${line}`, paddingTop: 10 }}>
                    <div style={{ fontSize: 11, fontFamily: mono, letterSpacing: 0.5, textTransform: "uppercase", color: inkSoft, marginBottom: 8 }}>
                      Chance someone switches into {result.courseName}
                    </div>
                    {statsLoading && !switchStats[g.code] ? (
                      <p style={{ color: inkSoft, fontSize: 12, margin: "0 0 10px" }}>Loading…</p>
                    ) : (
                      <div style={{ display: "grid", gap: 5, marginBottom: 10 }}>
                        {(switchStats[g.code] || []).map((row) => (
                          <div key={row.courseId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                            <span>
                              {row.courseName}
                              {row.count > 0 && <span style={{ color: inkSoft }}> ({row.count})</span>}
                            </span>
                            <span style={{ fontWeight: 700, color: ink }}>{row.percent === null ? "—" : `${row.percent.toFixed(1)}%`}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      style={{ ...inputStyle, width: "auto", flex: 1, minWidth: 140 }}
                      value={requestTarget}
                      onChange={(e) => setRequestTarget(e.target.value)}
                    >
                      <option value="">Switch to…</option>
                      {(g.courses || [])
                        .filter((c) => c.id !== result.courseId)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                    <Btn onClick={() => submitRequest(g, result)} disabled={busy || !requestTarget}>
                      {busy ? "Sending…" : "Send request"}
                    </Btn>
                    <Btn
                      tone="ghost"
                      onClick={() => {
                        setOpenRequestFor(null);
                        setRequestTarget("");
                        setSwitchStats((prev) => {
                          const next = { ...prev };
                          delete next[g.code];
                          return next;
                        });
                      }}
                      disabled={busy}
                    >
                      Cancel
                    </Btn>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------- STUDENT JOIN ----------------
function StudentJoin({ onJoined }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    const clean = code.trim().toUpperCase();
    if (!clean) return;
    setBusy(true);
    const g = normalizeGroup(await storeGet(`group:${clean}`, true));
    setBusy(false);
    if (!g) return setError("No group found with that code — check it with your teacher.");
    if (g.status === "draft") return setError("This group isn't open for responses yet — check back once your teacher activates it.");
    if (g.status === "published") return setError("This group is no longer accepting responses — check the Active Groups tab for your result.");
    if (g.courses.length < 2) return setError("This group's teacher hasn't finished setting up courses yet — check back soon.");
    onJoined(clean);
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: inkSoft, marginTop: 0, marginBottom: 16 }}>Your teacher shared a 6-character code for their sorting group.</p>
      <Field label="Group code">
        <input
          style={{ ...inputStyle, fontFamily: mono, fontSize: 18, letterSpacing: 3, textAlign: "center", textTransform: "uppercase" }}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABC123"
          maxLength={6}
        />
      </Field>
      {error && (
        <div style={{ color: clay, fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
          <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
        </div>
      )}
      <Btn onClick={submit} full disabled={busy || !code.trim()}>
        {busy ? "Checking…" : "Continue"}
      </Btn>
    </div>
  );
}

// ---------------- STUDENT SURVEY ----------------
function StudentSurvey({ code, user, onDone }) {
  const [group, setGroup] = useState(null);
  const [grade, setGrade] = useState("");
  const [prefs, setPrefs] = useState(["", "", ""]);
  const [extraAnswers, setExtraAnswers] = useState({}); // questionId -> answer text
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isEdit, setIsEdit] = useState(false);
  const [createdAt, setCreatedAt] = useState(null); // preserved across edits, for "submission order" sorting

  useEffect(() => {
    (async () => {
      const g = normalizeGroup(await storeGet(`group:${code}`, true));
      setGroup(g);
      const existing = await storeGet(`submission:${code}:${safeKey(user.email)}`, true);
      if (existing) {
        setIsEdit(true);
        setGrade(String(existing.grade));
        setPrefs([...existing.prefs, "", ""].slice(0, 3));
        setExtraAnswers(existing.extraAnswers || {});
        setCreatedAt(existing.createdAt || null);
      }
    })();
  }, [code, user.email]);

  const choiceCount = group ? Math.max(2, Math.min(3, group.courses.length)) : 3;

  const setPref = (i, v) => {
    const next = [...prefs];
    next[i] = v;
    setPrefs(next);
  };
  const setExtraAnswer = (questionId, v) => setExtraAnswers((prev) => ({ ...prev, [questionId]: v }));

  const submit = async () => {
    setError("");
    if (group.status !== "active") return setError("This group is no longer accepting responses.");
    if (!grade) return setError("Enter your grade.");
    const chosen = prefs.slice(0, choiceCount);
    if (chosen.some((p) => !p)) return setError(`Choose all ${choiceCount} courses, in order of preference.`);
    if (new Set(chosen).size < choiceCount) return setError(`Choose ${choiceCount} different courses.`);
    const missingRequired = (group.extraQuestions || []).find((q) => q.required && !(extraAnswers[q.id] || "").trim());
    if (missingRequired) return setError(`Please answer: ${missingRequired.text || "the required question"}`);
    setBusy(true);
    const key = `submission:${code}:${safeKey(user.email)}`;
    await storeSet(
      key,
      { id: safeKey(user.email), name: user.name, email: user.email, grade: Number(grade), prefs: chosen, extraAnswers, createdAt: createdAt || Date.now() },
      true
    );
    // Track which groups this student has responded to, so their "Active Groups"
    // tab can find these without scanning every group in storage.
    const indexKey = `student-groups:${safeKey(user.email)}`;
    const existing = (await storeGet(indexKey, true)) || [];
    if (!existing.includes(code)) await storeSet(indexKey, [...existing, code], true);
    setBusy(false);
    onDone();
  };

  if (!group) return <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <Header
        eyebrow={group.name}
        title={isEdit ? `Update your top ${choiceCount} courses` : `Rank your top ${choiceCount} courses`}
        sub={isEdit ? "You've already responded to this group — submitting again replaces your previous choices." : "Choice 1 is your favorite. Courses fill from choice 1 first."}
      />
      <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 10, padding: 20 }}>
        <Field label="Your grade">
          <input style={inputStyle} type="number" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="9" />
        </Field>
        {Array.from({ length: choiceCount }, (_, i) => i).map((i) => (
          <Field key={i} label={`Choice ${i + 1}`}>
            <select style={inputStyle} value={prefs[i]} onChange={(e) => setPref(i, e.target.value)}>
              <option value="">Select a course</option>
              {group.courses.map((c) => (
                <option key={c.id} value={c.id} disabled={prefs.slice(0, choiceCount).includes(c.id) && prefs[i] !== c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        ))}
        {(group.extraQuestions || []).map((q) => (
          <Field key={q.id} label={`${q.text || "Question"}${q.required ? " *" : ""}`}>
            <input
              style={inputStyle}
              value={extraAnswers[q.id] || ""}
              onChange={(e) => setExtraAnswer(q.id, e.target.value)}
              placeholder="Your answer"
            />
          </Field>
        ))}
        {error && (
          <div style={{ color: clay, fontSize: 12.5, marginBottom: 10, display: "flex", gap: 6 }}>
            <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
          </div>
        )}
        <Btn onClick={submit} full disabled={busy}>
          {busy ? "Submitting…" : isEdit ? "Update my choices" : "Submit my choices"}
        </Btn>
      </div>
    </div>
  );
}
