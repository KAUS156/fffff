

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

/* ==========================================
   BIHAR ACADEMIC BATTLE
   Complete Frontend JavaScript
========================================== */

/* 1. FIREBASE CONFIG */

const firebaseConfig = {
  apiKey: "AIzaSyBO6-Qq6Yh6E4ECx9BXGySqzC8J2zdHYzs",
  authDomain: "babbihar-23fcc.firebaseapp.com",
  databaseURL: "https://babbihar-23fcc-default-rtdb.firebaseio.com/",
  projectId: "babbihar-23fcc",
  storageBucket: "babbihar-23fcc.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_FIREBASE_APP_ID"
};

const API_BASE = "/api";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

/* 2. GLOBAL STATE */

let currentUser = null;
let idToken = null;

let currentSeries = [];
let currentPapers = [];

let currentPaper = null;
let currentTestQuestions = [];

let testAnswers = {};
let testTimerInterval = null;
let testSecondsLeft = 0;

let adminVerified = false;

let adminCharts = {};

let adminData = {
  purchases: [],
  series: [],
  papers: [],
  users: [],
  totalStudents: 0
};

const $ = id => document.getElementById(id);

/* ==========================================
   3. COMMON HELPERS
========================================== */

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = String(value ?? "");
  }
}

function formatMoney(paise = 0) {
  const rupees = Number(paise || 0) / 100;

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(rupees);
}

function formatDate(value) {
  if (!value) return "—";

  let date;

  if (typeof value === "number") {
    date = new Date(value);
  } else if (/^\d+$/.test(String(value))) {
    const number = Number(value);

    date = new Date(
      number < 1000000000000
        ? number * 1000
        : number
    );
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function showNotice(message, type = "success") {
  const element = $("notice");

  if (!element) {
    console.log(message);
    return;
  }

  element.textContent = message;

  element.classList.remove(
    "hidden",
    "success",
    "error",
    "warning"
  );

  element.classList.add(type);

  clearTimeout(showNotice.timer);

  showNotice.timer = setTimeout(() => {
    element.classList.add("hidden");
  }, 4500);
}

function setButtonLoading(button, loading, label = "Please wait...") {
  if (!button) return;

  if (loading) {
    button.dataset.oldText = button.textContent;
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;

    if (button.dataset.oldText) {
      button.textContent = button.dataset.oldText;
      delete button.dataset.oldText;
    }
  }
}

function jsonBody(data) {
  return JSON.stringify(data);
}

/* ==========================================
   4. API REQUEST HELPER
========================================== */

async function api(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});

  if (idToken) {
    headers.set("Authorization", `Bearer ${idToken}`);
  }

  const isFormData = options.body instanceof FormData;

  if (options.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    cache: "no-store"
  });

  const contentType =
    response.headers.get("content-type") || "";

  if (contentType.includes("application/pdf")) {
    if (!response.ok) {
      throw new Error("PDF could not be loaded.");
    }

    return response.blob();
  }

  let result = {};

  try {
    if (contentType.includes("application/json")) {
      result = await response.json();
    } else {
      result = {
        error: await response.text()
      };
    }
  } catch {
    result = {};
  }

  if (!response.ok) {
    throw new Error(
      result.error || `Request failed (${response.status})`
    );
  }

  return result;
}

/* ==========================================
   5. AUTH CHECK
========================================== */

function requireLogin() {
  if (!currentUser || !idToken) {
    showNotice("पहले Login करें।", "error");

    $("authPanel")?.scrollIntoView({
      behavior: "smooth"
    });

    return false;
  }

  return true;
}

function requireAdmin() {
  if (!requireLogin()) {
    return false;
  }

  if (!adminVerified) {
    showNotice(
      "आपके खाते को Admin access नहीं मिला है।",
      "error"
    );

    return false;
  }

  return true;
}

/* ==========================================
   6. PAGE NAVIGATION
========================================== */

function showView(viewName) {
  const views = {
    store: "storeView",
    mine: "mineView",
    profile: "profileView",
    admin: "adminView",
    test: "testView"
  };

  Object.entries(views).forEach(([name, id]) => {
    const element = $(id);

    if (element) {
      element.classList.toggle(
        "hidden",
        name !== viewName
      );
    }
  });

  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.view === viewName
    );
  });

  if (viewName === "store") loadStore();
  if (viewName === "mine") loadMySeries();
  if (viewName === "profile") loadProfile();
  if (viewName === "admin") loadAdmin();
}

/* ==========================================
   7. AUTH UI
========================================== */

function setAuthUI(user) {
  const authPanel = $("authPanel");
  const logoutButton = $("logoutBtn");

  if (authPanel) {
    authPanel.classList.toggle(
      "hidden",
      Boolean(user)
    );
  }

  if (logoutButton) {
    logoutButton.classList.toggle(
      "hidden",
      !user
    );
  }

  setText(
    "accountStatus",
    user
      ? `Signed in: ${user.email || "Student"}`
      : "Not signed in"
  );

  $("adminNav")?.classList.toggle(
    "hidden",
    !adminVerified
  );
}

/* ==========================================
   8. LOGIN
========================================== */

async function login() {
  const email = $("email")?.value.trim();
  const password = $("password")?.value;

  if (!email || !password) {
    showNotice(
      "Email और Password भरें।",
      "error"
    );

    return;
  }

  try {
    setButtonLoading(
      $("loginBtn"),
      true,
      "Signing in..."
    );

    await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

    showNotice("Login successful.");

  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setButtonLoading($("loginBtn"), false);
  }
}

/* ==========================================
   9. SIGNUP
========================================== */

async function signup() {
  const email = $("email")?.value.trim();
  const password = $("password")?.value;

  if (!email || !password) {
    showNotice(
      "Email और Password भरें।",
      "error"
    );

    return;
  }

  if (password.length < 6) {
    showNotice(
      "Password कम से कम 6 characters का होना चाहिए।",
      "error"
    );

    return;
  }

  try {
    setButtonLoading(
      $("signupBtn"),
      true,
      "Creating account..."
    );

    await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    showNotice("Account successfully created.");

  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setButtonLoading($("signupBtn"), false);
  }
}

/* ==========================================
   10. RESET PASSWORD
========================================== */

async function resetPassword() {
  const email = $("email")?.value.trim();

  if (!email) {
    showNotice(
      "पहले Email भरें।",
      "error"
    );

    return;
  }

  try {
    setButtonLoading(
      $("resetBtn"),
      true,
      "Sending..."
    );

    await sendPasswordResetEmail(
      auth,
      email
    );

    showNotice(
      "Password reset email भेज दिया गया है।"
    );

  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setButtonLoading($("resetBtn"), false);
  }
}

/* ==========================================
   11. LOGOUT
========================================== */

async function logout() {
  try {
    stopTestTimer();

    await signOut(auth);

    showNotice("Logout successful.");

    showView("store");

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   12. FIREBASE AUTH STATE
========================================== */

onAuthStateChanged(auth, async user => {
  currentUser = user;

  idToken = user
    ? await user.getIdToken(true)
    : null;

  adminVerified = false;

  if (user) {
    try {
      await api("/admin/series");
      adminVerified = true;
    } catch {
      adminVerified = false;
    }
  }

  setAuthUI(user);

  if (user) {
    await loadStore();

    if (adminVerified) {
      $("adminNav")?.classList.remove("hidden");
    }
  } else {
    currentSeries = [];

    adminData = {
      purchases: [],
      series: [],
      papers: [],
      users: [],
      totalStudents: 0
    };
  }
});

/* ==========================================
   13. TEST SERIES STORE
========================================== */

async function loadStore() {
  try {
    const result = await api("/series");

    currentSeries = Array.isArray(result.series)
      ? result.series
      : [];

    renderStore();

  } catch (error) {
    showNotice(error.message, "error");
  }
}

function renderStore() {
  const grid = $("seriesGrid");

  if (!grid) return;

  const search = (
    $("search")?.value || ""
  ).toLowerCase().trim();

  const classFilter =
    $("classFilter")?.value || "";

  const filtered = currentSeries.filter(series => {
    const searchText = [
      series.title,
      series.subject,
      series.className,
      series.description
    ].join(" ").toLowerCase();

    const matchesSearch =
      !search || searchText.includes(search);

    const matchesClass =
      !classFilter ||
      String(series.className || "") === classFilter;

    return (
      series.active !== false &&
      matchesSearch &&
      matchesClass
    );
  });

  if (!filtered.length) {
    grid.innerHTML = `
      <p class="empty-state">
        अभी कोई Test Series उपलब्ध नहीं है।
      </p>
    `;

    return;
  }

  grid.innerHTML = filtered.map(series => `
    <article class="series-card">
      <div class="series-card-body">

        <span class="status-pill">
          Available
        </span>

        <h3>
          ${escapeHTML(series.title)}
        </h3>

        <p>
          ${escapeHTML(series.description || "")}
        </p>

        <div class="series-meta">

          <span>
            ${escapeHTML(series.className || "")}
          </span>

          <span>
            ${escapeHTML(series.subject || "")}
          </span>

          <span>
            ${Number(series.testCount || 0)} Tests
          </span>

        </div>

        <h2>
          ${formatMoney(series.pricePaise)}
        </h2>

        <button
          type="button"
          data-buy-series="${escapeHTML(series.id)}"
        >
          Buy Now
        </button>

      </div>
    </article>
  `).join("");

  grid.querySelectorAll("[data-buy-series]").forEach(button => {
    button.addEventListener("click", () => {
      const series = currentSeries.find(
        item => item.id === button.dataset.buySeries
      );

      if (series) {
        buySeries(series);
      }
    });
  });
}

/* ==========================================
   14. RAZORPAY PAYMENT
========================================== */

async function buySeries(series) {
  if (!requireLogin()) return;

  if (typeof window.Razorpay !== "function") {
    showNotice(
      "Razorpay Checkout script HTML में load नहीं है।",
      "error"
    );

    return;
  }

  try {
    const order = await api("/create-order", {
      method: "POST",
      body: jsonBody({
        seriesId: series.id
      })
    });

    const options = {
      key: order.keyId,

      amount: order.amount,

      currency: order.currency || "INR",

      name:
        order.name ||
        "BIHAR ACADEMIC BATTLE",

      description:
        order.description ||
        series.title,

      order_id: order.orderId,

      prefill: {
        name: currentUser.displayName || "",
        email: currentUser.email || ""
      },

      theme: {
        color: "#123b82"
      },

      handler: async paymentResponse => {
        try {
          await api("/verify-payment", {
            method: "POST",
            body: jsonBody(paymentResponse)
          });

          showNotice(
            "Payment verified! Series unlock हो गई है।"
          );

          await loadMySeries();
          await loadMyPurchases();

          showView("mine");

        } catch (error) {
          showNotice(
            error.message,
            "error"
          );
        }
      },

      modal: {
        ondismiss: () => {
          showNotice(
            "Payment window बंद कर दी गई।",
            "warning"
          );
        }
      }
    };

    if (
      !options.key ||
      !options.order_id ||
      !options.amount
    ) {
      throw new Error(
        "Razorpay order details missing."
      );
    }

    const razorpay = new window.Razorpay(options);

    razorpay.open();

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   15. MY PURCHASED SERIES
========================================== */

async function loadMySeries() {
  if (!currentUser) return;

  try {
    const result = await api("/my-series");

    const series = Array.isArray(result.series)
      ? result.series
      : [];

    renderMySeries(series);

  } catch (error) {
    showNotice(error.message, "error");
  }
}

function renderMySeries(series) {
  const grid = $("mineGrid");

  if (!grid) return;

  if (!series.length) {
    grid.innerHTML = `
      <p class="empty-state">
        आपने अभी कोई Test Series नहीं खरीदी है।
      </p>
    `;

    return;
  }

  grid.innerHTML = series.map(item => `
    <article class="series-card">

      <div class="series-card-body">

        <span class="status-pill">
          Purchased
        </span>

        <h3>
          ${escapeHTML(item.title)}
        </h3>

        <p>
          ${escapeHTML(item.className || "")}
          ·
          ${escapeHTML(item.subject || "")}
        </p>

        <p>
          Purchased:
          ${formatDate(item.purchase?.purchasedAt)}
        </p>

        <p>
          Paid:
          ${formatMoney(item.purchase?.amountPaise || 0)}
        </p>

        <button
          type="button"
          data-open-series="${escapeHTML(item.id)}"
        >
          Open Series
        </button>

      </div>

    </article>
  `).join("");

  grid.querySelectorAll("[data-open-series]").forEach(button => {
    button.addEventListener("click", () => {
      openSeries(button.dataset.openSeries);
    });
  });
}

/* ==========================================
   16. OPEN SERIES PAPERS
========================================== */

async function openSeries(seriesId) {
  if (!requireLogin()) return;

  try {
    const result = await api(
      `/access/${encodeURIComponent(seriesId)}`
    );

    if (!result.allowed) {
      throw new Error(
        result.error || "Series access denied."
      );
    }

    const series = result.series;
    const papers = result.papers || [];

    setText(
      "paperHeading",
      series?.title || "Test Papers"
    );

    $("paperPanel")?.classList.remove("hidden");

    const grid = $("paperGrid");

    if (!grid) return;

    if (!papers.length) {
      grid.innerHTML = `
        <p class="empty-state">
          इस Series में अभी कोई Paper प्रकाशित नहीं हुआ है।
        </p>
      `;
    } else {
      grid.innerHTML = papers.map(paper => `
        <article class="paper-card">

          <h3>
            ${escapeHTML(paper.title)}
          </h3>

          <p>
            ${escapeHTML(paper.subject || "")}
            ·
            ${escapeHTML(paper.className || "")}
          </p>

          <p>
            ${Number(paper.durationMinutes || 60)}
            Minutes
          </p>

          ${
            paper.type === "pdf"
              ? `
                <button
                  type="button"
                  data-open-pdf="${escapeHTML(paper.id)}"
                >
                  View PDF
                </button>
              `
              : `
                <button
                  type="button"
                  data-start-test="${escapeHTML(paper.id)}"
                >
                  Start Test
                </button>
              `
          }

        </article>
      `).join("");

      grid.querySelectorAll("[data-open-pdf]").forEach(button => {
        button.addEventListener("click", () => {
          openStudentPDF(button.dataset.openPdf);
        });
      });

      grid.querySelectorAll("[data-start-test]").forEach(button => {
        button.addEventListener("click", () => {
          startTest(button.dataset.startTest);
        });
      });
    }

    $("paperPanel")?.scrollIntoView({
      behavior: "smooth"
    });

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   17. PRIVATE STUDENT PDF
========================================== */

async function openStudentPDF(paperId) {
  if (!requireLogin()) return;

  try {
    showNotice(
      "PDF लोड हो रहा है...",
      "warning"
    );

    const blob = await api(
      `/papers/${encodeURIComponent(paperId)}/pdf`
    );

    const url = URL.createObjectURL(blob);

    const win = window.open(
      url,
      "_blank",
      "noopener"
    );

    if (!win) {
      const link = document.createElement("a");

      link.href = url;
      link.download = `paper-${paperId}.pdf`;

      link.click();
    }

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60000);

    showNotice("PDF opened.");

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   18. STUDENT PROFILE
========================================== */

async function loadProfile() {
  if (!currentUser) return;

  try {
    const [profile, history] = await Promise.all([
      api("/profile"),
      api("/my-purchases")
    ]);

    setText(
      "profileDisplayName",
      profile.displayName || "Student"
    );

    setText(
      "profileEmail",
      profile.email || currentUser.email || ""
    );

    setText(
      "profileVerification",
      profile.emailVerified
        ? "Verified"
        : "Not verified"
    );

    setText(
      "profilePurchaseCount",
      profile.purchaseCount || 0
    );

    setText(
      "profileTotalPaid",
      formatMoney(profile.totalPaidPaise || 0)
    );

    setText(
      "profileAccountStatus",
      profile.disabled
        ? "Disabled"
        : "Active"
    );

    if ($("profileNameInput")) {
      $("profileNameInput").value =
        profile.displayName || "";
    }

    if ($("profileEmailInput")) {
      $("profileEmailInput").value =
        profile.email || "";
    }

    const avatar = $("profileAvatar");

    if (avatar) {
      if (profile.photoURL) {
        avatar.src = profile.photoURL;
        avatar.classList.remove("hidden");
      } else {
        avatar.classList.add("hidden");
      }
    }

    renderPaymentHistory(
      history.purchases || []
    );

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   19. SAVE PROFILE
========================================== */

async function saveProfile(event) {
  event.preventDefault();

  if (!requireLogin()) return;

  const displayName =
    $("profileNameInput")?.value.trim();

  if (!displayName || displayName.length < 2) {
    showNotice(
      "Name कम से कम 2 characters का होना चाहिए।",
      "error"
    );

    return;
  }

  try {
    setButtonLoading(
      $("saveProfileBtn"),
      true,
      "Saving..."
    );

    await api("/profile", {
      method: "PUT",
      body: jsonBody({
        displayName
      })
    });

    await updateProfile(currentUser, {
      displayName
    });

    showNotice("Profile updated successfully.");

    await loadProfile();

  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setButtonLoading(
      $("saveProfileBtn"),
      false
    );
  }
}

/* ==========================================
   20. PAYMENT HISTORY
========================================== */

async function loadMyPurchases() {
  if (!currentUser) return;

  try {
    const result = await api("/my-purchases");

    renderPaymentHistory(
      result.purchases || []
    );

  } catch (error) {
    showNotice(error.message, "error");
  }
}

function renderPaymentHistory(purchases) {
  const container = $("paymentHistory");

  if (!container) return;

  if (!purchases.length) {
    container.innerHTML = `
      <p>No payment history found.</p>
    `;

    return;
  }

  container.innerHTML = purchases.map(item => `
    <div class="history-row">

      <strong>
        ${escapeHTML(item.seriesTitle || "Test Series")}
      </strong>

      <span>
        ${formatMoney(item.amountPaise)}
      </span>

      <span>
        ${formatDate(item.purchasedAt)}
      </span>

      <span class="status-pill">
        ${escapeHTML(item.status)}
      </span>

    </div>
  `).join("");
}

/* ==========================================
   21. ADMIN DASHBOARD
========================================== */

async function loadAdmin() {
  if (!requireAdmin()) return;

  const jobs = await Promise.allSettled([
    loadAdminSeries(),
    loadAdminPapers(),
    loadAdminPurchases(),
    loadAdminUsers()
  ]);

  renderAdminCharts(
    adminData.purchases,
    adminData.series,
    adminData.papers
  );

  updateAdminCounters();

  if (jobs.some(job => job.status === "rejected")) {
    showNotice(
      "कुछ Admin डेटा लोड नहीं हो पाया। Refresh करें।",
      "error"
    );
  }
}

/* ==========================================
   22. ADMIN SERIES
========================================== */

async function loadAdminSeries() {
  const result = await api("/admin/series");

  const series = Array.isArray(result.series)
    ? result.series
    : [];

  adminData.series = series;
  currentSeries = series;

  renderAdminSeries(series);

  updateSeriesDropdowns(series);
  updateAdminCounters();

  return series;
}

function renderAdminSeries(series) {
  const container = $("adminSeries");

  if (!container) return;

  if (!series.length) {
    container.innerHTML = `
      <p>No test series found.</p>
    `;

    return;
  }

  container.innerHTML = series.map(item => `
    <div class="admin-list-row">

      <div>

        <strong>
          ${escapeHTML(item.title)}
        </strong>

        <small>
          ${escapeHTML(item.className)}
          ·
          ${escapeHTML(item.subject)}
        </small>

        <small>
          ${formatMoney(item.pricePaise)}
          ·
          ${Number(item.testCount || 0)} tests
        </small>

        <span class="status-pill">
          ${item.active ? "Active" : "Hidden"}
        </span>

      </div>

      <div class="admin-actions">

        <button
          type="button"
          data-edit-series="${escapeHTML(item.id)}"
        >
          Edit
        </button>

        <button
          type="button"
          data-toggle-series="${escapeHTML(item.id)}"
        >
          ${item.active ? "Hide" : "Publish"}
        </button>

        <button
          type="button"
          data-delete-series="${escapeHTML(item.id)}"
        >
          Disable
        </button>

      </div>

    </div>
  `).join("");

  container.querySelectorAll("[data-edit-series]").forEach(button => {
    button.addEventListener("click", () => {
      const item = series.find(
        row => row.id === button.dataset.editSeries
      );

      if (item) editSeries(item);
    });
  });

  container.querySelectorAll("[data-toggle-series]").forEach(button => {
    button.addEventListener("click", () => {
      toggleSeries(button.dataset.toggleSeries);
    });
  });

  container.querySelectorAll("[data-delete-series]").forEach(button => {
    button.addEventListener("click", () => {
      disableSeries(button.dataset.deleteSeries);
    });
  });
}

/* ==========================================
   23. EDIT SERIES
========================================== */

function editSeries(item) {
  $("seriesId").value = item.id;

  $("sTitle").value = item.title || "";
  $("sSubject").value = item.subject || "";
  $("sClass").value = item.className || "";

  $("sPrice").value =
    Number(item.pricePaise || 0) / 100;

  $("sCount").value =
    item.testCount || 1;

  $("sDesc").value =
    item.description || "";

  if ($("sActive")) {
    $("sActive").value =
      item.active === false ? "false" : "true";
  }

  setText(
    "formHeading",
    "Edit Test Series"
  );

  $("seriesForm")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

/* ==========================================
   24. TOGGLE SERIES
========================================== */

async function toggleSeries(id) {
  if (!requireAdmin()) return;

  const item = adminData.series.find(
    series => series.id === id
  );

  if (!item) return;

  try {
    await api(
      `/admin/series/${encodeURIComponent(id)}/toggle`,
      {
        method: "POST",
        body: jsonBody({
          active: item.active === false
        })
      }
    );

    showNotice("Series status updated.");

    await loadAdminSeries();

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   25. DISABLE SERIES
========================================== */

async function disableSeries(id) {
  if (!requireAdmin()) return;

  if (!confirm("इस Series को disable करना चाहते हैं?")) {
    return;
  }

  try {
    await api(
      `/admin/series/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      }
    );

    showNotice("Series disabled.");

    await loadAdminSeries();

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   26. SAVE SERIES
========================================== */

async function saveAdminSeries(event) {
  event.preventDefault();

  if (!requireAdmin()) return;

  const id = $("seriesId")?.value;

  const payload = {
    title: $("sTitle")?.value.trim(),

    subject: $("sSubject")?.value.trim(),

    className: $("sClass")?.value.trim(),

    pricePaise: Math.round(
      Number($("sPrice")?.value || 0) * 100
    ),

    testCount: Number(
      $("sCount")?.value || 1
    ),

    description: $("sDesc")?.value.trim(),

    active:
      $("sActive")?.value !== "false"
  };

  if (
    !payload.title ||
    !payload.subject ||
    !payload.className
  ) {
    showNotice(
      "Title, Class और Subject भरें।",
      "error"
    );

    return;
  }

  try {
    const button = $("seriesForm")?.querySelector(
      '[type="submit"]'
    );

    setButtonLoading(
      button,
      true,
      "Saving..."
    );

    if (id) {
      await api(
        `/admin/series/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          body: jsonBody(payload)
        }
      );
    } else {
      await api("/admin/series", {
        method: "POST",
        body: jsonBody(payload)
      });
    }

    $("seriesForm")?.reset();

    $("seriesId").value = "";

    setText(
      "formHeading",
      "Add Test Series"
    );

    showNotice("Test Series saved.");

    await loadAdminSeries();

  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setButtonLoading(
      $("seriesForm")?.querySelector('[type="submit"]'),
      false
    );
  }
}

/* ==========================================
   27. SERIES DROPDOWNS
========================================== */

function updateSeriesDropdowns(series) {
  [
    "pdfSeriesId",
    "paperSeriesId"
  ].forEach(id => {
    const select = $(id);

    if (!select) return;

    const previous = select.value;

    select.innerHTML = `
      <option value="">
        Select Test Series
      </option>

      ${series.map(item => `
        <option value="${escapeHTML(item.id)}">
          ${escapeHTML(item.title)}
        </option>
      `).join("")}
    `;

    if (
      series.some(item => item.id === previous)
    ) {
      select.value = previous;
    }
  });
}

/* ==========================================
   28. ADMIN PAPER LOADER
========================================== */

async function loadAdminPapers() {
  const result = await api("/admin/papers");

  const papers = Array.isArray(result.papers)
    ? result.papers
    : [];

  adminData.papers = papers;

  renderAdminPapers(papers);

  updateAdminCounters();

  return papers;
}

/* ==========================================
   29. RENDER ADMIN PAPERS
========================================== */

function renderAdminPapers(papers) {
  const container = $("adminPapers");

  if (!container) return;

  if (!papers.length) {
    container.innerHTML = `
      <p>No papers found.</p>
    `;

    return;
  }

  container.innerHTML = papers.map(paper => `
    <div class="admin-list-row">

      <div>

        <strong>
          ${escapeHTML(paper.title)}
        </strong>

        <small>
          ${escapeHTML(paper.className)}
          ·
          ${escapeHTML(paper.subject)}
        </small>

        <small>
          ${escapeHTML(paper.type)}
          ·
          ${Number(paper.durationMinutes || 60)} min
        </small>

        <span class="status-pill">
          ${escapeHTML(paper.status)}
        </span>

      </div>

      <div class="admin-actions">

        ${
          paper.type === "pdf"
            ? `
              <button
                type="button"
                data-preview-pdf="${escapeHTML(paper.id)}"
              >
                Preview PDF
              </button>
            `
            : `
              <button
                type="button"
                data-edit-paper="${escapeHTML(paper.id)}"
              >
                Edit MCQ
              </button>
            `
        }

        <button
          type="button"
          data-publish-paper="${escapeHTML(paper.id)}"
          data-status="${escapeHTML(paper.status)}"
        >
          ${
            paper.status === "published"
              ? "Unpublish"
              : "Publish"
          }
        </button>

        <button
          type="button"
          data-delete-paper="${escapeHTML(paper.id)}"
        >
          Delete
        </button>

      </div>

    </div>
  `).join("");

  container.querySelectorAll("[data-preview-pdf]").forEach(button => {
    button.addEventListener("click", () => {
      previewAdminPDF(button.dataset.previewPdf);
    });
  });

  container.querySelectorAll("[data-edit-paper]").forEach(button => {
    button.addEventListener("click", () => {
      editMCQPaper(button.dataset.editPaper);
    });
  });

  container.querySelectorAll("[data-publish-paper]").forEach(button => {
    button.addEventListener("click", () => {
      const published =
        button.dataset.status !== "published";

      publishPaper(
        button.dataset.publishPaper,
        published
      );
    });
  });

  container.querySelectorAll("[data-delete-paper]").forEach(button => {
    button.addEventListener("click", () => {
      deletePaper(button.dataset.deletePaper);
    });
  });
}

/* ==========================================
   30. PUBLISH / UNPUBLISH PAPER
========================================== */

async function publishPaper(id, published) {
  try {
    await api(
      `/admin/papers/${encodeURIComponent(id)}/publish`,
      {
        method: "POST",
        body: jsonBody({
          published
        })
      }
    );

    showNotice(
      published
        ? "Paper published."
        : "Paper unpublished."
    );

    await loadAdminPapers();

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   31. DELETE PAPER
========================================== */

async function deletePaper(id) {
  if (!confirm("इस Paper को delete करना चाहते हैं?")) {
    return;
  }

  try {
    await api(
      `/admin/papers/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      }
    );

    showNotice("Paper deleted.");

    await loadAdminPapers();

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   32. ADMIN PDF PREVIEW
========================================== */

async function previewAdminPDF(id) {
  try {
    const blob = await api(
      `/admin/papers/${encodeURIComponent(id)}/pdf`
    );

    const url = URL.createObjectURL(blob);

    window.open(
      url,
      "_blank",
      "noopener"
    );

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60000);

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   33. MCQ QUESTION EDITOR
========================================== */

function addQuestionEditor(question = {}) {
  const container = $("paperQuestions");

  if (!container) return;

  const index =
    container.querySelectorAll(".question-editor").length + 1;

  const options = Array.isArray(question.options)
    ? question.options
    : ["", "", "", ""];

  const editor = document.createElement("div");

  editor.className = "question-editor";

  editor.innerHTML = `

    <div class="question-editor-head">

      <strong>
        Question ${index}
      </strong>

      <button
        type="button"
        class="remove-question"
      >
        Remove
      </button>

    </div>

    <label>
      Question

      <textarea
        class="question-text"
        required
      >${escapeHTML(question.question || "")}</textarea>

    </label>

    <div class="option-grid">

      <label>
        Option A

        <input
          class="option-a"
          value="${escapeHTML(options[0] || "")}"
          required
        >
      </label>

      <label>
        Option B

        <input
          class="option-b"
          value="${escapeHTML(options[1] || "")}"
          required
        >
      </label>

      <label>
        Option C

        <input
          class="option-c"
          value="${escapeHTML(options[2] || "")}"
          required
        >
      </label>

      <label>
        Option D

        <input
          class="option-d"
          value="${escapeHTML(options[3] || "")}"
          required
        >
      </label>

    </div>

    <label>
      Correct Answer

      <select class="correct-answer">

        <option value="0"
          ${Number(question.correctIndex) === 0 ? "selected" : ""}>
          A
        </option>

        <option value="1"
          ${Number(question.correctIndex) === 1 ? "selected" : ""}>
          B
        </option>

        <option value="2"
          ${Number(question.correctIndex) === 2 ? "selected" : ""}>
          C
        </option>

        <option value="3"
          ${Number(question.correctIndex) === 3 ? "selected" : ""}>
          D
        </option>

      </select>

    </label>

    <label>
      Explanation (optional)

      <textarea
        class="question-explanation"
      >${escapeHTML(question.explanation || "")}</textarea>

    </label>

  `;

  editor.querySelector(
    ".remove-question"
  ).addEventListener("click", () => {
    editor.remove();
    renumberQuestionEditors();
  });

  container.appendChild(editor);
}

function renumberQuestionEditors() {
  document.querySelectorAll(
    "#paperQuestions .question-editor"
  ).forEach((editor, index) => {
    const heading = editor.querySelector(
      ".question-editor-head strong"
    );

    if (heading) {
      heading.textContent =
        `Question ${index + 1}`;
    }
  });
}

/* ==========================================
   34. COLLECT MCQ QUESTIONS
========================================== */

function collectQuestions() {
  const editors = document.querySelectorAll(
    "#paperQuestions .question-editor"
  );

  return Array.from(editors).map(editor => ({
    question:
      editor.querySelector(".question-text")?.value.trim() || "",

    options: [
      editor.querySelector(".option-a")?.value.trim() || "",
      editor.querySelector(".option-b")?.value.trim() || "",
      editor.querySelector(".option-c")?.value.trim() || "",
      editor.querySelector(".option-d")?.value.trim() || ""
    ],

    correctIndex: Number(
      editor.querySelector(".correct-answer")?.value || 0
    ),

    explanation:
      editor.querySelector(".question-explanation")?.value.trim() || ""
  }));
}

/* ==========================================
   35. SAVE MCQ PAPER
========================================== */

async function saveMCQPaper(event) {
  event.preventDefault();

  if (!requireAdmin()) return;

  const questions = collectQuestions();

  if (
    !questions.length ||
    questions.some(question =>
      !question.question ||
      question.options.length !== 4 ||
      question.options.some(option => !option)
    )
  ) {
    showNotice(
      "हर Question में Question text और चारों Options भरें।",
      "error"
    );

    return;
  }

  const payload = {
    id: $("paperId")?.value || undefined,

    title: $("paperTitle")?.value.trim(),

    seriesId:
      $("paperSeriesId")?.value || null,

    className:
      $("paperClass")?.value.trim(),

    subject:
      $("paperSubject")?.value.trim(),

    durationMinutes: Number(
      $("paperDuration")?.value || 60
    ),

    marksPerQuestion: Number(
      $("paperMarks")?.value || 1
    ),

    status:
      $("paperStatus")?.value || "draft",

    instructions:
      $("paperInstructions")?.value.trim(),

    questions
  };

  try {
    setButtonLoading(
      $("savePaperBtn"),
      true,
      "Saving..."
    );

    await api("/admin/papers", {
      method: "POST",
      body: jsonBody(payload)
    });

    showNotice("MCQ Paper saved.");

    clearMCQForm();

    await loadAdminPapers();

  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setButtonLoading(
      $("savePaperBtn"),
      false
    );
  }
}

/* ==========================================
   36. CLEAR MCQ FORM
========================================== */

function clearMCQForm() {
  $("paperForm")?.reset();

  if ($("paperId")) {
    $("paperId").value = "";
  }

  if ($("paperQuestions")) {
    $("paperQuestions").innerHTML = "";
  }
}

/* ==========================================
   37. EDIT MCQ PAPER
========================================== */

function editMCQPaper(id) {
  const paper = adminData.papers.find(
    item => item.id === id
  );

  if (!paper) return;

  $("paperId").value = paper.id;

  $("paperTitle").value =
    paper.title || "";

  $("paperSeriesId").value =
    paper.seriesId || "";

  $("paperClass").value =
    paper.className || "";

  $("paperSubject").value =
    paper.subject || "";

  $("paperDuration").value =
    paper.durationMinutes || 60;

  $("paperMarks").value =
    paper.marksPerQuestion || 1;

  $("paperStatus").value =
    paper.status || "draft";

  $("paperInstructions").value =
    paper.instructions || "";

  $("paperQuestions").innerHTML = "";

  (paper.questions || []).forEach(question => {
    addQuestionEditor(question);
  });

  $("paperForm")?.scrollIntoView({
    behavior: "smooth"
  });
}

/* ==========================================
   38. ADMIN PDF UPLOAD
========================================== */

async function uploadPDFPaper(event) {
  event.preventDefault();

  if (!requireAdmin()) return;

  const file = $("pdfPaperFile")?.files?.[0];

  if (!file) {
    showNotice(
      "PDF file चुनें।",
      "error"
    );

    return;
  }

  if (
    file.type !== "application/pdf" ||
    !file.name.toLowerCase().endsWith(".pdf")
  ) {
    showNotice(
      "केवल PDF file upload करें।",
      "error"
    );

    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    showNotice(
      "PDF अधिकतम 10 MB की हो सकती है।",
      "error"
    );

    return;
  }

  const payload = {
    id: $("pdfPaperId")?.value || undefined,

    title:
      $("pdfPaperTitle")?.value.trim(),

    seriesId:
      $("pdfSeriesId")?.value || null,

    className:
      $("pdfPaperClass")?.value.trim(),

    subject:
      $("pdfPaperSubject")?.value.trim(),

    durationMinutes: Number(
      $("pdfPaperDuration")?.value || 60
    ),

    instructions:
      $("pdfPaperInstructions")?.value.trim()
  };

  if (
    !payload.title ||
    !payload.className ||
    !payload.subject
  ) {
    showNotice(
      "PDF Paper की सभी details भरें।",
      "error"
    );

    return;
  }

  try {
    setButtonLoading(
      $("savePdfPaperBtn"),
      true,
      "Uploading..."
    );

    setText(
      "selectedPdfName",
      file.name
    );

    setText(
      "pdfUploadStatus",
      "Saving PDF details..."
    );

    const metadata = await api(
      "/admin/papers/pdf-metadata",
      {
        method: "POST",
        body: jsonBody(payload)
      }
    );

    if (!metadata.id) {
      throw new Error("Paper ID नहीं मिली।");
    }

    const formData = new FormData();

    formData.append("pdf", file);

    setText(
      "pdfUploadStatus",
      "Uploading PDF..."
    );

    const uploadResult = await api(
      `/admin/papers/${encodeURIComponent(metadata.id)}/pdf`,
      {
        method: "POST",
        body: formData
      }
    );

    const shouldPublish =
      $("pdfPaperStatus")?.value === "published";

    if (shouldPublish) {
      await api(
        `/admin/papers/${encodeURIComponent(metadata.id)}/publish`,
        {
          method: "POST",
          body: jsonBody({
            published: true
          })
        }
      );
    }

    setText(
      "pdfUploadStatus",
      uploadResult.message || "Upload complete."
    );

    setText("pdfProgress", "100%");

    if ($("pdfProgressBar")) {
      $("pdfProgressBar").style.width = "100%";
    }

    showNotice("PDF Paper successfully uploaded.");

    clearPDFForm();

    await loadAdminPapers();

  } catch (error) {
    setText(
      "pdfUploadStatus",
      error.message
    );

    showNotice(error.message, "error");

  } finally {
    setButtonLoading(
      $("savePdfPaperBtn"),
      false
    );
  }
}

/* ==========================================
   39. CLEAR PDF FORM
========================================== */

function clearPDFForm() {
  $("pdfPaperForm")?.reset();

  if ($("pdfPaperId")) {
    $("pdfPaperId").value = "";
  }

  setText(
    "selectedPdfName",
    "No file selected"
  );

  setText(
    "pdfProgress",
    "0%"
  );

  setText(
    "pdfUploadStatus",
    ""
  );

  if ($("pdfProgressBar")) {
    $("pdfProgressBar").style.width = "0%";
  }
}

/* ==========================================
   40. ADMIN PURCHASES
========================================== */

async function loadAdminPurchases() {
  const result = await api("/admin/purchases");

  const purchases = Array.isArray(result.purchases)
    ? result.purchases
    : [];

  adminData.purchases = purchases;

  renderAdminPurchases(purchases);

  updateAdminCounters();

  return purchases;
}

function renderAdminPurchases(purchases) {
  const container = $("adminPurchases");

  if (!container) return;

  if (!purchases.length) {
    container.innerHTML = `
      <p>No purchases found.</p>
    `;

    return;
  }

  container.innerHTML = purchases.map(item => `
    <div class="admin-list-row">

      <div>

        <strong>
          ${escapeHTML(item.seriesTitle || "Test Series")}
        </strong>

        <small>
          ${escapeHTML(item.email || "Student")}
        </small>

        <small>
          ${escapeHTML(item.paymentId || "Payment ID unavailable")}
        </small>

        <small>
          ${formatDate(item.purchasedAt)}
        </small>

      </div>

      <div>

        <strong>
          ${formatMoney(item.amountPaise)}
        </strong>

        <span class="status-pill">
          ${escapeHTML(item.status)}
        </span>

      </div>

    </div>
  `).join("");
}

/* ==========================================
   41. ADMIN STUDENTS
========================================== */

async function loadAdminUsers() {
  const result = await api("/admin/users");

  const users = Array.isArray(result.users)
    ? result.users
    : [];

  adminData.users = users;

  adminData.totalStudents = Number(
    result.totalStudents ?? users.length
  );

  renderAdminUsers(users);

  setText(
    "adminStudentCount",
    adminData.totalStudents
  );

  updateAdminCounters();

  return users;
}

function renderAdminUsers(users) {
  const container = $("adminUsers");

  if (!container) return;

  if (!users.length) {
    container.innerHTML = `
      <p>No registered students found.</p>
    `;

    return;
  }

  container.innerHTML = users.map(user => `
    <div class="admin-list-row">

      <div>

        <strong>
          ${escapeHTML(user.displayName || "Student")}
        </strong>

        <small>
          ${escapeHTML(user.email || "")}
        </small>

        <small>
          Joined: ${formatDate(user.createdAt)}
        </small>

        <small>
          Purchases: ${Number(user.purchaseCount || 0)}
        </small>

      </div>

      <div>

        <span class="status-pill">
          ${user.disabled ? "Disabled" : "Active"}
        </span>

        <small>
          ${user.emailVerified ? "Email verified" : "Email not verified"}
        </small>

        <strong>
          ${formatMoney(user.totalPaidPaise || 0)}
        </strong>

      </div>

    </div>
  `).join("");
}

/* ==========================================
   42. ADMIN DASHBOARD COUNTERS
========================================== */

function isVerifiedPurchase(item) {
  return String(
    item?.status || ""
  ).toLowerCase() === "active";
}

function getPurchaseAmountPaise(item) {
  const amount = Number(
    item?.amountPaise || 0
  );

  return Number.isFinite(amount)
    ? amount
    : 0;
}

function updateAdminCounters() {
  const paid = adminData.purchases.filter(
    isVerifiedPurchase
  );

  const revenue = paid.reduce(
    (sum, item) =>
      sum + getPurchaseAmountPaise(item),
    0
  );

  setText(
    "dashStudents",
    adminData.totalStudents
  );

  setText(
    "dashPurchases",
    paid.length
  );

  setText(
    "dashRevenue",
    formatMoney(revenue)
  );

  setText(
    "dashSeries",
    adminData.series.length
  );

  setText(
    "adminStudentCount",
    adminData.totalStudents
  );
}

/* ==========================================
   43. CHART DATE HELPERS
========================================== */

function getPurchaseDate(item) {
  const value =
    item?.purchasedAt ??
    item?.paidAt ??
    item?.createdAt ??
    item?.timestamp;

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  let date;

  if (typeof value === "number") {
    date = new Date(value);
  } else if (/^\d+$/.test(String(value))) {
    const number = Number(value);

    date = new Date(
      number < 1000000000000
        ? number * 1000
        : number
    );
  } else {
    date = new Date(value);
  }

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

/* ==========================================
   44. ADMIN CHARTS
========================================== */

function renderAdminCharts(
  purchases = [],
  series = [],
  papers = []
) {
  if (!window.Chart) return;

  const paid = purchases.filter(
    isVerifiedPurchase
  );

  const months = [];

  for (let i = 5; i >= 0; i--) {
    const date = new Date();

    date.setDate(1);

    date.setMonth(
      date.getMonth() - i
    );

    months.push({
      key:
        `${date.getFullYear()}-${String(
          date.getMonth() + 1
        ).padStart(2, "0")}`,

      label: date.toLocaleString(
        "en-IN",
        {
          month: "short",
          year: "2-digit"
        }
      ),

      count: 0,
      revenue: 0
    });
  }

  paid.forEach(item => {
    const date = getPurchaseDate(item);

    if (!date) return;

    const key =
      `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`;

    const month = months.find(
      entry => entry.key === key
    );

    if (month) {
      month.count++;

      month.revenue +=
        getPurchaseAmountPaise(item) / 100;
    }
  });

  const seriesTotals = series.map(item => {
    const related = paid.filter(
      purchase => purchase.seriesId === item.id
    );

    return {
      label: item.title || "Series",
      count: related.length
    };
  })
  .sort((a, b) => b.count - a.count)
  .slice(0, 8);

  const mcqCount = papers.filter(
    paper => paper.type !== "pdf"
  ).length;

  const pdfCount = papers.filter(
    paper => paper.type === "pdf"
  ).length;

  createAdminChart(
    "revenueChart",
    "line",
    {
      labels: months.map(
        item => item.label
      ),

      datasets: [{
        label: "Revenue (₹)",

        data: months.map(
          item => Math.round(item.revenue)
        ),

        tension: 0.35,
        fill: true
      }]
    }
  );

  createAdminChart(
    "purchaseChart",
    "bar",
    {
      labels: months.map(
        item => item.label
      ),

      datasets: [{
        label: "Purchases",

        data: months.map(
          item => item.count
        )
      }]
    }
  );

  createAdminChart(
    "seriesChart",
    "bar",
    {
      labels: seriesTotals.map(
        item => item.label
      ),

      datasets: [{
        label: "Paid Purchases",

        data: seriesTotals.map(
          item => item.count
        )
      }]
    }
  );

  createAdminChart(
    "contentChart",
    "doughnut",
    {
      labels: [
        "MCQ Papers",
        "PDF Papers"
      ],

      datasets: [{
        label: "Papers",

        data: [
          mcqCount,
          pdfCount
        ]
      }]
    }
  );
}

function createAdminChart(
  canvasId,
  type,
  data
) {
  const canvas = $(canvasId);

  if (!canvas || !window.Chart) {
    return;
  }

  if (adminCharts[canvasId]) {
    adminCharts[canvasId].destroy();
  }

  adminCharts[canvasId] = new window.Chart(
    canvas,
    {
      type,
      data,

      options: {
        responsive: true,

        maintainAspectRatio: false,

        plugins: {
          legend: {
            display: type === "doughnut"
          }
        },

        scales:
  type === "doughnut"
    ? {}
    : {
        y: {
          beginAtZero: true,
          grace: '10%',
          ticks: {
            precision: 0
          }
        }
      }
      }
    }
  );
}

/* ==========================================
   45. START ONLINE MCQ TEST
========================================== */

async function startTest(paperId) {
  if (!requireLogin()) return;

  try {
    const result = await api(
      `/papers/${encodeURIComponent(paperId)}/questions`
    );

    const paper = result.paper || {};

    const questions =
      result.questions ||
      paper.questions ||
      [];

    if (!questions.length) {
      throw new Error(
        "इस Test में Questions उपलब्ध नहीं हैं।"
      );
    }

    currentPaper = paper;

    currentTestQuestions = questions;

    testAnswers = {};

    setText(
      "testTitle",
      paper.title || "Online Test"
    );

    setText(
      "testQuestionCount",
      questions.length
    );

    setText(
      "testDuration",
      `${paper.durationMinutes || 60} Minutes`
    );

    setText(
      "testInstructions",
      paper.instructions || "सभी प्रश्नों का उत्तर दें।"
    );

    testSecondsLeft = Math.max(
      1,
      Number(paper.durationMinutes || 60) * 60
    );

    renderTestQuestions(questions);

    updateTestTimer();

    startTestTimer();

    $("testResult")?.classList.add("hidden");

    $("submitTestBtn")?.classList.remove("hidden");

    showView("test");

  } catch (error) {
    showNotice(error.message, "error");
  }
}

/* ==========================================
   46. RENDER TEST QUESTIONS
========================================== */

function renderTestQuestions(questions) {
  const container = $("testQuestions");

  if (!container) return;

  container.innerHTML = questions.map(
    (question, index) => `
      <article class="test-question">

        <h3>
          Q${index + 1}.
          ${escapeHTML(question.question)}
        </h3>

        <div class="test-options">

          ${(question.options || []).map(
            (option, optionIndex) => `
              <label class="test-option">

                <input
                  type="radio"
                  name="question-${index}"
                  value="${optionIndex}"
                  data-question-index="${index}"
                >

                <span>
                  ${escapeHTML(option)}
                </span>

              </label>
            `
          ).join("")}

        </div>

      </article>
    `
  ).join("");

  container.querySelectorAll(
    'input[type="radio"]'
  ).forEach(input => {
    input.addEventListener("change", () => {
      testAnswers[
        Number(input.dataset.questionIndex)
      ] = Number(input.value);
    });
  });
}

/* ==========================================
   47. TEST TIMER
========================================== */

function updateTestTimer() {
  const minutes = Math.floor(
    testSecondsLeft / 60
  );

  const seconds =
    testSecondsLeft % 60;

  setText(
    "testTimer",
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  );
}

function startTestTimer() {
  stopTestTimer();

  testTimerInterval = setInterval(() => {
    testSecondsLeft--;

    updateTestTimer();

    if (testSecondsLeft <= 0) {
      stopTestTimer();

      submitTest(true);
    }
  }, 1000);
}

function stopTestTimer() {
  if (testTimerInterval) {
    clearInterval(testTimerInterval);

    testTimerInterval = null;
  }
}

/* ==========================================
   48. SUBMIT ONLINE TEST
========================================== */

async function submitTest(autoSubmit = false) {
  if (!currentPaper) return;

  if (
    !autoSubmit &&
    !confirm("क्या आप Test Submit करना चाहते हैं?")
  ) {
    return;
  }

  stopTestTimer();

  const answers = Object.entries(
    testAnswers
  ).map(([index, answer]) => ({
    questionIndex: Number(index),
    answer: Number(answer)
  }));

  try {
    setButtonLoading(
      $("submitTestBtn"),
      true,
      "Submitting..."
    );

    const result = await api(
      `/papers/${encodeURIComponent(currentPaper.id)}/submit`,
      {
        method: "POST",

        body: jsonBody({
          answers
        })
      }
    );

    setText(
      "testResultMessage",
      result.message || "Test submitted."
    );

    setText(
      "testResultDetails",

      `Score: ${result.score} / ${result.totalMarks} · Correct: ${result.correct} · Attempted: ${result.attempted} / ${result.totalQuestions}`
    );

    $("testResult")?.classList.remove("hidden");

    $("submitTestBtn")?.classList.add("hidden");

    showNotice(
      autoSubmit
        ? "समय समाप्त! Test submit हो गया।"
        : "Test submitted successfully."
    );

  } catch (error) {
    showNotice(error.message, "error");

    startTestTimer();

  } finally {
    setButtonLoading(
      $("submitTestBtn"),
      false
    );
  }
}

/* ==========================================
   49. EXIT TEST
========================================== */

function exitTest() {
  if (
    !confirm(
      "Test से बाहर निकलना चाहते हैं? आपका current attempt submit नहीं होगा।"
    )
  ) {
    return;
  }

  stopTestTimer();

  currentPaper = null;

  currentTestQuestions = [];

  testAnswers = {};

  $("testResult")?.classList.add("hidden");

  $("submitTestBtn")?.classList.remove("hidden");

  showView("mine");
}

/* ==========================================
   50. EVENT LISTENERS
========================================== */

function bindEvents() {

  // Authentication

  $("loginBtn")?.addEventListener(
    "click",
    login
  );

  $("signupBtn")?.addEventListener(
    "click",
    signup
  );

  $("resetBtn")?.addEventListener(
    "click",
    resetPassword
  );

  $("logoutBtn")?.addEventListener(
    "click",
    logout
  );

  // Store

  $("refreshStore")?.addEventListener(
    "click",
    loadStore
  );

  $("search")?.addEventListener(
    "input",
    renderStore
  );

  $("classFilter")?.addEventListener(
    "change",
    renderStore
  );

  // My Series

  $("refreshMine")?.addEventListener(
    "click",
    loadMySeries
  );

  $("backToMine")?.addEventListener(
    "click",
    () => {
      $("paperPanel")?.classList.add("hidden");

      showView("mine");
    }
  );

  // Profile

  $("refreshProfile")?.addEventListener(
    "click",
    loadProfile
  );

  $("profileForm")?.addEventListener(
    "submit",
    saveProfile
  );

  $("refreshPaymentHistory")?.addEventListener(
    "click",
    loadMyPurchases
  );

  // Admin

  $("loadAdmin")?.addEventListener(
    "click",
    loadAdmin
  );

  $("seriesForm")?.addEventListener(
    "submit",
    saveAdminSeries
  );

  $("clearForm")?.addEventListener(
    "click",
    () => {
      $("seriesForm")?.reset();

      if ($("seriesId")) {
        $("seriesId").value = "";
      }

      setText(
        "formHeading",
        "Add Test Series"
      );
    }
  );

  // MCQ

  $("paperForm")?.addEventListener(
    "submit",
    saveMCQPaper
  );

  $("addPaperQuestion")?.addEventListener(
    "click",
    () => addQuestionEditor()
  );

  $("clearPaperForm")?.addEventListener(
    "click",
    clearMCQForm
  );

  // PDF

  $("pdfPaperForm")?.addEventListener(
    "submit",
    uploadPDFPaper
  );

  $("clearPdfPaperBtn")?.addEventListener(
    "click",
    clearPDFForm
  );

  $("pdfPaperFile")?.addEventListener(
    "change",
    event => {
      const file = event.target.files?.[0];

      setText(
        "selectedPdfName",
        file?.name || "No file selected"
      );
    }
  );

  // Admin refresh

  $("refreshPapers")?.addEventListener(
    "click",
    loadAdminPapers
  );

  $("refreshAdminUsers")?.addEventListener(
    "click",
    loadAdminUsers
  );

  // Test

  $("submitTestBtn")?.addEventListener(
    "click",
    () => submitTest(false)
  );

  $("exitTestBtn")?.addEventListener(
    "click",
    exitTest
  );

  $("testResultBack")?.addEventListener(
    "click",
    () => {
      $("testResult")?.classList.add("hidden");

      $("submitTestBtn")?.classList.remove("hidden");

      showView("mine");
    }
  );

  // Navigation

  document.querySelectorAll("[data-view]").forEach(button => {

    button.addEventListener("click", () => {

      const view = button.dataset.view;

      if (
        view === "admin" &&
        !requireAdmin()
      ) {
        return;
      }

      if (
        view !== "admin" &&
        view !== "store" &&
        !requireLogin()
      ) {
        return;
      }

      showView(view);
    });

  });

}

/* ==========================================
   51. INITIALIZATION
========================================== */

bindEvents();

if (
  $("paperQuestions") &&
  !$("paperQuestions").children.length
) {
  addQuestionEditor();
}

showView("store");

console.log(
  "BIHAR ACADEMIC BATTLE app.js loaded successfully."
);