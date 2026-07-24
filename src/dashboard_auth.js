"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_PATH = process.env.DASHBOARD_AUTH_STORE
  || "/opt/ozon-api-v2/data/dashboard-auth.json";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = "dashboard_session";
const OPERATORS = new Set(["梦婷", "云湖"]);
const sessions = new Map();

function initialStore() {
  return { version: 1, users: [], assignments: {} };
}

function ensureStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(initialStore(), null, 2), {
      mode: 0o600,
    });
  }
}

function loadStore() {
  ensureStore();
  const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  parsed.users = Array.isArray(parsed.users) ? parsed.users : [];
  parsed.assignments = parsed.assignments && typeof parsed.assignments === "object"
    ? parsed.assignments
    : {};
  return parsed;
}

function saveStore(store) {
  ensureStore();
  const temp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STORE_PATH);
  try { fs.chmodSync(STORE_PATH, 0o600); } catch (_) {}
}

function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64)
    .toString("hex");
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, passwordHash: hashPassword(password, salt) };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length
    && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    operator: user.operator || null,
  };
}

function provisionAdmin(username, password) {
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername || !password) throw new Error("管理员账号和密码不能为空");
  const store = loadStore();
  const record = passwordRecord(password);
  const existing = store.users.find((item) => item.role === "admin");
  if (existing) {
    Object.assign(existing, {
      username: cleanUsername,
      role: "admin",
      operator: null,
      ...record,
    });
  } else {
    store.users.push({
      username: cleanUsername,
      role: "admin",
      operator: null,
      ...record,
    });
  }
  saveStore(store);
  return publicUser(existing || store.users[store.users.length - 1]);
}

function login(username, password) {
  const store = loadStore();
  const user = store.users.find((item) => item.username === String(username || "").trim());
  if (!verifyPassword(password, user)) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    user: publicUser(user),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { token, user: publicUser(user) };
}

function parseCookies(req) {
  const result = {};
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function sessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || "";
}

function currentUser(req) {
  const token = sessionToken(req);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.user;
}

function logout(req) {
  const token = sessionToken(req);
  if (token) sessions.delete(token);
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function listUsers() {
  return loadStore().users.map(publicUser);
}

function upsertOperatorUser(operator, payload) {
  if (!OPERATORS.has(operator)) throw new Error("运营人员只能是梦婷或云湖");
  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  if (!username) throw new Error("登录账号不能为空");
  const store = loadStore();
  const duplicate = store.users.find((item) => (
    item.username === username && item.operator !== operator
  ));
  if (duplicate) throw new Error("该登录账号已经被使用");
  let user = store.users.find((item) => item.role === "operator" && item.operator === operator);
  if (!user && !password) throw new Error("首次设置账号时必须填写密码");
  if (!user) {
    user = { role: "operator", operator };
    store.users.push(user);
  }
  user.username = username;
  if (password) Object.assign(user, passwordRecord(password));
  saveStore(store);
  for (const [token, session] of sessions.entries()) {
    if (session.user.operator === operator) sessions.delete(token);
  }
  return publicUser(user);
}

function listAssignments() {
  return { ...loadStore().assignments };
}

function setAssignment(sku, operator) {
  const cleanSku = String(sku || "").trim();
  const cleanOperator = String(operator || "").trim();
  if (!cleanSku) throw new Error("SKU不能为空");
  if (cleanOperator && !OPERATORS.has(cleanOperator)) {
    throw new Error("运营人员只能是梦婷、云湖或未分配");
  }
  const store = loadStore();
  if (cleanOperator) store.assignments[cleanSku] = cleanOperator;
  else delete store.assignments[cleanSku];
  saveStore(store);
  return { sku: cleanSku, operator: cleanOperator };
}

function filterEconomicsPayload(payload, user) {
  if (!payload || !Array.isArray(payload.rows) || user.role === "admin") return payload;
  const assignments = loadStore().assignments;
  const rows = payload.rows.filter((row) => assignments[String(row.sku || "").trim()] === user.operator);
  return {
    ...payload,
    rows,
    meta: {
      ...(payload.meta || {}),
      visibleRows: rows.length,
      accessScope: user.operator,
    },
  };
}

ensureStore();

module.exports = {
  clearedSessionCookie,
  currentUser,
  filterEconomicsPayload,
  listAssignments,
  listUsers,
  login,
  logout,
  provisionAdmin,
  sessionCookie,
  setAssignment,
  upsertOperatorUser,
};
