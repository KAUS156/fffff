import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import admin from "firebase-admin";
import Razorpay from "razorpay";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  initializeApp,
  cert,
  getApps
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  getDatabase,
  ServerValue
} from "firebase-admin/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5000);

const DB_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://babbihar-23fcc-default-rtdb.firebaseio.com/";

const STORAGE_DIR = path.resolve(
  process.env.PAPER_STORAGE_DIR || "./private-paper-uploads"
);

const ADMIN_UIDS = new Set(
  (process.env.ADMIN_UIDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

app.disable("x-powered-by");
app.set("trust proxy", 1);

fs.mkdirSync(STORAGE_DIR, { recursive: true });

/* ---------- Firebase initialization ---------- */

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON in .env");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON");
}

if (
  serviceAccount.project_id !== "babbihar-23fcc" ||
  !serviceAccount.private_key ||
  !serviceAccount.client_email
) {
  throw new Error("Service account must belong to Firebase project babbihar-23fcc");
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: DB_URL
  });
}

const db = getDatabase();
const auth = getAuth();

/* ---------- Razorpay ---------- */

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

/* ---------- Security headers ---------- */

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

/* ---------- Helpers ---------- */

const text = (value, max = 500) => String(value ?? "").trim().slice(0, max);

const validId = value =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);

function safeFilename(name) {
  return path.basename(String(name || "paper.pdf"))
    .replace(/[\r\n"]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120) || "paper.pdf";
}

function safeSeries(item, id) {
  return {
    id,
    title: text(item.title, 150),
    description: text(item.description, 2000),
    className: text(item.className, 40),
    subject: text(item.subject, 80),
    pricePaise: Number(item.pricePaise || 0),
    testCount: Number(item.testCount || 0),
    active: item.active === true,
    createdAt: item.createdAt || null
  };
}

function safeEqualHex(a, b) {
  try {
    const x = Buffer.from(String(a), "hex");
    const y = Buffer.from(String(b), "hex");
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

function normalizeField(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^class\s*/, "")
    .replace(/\s+/g, " ");
}

async function requireUser(req, res, next) {
  try {
    const match = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: "Please sign in first." });
    }
    req.user = await auth.verifyIdToken(match[1], true);
    return next();
  } catch {
    return res.status(401).json({ error: "Your session is invalid or expired." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_UIDS.has(req.user.uid)) {
    return res.status(403).json({ error: "Admin access denied." });
  }
  next();
}

async function getSeries(id) {
  if (!validId(id)) return null;
  const snap = await db.ref(`testSeries/${id}`).get();
  return snap.exists() ? safeSeries(snap.val(), id) : null;
}

async function ownsSeries(uid, id) {
  const snap = await db.ref(`purchases/${uid}/${id}`).get();
  return snap.val()?.status === "active";
}

async function grantPurchase({ uid, seriesId, orderId, paymentId, amount, currency }) {
  const series = await getSeries(seriesId);
  if (!series || !series.active) throw new Error("Series unavailable");
  if (Number(amount) !== series.pricePaise || currency !== "INR") {
    throw new Error("Payment amount mismatch");
  }

  await db.ref(`purchases/${uid}/${seriesId}`).transaction(current => {
    if (current?.status === "active") return current;
    return {
      seriesId,
      status: "active",
      orderId,
      paymentId,
      amountPaise: Number(amount),
      currency: "INR",
      purchasedAt: ServerValue.TIMESTAMP
    };
  });
}

/* ---------- Private PDF storage ---------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, STORAGE_DIR),
    filename: (_req, _file, callback) => {
      callback(null, `${Date.now()}_${crypto.randomBytes(16).toString("hex")}.pdf`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "application/pdf" || !file.originalname.toLowerCase().endsWith(".pdf")) {
      return callback(new Error("Only PDF files are allowed."));
    }
    callback(null, true);
  }
});

function handleUpload(req, res, next) {
  upload.single("pdf")(req, res, error => {
    if (!error) return next();
    return res.status(400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "PDF must be 10 MB or smaller."
        : error.message || "PDF upload failed."
    });
  });
}

async function removeLocalFile(filename) {
  if (!filename || path.basename(filename) !== filename) return;
  try {
    await fs.promises.unlink(path.join(STORAGE_DIR, filename));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function resolveStoredPdf(pdf) {
  if (!pdf?.diskName) return null;
  if (!/^\d+_[a-f0-9]{32}\.pdf$/.test(pdf.diskName)) return null;
  const fullPath = path.resolve(STORAGE_DIR, pdf.diskName);
  if (path.dirname(fullPath) !== STORAGE_DIR) return null;
  return fullPath;
}

async function streamPaperPdf(req, res, adminPreview = false) {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "Invalid paper ID." });

  const snap = await db.ref(`questionPapers/${id}`).get();
  const paper = snap.val();
  if (!paper) return res.status(404).json({ error: "Paper not found." });

  if (!adminPreview && paper.status !== "published") {
    return res.status(404).json({ error: "Published PDF not found." });
  }

  const fullPath = resolveStoredPdf(paper.pdf);
  if (!fullPath) {
    return res.status(404).json({ error: "PDF file record is missing or invalid." });
  }

  try {
    await fs.promises.access(fullPath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: "PDF file is missing from server storage." });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${safeFilename(paper.pdf.fileName)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  await pipeline(fs.createReadStream(fullPath), res);
}

/* ---------- Razorpay webhook ---------- */

app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.get("x-razorpay-signature");

      if (!secret || !signature || !Buffer.isBuffer(req.body)) {
        return res.status(400).send("Webhook not configured.");
      }

      const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
      if (!safeEqualHex(expected, signature)) {
        return res.status(400).send("Invalid webhook signature.");
      }

      const event = JSON.parse(req.body.toString("utf8"));

      if (event.event === "payment.captured" || event.event === "order.paid") {
        const payment = event.payload?.payment?.entity;
        const order = event.payload?.order?.entity;
        const orderId = payment?.order_id || order?.id;

        if (orderId && payment?.status === "captured") {
          const saved = (await db.ref(`paymentOrders/${orderId}`).get()).val();
          if (
            saved?.uid &&
            saved?.seriesId &&
            Number(payment.amount) === Number(saved.amountPaise) &&
            payment.currency === saved.currency
          ) {
            await grantPurchase({
              uid: saved.uid,
              seriesId: saved.seriesId,
              orderId,
              paymentId: payment.id,
              amount: payment.amount,
              currency: payment.currency
            });
            await db.ref(`paymentOrders/${orderId}`).update({
              status: "paid",
              paymentId: payment.id,
              paidAt: ServerValue.TIMESTAMP
            });
          }
        }
      }
      return res.json({ received: true });
    } catch (error) {
      console.error("Razorpay webhook:", error.message);
      return res.status(500).send("Webhook processing failed.");
    }
  }
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

/* ---------- Health ---------- */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Bihar Academic Battle Test Series",
    storage: "private-local-disk",
    time: new Date().toISOString()
  });
});

/* ---------- Public series ---------- */

app.get("/api/series", async (_req, res) => {
  try {
    const snap = await db.ref("testSeries").get();
    const series = Object.entries(snap.val() || {})
      .map(([id, item]) => safeSeries(item, id))
      .filter(item => item.active)
      .sort((a, b) => a.pricePaise - b.pricePaise);

    res.json({
      series,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || ""
    });
  } catch (error) {
    console.error("Load series:", error.message);
    res.status(500).json({ error: "Could not load test series." });
  }
});

/* ---------- Student purchases ---------- */

app.get("/api/my-series", requireUser, async (req, res) => {
  try {
    const snap = await db.ref(`purchases/${req.user.uid}`).get();
    const purchases = snap.val() || {};
    const seriesList = [];

    for (const [seriesId, purchase] of Object.entries(purchases)) {
      if (purchase?.status !== "active") continue;
      const series = await getSeries(seriesId);
      if (!series) continue;

      seriesList.push({
        ...series,
        purchase: {
          status: purchase.status,
          purchasedAt: purchase.purchasedAt ?? null,
          paymentId: purchase.paymentId ?? null,
          amountPaise: Number(purchase.amountPaise || 0),
          currency: purchase.currency || "INR"
        }
      });
    }

    res.json({ ok: true, series: seriesList, purchases: seriesList });
  } catch (error) {
    console.error("My series:", error.message);
    res.status(500).json({ ok: false, error: "Could not load purchases." });
  }
});

/* ---------- Create Razorpay order ---------- */

app.post("/api/create-order", requireUser, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured." });

    const seriesId = text(req.body?.seriesId, 100);
    if (!validId(seriesId)) return res.status(400).json({ error: "Invalid series." });

    const series = await getSeries(seriesId);
    if (!series || !series.active) return res.status(404).json({ error: "Series unavailable." });

    if (!Number.isSafeInteger(series.pricePaise) || series.pricePaise < 100) {
      return res.status(400).json({ error: "Invalid series price." });
    }

    if (await ownsSeries(req.user.uid, seriesId)) {
      return res.status(409).json({ error: "Already purchased." });
    }

    const order = await razorpay.orders.create({
      amount: series.pricePaise,
      currency: "INR",
      receipt: `bab_${crypto.randomBytes(12).toString("hex")}`.slice(0, 40),
      notes: { firebaseUid: req.user.uid, seriesId }
    });

    await db.ref(`paymentOrders/${order.id}`).set({
      uid: req.user.uid,
      seriesId,
      amountPaise: series.pricePaise,
      currency: "INR",
      status: "created",
      createdAt: ServerValue.TIMESTAMP
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      name: "Bihar Academic Battle",
      description: series.title
    });
  } catch (error) {
    console.error("Create order:", error.message);
    res.status(500).json({ error: "Could not create payment order." });
  }
});

/* ---------- Verify Razorpay payment ---------- */

app.post("/api/verify-payment", requireUser, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured." });

    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature
    } = req.body || {};

    if (![orderId, paymentId, signature].every(v => typeof v === "string" && v.length > 0 && v.length < 300)) {
      return res.status(400).json({ error: "Missing payment details." });
    }

    const saved = (await db.ref(`paymentOrders/${orderId}`).get()).val();
    if (!saved || saved.uid !== req.user.uid) {
      return res.status(403).json({ error: "Order ownership mismatch." });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (!safeEqualHex(expected, signature)) {
      return res.status(400).json({ error: "Invalid payment signature." });
    }

    const [order, payment] = await Promise.all([
      razorpay.orders.fetch(orderId),
      razorpay.payments.fetch(paymentId)
    ]);

    if (
      payment.order_id !== orderId ||
      order.id !== orderId ||
      payment.status !== "captured" ||
      order.status !== "paid" ||
      Number(payment.amount) !== Number(saved.amountPaise) ||
      Number(order.amount) !== Number(saved.amountPaise) ||
      payment.currency !== "INR" ||
      order.currency !== "INR"
    ) {
      return res.status(402).json({ error: "Payment not confirmed." });
    }

    await grantPurchase({
      uid: req.user.uid,
      seriesId: saved.seriesId,
      orderId,
      paymentId,
      amount: payment.amount,
      currency: payment.currency
    });

    await db.ref(`paymentOrders/${orderId}`).update({
      status: "paid",
      paymentId,
      paidAt: ServerValue.TIMESTAMP
    });

    res.json({ ok: true, message: "Payment verified." });
  } catch (error) {
    console.error("Verify payment:", error.message);
    res.status(500).json({ error: "Could not verify payment." });
  }
});

/* ---------- Check series access ---------- */

app.get("/api/access/:seriesId", requireUser, async (req, res) => {
  try {
    const id = req.params.seriesId;
    const series = await getSeries(id);
    const allowed = Boolean(series && series.active && await ownsSeries(req.user.uid, id));

    res.status(allowed ? 200 : 403).json({
      allowed,
      ...(!allowed ? { error: "Purchase this series to access its papers." } : {})
    });
  } catch {
    res.status(500).json({ error: "Could not check access." });
  }
});

/* ---------- Admin: series ---------- */

app.get("/api/admin/series", requireUser, requireAdmin, async (_req, res) => {
  try {
    const snap = await db.ref("testSeries").get();
    res.json({
      series: Object.entries(snap.val() || {}).map(([id, item]) => safeSeries(item, id))
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not load series." });
  }
});

app.post("/api/admin/series", requireUser, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.id ? text(body.id, 100) : `series_${crypto.randomBytes(8).toString("hex")}`;

    const title = text(body.title, 150);
    const description = text(body.description, 2000);
    const className = text(body.className, 40);
    const subject = text(body.subject, 80);
    const priceRupees = Number(body.priceRupees);
    const testCount = Number(body.testCount || 1);

    if (
      !validId(id) || !title || !className || !subject ||
      !Number.isFinite(priceRupees) || priceRupees < 1 || priceRupees > 100000 ||
      !Number.isInteger(testCount) || testCount < 1 || testCount > 10000
    ) {
      return res.status(400).json({ error: "Invalid series details." });
    }

    const ref = db.ref(`testSeries/${id}`);
    const old = (await ref.get()).val();

    const record = {
      title,
      description,
      className,
      subject,
      pricePaise: Math.round(priceRupees * 100),
      testCount,
      active: body.active === true,
      createdAt: old?.createdAt || ServerValue.TIMESTAMP,
      updatedAt: ServerValue.TIMESTAMP
    };

    await ref.set(record);
    res.json({ ok: true, series: safeSeries(record, id) });
  } catch (error) {
    console.error("Save series:", error.message);
    res.status(500).json({ error: "Could not save series." });
  }
});

app.post("/api/admin/series/:id/toggle", requireUser, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!validId(id)) return res.status(400).json({ error: "Invalid ID." });

    const ref = db.ref(`testSeries/${id}`);
    if (!(await ref.get()).exists()) return res.status(404).json({ error: "Series not found." });

    await ref.update({
      active: req.body?.active === true,
      updatedAt: ServerValue.TIMESTAMP
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not update series." });
  }
});

/* ---------- Admin: purchases ---------- */

app.get("/api/admin/purchases", requireUser, requireAdmin, async (_req, res) => {
  try {
    const [purchaseSnap, seriesSnap] = await Promise.all([
      db.ref("purchases").get(),
      db.ref("testSeries").get()
    ]);

    const series = seriesSnap.val() || {};
    const purchases = [];

    for (const [uid, items] of Object.entries(purchaseSnap.val() || {})) {
      for (const [seriesId, purchase] of Object.entries(items || {})) {
        if (purchase?.status !== "active") continue;
        purchases.push({
          uid,
          seriesId,
          seriesTitle: series[seriesId]?.title || seriesId,
          paymentId: purchase.paymentId || "",
          amountPaise: Number(purchase.amountPaise || 0),
          purchasedAt: purchase.purchasedAt || null,
          status: purchase.status
        });
      }
    }

    purchases.sort((a, b) => Number(b.purchasedAt || 0) - Number(a.purchasedAt || 0));
    res.json({ purchases });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not load purchases." });
  }
});

/* ---------- Normalize questions ---------- */

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) {
    throw new Error("Add between 1 and 500 MCQ questions.");
  }

  return raw.map((item, index) => {
    const question = {
      id: validId(item?.id) ? item.id : `q_${index + 1}`,
      question: text(item?.question, 1000),
      options: Array.isArray(item?.options) ? item.options.map(v => text(v, 400)) : [],
      correctIndex: Number(item?.correctIndex),
      explanation: text(item?.explanation, 1000)
    };

    if (
      !question.question ||
      question.options.length !== 4 ||
      question.options.some(v => !v) ||
      !Number.isInteger(question.correctIndex) ||
      question.correctIndex < 0 ||
      question.correctIndex > 3
    ) {
      throw new Error(`Question ${index + 1}: enter question, four options and correctIndex 0–3.`);
    }
    return question;
  });
}

/* ---------- Admin: list papers ---------- */

app.get("/api/admin/papers", requireUser, requireAdmin, async (_req, res) => {
  try {
    const snap = await db.ref("questionPapers").get();
    const papers = Object.entries(snap.val() || {})
      .map(([id, paper]) => ({
        id,
        ...paper,
        questions: Array.isArray(paper.questions) ? paper.questions : [],
        pdf: paper.pdf || null,
        status: paper.status || "draft",
        seriesId: paper.seriesId || null
      }))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    res.json({ papers });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not load papers." });
  }
});

/* ---------- Admin: save MCQ paper ---------- */

app.post("/api/admin/papers", requireUser, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.id ? text(body.id, 100) : `paper_${crypto.randomBytes(8).toString("hex")}`;

    const title = text(body.title, 150);
    const className = text(body.className, 40);
    const subject = text(body.subject, 80);
    const seriesId = body.seriesId ? text(body.seriesId, 100) : null;
    const durationMinutes = Number(body.durationMinutes ?? body.duration ?? 60);
    const marksPerQuestion = Number(body.marksPerQuestion ?? 1);
    const questions = normalizeQuestions(body.questions);

    if (
      !validId(id) || !title || !className || !subject ||
      !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240 ||
      !Number.isFinite(marksPerQuestion) || marksPerQuestion <= 0 || marksPerQuestion > 100
    ) {
      return res.status(400).json({ error: "Invalid paper details." });
    }

    const ref = db.ref(`questionPapers/${id}`);
    const old = (await ref.get()).val();

    if (body.id && !old) return res.status(404).json({ error: "Paper not found." });

    const paper = {
      title,
      className,
      subject,
      seriesId: seriesId || null,
      durationMinutes,
      marksPerQuestion,
      instructions: text(body.instructions, 3000),
      questions,
      pdf: old?.pdf || null,
      type: "mcq",
      status: body.status === "published" ? "published" : (old?.status || "draft"),
      createdAt: old?.createdAt || ServerValue.TIMESTAMP,
      updatedAt: ServerValue.TIMESTAMP
    };

    await ref.set(paper);
    res.json({ ok: true, id, paper: { id, ...paper } });
  } catch (error) {
    if (/^Add between|^Question /.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Save MCQ paper:", error.message);
    res.status(500).json({ error: "Could not save paper." });
  }
});

/* ---------- Admin: PDF metadata ---------- */

app.post("/api/admin/papers/pdf-metadata", requireUser, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.id ? text(body.id, 100) : `paper_${crypto.randomBytes(8).toString("hex")}`;

    const title = text(body.title, 150);
    const className = text(body.className, 40);
    const subject = text(body.subject, 80);
    const seriesId = body.seriesId ? text(body.seriesId, 100) : null;
    const durationMinutes = Number(body.durationMinutes || 60);

    if (
      !validId(id) || !title || !className || !subject ||
      !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 300
    ) {
      return res.status(400).json({ error: "Enter valid title, class, subject and duration." });
    }

    const ref = db.ref(`questionPapers/${id}`);
    const old = (await ref.get()).val();
    if (body.id && !old) return res.status(404).json({ error: "Paper not found." });

    const paper = {
      ...(old || {}),
      title,
      className,
      subject,
      seriesId: seriesId || null,
      durationMinutes,
      instructions: text(body.instructions, 2000),
      type: "pdf",
      status: "draft",
      createdAt: old?.createdAt || ServerValue.TIMESTAMP,
      updatedAt: ServerValue.TIMESTAMP
    };

    await ref.set(paper);
    res.json({ ok: true, id, paper: { id, ...paper } });
  } catch (error) {
    console.error("PDF metadata:", error.message);
    res.status(500).json({ error: "Could not save PDF metadata." });
  }
});

/* ---------- Admin: upload PDF ---------- */

app.post("/api/admin/papers/:id/pdf", requireUser, requireAdmin, handleUpload, async (req, res) => {
  try {
    const id = req.params.id;
    const file = req.file;

    if (!validId(id)) {
      if (file) await removeLocalFile(file.filename);
      return res.status(400).json({ error: "Invalid paper ID." });
    }
    if (!file) return res.status(400).json({ error: "Choose a PDF file." });

    const handle = await fs.promises.open(file.path, "r");
    const header = Buffer.alloc(5);
    try {
      await handle.read(header, 0, 5, 0);
    } finally {
      await handle.close();
    }

    if (header.toString("ascii") !== "%PDF-") {
      await removeLocalFile(file.filename);
      return res.status(400).json({ error: "The uploaded file is not a valid PDF." });
    }

    const ref = db.ref(`questionPapers/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) {
      await removeLocalFile(file.filename);
      return res.status(404).json({ error: "Save PDF metadata before uploading." });
    }

    const oldPdf = snap.val()?.pdf;
    const pdf = {
      fileName: safeFilename(file.originalname),
      diskName: file.filename,
      size: file.size,
      contentType: "application/pdf",
      uploadedAt: Date.now()
    };

    await ref.update({
      pdf,
      type: "pdf",
      status: "draft",
      updatedAt: ServerValue.TIMESTAMP
    });

    if (oldPdf?.diskName && oldPdf.diskName !== file.filename) {
      removeLocalFile(oldPdf.diskName).catch(err => console.warn("Old PDF cleanup:", err.message));
    }

    res.json({ ok: true, pdf, message: "PDF uploaded to private server storage." });
  } catch (error) {
    if (req.file?.filename) await removeLocalFile(req.file.filename).catch(() => {});
    console.error("PDF upload:", error.message);
    res.status(500).json({ error: "PDF upload failed.", details: error.message });
  }
});

/* ---------- Admin: PDF preview ---------- */

app.get("/api/admin/papers/:id/pdf", requireUser, requireAdmin, async (req, res) => {
  try {
    await streamPaperPdf(req, res, true);
  } catch (error) {
    console.error("Admin PDF preview:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Could not open PDF." });
    else res.destroy(error);
  }
});

/* ---------- Admin: publish/unpublish ---------- */

app.post("/api/admin/papers/:id/publish", requireUser, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!validId(id)) return res.status(400).json({ error: "Invalid paper ID." });

    const ref = db.ref(`questionPapers/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ error: "Paper not found." });

    const paper = snap.val();
    const published = req.body?.published === true || req.body?.status === "published";

    if (
      published &&
      !(Array.isArray(paper.questions) && paper.questions.length) &&
      !paper.pdf?.diskName
    ) {
      return res.status(400).json({ error: "Add MCQ questions or upload a PDF first." });
    }

    await ref.update({
      status: published ? "published" : "draft",
      updatedAt: ServerValue.TIMESTAMP
    });

    res.json({ ok: true, status: published ? "published" : "draft" });
  } catch (error) {
    console.error("Publish paper:", error.message);
    res.status(500).json({ error: "Could not update paper status." });
  }
});

/* ---------- Student: published papers (with seriesId support) ---------- */

app.get("/api/papers", requireUser, async (req, res) => {
  try {
    const seriesIdFilter = req.query.seriesId ? text(req.query.seriesId, 100) : null;

    const snap = await db.ref("questionPapers").get();
    const allPapers = snap.val() || {};

    const purchaseSnap = await db.ref(`purchases/${req.user.uid}`).get();
    const purchases = purchaseSnap.val() || {};
    const seriesSnap = await db.ref("testSeries").get();
    const allSeries = seriesSnap.val() || {};

    // Case 1: specific seriesId requested
    if (seriesIdFilter) {
      if (!purchases[seriesIdFilter] || purchases[seriesIdFilter].status !== "active") {
        return res.status(403).json({ error: "You do not have access to this series." });
      }

      const papers = Object.entries(allPapers)
        .filter(([, paper]) => {
          if (paper?.status !== "published") return false;
          // Prefer exact seriesId match
          if (paper.seriesId && paper.seriesId === seriesIdFilter) return true;
          return false;
        })
        .map(([id, paper]) => ({
          id,
          title: text(paper.title, 150),
          className: text(paper.className, 40),
          subject: text(paper.subject, 80),
          durationMinutes: Number(paper.durationMinutes || 60),
          marksPerQuestion: Number(paper.marksPerQuestion || 1),
          instructions: text(paper.instructions, 3000),
          type: paper.type || (paper.pdf ? "pdf" : "mcq"),
          pdf: paper.pdf ? { fileName: text(paper.pdf.fileName, 150), size: Number(paper.pdf.size || 0) } : null,
          questionCount: Array.isArray(paper.questions) ? paper.questions.length : 0,
          questions: []
        }));

      return res.json({ papers });
    }

    // Case 2: fallback – class + subject matching (for older papers without seriesId)
    const ownsMatchingSeries = paper =>
      Object.entries(purchases).some(([seriesId, purchase]) => {
        if (purchase?.status !== "active") return false;
        const series = allSeries[seriesId];
        if (!series) return false;

        const classMatch =
          normalizeField(series.className) === normalizeField(paper.className) ||
          normalizeField(series.className) === "all classes" ||
          normalizeField(paper.className) === "all classes";

        const subjectMatch = normalizeField(series.subject) === normalizeField(paper.subject);
        return classMatch && subjectMatch;
      });

    const papers = Object.entries(allPapers)
      .filter(([, paper]) => paper?.status === "published" && ownsMatchingSeries(paper))
      .map(([id, paper]) => ({
        id,
        title: text(paper.title, 150),
        className: text(paper.className, 40),
        subject: text(paper.subject, 80),
        durationMinutes: Number(paper.durationMinutes || 60),
        marksPerQuestion: Number(paper.marksPerQuestion || 1),
        instructions: text(paper.instructions, 3000),
        type: paper.type || (paper.pdf ? "pdf" : "mcq"),
        pdf: paper.pdf ? { fileName: text(paper.pdf.fileName, 150), size: Number(paper.pdf.size || 0) } : null,
        questionCount: Array.isArray(paper.questions) ? paper.questions.length : 0,
        questions: []
      }));

    res.json({ papers });
  } catch (error) {
    console.error("Published papers:", error.message);
    res.status(500).json({ error: "Could not load published papers." });
  }
});

/* ---------- Student: MCQ questions ---------- */

app.get("/api/papers/:id/questions", requireUser, async (req, res) => {
  try {
    const id = req.params.id;
    if (!validId(id)) return res.status(400).json({ error: "Invalid paper ID." });

    const paperSnap = await db.ref(`questionPapers/${id}`).get();
    if (!paperSnap.exists()) return res.status(404).json({ error: "Paper not found." });

    const paper = paperSnap.val();
    if (paper.status !== "published") {
      return res.status(404).json({ error: "This paper is not published." });
    }
    if (paper.type === "pdf" || paper.pdf?.diskName) {
      return res.status(400).json({ error: "This is a PDF paper, not an MCQ paper." });
    }

    const purchaseSnap = await db.ref(`purchases/${req.user.uid}`).get();
    const purchases = purchaseSnap.val() || {};
    const seriesSnap = await db.ref("testSeries").get();
    const allSeries = seriesSnap.val() || {};

    // Check access via seriesId first, then fallback to class+subject
    let hasAccess = false;

    if (paper.seriesId && purchases[paper.seriesId]?.status === "active") {
      hasAccess = true;
    } else {
      hasAccess = Object.entries(purchases).some(([seriesId, purchase]) => {
        if (purchase?.status !== "active") return false;
        const series = allSeries[seriesId];
        if (!series) return false;

        const classMatch =
          normalizeField(series.className) === normalizeField(paper.className) ||
          normalizeField(series.className) === "all classes" ||
          normalizeField(paper.className) === "all classes";

        const subjectMatch = normalizeField(series.subject) === normalizeField(paper.subject);
        return classMatch && subjectMatch;
      });
    }

    if (!hasAccess) {
      return res.status(403).json({
        error: "Purchase the matching active test series to access this paper."
      });
    }

    if (!Array.isArray(paper.questions) || !paper.questions.length) {
      return res.status(404).json({ error: "No MCQ questions are saved in this paper." });
    }

    const questions = paper.questions.map((q, index) => ({
      id: String(q.id || `q_${index + 1}`),
      question: text(q.question, 1000),
      options: Array.isArray(q.options) ? q.options.slice(0, 4).map(o => text(o, 400)) : []
    }));

    res.json({
      ok: true,
      paper: {
        id,
        title: text(paper.title, 150),
        className: text(paper.className, 40),
        subject: text(paper.subject, 80),
        durationMinutes: Number(paper.durationMinutes || 60),
        marksPerQuestion: Number(paper.marksPerQuestion || 1),
        instructions: text(paper.instructions, 3000),
        questions
      }
    });
  } catch (error) {
    console.error("Load MCQ questions:", error.message);
    res.status(500).json({ error: "Could not load MCQ questions." });
  }
});

/* ---------- Student: private PDF ---------- */

app.get("/api/papers/:id/pdf", requireUser, async (req, res) => {
  try {
    const id = req.params.id;
    if (!validId(id)) return res.status(400).json({ error: "Invalid paper ID." });

    const paperSnap = await db.ref(`questionPapers/${id}`).get();
    const paper = paperSnap.val();

    if (!paper || paper.status !== "published") {
      return res.status(404).json({ error: "Published PDF not found." });
    }
    if (!paper.pdf?.diskName) {
      return res.status(404).json({ error: "PDF is not attached to this paper." });
    }

    const purchaseSnap = await db.ref(`purchases/${req.user.uid}`).get();
    const purchases = purchaseSnap.val() || {};
    const seriesSnap = await db.ref("testSeries").get();
    const allSeries = seriesSnap.val() || {};

    let hasAccess = false;
    if (paper.seriesId && purchases[paper.seriesId]?.status === "active") {
      hasAccess = true;
    } else {
      hasAccess = Object.entries(purchases).some(([seriesId, purchase]) => {
        if (purchase?.status !== "active") return false;
        const series = allSeries[seriesId];
        if (!series) return false;

        const classMatch =
          normalizeField(series.className) === normalizeField(paper.className) ||
          normalizeField(series.className) === "all classes" ||
          normalizeField(paper.className) === "all classes";

        const subjectMatch = normalizeField(series.subject) === normalizeField(paper.subject);
        return classMatch && subjectMatch;
      });
    }

    if (!hasAccess) {
      return res.status(403).json({
        error: "Purchase the matching active test series to access this PDF."
      });
    }

    await streamPaperPdf(req, res, false);
  } catch (error) {
    console.error("Student PDF:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Could not open PDF." });
    else res.destroy(error);
  }
});

/* ---------- Fallback ---------- */

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API route not found." });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"), error => {
    if (error) next(error);
  });
});

app.use((error, req, res, _next) => {
  console.error("Unhandled server error:", error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Unexpected server error." });
});

/* ---------- Start ---------- */

app.listen(PORT, () => {
  console.log(`Bihar Academic Battle server running on port ${PORT}`);
  console.log(`Private PDF directory: ${STORAGE_DIR}`);
});