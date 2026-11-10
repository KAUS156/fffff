// server.js
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

/* =========================================
   1. INITIAL CONFIGURATION
========================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 5000);

const DB_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://babbihar-23fcc-default-rtdb.firebaseio.com/";

const STORAGE_DIR = path.resolve(
  process.env.STORAGE_DIR ||
  path.join(__dirname, "private-paper-uploads")
);

const PUBLIC_DIR = path.join(__dirname, "public");

const ADMIN_UIDS = new Set(
  String(process.env.ADMIN_UIDS || "")
    .split(",")
    .map(uid => uid.trim())
    .filter(Boolean)
);

fs.mkdirSync(STORAGE_DIR, {
  recursive: true
});

/* =========================================
   2. FIREBASE ADMIN INITIALIZATION
========================================= */

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON environment variable missing."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON."
    );
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return serviceAccount;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      loadServiceAccount()
    ),

    databaseURL: DB_URL
  });
}

const db = admin.database();

/* =========================================
   3. RAZORPAY INITIALIZATION
========================================= */

const RAZORPAY_KEY_ID =
  process.env.RAZORPAY_KEY_ID || "";

const RAZORPAY_KEY_SECRET =
  process.env.RAZORPAY_KEY_SECRET || "";

let razorpay = null;

if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
  });
} else {
  console.warn(
    "WARNING: Razorpay credentials are not configured."
  );
}

/* =========================================
   4. EXPRESS MIDDLEWARE
========================================= */

app.disable("x-powered-by");

app.use(express.json({
  limit: "2mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "2mb"
}));

app.use(express.static(PUBLIC_DIR));

/* =========================================
   5. COMMON HELPERS
========================================= */

function sendError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message
  });
}

function makeId(prefix = "item") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function cleanString(value, maxLength = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function isValidId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 180 &&
    !/[.#$\[\]/]/.test(value)
  );
}

function safeSeries(item, id) {
  if (!item) return null;

  return {
    id,

    title: cleanString(item.title, 200),

    description: cleanString(
      item.description,
      3000
    ),

    className: cleanString(
      item.className,
      100
    ),

    subject: cleanString(
      item.subject,
      150
    ),

    pricePaise: safeNumber(
      item.pricePaise
    ),

    testCount: safeNumber(
      item.testCount
    ),

    active: item.active !== false,

    createdAt: item.createdAt || null,

    updatedAt: item.updatedAt || null
  };
}

function safePaper(item, id) {
  if (!item) return null;

  return {
    id,

    title: cleanString(
      item.title,
      200
    ),

    className: cleanString(
      item.className,
      100
    ),

    subject: cleanString(
      item.subject,
      150
    ),

    seriesId: cleanString(
      item.seriesId,
      180
    ),

    durationMinutes: safeNumber(
      item.durationMinutes,
      60
    ),

    marksPerQuestion: safeNumber(
      item.marksPerQuestion,
      1
    ),

    instructions: cleanString(
      item.instructions,
      5000
    ),

    type: item.type === "pdf"
      ? "pdf"
      : "mcq",

    status: item.status || "draft",

    questionCount: Array.isArray(item.questions)
      ? item.questions.length
      : safeNumber(item.questionCount),

    pdf: item.pdf || null,

    createdAt: item.createdAt || null,

    updatedAt: item.updatedAt || null
  };
}

function getRupees(pricePaise) {
  return safeNumber(pricePaise) / 100;
}

function getNow() {
  return Date.now();
}

function safeFilePath(paperId) {
  if (!isValidId(paperId)) {
    throw new Error("Invalid paper ID.");
  }

  return path.join(
    STORAGE_DIR,
    `${paperId}.pdf`
  );
}

/* =========================================
   6. FIREBASE AUTHENTICATION MIDDLEWARE
========================================= */

async function requireAuth(req, res, next) {
  try {
    const header =
      req.headers.authorization || "";

    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return sendError(
        res,
        401,
        "Authentication required."
      );
    }

    const decoded = await admin.auth().verifyIdToken(
      match[1]
    );

    req.user = decoded;

    next();

  } catch (error) {
    console.error(
      "Authentication error:",
      error.message
    );

    return sendError(
      res,
      401,
      "Invalid or expired login session."
    );
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.uid) {
    return sendError(
      res,
      401,
      "Authentication required."
    );
  }

  if (!ADMIN_UIDS.has(req.user.uid)) {
    return sendError(
      res,
      403,
      "Admin access denied."
    );
  }

  next();
}

function requireRazorpay(res) {
  if (!razorpay) {
    sendError(
      res,
      503,
      "Payment gateway is not configured."
    );

    return false;
  }

  return true;
}

/* =========================================
   7. DATABASE HELPERS
========================================= */

async function getSeries(seriesId) {
  const snapshot = await db
    .ref(`testSeries/${seriesId}`)
    .get();

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.val();
}

async function getPaper(paperId) {
  const snapshot = await db
    .ref(`questionPapers/${paperId}`)
    .get();

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.val();
}

async function hasPaperAccess(uid, seriesId) {
  if (!uid || !seriesId) return false;

  const snapshot = await db
    .ref(`purchases/${uid}/${seriesId}`)
    .get();

  if (!snapshot.exists()) return false;

  return snapshot.val()?.status === "active";
}

async function getPurchasedSeries(uid) {
  const snapshot = await db
    .ref(`purchases/${uid}`)
    .get();

  return snapshot.exists()
    ? snapshot.val()
    : {};
}

async function grantPurchase({
  uid,
  seriesId,
  paymentId,
  orderId,
  amountPaise
}) {
  const series = await getSeries(seriesId);

  if (!series || series.active === false) {
    throw new Error(
      "This Test Series is not available."
    );
  }

  const expectedAmount = safeNumber(
    series.pricePaise
  );

  if (
    expectedAmount !== safeNumber(amountPaise)
  ) {
    throw new Error(
      "Payment amount does not match the Test Series price."
    );
  }

  const purchaseRef = db.ref(
    `purchases/${uid}/${seriesId}`
  );

  const existing = await purchaseRef.get();

  if (
    existing.exists() &&
    existing.val()?.status === "active"
  ) {
    return existing.val();
  }

  const purchase = {
    status: "active",

    amountPaise: expectedAmount,

    currency: "INR",

    paymentId,

    orderId,

    purchasedAt: getNow()
  };

  await purchaseRef.set(purchase);

  return purchase;
}

/* =========================================
   8. PROFILE HELPERS
========================================= */

async function getProfileData(uid) {
  const user = await admin.auth().getUser(uid);

  const profileSnapshot = await db
    .ref(`studentProfiles/${uid}`)
    .get();

  const profile = profileSnapshot.exists()
    ? profileSnapshot.val()
    : {};

  const purchases = await getPurchasedSeries(uid);

  const activePurchases = Object.values(
    purchases
  ).filter(item =>
    item?.status === "active"
  );

  const totalPaidPaise = activePurchases.reduce(
    (sum, item) =>
      sum + safeNumber(item.amountPaise),
    0
  );

  return {
    uid,

    displayName:
      profile.displayName ||
      user.displayName ||
      "",

    email:
      user.email || "",

    photoURL:
      profile.photoURL ||
      user.photoURL ||
      "",

    emailVerified:
      Boolean(user.emailVerified),

    disabled:
      Boolean(user.disabled),

    createdAt:
      user.metadata?.creationTime || null,

    lastSignInAt:
      user.metadata?.lastSignInTime || null,

    purchaseCount:
      activePurchases.length,

    totalPaidPaise
  };
}

/* =========================================
   9. SERIES BODY VALIDATION
========================================= */

function normalizeSeriesBody(body = {}) {
  const title = cleanString(body.title, 200);

  const description = cleanString(
    body.description,
    3000
  );

  const className = cleanString(
    body.className,
    100
  );

  const subject = cleanString(
    body.subject,
    150
  );

  let pricePaise;

  if (body.pricePaise !== undefined) {
    pricePaise = safeNumber(body.pricePaise, -1);
  } else if (body.priceRupees !== undefined) {
    pricePaise = Math.round(
      safeNumber(body.priceRupees, -1) * 100
    );
  } else {
    pricePaise = Math.round(
      safeNumber(body.price, -1) * 100
    );
  }

  const testCount = Math.floor(
    safeNumber(body.testCount, 0)
  );

  const active =
    body.active === undefined
      ? true
      : body.active === true;

  if (!title) {
    throw new Error("Series title is required.");
  }

  if (!className) {
    throw new Error("Class is required.");
  }

  if (!subject) {
    throw new Error("Subject is required.");
  }

  if (
    !Number.isInteger(pricePaise) ||
    pricePaise < 0
  ) {
    throw new Error("Invalid series price.");
  }

  if (testCount < 0 || testCount > 10000) {
    throw new Error("Invalid test count.");
  }

  return {
    title,
    description,
    className,
    subject,
    pricePaise,
    testCount,
    active
  };
}

/* =========================================
   10. MCQ QUESTION VALIDATION
========================================= */

function normalizeQuestions(input) {
  if (!Array.isArray(input)) {
    throw new Error("Questions must be an array.");
  }

  if (input.length < 1 || input.length > 500) {
    throw new Error(
      "A paper must contain between 1 and 500 questions."
    );
  }

  return input.map((item, index) => {
    const question = cleanString(
      item.question,
      5000
    );

    const options = Array.isArray(item.options)
      ? item.options.map(option =>
          cleanString(option, 1000)
        )
      : [];

    const correctIndex = Number(
      item.correctIndex
    );

    if (!question) {
      throw new Error(
        `Question ${index + 1} is empty.`
      );
    }

    if (
      options.length !== 4 ||
      options.some(option => !option)
    ) {
      throw new Error(
        `Question ${index + 1} must have four options.`
      );
    }

    if (
      !Number.isInteger(correctIndex) ||
      correctIndex < 0 ||
      correctIndex > 3
    ) {
      throw new Error(
        `Question ${index + 1} has an invalid correct answer.`
      );
    }

    return {
      id: cleanString(
        item.id,
        100
      ) || makeId("q"),

      question,

      options,

      correctIndex,

      explanation: cleanString(
        item.explanation,
        3000
      )
    };
  });
}

/* =========================================
   11. PUBLIC TEST SERIES
========================================= */

app.get("/api/series", async (req, res) => {
  try {
    const snapshot = await db
      .ref("testSeries")
      .get();

    const data = snapshot.exists()
      ? snapshot.val()
      : {};

    const series = Object.entries(data)
      .map(([id, item]) =>
        safeSeries(item, id)
      )
      .filter(item =>
        item && item.active !== false
      );

    res.json({
      ok: true,
      series,

      razorpayKeyId:
        RAZORPAY_KEY_ID || null
    });

  } catch (error) {
    console.error("Series error:", error);

    sendError(
      res,
      500,
      "Unable to load Test Series."
    );
  }
});

/* =========================================
   12. STUDENT PROFILE
========================================= */

app.get(
  "/api/profile",
  requireAuth,
  async (req, res) => {
    try {
      const profile = await getProfileData(
        req.user.uid
      );

      res.json({
        ok: true,
        ...profile
      });

    } catch (error) {
      console.error("Profile error:", error);

      sendError(
        res,
        500,
        "Unable to load profile."
      );
    }
  }
);

app.put(
  "/api/profile",
  requireAuth,
  async (req, res) => {
    try {
      const displayName = cleanString(
        req.body.displayName,
        100
      );

      if (displayName.length < 2) {
        return sendError(
          res,
          400,
          "Name must contain at least 2 characters."
        );
      }

      await admin.auth().updateUser(
        req.user.uid,
        {
          displayName
        }
      );

      await db
        .ref(`studentProfiles/${req.user.uid}`)
        .update({
          displayName,
          updatedAt: getNow()
        });

      const profile = await getProfileData(
        req.user.uid
      );

      res.json({
        ok: true,
        ...profile
      });

    } catch (error) {
      console.error("Profile update error:", error);

      sendError(
        res,
        500,
        "Unable to update profile."
      );
    }
  }
);

/* =========================================
   13. MY PURCHASED SERIES
========================================= */

app.get(
  "/api/my-series",
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.user.uid;

      const purchases = await getPurchasedSeries(uid);

      const seriesSnapshot = await db
        .ref("testSeries")
        .get();

      const allSeries = seriesSnapshot.exists()
        ? seriesSnapshot.val()
        : {};

      const series = Object.entries(purchases)
        .filter(([id, purchase]) =>
          purchase?.status === "active" &&
          allSeries[id]
        )
        .map(([id, purchase]) => ({
          ...safeSeries(allSeries[id], id),

          purchase: {
            status: purchase.status,

            purchasedAt: purchase.purchasedAt || null,

            paymentId: purchase.paymentId || null,

            amountPaise: safeNumber(
              purchase.amountPaise
            ),

            currency: purchase.currency || "INR"
          }
        }));

      res.json({
        ok: true,
        series
      });

    } catch (error) {
      console.error("My series error:", error);

      sendError(
        res,
        500,
        "Unable to load purchased series."
      );
    }
  }
);

/* =========================================
   14. MY PAYMENT HISTORY
========================================= */

app.get(
  "/api/my-purchases",
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.user.uid;

      const purchases = await getPurchasedSeries(uid);

      const seriesSnapshot = await db
        .ref("testSeries")
        .get();

      const seriesData = seriesSnapshot.exists()
        ? seriesSnapshot.val()
        : {};

      const result = Object.entries(purchases)
        .filter(([, purchase]) =>
          purchase?.status === "active"
        )
        .map(([seriesId, purchase]) => ({
          seriesId,

          seriesTitle:
            seriesData[seriesId]?.title ||
            "Test Series",

          paymentId:
            purchase.paymentId || null,

          orderId:
            purchase.orderId || null,

          amountPaise:
            safeNumber(purchase.amountPaise),

          currency:
            purchase.currency || "INR",

          purchasedAt:
            purchase.purchasedAt || null,

          status:
            purchase.status
        }));

      result.sort(
        (a, b) =>
          safeNumber(b.purchasedAt) -
          safeNumber(a.purchasedAt)
      );

      res.json({
        ok: true,
        purchases: result
      });

    } catch (error) {
      console.error("Payment history error:", error);

      sendError(
        res,
        500,
        "Unable to load payment history."
      );
    }
  }
);

/* =========================================
   15. CREATE RAZORPAY ORDER
========================================= */

app.post(
  "/api/create-order",
  requireAuth,
  async (req, res) => {
    try {
      if (!requireRazorpay(res)) return;

      const seriesId = cleanString(
        req.body.seriesId,
        180
      );

      if (!isValidId(seriesId)) {
        return sendError(
          res,
          400,
          "Invalid Test Series ID."
        );
      }

      const series = await getSeries(seriesId);

      if (!series || series.active === false) {
        return sendError(
          res,
          404,
          "Test Series is not available."
        );
      }

      const alreadyPurchased = await hasPaperAccess(
        req.user.uid,
        seriesId
      );

      if (alreadyPurchased) {
        return sendError(
          res,
          409,
          "You have already purchased this Test Series."
        );
      }

      const amount = safeNumber(
        series.pricePaise
      );

      if (
        !Number.isInteger(amount) ||
        amount <= 0
      ) {
        return sendError(
          res,
          400,
          "Invalid Test Series price."
        );
      }

      const order = await razorpay.orders.create({
        amount,

        currency: "INR",

        receipt: makeId("receipt"),

        notes: {
          uid: req.user.uid,
          seriesId
        }
      });

      await db
        .ref(`paymentOrders/${order.id}`)
        .set({
          uid: req.user.uid,

          seriesId,

          amountPaise: amount,

          currency: "INR",

          status: "created",

          createdAt: getNow()
        });

      res.json({
        ok: true,

        orderId: order.id,

        amount: order.amount,

        currency: order.currency,

        keyId: RAZORPAY_KEY_ID,

        name: "BIHAR ACADEMIC BATTLE",

        description: series.title
      });

    } catch (error) {
      console.error("Create order error:", error);

      sendError(
        res,
        500,
        error.message || "Unable to create payment order."
      );
    }
  }
);

/* =========================================
   16. VERIFY RAZORPAY PAYMENT
========================================= */

app.post(
  "/api/verify-payment",
  requireAuth,
  async (req, res) => {
    try {
      if (!requireRazorpay(res)) return;

      const orderId = cleanString(
        req.body.razorpay_order_id,
        200
      );

      const paymentId = cleanString(
        req.body.razorpay_payment_id,
        200
      );

      const signature = cleanString(
        req.body.razorpay_signature,
        300
      );

      if (!orderId || !paymentId || !signature) {
        return sendError(
          res,
          400,
          "Payment details are incomplete."
        );
      }

      const orderSnapshot = await db
        .ref(`paymentOrders/${orderId}`)
        .get();

      if (!orderSnapshot.exists()) {
        return sendError(
          res,
          404,
          "Payment order not found."
        );
      }

      const orderData = orderSnapshot.val();

      if (orderData.uid !== req.user.uid) {
        return sendError(
          res,
          403,
          "This payment order does not belong to your account."
        );
      }

      const expectedSignature = crypto
        .createHmac(
          "sha256",
          RAZORPAY_KEY_SECRET
        )
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      const suppliedBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (
        suppliedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(
          suppliedBuffer,
          expectedBuffer
        )
      ) {
        return sendError(
          res,
          400,
          "Payment signature verification failed."
        );
      }

      // Fetch payment directly from Razorpay.
      const payment = await razorpay.payments.fetch(
        paymentId
      );

      if (payment.order_id !== orderId) {
        return sendError(
          res,
          400,
          "Payment order mismatch."
        );
      }

      if (
        safeNumber(payment.amount) !==
        safeNumber(orderData.amountPaise)
      ) {
        return sendError(
          res,
          400,
          "Payment amount mismatch."
        );
      }

      if (payment.currency !== "INR") {
        return sendError(
          res,
          400,
          "Invalid payment currency."
        );
      }

      if (payment.status !== "captured") {
        return sendError(
          res,
          409,
          "Payment is not captured yet."
        );
      }

      const purchase = await grantPurchase({
        uid: req.user.uid,

        seriesId: orderData.seriesId,

        paymentId,

        orderId,

        amountPaise: payment.amount
      });

      await db
        .ref(`paymentOrders/${orderId}`)
        .update({
          status: "paid",

          paymentId,

          verifiedAt: getNow()
        });

      res.json({
        ok: true,

        message: "Payment verified successfully.",

        purchase
      });

    } catch (error) {
      console.error("Verify payment error:", error);

      sendError(
        res,
        500,
        error.message || "Payment verification failed."
      );
    }
  }
);

/* =========================================
   17. STUDENT SERIES ACCESS
========================================= */

app.get(
  "/api/access/:seriesId",
  requireAuth,
  async (req, res) => {
    try {
      const seriesId = req.params.seriesId;

      if (!isValidId(seriesId)) {
        return sendError(
          res,
          400,
          "Invalid series ID."
        );
      }

      const allowed = await hasPaperAccess(
        req.user.uid,
        seriesId
      );

      if (!allowed) {
        return res.status(403).json({
          ok: false,

          allowed: false,

          error: "Purchase required to access this Test Series."
        });
      }

      const series = await getSeries(seriesId);

      if (!series) {
        return sendError(
          res,
          404,
          "Test Series not found."
        );
      }

      const papersSnapshot = await db
        .ref("questionPapers")
        .get();

      const allPapers = papersSnapshot.exists()
        ? papersSnapshot.val()
        : {};

      const papers = Object.entries(allPapers)
        .filter(([, paper]) =>
          paper.seriesId === seriesId &&
          paper.status === "published"
        )
        .map(([id, paper]) =>
          safePaper(paper, id)
        );

      res.json({
        ok: true,

        allowed: true,

        series: safeSeries(series, seriesId),

        papers
      });

    } catch (error) {
      console.error("Access error:", error);

      sendError(
        res,
        500,
        "Unable to load Test Series."
      );
    }
  }
);

/* =========================================
   18. ADMIN SERIES LIST
========================================= */

app.get(
  "/api/admin/series",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot = await db
        .ref("testSeries")
        .get();

      const data = snapshot.exists()
        ? snapshot.val()
        : {};

      const series = Object.entries(data)
        .map(([id, item]) =>
          safeSeries(item, id)
        )
        .filter(Boolean);

      res.json({
        ok: true,
        series
      });

    } catch (error) {
      console.error("Admin series error:", error);

      sendError(
        res,
        500,
        "Unable to load Admin Series."
      );
    }
  }
);

/* =========================================
   19. ADMIN CREATE SERIES
========================================= */

app.post(
  "/api/admin/series",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const payload = normalizeSeriesBody(
        req.body
      );

      const id = req.body.id
        ? cleanString(req.body.id, 180)
        : makeId("series");

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Series ID."
        );
      }

      const ref = db.ref(
        `testSeries/${id}`
      );

      const existing = await ref.get();

      if (existing.exists()) {
        return sendError(
          res,
          409,
          "This Series ID already exists."
        );
      }

      const now = getNow();

      await ref.set({
        ...payload,

        createdAt: now,

        updatedAt: now
      });

      res.status(201).json({
        ok: true,

        id,

        series: safeSeries(
          {
            ...payload,
            createdAt: now,
            updatedAt: now
          },
          id
        )
      });

    } catch (error) {
      console.error("Create series error:", error);

      sendError(
        res,
        400,
        error.message || "Unable to create series."
      );
    }
  }
);

/* =========================================
   20. ADMIN UPDATE SERIES
========================================= */

app.put(
  "/api/admin/series/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Series ID."
        );
      }

      const ref = db.ref(
        `testSeries/${id}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Series not found."
        );
      }

      const payload = normalizeSeriesBody(
        req.body
      );

      const existing = snapshot.val();

      await ref.update({
        ...payload,

        createdAt:
          existing.createdAt || getNow(),

        updatedAt: getNow()
      });

      const updated = await ref.get();

      res.json({
        ok: true,

        series: safeSeries(
          updated.val(),
          id
        )
      });

    } catch (error) {
      console.error("Update series error:", error);

      sendError(
        res,
        400,
        error.message || "Unable to update series."
      );
    }
  }
);

/* =========================================
   21. ADMIN DISABLE SERIES
========================================= */

app.delete(
  "/api/admin/series/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Series ID."
        );
      }

      const ref = db.ref(
        `testSeries/${id}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Series not found."
        );
      }

      await ref.update({
        active: false,
        updatedAt: getNow()
      });

      res.json({
        ok: true,
        message: "Series disabled successfully."
      });

    } catch (error) {
      console.error("Disable series error:", error);

      sendError(
        res,
        500,
        "Unable to disable series."
      );
    }
  }
);

/* =========================================
   22. ADMIN TOGGLE SERIES
========================================= */

app.post(
  "/api/admin/series/:id/toggle",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Series ID."
        );
      }

      if (typeof req.body.active !== "boolean") {
        return sendError(
          res,
          400,
          "active must be true or false."
        );
      }

      const ref = db.ref(
        `testSeries/${id}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Series not found."
        );
      }

      await ref.update({
        active: req.body.active,
        updatedAt: getNow()
      });

      res.json({
        ok: true,
        active: req.body.active
      });

    } catch (error) {
      console.error("Toggle series error:", error);

      sendError(
        res,
        500,
        "Unable to update series status."
      );
    }
  }
);

/* =========================================
   23. ADMIN PAPER LIST
========================================= */

app.get(
  "/api/admin/papers",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot = await db
        .ref("questionPapers")
        .get();

      const data = snapshot.exists()
        ? snapshot.val()
        : {};

      const papers = Object.entries(data)
        .map(([id, paper]) => ({
          ...safePaper(paper, id),

          questions:
            Array.isArray(paper.questions)
              ? paper.questions
              : []
        }))
        .filter(Boolean);

      res.json({
        ok: true,
        papers
      });

    } catch (error) {
      console.error("Admin papers error:", error);

      sendError(
        res,
        500,
        "Unable to load papers."
      );
    }
  }
);

/* =========================================
   24. ADMIN CREATE / UPDATE MCQ PAPER
========================================= */

app.post(
  "/api/admin/papers",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const body = req.body || {};

      const title = cleanString(
        body.title,
        200
      );

      const className = cleanString(
        body.className,
        100
      );

      const subject = cleanString(
        body.subject,
        150
      );

      const seriesId = cleanString(
        body.seriesId,
        180
      );

      const durationMinutes = Math.floor(
        safeNumber(body.durationMinutes, 60)
      );

      const marksPerQuestion = safeNumber(
        body.marksPerQuestion,
        1
      );

      const instructions = cleanString(
        body.instructions,
        5000
      );

      const status = body.status === "published"
        ? "published"
        : "draft";

      if (!title || !className || !subject) {
        return sendError(
          res,
          400,
          "Title, class and subject are required."
        );
      }

      if (!isValidId(seriesId)) {
        return sendError(
          res,
          400,
          "A valid Test Series must be selected."
        );
      }

      const series = await getSeries(seriesId);

      if (!series) {
        return sendError(
          res,
          404,
          "Selected Test Series does not exist."
        );
      }

      if (
        durationMinutes < 1 ||
        durationMinutes > 1440
      ) {
        return sendError(
          res,
          400,
          "Invalid test duration."
        );
      }

      if (
        marksPerQuestion <= 0 ||
        marksPerQuestion > 100
      ) {
        return sendError(
          res,
          400,
          "Invalid marks per question."
        );
      }

      const questions = normalizeQuestions(
        body.questions
      );

      const id = body.id
        ? cleanString(body.id, 180)
        : makeId("paper");

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const ref = db.ref(
        `questionPapers/${id}`
      );

      const existingSnapshot = await ref.get();

      if (
        body.id &&
        !existingSnapshot.exists()
      ) {
        return sendError(
          res,
          404,
          "Paper to update was not found."
        );
      }

      if (
        existingSnapshot.exists() &&
        existingSnapshot.val().type === "pdf"
      ) {
        return sendError(
          res,
          400,
          "A PDF paper cannot be converted into an MCQ paper."
        );
      }

      const existing = existingSnapshot.exists()
        ? existingSnapshot.val()
        : {};

      const now = getNow();

      const paper = {
        title,

        className,

        subject,

        seriesId,

        durationMinutes,

        marksPerQuestion,

        instructions,

        type: "mcq",

        status,

        questions,

        questionCount: questions.length,

        createdAt:
          existing.createdAt || now,

        updatedAt: now
      };

      await ref.set(paper);

      res.json({
        ok: true,

        id,

        paper: safePaper(paper, id)
      });

    } catch (error) {
      console.error("Save MCQ error:", error);

      sendError(
        res,
        400,
        error.message || "Unable to save MCQ paper."
      );
    }
  }
);

/* =========================================
   25. PDF UPLOAD CONFIGURATION
========================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },

  fileFilter(req, file, callback) {
    const isPdf =
      file.mimetype === "application/pdf" &&
      file.originalname
        .toLowerCase()
        .endsWith(".pdf");

    if (!isPdf) {
      return callback(
        new Error("Only PDF files are allowed.")
      );
    }

    callback(null, true);
  }
});

/* =========================================
   26. ADMIN PDF METADATA
========================================= */

app.post(
  "/api/admin/papers/pdf-metadata",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const body = req.body || {};

      const title = cleanString(
        body.title,
        200
      );

      const className = cleanString(
        body.className,
        100
      );

      const subject = cleanString(
        body.subject,
        150
      );

      const seriesId = cleanString(
        body.seriesId,
        180
      );

      const durationMinutes = Math.floor(
        safeNumber(body.durationMinutes, 60)
      );

      const instructions = cleanString(
        body.instructions,
        5000
      );

      if (!title || !className || !subject) {
        return sendError(
          res,
          400,
          "Title, class and subject are required."
        );
      }

      if (!isValidId(seriesId)) {
        return sendError(
          res,
          400,
          "A valid Test Series must be selected."
        );
      }

      const series = await getSeries(seriesId);

      if (!series) {
        return sendError(
          res,
          404,
          "Test Series not found."
        );
      }

      if (
        durationMinutes < 1 ||
        durationMinutes > 1440
      ) {
        return sendError(
          res,
          400,
          "Invalid duration."
        );
      }

      const id = req.body.id
        ? cleanString(req.body.id, 180)
        : makeId("pdf");

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const ref = db.ref(
        `questionPapers/${id}`
      );

      const existingSnapshot = await ref.get();

      if (
        req.body.id &&
        !existingSnapshot.exists()
      ) {
        return sendError(
          res,
          404,
          "PDF paper not found."
        );
      }

      const existing = existingSnapshot.exists()
        ? existingSnapshot.val()
        : {};

      if (
        existingSnapshot.exists() &&
        existing.type !== "pdf"
      ) {
        return sendError(
          res,
          400,
          "This paper is not a PDF paper."
        );
      }

      const now = getNow();

      const paper = {
        title,

        className,

        subject,

        seriesId,

        durationMinutes,

        marksPerQuestion: 0,

        instructions,

        type: "pdf",

        status: existing.status || "draft",

        pdf: existing.pdf || null,

        questionCount: 0,

        createdAt:
          existing.createdAt || now,

        updatedAt: now
      };

      await ref.set(paper);

      res.json({
        ok: true,

        id,

        paper: safePaper(paper, id)
      });

    } catch (error) {
      console.error("PDF metadata error:", error);

      sendError(
        res,
        400,
        error.message || "Unable to save PDF details."
      );
    }
  }
);

/* =========================================
   27. ADMIN UPLOAD PDF FILE
========================================= */

app.post(
  "/api/admin/papers/:id/pdf",
  requireAuth,
  requireAdmin,
  (req, res, next) => {
    upload.single("pdf")(req, res, error => {
      if (error) {
        return sendError(
          res,
          400,
          error.message || "PDF upload failed."
        );
      }

      next();
    });
  },
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      if (!req.file) {
        return sendError(
          res,
          400,
          "PDF file is required."
        );
      }

      const pdfBuffer = req.file.buffer;

      // Validate actual PDF file signature.
      if (
        pdfBuffer.length < 5 ||
        pdfBuffer.subarray(0, 5).toString() !== "%PDF-"
      ) {
        return sendError(
          res,
          400,
          "The uploaded file is not a valid PDF."
        );
      }

      const ref = db.ref(
        `questionPapers/${id}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "PDF paper metadata not found."
        );
      }

      const paper = snapshot.val();

      if (paper.type !== "pdf") {
        return sendError(
          res,
          400,
          "This paper is not a PDF paper."
        );
      }

      const filePath = safeFilePath(id);

      const temporaryPath =
        `${filePath}.${crypto.randomUUID()}.tmp`;

      await fs.promises.writeFile(
        temporaryPath,
        pdfBuffer
      );

      await fs.promises.rename(
        temporaryPath,
        filePath
      );

      const fileInfo = {
        fileName: `${id}.pdf`,

        originalName: cleanString(
          path.basename(req.file.originalname),
          200
        ),

        size: pdfBuffer.length,

        mimeType: "application/pdf",

        uploadedAt: getNow()
      };

      await ref.update({
        pdf: fileInfo,

        updatedAt: getNow()
      });

      res.json({
        ok: true,

        id,

        message: "PDF uploaded successfully.",

        pdf: fileInfo
      });

    } catch (error) {
      console.error("PDF upload error:", error);

      sendError(
        res,
        500,
        "Unable to upload PDF."
      );
    }
  }
);

/* =========================================
   28. ADMIN PREVIEW PDF
========================================= */

app.get(
  "/api/admin/papers/:id/pdf",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const paper = await getPaper(id);

      if (!paper || paper.type !== "pdf" || !paper.pdf) {
        return sendError(
          res,
          404,
          "PDF not found."
        );
      }

      const filePath = safeFilePath(id);

      if (!fs.existsSync(filePath)) {
        return sendError(
          res,
          404,
          "PDF file is missing from storage."
        );
      }

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${id}.pdf"`
      );

      res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      await pipeline(
        fs.createReadStream(filePath),
        res
      );

    } catch (error) {
      console.error("Admin PDF preview error:", error);

      if (!res.headersSent) {
        sendError(
          res,
          500,
          "Unable to open PDF."
        );
      }
    }
  }
);

/* =========================================
   29. PUBLISH / UNPUBLISH PAPER
========================================= */

app.post(
  "/api/admin/papers/:id/publish",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const ref = db.ref(
        `questionPapers/${id}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Paper not found."
        );
      }

      const paper = snapshot.val();

      let published;

      if (typeof req.body.published === "boolean") {
        published = req.body.published;
      } else if (
        typeof req.body.status === "string"
      ) {
        published =
          req.body.status === "published";
      } else {
        return sendError(
          res,
          400,
          "published must be true or false."
        );
      }

      if (
        published &&
        paper.type === "pdf" &&
        !paper.pdf
      ) {
        return sendError(
          res,
          400,
          "Upload the PDF before publishing."
        );
      }

      if (
        published &&
        paper.type === "mcq" &&
        (
          !Array.isArray(paper.questions) ||
          paper.questions.length === 0
        )
      ) {
        return sendError(
          res,
          400,
          "Add questions before publishing."
        );
      }

      await ref.update({
        status: published
          ? "published"
          : "draft",

        updatedAt: getNow()
      });

      res.json({
        ok: true,

        status: published
          ? "published"
          : "draft"
      });

    } catch (error) {
      console.error("Publish paper error:", error);

      sendError(
        res,
        500,
        "Unable to update paper status."
      );
    }
  }
);

/* =========================================
   30. DELETE PAPER
========================================= */

app.delete(
  "/api/admin/papers/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const ref = db.ref(
        `questionPapers/${id}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Paper not found."
        );
      }

      const paper = snapshot.val();

      await ref.remove();

      if (paper.type === "pdf") {
        const filePath = safeFilePath(id);

        await fs.promises.rm(
          filePath,
          { force: true }
        );
      }

      res.json({
        ok: true,
        message: "Paper deleted successfully."
      });

    } catch (error) {
      console.error("Delete paper error:", error);

      sendError(
        res,
        500,
        "Unable to delete paper."
      );
    }
  }
);

/* =========================================
   31. STUDENT PAPER LIST
========================================= */

app.get(
  "/api/papers",
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.user.uid;

      const seriesId = req.query.seriesId
        ? cleanString(req.query.seriesId, 180)
        : "";

      const snapshot = await db
        .ref("questionPapers")
        .get();

      const allPapers = snapshot.exists()
        ? snapshot.val()
        : {};

      const purchases = await getPurchasedSeries(uid);

      const papers = Object.entries(allPapers)
        .filter(([id, paper]) => {
          if (paper.status !== "published") {
            return false;
          }

          if (
            seriesId &&
            paper.seriesId !== seriesId
          ) {
            return false;
          }

          return (
            purchases[paper.seriesId]?.status === "active"
          );
        })
        .map(([id, paper]) =>
          safePaper(paper, id)
        );

      res.json({
        ok: true,
        papers
      });

    } catch (error) {
      console.error("Student papers error:", error);

      sendError(
        res,
        500,
        "Unable to load papers."
      );
    }
  }
);

/* =========================================
   32. STUDENT GET MCQ QUESTIONS
========================================= */

app.get(
  "/api/papers/:id/questions",
  requireAuth,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const paper = await getPaper(id);

      if (!paper || paper.status !== "published") {
        return sendError(
          res,
          404,
          "Published paper not found."
        );
      }

      if (paper.type !== "mcq") {
        return sendError(
          res,
          400,
          "This is not an MCQ paper."
        );
      }

      const allowed = await hasPaperAccess(
        req.user.uid,
        paper.seriesId
      );

      if (!allowed) {
        return sendError(
          res,
          403,
          "Purchase required to access this paper."
        );
      }

      // Never send correctIndex to students.
      const questions = (
        Array.isArray(paper.questions)
          ? paper.questions
          : []
      ).map(question => ({
        id: question.id,

        question: question.question,

        options: question.options
      }));

      res.json({
        ok: true,

        paper: safePaper(paper, id),

        questions
      });

    } catch (error) {
      console.error("Load questions error:", error);

      sendError(
        res,
        500,
        "Unable to load questions."
      );
    }
  }
);

/* =========================================
   33. STUDENT DOWNLOAD / VIEW PDF
========================================= */

app.get(
  "/api/papers/:id/pdf",
  requireAuth,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidId(id)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const paper = await getPaper(id);

      if (
        !paper ||
        paper.type !== "pdf" ||
        paper.status !== "published" ||
        !paper.pdf
      ) {
        return sendError(
          res,
          404,
          "Published PDF not found."
        );
      }

      const allowed = await hasPaperAccess(
        req.user.uid,
        paper.seriesId
      );

      if (!allowed) {
        return sendError(
          res,
          403,
          "Purchase required to download this PDF."
        );
      }

      const filePath = safeFilePath(id);

      if (!fs.existsSync(filePath)) {
        return sendError(
          res,
          404,
          "PDF file is missing from storage."
        );
      }

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${id}.pdf"`
      );

      res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      res.setHeader(
        "Cache-Control",
        "private, no-store, no-cache, must-revalidate"
      );

      await pipeline(
        fs.createReadStream(filePath),
        res
      );

    } catch (error) {
      console.error("Student PDF error:", error);

      if (!res.headersSent) {
        sendError(
          res,
          500,
          "Unable to open PDF."
        );
      }
    }
  }
);

/* =========================================
   34. STUDENT SUBMIT MCQ TEST
========================================= */

app.post(
  "/api/papers/:id/submit",
  requireAuth,
  async (req, res) => {
    try {
      const paperId = req.params.id;

      if (!isValidId(paperId)) {
        return sendError(
          res,
          400,
          "Invalid Paper ID."
        );
      }

      const paper = await getPaper(paperId);

      if (
        !paper ||
        paper.status !== "published" ||
        paper.type !== "mcq"
      ) {
        return sendError(
          res,
          404,
          "Published MCQ paper not found."
        );
      }

      const allowed = await hasPaperAccess(
        req.user.uid,
        paper.seriesId
      );

      if (!allowed) {
        return sendError(
          res,
          403,
          "Purchase required to submit this test."
        );
      }

      const questions = Array.isArray(paper.questions)
        ? paper.questions
        : [];

      if (!questions.length) {
        return sendError(
          res,
          400,
          "This test has no questions."
        );
      }

      const submittedAnswers = req.body.answers;

      if (!Array.isArray(submittedAnswers)) {
        return sendError(
          res,
          400,
          "Answers must be an array."
        );
      }

      if (submittedAnswers.length > questions.length) {
        return sendError(
          res,
          400,
          "Too many answers were submitted."
        );
      }

      const answerMap = new Map();

      for (const item of submittedAnswers) {
        const index = Number(item.questionIndex);
        const answer = item.answer;

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= questions.length
        ) {
          return sendError(
            res,
            400,
            "Invalid question index."
          );
        }

        if (answer === null || answer === undefined) {
          continue;
        }

        const answerIndex = Number(answer);

        if (
          !Number.isInteger(answerIndex) ||
          answerIndex < 0 ||
          answerIndex > 3
        ) {
          return sendError(
            res,
            400,
            "Invalid answer option."
          );
        }

        if (answerMap.has(index)) {
          return sendError(
            res,
            400,
            "Duplicate answer for a question."
          );
        }

        answerMap.set(index, answerIndex);
      }

      let correct = 0;
      let attempted = 0;

      questions.forEach((question, index) => {
        if (!answerMap.has(index)) {
          return;
        }

        attempted++;

        if (
          answerMap.get(index) ===
          Number(question.correctIndex)
        ) {
          correct++;
        }
      });

      const marksPerQuestion = safeNumber(
        paper.marksPerQuestion,
        1
      );

      const score = correct * marksPerQuestion;

      const totalMarks =
        questions.length * marksPerQuestion;

      const attemptId = makeId("attempt");

      const attempt = {
        attemptId,

        paperId,

        paperTitle: paper.title || "",

        seriesId: paper.seriesId,

        uid: req.user.uid,

        attempted,

        correct,

        totalQuestions: questions.length,

        marksPerQuestion,

        score,

        totalMarks,

        submittedAt: getNow(),

        answers: Array.from(
          answerMap.entries()
        ).map(([questionIndex, answer]) => ({
          questionIndex,
          answer
        }))
      };

      await db
        .ref(
          `testAttempts/${req.user.uid}/${attemptId}`
        )
        .set(attempt);

      res.json({
        ok: true,

        message: "Test submitted successfully.",

        attemptId,

        score,

        totalMarks,

        correct,

        attempted,

        totalQuestions: questions.length
      });

    } catch (error) {
      console.error("Test submit error:", error);

      sendError(
        res,
        500,
        "Unable to submit test."
      );
    }
  }
);

/* =========================================
   35. ADMIN PURCHASES
========================================= */

app.get(
  "/api/admin/purchases",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const [purchasesSnapshot, seriesSnapshot] =
        await Promise.all([
          db.ref("purchases").get(),
          db.ref("testSeries").get()
        ]);

      const purchasesData =
        purchasesSnapshot.exists()
          ? purchasesSnapshot.val()
          : {};

      const seriesData =
        seriesSnapshot.exists()
          ? seriesSnapshot.val()
          : {};

      const purchases = [];

      for (
        const [uid, userPurchases]
        of Object.entries(purchasesData)
      ) {
        if (
          !userPurchases ||
          typeof userPurchases !== "object"
        ) {
          continue;
        }

        let email = "";

        try {
          const user = await admin.auth().getUser(uid);

          email = user.email || "";
        } catch {
          email = "";
        }

        for (
          const [seriesId, purchase]
          of Object.entries(userPurchases)
        ) {
          if (!purchase) continue;

          purchases.push({
            uid,

            email,

            seriesId,

            seriesTitle:
              seriesData[seriesId]?.title ||
              "Test Series",

            paymentId:
              purchase.paymentId || null,

            orderId:
              purchase.orderId || null,

            amountPaise:
              safeNumber(purchase.amountPaise),

            currency:
              purchase.currency || "INR",

            purchasedAt:
              purchase.purchasedAt || null,

            status:
              purchase.status || "unknown"
          });
        }
      }

      purchases.sort(
        (a, b) =>
          safeNumber(b.purchasedAt) -
          safeNumber(a.purchasedAt)
      );

      res.json({
        ok: true,
        purchases
      });

    } catch (error) {
      console.error("Admin purchases error:", error);

      sendError(
        res,
        500,
        "Unable to load purchases."
      );
    }
  }
);

/* =========================================
   36. ADMIN STUDENTS
========================================= */

app.get(
  "/api/admin/users",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const users = [];

      let pageToken;

      const maxPages = 20;

      for (
        let page = 0;
        page < maxPages;
        page++
      ) {
        const result = await admin.auth().listUsers(
          1000,
          pageToken
        );

        const userRecords = result.users;

        for (const user of userRecords) {
          const uid = user.uid;

          const [profileSnapshot, purchasesSnapshot] =
            await Promise.all([
              db.ref(`studentProfiles/${uid}`).get(),
              db.ref(`purchases/${uid}`).get()
            ]);

          const profile = profileSnapshot.exists()
            ? profileSnapshot.val()
            : {};

          const purchases = purchasesSnapshot.exists()
            ? purchasesSnapshot.val()
            : {};

          const activePurchases = Object.values(
            purchases
          ).filter(item =>
            item?.status === "active"
          );

          const totalPaidPaise =
            activePurchases.reduce(
              (sum, item) =>
                sum + safeNumber(item.amountPaise),
              0
            );

          users.push({
            uid,

            displayName:
              profile.displayName ||
              user.displayName ||
              "",

            email:
              user.email || "",

            emailVerified:
              Boolean(user.emailVerified),

            disabled:
              Boolean(user.disabled),

            createdAt:
              user.metadata?.creationTime || null,

            lastSignInAt:
              user.metadata?.lastSignInTime || null,

            purchaseCount:
              activePurchases.length,

            totalPaidPaise
          });
        }

        pageToken = result.pageToken;

        if (!pageToken) break;
      }

      res.json({
        ok: true,

        totalStudents: users.length,

        users
      });

    } catch (error) {
      console.error("Admin users error:", error);

      sendError(
        res,
        500,
        "Unable to load students."
      );
    }
  }
);

/* =========================================
   37. ADMIN TEST ATTEMPTS
========================================= */

app.get(
  "/api/admin/attempts",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot = await db
        .ref("testAttempts")
        .get();

      const data = snapshot.exists()
        ? snapshot.val()
        : {};

      const attempts = [];

      for (
        const [uid, userAttempts]
        of Object.entries(data)
      ) {
        for (
          const [attemptId, attempt]
          of Object.entries(userAttempts || {})
        ) {
          attempts.push({
            ...attempt,
            uid,
            attemptId
          });
        }
      }

      attempts.sort(
        (a, b) =>
          safeNumber(b.submittedAt) -
          safeNumber(a.submittedAt)
      );

      res.json({
        ok: true,
        attempts
      });

    } catch (error) {
      console.error("Admin attempts error:", error);

      sendError(
        res,
        500,
        "Unable to load test attempts."
      );
    }
  }
);

/* =========================================
   38. HEALTH CHECK
========================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,

    service: "BIHAR ACADEMIC BATTLE API",

    timestamp: getNow()
  });
});

/* =========================================
   39. API NOT FOUND
========================================= */

app.use("/api", (req, res) => {
  sendError(
    res,
    404,
    "API endpoint not found."
  );
});

/* =========================================
   40. GENERAL ERROR HANDLER
========================================= */

app.use((error, req, res, next) => {
  console.error(
    "Server error:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  sendError(
    res,
    500,
    "Internal server error."
  );
});

/* =========================================
   41. FRONTEND FALLBACK
========================================= */

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }

  const indexPath = path.join(
    PUBLIC_DIR,
    "index.html"
  );

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.status(404).send(
    "Frontend index.html not found in public folder."
  );
});

/* =========================================
   42. START SERVER
========================================= */

app.listen(PORT, () => {
  console.log(
    `BIHAR ACADEMIC BATTLE server running on port ${PORT}`
  );

  console.log(
    `PDF storage directory: ${STORAGE_DIR}`
  );

  console.log(
    `Admin UID count: ${ADMIN_UIDS.size}`
  );

  console.log(
    `Razorpay configured: ${Boolean(razorpay)}`
  );
});