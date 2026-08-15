import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plus, X, Play, Download, Users, ClipboardList, ListOrdered, Upload,
  AlertTriangle, LogOut, Copy, ArrowLeft, RefreshCw, Check, KeyRound, GripVertical, ArrowLeftRight, Link2, Sliders,
  ShieldCheck, Trash2, Pencil, Info, Mail, Sparkles, Lock, CheckSquare, Search, LogIn, Compass, ChevronRight, ChevronLeft, MessageCircle, Key, Bell, GraduationCap, Eye,
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
  return { ...g, courses: g.courses || g.clubs || [], status: g.status || "active", resultsFinalized: !!g.resultsFinalized, publishedAt: g.publishedAt || null };
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

const DEFAULT_LOGIC_SETTINGS = {
  useGrade: true,
  usePreference: true,
  useHistory: true,
  gradeDirection: "higher", // "higher" | "lower"
  order: ["history", "grade"], // tie-break priority order
  historyMode: "boost", // "boost" | "sameCourse" | "differentCourse" | "smartWeight"
  allowRequests: true,
  requestWindowDays: 3,
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

function assignStudents(courses, students, priority = {}, settings = {}) {
  const {
    useGrade = true,
    usePreference = true,
    useHistory = true,
    gradeDirection = "higher", // "higher" | "lower"
    order = ["history", "grade"], // tie-break priority order
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

  const gradeValue = (s) => (gradeDirection === "lower" ? -s.grade : s.grade);
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

  if (!usePreference) {
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
    body: "If you've allowed switch requests, they collect here from every group. Accommodate or Dismiss them one at a time or in bulk, or use Smart Fit to auto-match students who each want what the other already has.",
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

// =========================================================
export default function App() {
  const [view, setView] = useState("home"); // home | about | login | signup | admin-dashboard | teacher-dashboard | teacher-group | student-home | student-survey | student-done
  const [user, setUser] = useState(null);
  const [adminUser, setAdminUser] = useState(null); // holds the real admin's record while viewing another account
  const [activeCode, setActiveCode] = useState(null);
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

  return (
    <div
      style={{
        background: paper,
        backgroundImage: `radial-gradient(${line} 1px, transparent 1px)`,
        backgroundSize: "22px 22px",
        minHeight: "100vh",
        padding: "28px 20px",
        fontFamily: sans,
        color: ink,
      }}
    >
      {(view === "home" || view === "about" || view === "teacher-home" || view === "student-home") && <LeaderLines />}
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
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
            <AdminHome onEnterAccount={enterAccount} />
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
              showTutorial={!adminUser && !user.tutorialSeen}
              onTutorialDone={markTutorialSeen}
            />
          </>
        )}

        {view === "teacher-group" && user && activeCode && (
          <>
            <TopBar user={user} onLogout={logout} onBack={() => setView("teacher-home")} onNameChange={updateUserName} onPasswordChange={updateUserPassword} onReturnToAdmin={adminUser ? returnToAdmin : undefined} />
            <GroupEditor code={activeCode} />
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
      body: "Run the assignment, then Upload Results to publish it and lock the survey. If you allow it, students get a limited window to request a different course. Every request lands in your Mailbox, where you can Accommodate or Dismiss them individually or in bulk, or let Smart Fit automatically match students who each want what the other already has — a true swap that never changes a course's headcount.",
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
        background: claySoft,
        color: clay,
        borderRadius: 4,
        padding: "2px 7px",
        fontSize: 10.5,
        fontWeight: 700,
        fontFamily: mono,
        whiteSpace: "nowrap",
      }}
      title={title}
    >
      priority +{value}
    </span>
  );
}

// ---------------- ADMIN ----------------
async function adminDeleteGroup(group) {
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
function AdminHome({ onEnterAccount }) {
  const [subTab, setSubTab] = useState("accounts");
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnread = useCallback(async () => {
    const keys = await storeList("message:", true);
    const msgs = await Promise.all(keys.map((k) => storeGet(k, true)));
    setUnreadCount(msgs.filter((m) => m && !m.readByAdmin).length);
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
              {unreadCount > 0 && (
                <span style={{ position: "absolute", top: -3, right: -9, width: 7, height: 7, borderRadius: "50%", background: clay }} />
              )}
            </span>
          }
        />
        <FolderTab active={subTab === "testing"} onClick={() => setSubTab("testing")} icon={Sparkles} label="Testing" />
      </div>
      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22 }}>
        {subTab === "accounts" && <AdminDashboard onEnterAccount={onEnterAccount} />}
        {subTab === "messages" && <AdminMessages onViewed={refreshUnread} />}
        {subTab === "testing" && <AdminTesting onEnterAccount={onEnterAccount} />}
      </div>
    </div>
  );
}

function AdminTesting({ onEnterAccount }) {
  const [testUsers, setTestUsers] = useState(null);
  const [testGroups, setTestGroups] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    const keys = await storeList("user:", true);
    const recs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
    const tUsers = recs.filter((u) => u.isTest);
    setTestUsers(tUsers);

    const testTeacherEmails = new Set(tUsers.filter((u) => u.role === "teacher").map((u) => u.email));
    const groupKeys = await storeList("group:", true);
    const groupRecs = (await Promise.all(groupKeys.map((k) => storeGet(k, true).then(normalizeGroup)))).filter(Boolean);
    setTestGroups(groupRecs.filter((g) => testTeacherEmails.has(g.teacherEmail)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createTestAccount = async (role) => {
    setBusy(true);
    const used = new Set(testUsers.filter((u) => u.role === role).map((u) => u.testLabel));
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
    await load();
    setBusy(false);
  };

  const deleteTestAccount = async (u) => {
    setBusy(true);
    await storeDelete(`user:${safeKey(u.email)}`, true);
    setConfirmDelete(null);
    await load();
    setBusy(false);
  };

  const teachers = (testUsers || []).filter((u) => u.role === "teacher");
  const students = (testUsers || []).filter((u) => u.role === "student");

  const groupsByTeacherEmail = {};
  teachers.forEach((t) => {
    groupsByTeacherEmail[t.email] = (testGroups || [])
      .filter((g) => g.teacherEmail === t.email)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((g, i) => ({ ...g, testGroupLabel: `${t.testLabel}${i + 1}` }));
  });

  return (
    <div>
      <p style={{ fontSize: 12.5, color: inkSoft, marginTop: -4, marginBottom: 16 }}>
        Instant test accounts for trying things out — no email or sign-in needed. Click "Enter" to view the app as that account. These are kept separate from real accounts and can be deleted anytime.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <Btn onClick={() => createTestAccount("teacher")} disabled={busy || testUsers === null}>
          <Plus size={14} /> New test teacher
        </Btn>
        <Btn onClick={() => createTestAccount("student")} disabled={busy || testUsers === null}>
          <Plus size={14} /> New test student
        </Btn>
      </div>

      {testUsers === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <TestAccountGroup title="Teachers" users={teachers} groupsByEmail={groupsByTeacherEmail} onEnterAccount={onEnterAccount} onDelete={setConfirmDelete} />
          <TestAccountGroup title="Students" users={students} onEnterAccount={onEnterAccount} onDelete={setConfirmDelete} />
        </>
      )}

      {confirmDelete && (
        <div
          onClick={() => !busy && setConfirmDelete(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 340, maxWidth: "100%" }}>
            <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 10px" }}>Delete {confirmDelete.name}?</h3>
            <p style={{ fontSize: 12.5, color: inkSoft, marginBottom: 14 }}>This only removes the test account — it doesn't affect any real accounts or groups.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn tone="clay" onClick={() => deleteTestAccount(confirmDelete)} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </Btn>
              <Btn tone="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
                Cancel
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TestAccountGroup({ title, users, groupsByEmail, onEnterAccount, onDelete }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontFamily: mono, letterSpacing: 1, textTransform: "uppercase", color: inkSoft, marginBottom: 8 }}>{title}</div>
      {users.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>None yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {users.map((u) => {
            const groups = groupsByEmail?.[u.email] || [];
            return (
              <div key={u.email} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
                  <span style={{ flex: 1, fontWeight: 600 }}>{u.name}</span>
                  <IconBtn tone="green" title="Enter this account" onClick={() => onEnterAccount?.(u)}>
                    <LogIn size={13} /> Enter
                  </IconBtn>
                  <IconBtn tone="clay" title="Delete test account" onClick={() => onDelete(u)}>
                    <Trash2 size={13} />
                  </IconBtn>
                </div>
                {groups.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${line}` }}>
                    {groups.map((g) => (
                      <div key={g.code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                        <span
                          style={{
                            fontFamily: mono,
                            fontSize: 10.5,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 5,
                            background: "#E4E9F1",
                            color: inkSoft,
                          }}
                        >
                          {g.testGroupLabel}
                        </span>
                        <span>{g.name}</span>
                      </div>
                    ))}
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

function AdminMessages({ onViewed }) {
  const [messages, setMessages] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);

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
    msgs.sort((a, b) => b.createdAt - a.createdAt);
    setMessages(msgs);
    const unread = msgs.filter((m) => !m.readByAdmin);
    if (unread.length) {
      await Promise.all(unread.map((m) => storeSet(m._key, { ...m, readByAdmin: true }, true)));
    }
    onViewed?.();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sendReply = async (m) => {
    const draft = (replyDrafts[m.id] || "").trim();
    if (!draft) return;
    setBusyId(m.id);
    await storeSet(m._key, { ...m, adminReply: draft, repliedAt: Date.now(), readByAdmin: true }, true);
    setBusyId(null);
    setReplyDrafts((prev) => ({ ...prev, [m.id]: "" }));
    load();
  };

  return (
    <div>
      <Header eyebrow="Admin" title="Messages" sub="Sent to admin by teachers and students. Replies show up in their Contact Admin tab." />
      {messages === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : messages.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>No messages yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {messages.map((m) => (
            <div key={m._key} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{m.fromName}</span>
                <span style={{ fontSize: 11, color: inkSoft, fontFamily: mono }}>
                  {m.fromEmail} · {m.fromRole}
                </span>
              </div>
              <p style={{ fontSize: 13.5, color: ink, margin: "0 0 10px", lineHeight: 1.5 }}>{m.body}</p>
              {m.adminReply ? (
                <div style={{ background: greenSoft, borderRadius: 7, padding: "8px 10px", fontSize: 12.5, color: green }}>
                  <strong>Your reply:</strong> {m.adminReply}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder="Write a reply…"
                    value={replyDrafts[m.id] || ""}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                  />
                  <Btn onClick={() => sendReply(m)} disabled={busyId === m.id || !(replyDrafts[m.id] || "").trim()}>
                    {busyId === m.id ? "Sending…" : "Reply"}
                  </Btn>
                </div>
              )}
            </div>
          ))}
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

    const groupKeys = await storeList("group:", true);
    const groupRecs = (await Promise.all(groupKeys.map((k) => storeGet(k, true).then(normalizeGroup)))).filter(Boolean);
    setGroups(groupRecs);
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
      if (g) await adminDeleteGroup(g);
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
function ContactAdmin({ user }) {
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const keys = await storeList(`message:${safeKey(user.email)}:`, true);
    const msgs = (await Promise.all(keys.map((k) => storeGet(k, true)))).filter(Boolean);
    msgs.sort((a, b) => b.createdAt - a.createdAt);
    setMessages(msgs);
  }, [user.email]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    const id = genId();
    const key = `message:${safeKey(user.email)}:${id}`;
    await storeSet(
      key,
      { id, fromEmail: user.email, fromName: user.name, fromRole: user.role, body, createdAt: Date.now(), adminReply: null, repliedAt: null, readByAdmin: false },
      true
    );
    setBusy(false);
    setDraft("");
    load();
  };

  return (
    <div>
      <Header eyebrow="Support" title="Message admin" sub="Send a note straight to the site admin — replies show up here." />
      <div style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What's going on?"
          rows={3}
          style={{ ...inputStyle, minHeight: 72, resize: "vertical" }}
        />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={send} disabled={busy || !draft.trim()}>
            {busy ? "Sending…" : "Send message"}
          </Btn>
        </div>
      </div>
      {messages === null ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>Loading…</p>
      ) : messages.length === 0 ? (
        <p style={{ color: inkSoft, fontSize: 13 }}>No messages yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {messages.map((m) => (
            <div key={m.id} style={{ background: "#fff", border: `1px solid ${line}`, borderRadius: 9, padding: "10px 14px" }}>
              <p style={{ fontSize: 13, color: ink, margin: "0 0 8px", lineHeight: 1.5 }}>{m.body}</p>
              {m.adminReply ? (
                <div style={{ background: greenSoft, borderRadius: 6, padding: "7px 9px", fontSize: 12.5, color: green }}>
                  <strong>Admin:</strong> {m.adminReply}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: inkSoft, fontStyle: "italic" }}>Waiting on a reply…</div>
              )}
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

function TeacherHome({ user, onOpenGroup, showTutorial, onTutorialDone }) {
  const [subTab, setSubTab] = useState("groups");
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPending = useCallback(async () => {
    const codes = await collectTeacherGroupCodes(user);
    const counts = await Promise.all(codes.map((code) => storeList(`request:${code}:`, true).then((keys) => keys.length)));
    setPendingCount(counts.reduce((a, b) => a + b, 0));
  }, [user.email]);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

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
              {pendingCount > 0 && (
                <span style={{ position: "absolute", top: -3, right: -9, width: 7, height: 7, borderRadius: "50%", background: clay }} />
              )}
            </span>
          }
        />
        <FolderTab active={subTab === "contact"} onClick={() => setSubTab("contact")} icon={MessageCircle} label="Contact Admin" />
      </div>
      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22 }}>
        {subTab === "groups" && <TeacherDashboard user={user} onOpenGroup={onOpenGroup} />}
        {subTab === "mailbox" && <Mailbox user={user} onResolved={refreshPending} />}
        {subTab === "contact" && <ContactAdmin user={user} />}
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
    let swapCount = 0;
    const resolvedKeys = [];
    for (const [code, reqs] of Object.entries(byCode)) {
      const g = normalizeGroup(await storeGet(`group:${code}`, true));
      if (!g || !g.results) continue;
      let results = g.results;
      const used = new Set();
      let touched = false;
      for (let i = 0; i < reqs.length; i++) {
        const a = reqs[i];
        if (used.has(a.key)) continue;
        for (let j = i + 1; j < reqs.length; j++) {
          const b = reqs[j];
          if (used.has(b.key)) continue;
          const aCurrent = findCurrentCourseId(results, a.studentId);
          const bCurrent = findCurrentCourseId(results, b.studentId);
          if (aCurrent === undefined || bCurrent === undefined || aCurrent === bCurrent) continue;
          if (a.toCourseId === bCurrent && b.toCourseId === aCurrent) {
            results = moveStudentInResults(results, a.studentId, aCurrent, b.toCourseId);
            results = moveStudentInResults(results, b.studentId, bCurrent, a.toCourseId);
            used.add(a.key);
            used.add(b.key);
            resolvedKeys.push(a.key, b.key);
            swapCount++;
            touched = true;
            break;
          }
        }
      }
      if (touched) await storeSet(`group:${code}`, { ...g, results }, true);
    }
    await Promise.all(resolvedKeys.map((k) => storeDelete(k, true)));
    await finishUp(swapCount > 0 ? `Smart Fit matched ${swapCount} swap${swapCount === 1 ? "" : "s"}.` : "No reciprocal swaps were found among pending requests.");
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

function TeacherDashboard({ user, onOpenGroup }) {
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
    const byCode = {};
    groupObjs.filter(Boolean).forEach((g) => (byCode[g.code] = g));
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
                      <div style={{ fontFamily: serif, fontSize: 16, fontWeight: 700 }}>{g.name}</div>
                      <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>
                        {g.courses.length} courses · {g.studentCount} responses {i === chain.groups.length - 1 && "· most recent"}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                      <div style={{ fontFamily: serif, fontSize: 17, fontWeight: 700 }}>{g.name}</div>
                      <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>
                        {g.courses.length} courses · {g.studentCount} responses
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

function GroupEditor({ code }) {
  const [group, setGroup] = useState(null);
  const [chain, setChain] = useState(null);
  const [tab, setTab] = useState("courses");
  const [courses, setCourses] = useState([]);
  const [students, setStudents] = useState([]);
  const [result, setResult] = useState(null);
  const [priority, setPriority] = useState({});
  const [loadingPriority, setLoadingPriority] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savingCourses, setSavingCourses] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_LOGIC_SETTINGS);
  const [dragStudent, setDragStudent] = useState(null); // { studentId, fromCourseId } — fromCourseId null = from Unassigned
  const [dragOverId, setDragOverId] = useState(null); // course id, or "unassigned", currently hovered
  const [explainFor, setExplainFor] = useState(null); // { student, courseId }

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
    await storeSet(`group:${code}`, { ...group, courses: next }, true);
    setSavingCourses(false);
  };

  const updateStatus = async (status) => {
    const updated = { ...group, courses, status, publishedAt: status === "published" && !group.publishedAt ? Date.now() : group.publishedAt };
    setGroup(updated);
    await storeSet(`group:${code}`, updated, true);
  };

  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const finalizeResults = async () => {
    setFinalizing(true);
    const updated = { ...group, courses, resultsFinalized: true };
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

  const canRun = courses.length >= 2 && courses.every((c) => c.name.trim()) && students.length > 0;
  const runAssignment = async () => {
    const res = assignStudents(courses, students, priority, settings);
    setResult(res);
    await storeSet(`group:${code}`, { ...group, courses, results: res }, true);
    setTab("results");
  };

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
    await storeSet(`group:${code}`, { ...group, courses, results: nextResult }, true);
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

      {confirmFinalize && (
        <div onClick={() => !finalizing && setConfirmFinalize(false)} style={{ position: "fixed", inset: 0, background: "rgba(19,34,56,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: paper, border: `1px solid ${line}`, borderRadius: 10, padding: 20, width: 360, maxWidth: "100%" }}>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: 1.5, color: clay, textTransform: "uppercase" }}>This can't be undone</div>
            <h3 style={{ fontFamily: serif, fontSize: 19, margin: "4px 0 8px" }}>Finalize this group's results?</h3>
            <p style={{ fontSize: 12.5, color: inkSoft, marginBottom: 14 }}>
              No more manual drag adjustments will be possible, and any pending switch requests for this group will be cleared without being acted on.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn tone="clay" onClick={finalizeResults} disabled={finalizing}>
                {finalizing ? "Finalizing…" : "Finalize"}
              </Btn>
              <Btn tone="ghost" onClick={() => setConfirmFinalize(false)} disabled={finalizing}>
                Cancel
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
              <div style={{ position: "relative", marginBottom: 10 }}>
                <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: inkSoft }} />
                <input
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  placeholder="Search students by name or email…"
                  style={{ ...inputStyle, paddingLeft: 30, fontSize: 13 }}
                />
              </div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {students
                .filter((s) => {
                  const q = studentSearch.trim().toLowerCase();
                  return !q || s.name.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q);
                })
                .map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: "9px 12px", fontSize: 13.5 }}>
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
                    <IconBtn tone="clay" onClick={() => removeStudent(s.id)} title="Remove response">
                      <X size={13} />
                    </IconBtn>
                  </div>
                ))}
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
                  <IconBtn onClick={exportCSV} tone="green">
                    <Download size={14} /> Export CSV
                  </IconBtn>
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
              settings,
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
                  ) : settings.usePreference === false ? (
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
                        Grade priority: {settings.useGrade ? `on (${settings.gradeDirection} grade first)` : "off"} — this student is grade {s.grade}
                        <br />
                        History priority: {settings.useHistory ? `on (${settings.historyMode})` : "off"}
                        {settings.useHistory && info.course ? ` — worth +${info.historyScore} for this course` : ""}
                        {settings.useGrade && settings.useHistory && <><br />Order: {settings.order[0]} decided ties before {settings.order[1]}</>}
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

      {(tab === "courses" || tab === "students") && (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <Btn onClick={runAssignment} disabled={!canRun}>
            <Play size={15} /> Run assignment
          </Btn>
          <p style={{ fontSize: 11, color: inkSoft, fontFamily: mono, margin: 0, textAlign: "center", maxWidth: 380 }}>
            preference {settings.usePreference ? "on" : "off"} · grade {settings.useGrade ? `on (${settings.gradeDirection})` : "off"} · history{" "}
            {settings.useHistory ? `on (${settings.historyMode})` : "off"}
            {settings.useGrade && settings.useHistory ? ` · ties: ${settings.order[0]} first` : ""} — edit in the Logic tab
          </p>
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

  const refreshNewResults = useCallback(async () => {
    setNewResultCount(await countNewResults(user));
  }, [user.email]);

  useEffect(() => {
    refreshNewResults();
  }, [refreshNewResults]);

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
              {newResultCount > 0 && (
                <span style={{ position: "absolute", top: -3, right: -9, width: 7, height: 7, borderRadius: "50%", background: clay }} />
              )}
            </span>
          }
        />
        <FolderTab active={subTab === "contact"} onClick={() => setSubTab("contact")} icon={MessageCircle} label="Contact Admin" />
      </div>
      <div style={{ background: paper, border: `1px solid ${line}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 22, maxWidth: 420, margin: "0 auto" }}>
        {subTab === "join" && <StudentJoin onJoined={onJoined} />}
        {subTab === "active" && <ActiveGroupsList user={user} onEditGroup={onJoined} onViewed={refreshNewResults} />}
        {subTab === "contact" && <ContactAdmin user={user} />}
      </div>
    </div>
  );
}

function ActiveGroupsList({ user, onEditGroup, onViewed }) {
  const [entries, setEntries] = useState(null);
  const [openRequestFor, setOpenRequestFor] = useState(null); // group code currently showing the request form
  const [requestTarget, setRequestTarget] = useState("");
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
                    <Btn tone="ghost" onClick={() => setOpenRequestFor(g.code)}>
                      <ArrowLeftRight size={13} /> Request switch
                    </Btn>
                  </div>
                )}

                {eligible && openRequestFor === g.code && (
                  <div style={{ marginTop: 10, borderTop: `1px solid ${line}`, paddingTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
                      }}
                      disabled={busy}
                    >
                      Cancel
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isEdit, setIsEdit] = useState(false);

  useEffect(() => {
    (async () => {
      const g = normalizeGroup(await storeGet(`group:${code}`, true));
      setGroup(g);
      const existing = await storeGet(`submission:${code}:${safeKey(user.email)}`, true);
      if (existing) {
        setIsEdit(true);
        setGrade(String(existing.grade));
        setPrefs([...existing.prefs, "", ""].slice(0, 3));
      }
    })();
  }, [code, user.email]);

  const choiceCount = group ? Math.max(2, Math.min(3, group.courses.length)) : 3;

  const setPref = (i, v) => {
    const next = [...prefs];
    next[i] = v;
    setPrefs(next);
  };

  const submit = async () => {
    setError("");
    if (group.status !== "active") return setError("This group is no longer accepting responses.");
    if (!grade) return setError("Enter your grade.");
    const chosen = prefs.slice(0, choiceCount);
    if (chosen.some((p) => !p)) return setError(`Choose all ${choiceCount} courses, in order of preference.`);
    if (new Set(chosen).size < choiceCount) return setError(`Choose ${choiceCount} different courses.`);
    setBusy(true);
    const key = `submission:${code}:${safeKey(user.email)}`;
    await storeSet(key, { id: safeKey(user.email), name: user.name, email: user.email, grade: Number(grade), prefs: chosen }, true);
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
