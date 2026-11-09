import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

// ============================================================
// BIHAR ACADEMIC BATTLE — TEST SERIES STORE
// File: public/app.js
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBO6-Qq6Yh6E4ECx9BXGySqzC8J2zdHYzs",
  authDomain: "babbihar-23fcc.firebaseapp.com",
  databaseURL: "https://babbihar-23fcc-default-rtdb.firebaseio.com",
  projectId: "babbihar-23fcc",
  storageBucket: "babbihar-23fcc.firebasestorage.app",
  messagingSenderId: "310810953638",
  appId: "1:310810953638:web:cbaafbf43b5cfd2dffb167",
  measurementId: "G-43J5L0K1MZ"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const $ = id => document.getElementById(id);

let currentUser = null;
let catalogue = [];
let adminSeriesCache = [];
let allAdminPapers = [];
let currentSeries = null;

let authResolved = false;
let resolveAuthReady;
const authReady = new Promise(resolve => {
  resolveAuthReady = resolve;
});

// ============================================================
// AUTH TOKEN
// ============================================================

window.BAB_GET_ID_TOKEN = async function () {
  const user =
    auth.currentUser ||
    currentUser ||
    (authResolved ? null : await authReady);

  if (!user) {
    throw new Error("पहले अपने Firebase account से login करें।");
  }
  return user.getIdToken();
};

// ============================================================
// HELPERS
// ============================================================

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function money(paise) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format((Number(paise) || 0) / 100);
}

function notice(message, type = "error") {
  const element = $("notice");
  if (!element) {
    console[type === "error" ? "error" : "log"](message);
    alert(message);
    return;
  }
  element.textContent = String(message ?? "");
  element.className = type;
  element.style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearNotice() {
  const element = $("notice");
  if (!element) return;
  element.textContent = "";
  element.style.display = "none";
  element.className = "";
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value ?? "");
}

function setHidden(id, hidden) {
  $(id)?.classList.toggle("hidden", Boolean(hidden));
}

function setBusy(button, busy, busyText = "Please wait…") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent || "";
    }
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent || "";
    button.disabled = false;
    delete button.dataset.originalText;
  }
}

function authError(error) {
  const messages = {
    "auth/invalid-email": "सही email address दर्ज करें।",
    "auth/missing-password": "Password दर्ज करें।",
    "auth/weak-password": "कम से कम 6 characters का password रखें।",
    "auth/email-already-in-use": "इस email से account पहले से मौजूद है।",
    "auth/invalid-credential": "Email या password गलत है।",
    "auth/user-not-found": "इस email से account नहीं मिला।",
    "auth/wrong-password": "Password गलत है।",
    "auth/too-many-requests": "कुछ देर बाद दोबारा कोशिश करें।",
    "auth/network-request-failed": "Internet connection जाँचें।"
  };
  return messages[error?.code] || error?.message || "Authentication में समस्या आई।";
}

// ============================================================
// API HELPER
// ============================================================

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;

  if (options.body && !isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const user = auth.currentUser || currentUser || (authResolved ? null : await authReady);
  if (user) {
    headers.Authorization = `Bearer ${await user.getIdToken()}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    cache: options.cache || "no-store"
  });

  const contentType = response.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await response.json().catch(() => ({}));
  } else {
    data = await response.text().catch(() => "");
  }

  if (!response.ok) {
    const message = typeof data === "object"
      ? (data.error || data.message || `Request failed (${response.status})`)
      : (data || `Request failed (${response.status})`);
    throw new Error(message);
  }
  return data;
}

// ============================================================
// PRIVATE PDF
// ============================================================

function showPdfError(message) {
  const box = $("pdf-error");
  if (box) {
    box.textContent = String(message);
    box.hidden = false;
  } else {
    notice(message);
  }
}

window.openQuestionPaperPDF = async function (paperId) {
  let tab = null;
  let objectUrl = null;
  try {
    const id = String(paperId || "");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      throw new Error("Question paper ID सही नहीं है।");
    }

    tab = window.open("about:blank", "_blank");
    const token = await window.BAB_GET_ID_TOKEN();

    const response = await fetch(`/api/papers/${encodeURIComponent(id)}/pdf`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store"
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `PDF request failed: ${response.status}`);
    }

    const blob = await response.blob();
    const contentType = response.headers.get("content-type") || blob.type;
    if (!contentType.includes("application/pdf")) {
      throw new Error("Server ने PDF नहीं भेजी। Backend API route जाँचें।");
    }

    objectUrl = URL.createObjectURL(blob);
    if (tab && !tab.closed) {
      tab.location.href = objectUrl;
    } else {
      const link = document.createElement("a");
      link.href = objectUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.click();
    }

    setTimeout(() => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }, 120000);
  } catch (error) {
    if (tab && !tab.closed) tab.close();
    showPdfError(`Question paper नहीं खुला: ${error.message}`);
  }
};

// ============================================================
// NAVIGATION
// ============================================================

function showView(view) {
  if ((view === "mine" || view === "admin") && !currentUser) {
    notice("पहले अपने account में sign in करें।");
    return;
  }

  setHidden("storeView", view !== "store");
  setHidden("mineView", view !== "mine");
  setHidden("adminView", view !== "admin");

  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  if (view === "store") loadCatalogue();
  if (view === "mine") loadMine();
  if (view === "admin") loadAdmin();
}

document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

// ============================================================
// LOGIN / SIGNUP / RESET
// ============================================================

$("loginBtn")?.addEventListener("click", async event => {
  clearNotice();
  const button = event.currentTarget;
  const email = ($("email")?.value || "").trim();
  const password = $("password")?.value || "";

  if (!email || !password) return notice("Email और password दोनों दर्ज करें।");

  setBusy(button, true, "Signing in…");
  try {
    await signInWithEmailAndPassword(auth, email, password);
    notice("Login successful.", "success");
  } catch (error) {
    notice(authError(error));
  } finally {
    setBusy(button, false);
  }
});

$("signupBtn")?.addEventListener("click", async event => {
  clearNotice();
  const button = event.currentTarget;
  const email = ($("email")?.value || "").trim();
  const password = $("password")?.value || "";

  if (!email || !password) return notice("Email और password दर्ज करें।");
  if (password.length < 6) return notice("Password कम से कम 6 characters का होना चाहिए।");

  setBusy(button, true, "Creating account…");
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    notice("Account बन गया है।", "success");
  } catch (error) {
    notice(authError(error));
  } finally {
    setBusy(button, false);
  }
});

$("resetBtn")?.addEventListener("click", async event => {
  const email = ($("email")?.value || "").trim();
  if (!email) return notice("पहले अपना email address दर्ज करें।");

  const button = event.currentTarget;
  setBusy(button, true, "Sending…");
  try {
    await sendPasswordResetEmail(auth, email);
    notice("यदि email registered है, तो reset link भेज दिया गया है।", "success");
  } catch (error) {
    notice(authError(error));
  } finally {
    setBusy(button, false);
  }
});

// ============================================================
// CATALOGUE
// ============================================================

async function loadCatalogue() {
  const host = $("seriesGrid");
  if (!host) return;

  host.innerHTML = `<div class="empty">Loading test series…</div>`;
  try {
    const data = await api("/api/series");
    catalogue = Array.isArray(data.series) ? data.series : [];
    renderCatalogue();
  } catch (error) {
    host.innerHTML = `<div class="empty">Catalogue लोड नहीं हुआ। Server और Firebase जाँचें।</div>`;
    notice(error.message);
  }
}

function seriesCard(series, owned = false) {
  return `
    <article class="card">
      <span class="pill">${escapeHtml(series.className)} · ${escapeHtml(series.subject)}</span>
      <h3>${escapeHtml(series.title)}</h3>
      <div class="desc">${escapeHtml(series.description || "Practice with this test series.")}</div>
      <div class="muted">${Number(series.testCount) || 0} practice tests</div>
      <div class="price">${money(series.pricePaise)}</div>
      ${owned
        ? `<button type="button" class="btn" data-open-series="${escapeHtml(series.id)}">View Papers</button>`
        : `<button type="button" class="btn gold" data-buy-series="${escapeHtml(series.id)}">Buy now</button>`
      }
    </article>
  `;
}

function renderCatalogue() {
  const host = $("seriesGrid");
  if (!host) return;

  const query = ($("search")?.value || "").trim().toLowerCase();
  const classFilter = $("classFilter")?.value || "";

  const filtered = catalogue.filter(series => {
    const matchesClass = !classFilter || series.className === classFilter;
    const text = [series.title, series.subject, series.className, series.description].join(" ").toLowerCase();
    return matchesClass && text.includes(query);
  });

  host.innerHTML = filtered.length
    ? filtered.map(series => seriesCard(series)).join("")
    : `<div class="empty">कोई matching test series नहीं मिली।</div>`;

  host.querySelectorAll("[data-buy-series]").forEach(button => {
    button.addEventListener("click", () => buySeries(button.dataset.buySeries));
  });
}

$("search")?.addEventListener("input", renderCatalogue);
$("classFilter")?.addEventListener("change", renderCatalogue);
$("refreshStore")?.addEventListener("click", loadCatalogue);

// ============================================================
// RAZORPAY
// ============================================================

async function buySeries(seriesId) {
  clearNotice();
  if (!currentUser) return notice("Test Series खरीदने से पहले sign in करें।");

  const series = catalogue.find(item => item.id === seriesId);
  if (!series) return notice("Series नहीं मिली। Catalogue refresh करें।");
  if (!window.Razorpay) return notice("Razorpay Checkout load नहीं हुआ। Internet connection जाँचें।");

  try {
    const order = await api("/api/create-order", {
      method: "POST",
      body: JSON.stringify({ seriesId })
    });

    if (!order?.orderId || !order?.keyId || !order?.amount) {
      throw new Error("Server से Razorpay order details अधूरी मिलीं।");
    }

    const checkout = new window.Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency || "INR",
      name: order.name || "Bihar Academic Battle",
      description: order.description || series.title,
      order_id: order.orderId,
      prefill: { email: currentUser.email || "" },
      theme: { color: "#123b82" },
      handler: async response => {
        try {
          notice("Payment details verify किए जा रहे हैं…", "success");
          const verified = await api("/api/verify-payment", {
            method: "POST",
            body: JSON.stringify(response)
          });
          notice(verified.message || "Payment verified successfully.", "success");
          await loadMine();
          showView("mine");
        } catch (error) {
          notice(`${error.message} यदि पैसे कट गए हैं, तो दोबारा भुगतान करने से पहले My Test Series refresh करें।`);
        }
      }
    });

    checkout.on("payment.failed", response => {
      notice(response.error?.description || "Payment fail हुआ। Purchase access नहीं दिया गया।");
    });

    checkout.open();
  } catch (error) {
    notice(error.message);
  }
}

// ============================================================
// MY TEST SERIES
// ============================================================

async function loadMine() {
  const host = $("mineGrid");
  if (!host) return;

  if (!currentUser) {
    host.innerHTML = `<div class="empty">अपनी purchases देखने के लिए sign in करें।</div>`;
    return;
  }

  setHidden("paperPanel", true);
  host.innerHTML = `<div class="empty">Verified purchases लोड हो रही हैं…</div>`;

  try {
    const data = await api("/api/my-series");
    const series = Array.isArray(data.series) ? data.series : [];

    host.innerHTML = series.length
      ? series.map(item => seriesCard(item, true)).join("")
      : `<div class="empty">अभी कोई verified purchase नहीं है।</div>`;

    host.querySelectorAll("[data-open-series]").forEach(button => {
      button.addEventListener("click", () => openSeriesPapers(button.dataset.openSeries));
    });
  } catch (error) {
    host.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

$("refreshMine")?.addEventListener("click", loadMine);

$("backToMine")?.addEventListener("click", () => {
  setHidden("paperPanel", true);
  setHidden("mineGrid", false);
});

// ============================================================
// OPEN SERIES PAPERS (User)
// ============================================================

async function openSeriesPapers(seriesId) {
  if (!currentUser) return notice("पहले sign in करें।");

  try {
    clearNotice();

    const access = await api(`/api/access/${encodeURIComponent(seriesId)}`);
    if (!access?.allowed) {
      throw new Error("इस series का verified access उपलब्ध नहीं है।");
    }

    const mineData = await api("/api/my-series");
    const mySeries = Array.isArray(mineData.series) ? mineData.series : [];
    const series = mySeries.find(item => String(item.id) === String(seriesId));
    if (!series) throw new Error("यह series आपकी verified purchases में नहीं मिली।");

    currentSeries = series;

    const data = await api(`/api/papers?seriesId=${encodeURIComponent(seriesId)}`);
    const papers = Array.isArray(data.papers) ? data.papers : [];

    const heading = $("paperHeading");
    const grid = $("paperGrid");

    if (!heading || !grid) {
      throw new Error("HTML में paperHeading / paperGrid element नहीं मिला।");
    }

    heading.textContent = `${series.title} — Published Papers`;

    grid.innerHTML = papers.length
      ? papers.map(paper => `
          <article class="card">
            <span class="pill">${escapeHtml(paper.className || "All Classes")} · ${escapeHtml(paper.subject || "General")}</span>
            <h3>${escapeHtml(paper.title || "Question Paper")}</h3>
            <p class="muted">
              ${Number(paper.questionCount) || 0} MCQs · ${Number(paper.durationMinutes) || 60} minutes
            </p>
            ${paper.pdf
              ? `<button type="button" class="btn" data-open-pdf="${escapeHtml(paper.id)}">Open PDF</button>`
              : `<button type="button" class="btn" data-start-paper="${escapeHtml(paper.id)}">Start Test</button>`
            }
          </article>
        `).join("")
      : `<div class="empty">
          <h3>अभी कोई published question paper नहीं है।</h3>
          <p>Admin panel में paper publish करें और series select करना न भूलें।</p>
        </div>`;

    grid.querySelectorAll("[data-open-pdf]").forEach(button => {
      button.addEventListener("click", () => window.openQuestionPaperPDF(button.dataset.openPdf));
    });

    grid.querySelectorAll("[data-start-paper]").forEach(button => {
      button.addEventListener("click", () => {
        if (typeof window.startPaper === "function") {
          window.startPaper(button.dataset.startPaper);
        } else {
          notice("MCQ test engine अभी configure नहीं है।");
        }
      });
    });

    setHidden("mineGrid", true);
    setHidden("paperPanel", false);
    $("paperPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error("openSeriesPapers:", error);
    notice(error.message);
  }
}

// ============================================================
// ADMIN: SERIES FORM
// ============================================================

$("seriesForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser) return notice("Admin account से sign in करें।");

  const button = event.submitter;
  setBusy(button, true, "Saving…");

  const payload = {
    id: ($("seriesId")?.value || "").trim() || undefined,
    title: ($("sTitle")?.value || "").trim(),
    subject: ($("sSubject")?.value || "").trim(),
    className: $("sClass")?.value || "",
    priceRupees: Number($("sPrice")?.value),
    testCount: Number($("sCount")?.value),
    active: $("sActive")?.value === "true",
    description: ($("sDesc")?.value || "").trim()
  };

  try {
    await api("/api/admin/series", { method: "POST", body: JSON.stringify(payload) });
    notice("Test Series save हो गई।", "success");
    clearSeriesForm();
    await loadAdmin();
    await loadCatalogue();
    await populateSeriesDropdowns();
  } catch (error) {
    notice(error.message);
  } finally {
    setBusy(button, false);
  }
});

function clearSeriesForm() {
  $("seriesForm")?.reset();
  if ($("seriesId")) $("seriesId").value = "";
  setText("formHeading", "Add test series");
}

$("clearForm")?.addEventListener("click", clearSeriesForm);

// ============================================================
// SERIES DROPDOWNS (for paper forms)
// ============================================================

async function populateSeriesDropdowns() {
  try {
    const data = await api("/api/admin/series");
    const series = Array.isArray(data.series) ? data.series : [];
    adminSeriesCache = series;

    const options = series
      .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)} (${escapeHtml(s.className)} · ${escapeHtml(s.subject)})</option>`)
      .join("");

    const defaultOption = `<option value="">— Select Series (recommended) —</option>`;

    if ($("paperSeriesId")) $("paperSeriesId").innerHTML = defaultOption + options;
    if ($("pdfSeriesId")) $("pdfSeriesId").innerHTML = defaultOption + options;
  } catch (err) {
    console.warn("Could not load series for dropdowns:", err.message);
  }
}

// ============================================================
// MCQ QUESTION EDITOR
// ============================================================

function addQuestionEditor(question = {}) {
  const host = $("paperQuestions");
  if (!host) return;

  if (host.querySelector(".empty")) host.innerHTML = "";

  const index = host.querySelectorAll(".question-card").length;
  const options = Array.isArray(question.options) ? question.options : ["", "", "", ""];

  const card = document.createElement("div");
  card.className = "question-card";
  card.dataset.questionCard = "true";

  card.innerHTML = `
    <div class="sectionhead">
      <h4>Question ${index + 1}</h4>
      <button type="button" class="btn secondary" data-remove-question>Remove</button>
    </div>
    <div class="field">
      <label>Question text</label>
      <textarea data-q-text maxlength="1000" required placeholder="Type the question">${escapeHtml(question.question || "")}</textarea>
    </div>
    <div class="option-grid" style="margin-top:12px">
      ${[0,1,2,3].map(n => `
        <div class="field">
          <label>Option ${String.fromCharCode(65 + n)}</label>
          <input data-q-option="${n}" maxlength="400" required value="${escapeHtml(options[n] || "")}" placeholder="Option ${String.fromCharCode(65 + n)}">
        </div>
      `).join("")}
    </div>
    <div class="formgrid" style="margin-top:12px">
      <div class="field">
        <label>Correct answer</label>
        <select data-q-correct>
          ${[0,1,2,3].map(n => `
            <option value="${n}" ${Number(question.correctIndex ?? 0) === n ? "selected" : ""}>
              Option ${String.fromCharCode(65 + n)}
            </option>
          `).join("")}
        </select>
      </div>
      <div class="field">
        <label>Explanation (optional)</label>
        <textarea data-q-explanation maxlength="1000" placeholder="Explain the correct answer">${escapeHtml(question.explanation || "")}</textarea>
      </div>
    </div>
  `;

  card.querySelector("[data-remove-question]")?.addEventListener("click", () => {
    card.remove();
    renumberQuestions();
    if (!host.querySelector("[data-question-card]")) {
      host.innerHTML = `<div class="empty">Click “Add question” to begin.</div>`;
    }
  });

  host.appendChild(card);
  renumberQuestions();
}

function renumberQuestions() {
  [...($("paperQuestions")?.querySelectorAll("[data-question-card]") || [])].forEach((card, i) => {
    const h = card.querySelector("h4");
    if (h) h.textContent = `Question ${i + 1}`;
  });
}

$("addPaperQuestion")?.addEventListener("click", () => addQuestionEditor());

function readQuestionsFromForm() {
  return [...($("paperQuestions")?.querySelectorAll("[data-question-card]") || [])].map((card, index) => ({
    id: `q_${index + 1}`,
    question: card.querySelector("[data-q-text]")?.value.trim() || "",
    options: [0,1,2,3].map(n => card.querySelector(`[data-q-option="${n}"]`)?.value.trim() || ""),
    correctIndex: Number(card.querySelector("[data-q-correct]")?.value || 0),
    explanation: card.querySelector("[data-q-explanation]")?.value.trim() || ""
  }));
}

function clearPaperForm() {
  $("paperForm")?.reset();
  if ($("paperId")) $("paperId").value = "";
  if ($("paperQuestions")) $("paperQuestions").innerHTML = `<div class="empty">Click “Add question” to begin.</div>`;
  if ($("paperDuration")) $("paperDuration").value = "60";
  if ($("paperMarks")) $("paperMarks").value = "1";
  if ($("paperStatus")) $("paperStatus").value = "draft";
  setText("paperFormHeading", "Add Question Paper (MCQ)");
}

$("clearPaperForm")?.addEventListener("click", clearPaperForm);

// ============================================================
// SAVE MCQ PAPER
// ============================================================

$("paperForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser) return notice("Admin account से sign in करें।");

  const button = event.submitter;
  setBusy(button, true, "Saving paper…");

  try {
    const questions = readQuestionsFromForm();
    if (!questions.length) throw new Error("कम से कम एक MCQ question जोड़ें।");

    for (const [index, q] of questions.entries()) {
      if (!q.question) throw new Error(`Question ${index + 1} का text भरें।`);
      if (q.options.some(o => !o)) throw new Error(`Question ${index + 1} के सभी चार options भरें।`);
    }

    const payload = {
      id: ($("paperId")?.value || "").trim() || undefined,
      title: ($("paperTitle")?.value || "").trim(),
      className: $("paperClass")?.value || "",
      subject: $("paperSubject")?.value || "",
      seriesId: ($("paperSeriesId")?.value || "").trim() || null,
      durationMinutes: Number($("paperDuration")?.value || 60),
      marksPerQuestion: Number($("paperMarks")?.value || 1),
      instructions: ($("paperInstructions")?.value || "").trim(),
      status: $("paperStatus")?.value || "draft",
      questions
    };

    if (!payload.title || !payload.className || !payload.subject) {
      throw new Error("Paper title, class और subject भरें।");
    }

    const result = await api("/api/admin/papers", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    notice("Question Paper save हो गया।", "success");
    clearPaperForm();
    await loadAdminPapers();
  } catch (error) {
    notice(error.message);
  } finally {
    setBusy(button, false);
  }
});

// ============================================================
// PDF PAPER FORM
// ============================================================

const pdfForm = $("pdfPaperForm");
const pdfInput = $("pdfPaperFile");
let selectedPdf = null;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

pdfInput?.addEventListener("change", () => {
  selectedPdf = pdfInput.files?.[0] || null;
  $("selectedPdfName").textContent = selectedPdf
    ? `${selectedPdf.name} · ${(selectedPdf.size / 1024 / 1024).toFixed(2)} MB`
    : "No PDF selected.";

  if (selectedPdf && !validatePdf(selectedPdf)) {
    selectedPdf = null;
    pdfInput.value = "";
    $("selectedPdfName").textContent = "No valid PDF selected.";
  }
});

function validatePdf(file) {
  const extension = file.name.toLowerCase().endsWith(".pdf");
  const mimeOK = file.type === "application/pdf" || file.type === "";
  if (!extension || !mimeOK) {
    notice("Only PDF files are allowed.", "error");
    return false;
  }
  if (file.size <= 0 || file.size > MAX_PDF_BYTES) {
    notice("PDF file must be greater than 0 bytes and no larger than 10 MB.", "error");
    return false;
  }
  return true;
}

function clearPdfForm() {
  pdfForm?.reset();
  if ($("pdfPaperId")) $("pdfPaperId").value = "";
  if ($("pdfPaperDuration")) $("pdfPaperDuration").value = 60;
  if ($("pdfPaperStatus")) $("pdfPaperStatus").value = "draft";
  setText("pdfFormHeading", "Upload PDF Question Paper");
  if ($("selectedPdfName")) $("selectedPdfName").textContent = "No PDF selected.";
  if ($("pdfUploadStatus")) $("pdfUploadStatus").textContent = "";
  $("pdfProgress")?.classList.add("hidden");
  if ($("pdfProgressBar")) $("pdfProgressBar").style.width = "0%";
  selectedPdf = null;
}

$("clearPdfPaperBtn")?.addEventListener("click", clearPdfForm);

pdfForm?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser) return notice("Admin account से sign in करें।");

  const file = pdfInput?.files?.[0] || null;
  const existingId = ($("pdfPaperId")?.value || "").trim();

  if (file && !validatePdf(file)) return;
  if (!existingId && !file) {
    notice("Please select a PDF file for the new paper.", "error");
    return;
  }

  const metadata = {
    id: existingId || null,
    title: ($("pdfPaperTitle")?.value || "").trim(),
    className: $("pdfPaperClass")?.value || "",
    subject: $("pdfPaperSubject")?.value || "",
    seriesId: ($("pdfSeriesId")?.value || "").trim() || null,
    durationMinutes: Number($("pdfPaperDuration")?.value || 60),
    instructions: ($("pdfPaperInstructions")?.value || "").trim(),
    status: "draft",
    type: "pdf"
  };

  const btn = $("savePdfPaperBtn");
  setBusy(btn, true, "Saving PDF paper…");
  if ($("pdfUploadStatus")) $("pdfUploadStatus").textContent = "";
  $("pdfProgress")?.classList.remove("hidden");
  if ($("pdfProgressBar")) $("pdfProgressBar").style.width = "10%";

  try {
    let paperId = existingId;

    if (!paperId) {
      const created = await api("/api/admin/papers/pdf-metadata", {
        method: "POST",
        body: JSON.stringify(metadata)
      });
      paperId = created.paper?.id || created.id;
      if (!paperId) throw new Error("Server did not return the new paper ID.");
      if ($("pdfPaperId")) $("pdfPaperId").value = paperId;
    } else {
      await api("/api/admin/papers/pdf-metadata", {
        method: "POST",
        body: JSON.stringify(metadata)
      });
    }

    if ($("pdfProgressBar")) $("pdfProgressBar").style.width = "30%";

    if (file) {
      const body = new FormData();
      body.append("pdf", file, file.name);
      const uploaded = await api(`/api/admin/papers/${encodeURIComponent(paperId)}/pdf`, {
        method: "POST",
        body
      });
      if ($("pdfProgressBar")) $("pdfProgressBar").style.width = "85%";
      if ($("pdfUploadStatus")) $("pdfUploadStatus").textContent = uploaded.message || "PDF uploaded. Finishing…";
    }

    if ($("pdfPaperStatus")?.value === "published") {
      await api(`/api/admin/papers/${encodeURIComponent(paperId)}/publish`, {
        method: "POST",
        body: JSON.stringify({ status: "published" })
      });
    }

    if ($("pdfProgressBar")) $("pdfProgressBar").style.width = "100%";
    if ($("pdfUploadStatus")) $("pdfUploadStatus").textContent = "Saved successfully.";
    notice(
      $("pdfPaperStatus")?.value === "published"
        ? "PDF question paper saved and published."
        : "PDF question paper saved as draft.",
      "success"
    );
    await loadAdminPapers();
    clearPdfForm();
  } catch (error) {
    if ($("pdfUploadStatus")) $("pdfUploadStatus").textContent = "Upload/save failed: " + error.message;
    notice("PDF question paper error: " + error.message, "error");
  } finally {
    setBusy(btn, false);
  }
});

// ============================================================
// ADMIN PAPERS LIST
// ============================================================

async function loadAdminPapers() {
  const host = $("adminPapers");
  if (!host) return;

  host.innerHTML = `<p class="muted">Loading papers…</p>`;

  try {
    const data = await api("/api/admin/papers");
    allAdminPapers = Array.isArray(data.papers) ? data.papers : [];

    if (!allAdminPapers.length) {
      host.innerHTML = `<p class="muted">अभी कोई question paper नहीं है।</p>`;
      return;
    }

    host.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Paper</th>
            <th>Class / Subject</th>
            <th>Series</th>
            <th>Questions</th>
            <th>Type</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${allAdminPapers.map(paper => {
            const isPdf = paper.type === "pdf" || paper.pdf;
            return `
              <tr>
                <td>
                  <strong>${escapeHtml(paper.title)}</strong><br>
                  <small>${escapeHtml(paper.id)}</small>
                </td>
                <td>${escapeHtml(paper.className || "—")} / ${escapeHtml(paper.subject || "—")}</td>
                <td><small>${escapeHtml(paper.seriesId || "—")}</small></td>
                <td>${Array.isArray(paper.questions) ? paper.questions.length : (Number(paper.questionCount) || 0)}</td>
                <td><span class="status ${isPdf ? "pdf" : ""}">${isPdf ? "PDF" : "MCQ"}</span></td>
                <td>
                  <span class="status ${paper.status === "published" ? "published" : "draft"}">
                    ${paper.status === "published" ? "Published" : "Draft"}
                  </span>
                </td>
                <td>
                  <div class="paper-row-actions">
                    ${isPdf
                      ? `<button type="button" class="btn secondary" data-pdf-view="${escapeHtml(paper.id)}">Open PDF</button>`
                      : `<button type="button" class="btn secondary" data-edit-paper="${escapeHtml(paper.id)}">Edit MCQ</button>`
                    }
                    <button type="button" class="btn" data-publish-paper="${escapeHtml(paper.id)}" data-published="${paper.status !== "published"}">
                      ${paper.status === "published" ? "Unpublish" : "Publish"}
                    </button>
                  </div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;

    host.querySelectorAll("[data-edit-paper]").forEach(button => {
      button.addEventListener("click", () => {
        const paper = allAdminPapers.find(p => p.id === button.dataset.editPaper);
        if (paper) editPaper(paper);
      });
    });

    host.querySelectorAll("[data-pdf-view]").forEach(button => {
      button.addEventListener("click", () => openAdminPdf(button.dataset.pdfView));
    });

    host.querySelectorAll("[data-publish-paper]").forEach(button => {
      button.addEventListener("click", () => {
        togglePaperPublish(button.dataset.publishPaper, button.dataset.published === "true");
      });
    });
  } catch (error) {
    host.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

async function openAdminPdf(id) {
  try {
    const token = await window.BAB_GET_ID_TOKEN();
    const response = await fetch(`/api/admin/papers/${encodeURIComponent(id)}/pdf`, {
      headers: { Authorization: "Bearer " + token }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Unable to open PDF");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    notice("Could not open PDF: " + error.message);
  }
}

function editPaper(paper) {
  if ($("paperId")) $("paperId").value = paper.id || "";
  if ($("paperTitle")) $("paperTitle").value = paper.title || "";
  if ($("paperClass")) $("paperClass").value = paper.className || "";
  if ($("paperSubject")) $("paperSubject").value = paper.subject || "";
  if ($("paperSeriesId")) $("paperSeriesId").value = paper.seriesId || "";
  if ($("paperDuration")) $("paperDuration").value = paper.durationMinutes || 60;
  if ($("paperMarks")) $("paperMarks").value = paper.marksPerQuestion || 1;
  if ($("paperStatus")) $("paperStatus").value = paper.status || "draft";
  if ($("paperInstructions")) $("paperInstructions").value = paper.instructions || "";

  if ($("paperQuestions")) {
    $("paperQuestions").innerHTML = "";
    (paper.questions || []).forEach(q => addQuestionEditor(q));
    if (!(paper.questions || []).length) addQuestionEditor();
  }

  setText("paperFormHeading", "Edit Question Paper");
  $("questionPaperPanel")?.scrollIntoView({ behavior: "smooth" });
  notice(`Editing: ${paper.title}`, "success");
}

async function togglePaperPublish(paperId, published) {
  const action = published ? "publish" : "unpublish";
  if (!confirm(`क्या आप इस paper को ${action} करना चाहते हैं?`)) return;

  try {
    await api(`/api/admin/papers/${encodeURIComponent(paperId)}/publish`, {
      method: "POST",
      body: JSON.stringify({ status: published ? "published" : "draft" })
    });
    notice(published ? "Paper publish हो गया।" : "Paper unpublish हो गया।", "success");
    await loadAdminPapers();
  } catch (error) {
    notice(error.message);
  }
}

$("refreshPapers")?.addEventListener("click", loadAdminPapers);

// ============================================================
// ADMIN DASHBOARD
// ============================================================

$("loadAdmin")?.addEventListener("click", loadAdmin);

async function loadAdmin() {
  if (!currentUser) return notice("Admin account से sign in करें।");

  try {
    const [seriesData, purchaseData] = await Promise.all([
      api("/api/admin/series"),
      api("/api/admin/purchases")
    ]);

    adminSeriesCache = Array.isArray(seriesData.series) ? seriesData.series : [];
    renderAdminSeries(adminSeriesCache);
    renderAdminPurchases(purchaseData.purchases || []);
    await loadAdminPapers();
    await populateSeriesDropdowns();
  } catch (error) {
    if ($("adminSeries")) $("adminSeries").innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    if ($("adminPurchases")) $("adminPurchases").innerHTML = `<p class="muted">Admin access required.</p>`;
    notice(error.message);
  }
}

function renderAdminSeries(rows) {
  const host = $("adminSeries");
  if (!host) return;

  if (!rows.length) {
    host.innerHTML = `<p class="muted">अभी कोई series नहीं बनी है।</p>`;
    return;
  }

  host.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Series</th>
          <th>Class / Subject</th>
          <th>Price</th>
          <th>Tests</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(series => `
          <tr>
            <td>
              <strong>${escapeHtml(series.title)}</strong><br>
              <small>${escapeHtml(series.id)}</small>
            </td>
            <td>${escapeHtml(series.className)} / ${escapeHtml(series.subject)}</td>
            <td>${money(series.pricePaise)}</td>
            <td>${Number(series.testCount) || 0}</td>
            <td>${series.active ? "Published" : "Draft"}</td>
            <td>
              <button type="button" class="btn secondary" data-edit-series="${escapeHtml(series.id)}">Edit</button>
              <button type="button" class="btn" data-toggle-series="${escapeHtml(series.id)}" data-active="${!series.active}">
                ${series.active ? "Unpublish" : "Publish"}
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  host.querySelectorAll("[data-edit-series]").forEach(button => {
    button.addEventListener("click", () => {
      const series = rows.find(item => item.id === button.dataset.editSeries);
      if (!series) return;
      if ($("seriesId")) $("seriesId").value = series.id || "";
      if ($("sTitle")) $("sTitle").value = series.title || "";
      if ($("sSubject")) $("sSubject").value = series.subject || "";
      if ($("sClass")) $("sClass").value = series.className || "";
      if ($("sPrice")) $("sPrice").value = (Number(series.pricePaise) || 0) / 100;
      if ($("sCount")) $("sCount").value = series.testCount || 1;
      if ($("sActive")) $("sActive").value = String(series.active);
      if ($("sDesc")) $("sDesc").value = series.description || "";
      setText("formHeading", "Edit test series");
      $("seriesForm")?.scrollIntoView({ behavior: "smooth" });
    });
  });

  host.querySelectorAll("[data-toggle-series]").forEach(button => {
    button.addEventListener("click", async () => {
      const id = button.dataset.toggleSeries;
      const active = button.dataset.active === "true";
      try {
        await api(`/api/admin/series/${encodeURIComponent(id)}/toggle`, {
          method: "POST",
          body: JSON.stringify({ active })
        });
        notice(active ? "Series publish हो गई।" : "Series unpublish हो गई।", "success");
        await loadAdmin();
        await loadCatalogue();
      } catch (error) {
        notice(error.message);
      }
    });
  });
}

function renderAdminPurchases(purchases) {
  const host = $("adminPurchases");
  if (!host) return;

  if (!purchases.length) {
    host.innerHTML = `<p class="muted">अभी कोई verified purchase नहीं है।</p>`;
    return;
  }

  host.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Firebase UID</th>
          <th>Series</th>
          <th>Payment ID</th>
          <th>Amount</th>
          <th>Purchased</th>
        </tr>
      </thead>
      <tbody>
        ${purchases.map(p => `
          <tr>
            <td>${escapeHtml(p.uid)}</td>
            <td>${escapeHtml(p.seriesTitle)}</td>
            <td>${escapeHtml(p.paymentId)}</td>
            <td>${money(p.amountPaise)}</td>
            <td>${p.purchasedAt ? escapeHtml(new Date(p.purchasedAt).toLocaleString()) : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ============================================================
// AUTH STATE
// ============================================================

onAuthStateChanged(auth, async user => {
  currentUser = user;
  authResolved = true;
  resolveAuthReady(user);

  setHidden("authPanel", Boolean(user));

  const status = $("accountStatus");
  if (status) {
    status.replaceChildren();
    if (user) {
      status.append(document.createTextNode(`Signed in: ${user.email || "User"} `));
      const logoutButton = document.createElement("button");
      logoutButton.id = "logoutBtn";
      logoutButton.className = "navbtn";
      logoutButton.textContent = "Sign out";
      logoutButton.style.marginLeft = "8px";
      logoutButton.addEventListener("click", async () => {
        try {
          await signOut(auth);
          showView("store");
          notice("आप sign out हो गए हैं।", "success");
        } catch (error) {
          notice(authError(error));
        }
      });
      status.append(logoutButton);
    } else {
      status.textContent = "Not signed in";
    }
  }

  setHidden("adminNav", !user);

  if (user) {
    try { await user.getIdToken(); } catch (e) { console.error(e); }
    if (!$("mineView")?.classList.contains("hidden")) await loadMine();
    if (!$("adminView")?.classList.contains("hidden")) await loadAdmin();
  }

  renderCatalogue();
});

// ============================================================
// START PAPER (MCQ)
// ============================================================

window.startPaper = async function (paperId) {
  try {
    const response = await api(`/api/papers/${encodeURIComponent(paperId)}/questions`);
    const paper = response.paper;

    if (!paper || !Array.isArray(paper.questions) || !paper.questions.length) {
      throw new Error("Paper या questions उपलब्ध नहीं हैं।");
    }

    const root = document.querySelector("#app") || document.querySelector("main") || document.body;
    let current = 0;
    const answers = {};

    function renderQuestion() {
      const q = paper.questions[current];
      root.innerHTML = `
        <section class="panel" style="max-width:800px;margin:40px auto">
          <h2>${escapeHtml(paper.title)}</h2>
          <p class="muted">Class: ${escapeHtml(paper.className)} · Subject: ${escapeHtml(paper.subject)}</p>
          <p><strong>Question ${current + 1} of ${paper.questions.length}</strong></p>
          <h3 style="margin:20px 0">${escapeHtml(q.question)}</h3>
          <div>
            ${q.options.map((option, index) => `
              <label style="display:block;padding:12px;margin:8px 0;border:1px solid #ccd5e5;border-radius:10px;cursor:pointer">
                <input type="radio" name="answer" value="${index}" ${String(answers[q.id]) === String(index) ? "checked" : ""} style="margin-right:10px">
                ${escapeHtml(option)}
              </label>
            `).join("")}
          </div>
          <div style="display:flex;gap:10px;margin-top:24px">
            <button class="btn secondary" id="previousQuestion" ${current === 0 ? "disabled" : ""}>Previous</button>
            <button class="btn" id="nextQuestion">${current === paper.questions.length - 1 ? "Finish" : "Next"}</button>
          </div>
        </section>
      `;

      root.querySelectorAll('input[name="answer"]').forEach(input => {
        input.addEventListener("change", () => { answers[q.id] = Number(input.value); });
      });

      root.querySelector("#previousQuestion").onclick = () => {
        if (current > 0) { current--; renderQuestion(); }
      };

      root.querySelector("#nextQuestion").onclick = () => {
        if (current < paper.questions.length - 1) {
          current++;
          renderQuestion();
        } else {
          root.innerHTML = `
            <section class="panel" style="max-width:800px;margin:40px auto;text-align:center">
              <h2>Test Completed</h2>
              <p>आपने ${Object.keys(answers).length} में से ${paper.questions.length} questions attempt किए।</p>
              <p class="muted">Secure answer checking API अभी available नहीं है।</p>
              <button class="btn" id="backToPapers" style="margin-top:20px">Back</button>
            </section>
          `;
          root.querySelector("#backToPapers").onclick = () => location.reload();
        }
      };
    }

    renderQuestion();
  } catch (error) {
    alert(error.message || "Questions load नहीं हो सके।");
    console.error("Start test error:", error);
  }
};

// ============================================================
// INIT
// ============================================================

setText("year", new Date().getFullYear());
if ($("paperQuestions") && !$("paperQuestions").querySelector("[data-question-card]")) {
  // empty state already set in HTML
}
loadCatalogue();