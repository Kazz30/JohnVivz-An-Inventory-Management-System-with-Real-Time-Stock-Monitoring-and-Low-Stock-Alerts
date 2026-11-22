/* JOHNVIVZ app shell: presentation and interaction only.
   Navigation drawer / collapse, notification dropdown, keyboard shortcuts, confirmation dialogs,
   status badges, password visibility and form loading states. It never changes request data. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const body = document.body;
  const root = document.documentElement;
  const shell = $(".app-shell");
  const mobile = window.matchMedia("(max-width: 800px)");
  const store = {
    get: key => { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  };
  const isEditable = el => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));

  /* ---------- Modals (shortcut guide and confirmation) ---------- */
  let lastFocus = null;
  const focusables = modal => $$("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])", modal).filter(el => !el.disabled);
  const openModal = (backdrop, focusSelector) => {
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    const target = (focusSelector && $(focusSelector, backdrop)) || focusables(backdrop)[0];
    if (target) target.focus();
  };
  const closeModal = backdrop => {
    if (!backdrop || backdrop.hidden) return;
    backdrop.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  };
  const openModals = () => $$(".modal-backdrop").filter(el => !el.hidden);
  const shortcutsModal = $("#shortcuts-modal");
  const openShortcuts = () => { if (shell && shortcutsModal) openModal(shortcutsModal); };
  document.addEventListener("click", event => {
    if (event.target.closest("[data-open-shortcuts]")) { event.preventDefault(); closeDrawer(); openShortcuts(); return; }
    if (event.target.closest("[data-close-modal]")) { closeModal(event.target.closest(".modal-backdrop")); return; }
    // The add/edit form modal only closes through its close icon, Cancel or Esc, so a stray click never discards typing.
    if (event.target.classList && event.target.classList.contains("modal-backdrop") && !event.target.hasAttribute("data-form-modal")) closeModal(event.target);
  });

  /* Styled confirmation for every [data-confirm] button (replaces window.confirm). */
  const confirmModal = $("#confirm-modal");
  const ask = message => new Promise(resolve => {
    if (!confirmModal) { resolve(window.confirm(message)); return; }
    $("#confirm-message", confirmModal).textContent = message;
    const finish = answer => {
      confirmModal.removeEventListener("click", onClick);
      closeModal(confirmModal);
      resolve(answer);
    };
    const onClick = event => {
      if (event.target.closest("[data-confirm-ok]")) finish(true);
      else if (event.target.closest("[data-confirm-cancel]") || event.target === confirmModal) finish(false);
    };
    confirmModal.addEventListener("click", onClick);
    confirmModal._cancel = () => finish(false);
    openModal(confirmModal, "[data-confirm-cancel]");
  });
  document.addEventListener("click", event => {
    const trigger = event.target.closest("[data-confirm]");
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    ask(trigger.dataset.confirm).then(ok => {
      if (!ok) return;
      if (trigger.form) trigger.form.requestSubmit(trigger);
    });
  }, true);

  /* ---------- Navigation: collapse (desktop) and drawer (mobile) ---------- */
  const toggle = $("#nav-toggle");
  const syncToggle = () => {
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(mobile.matches ? body.classList.contains("nav-open") : !root.classList.contains("sidebar-collapsed")));
  };
  function closeDrawer() { body.classList.remove("nav-open"); syncToggle(); }
  if (toggle) {
    toggle.addEventListener("click", () => {
      if (mobile.matches) body.classList.toggle("nav-open");
      else {
        root.classList.toggle("sidebar-collapsed");
        store.set("jv.sidebar", root.classList.contains("sidebar-collapsed") ? "collapsed" : "expanded");
      }
      syncToggle();
    });
    syncToggle();
  }
  $$("[data-nav-overlay]").forEach(el => el.addEventListener("click", closeDrawer));
  $$(".sidebar a").forEach(el => el.addEventListener("click", closeDrawer));
  mobile.addEventListener("change", closeDrawer);

  /* ---------- Notification dropdown (the bell stays a normal link without JavaScript) ---------- */
  const bell = $("#notif-button");
  const panel = $("#notif-panel");
  const setPanel = open => {
    if (!bell || !panel) return;
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
  };
  if (bell && panel) {
    bell.addEventListener("click", event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      setPanel(panel.hidden);
    });
    document.addEventListener("click", event => {
      if (!panel.hidden && !event.target.closest(".notif-menu")) setPanel(false);
    });
  }

  /* ---------- Breadcrumb: Home / active section / page title ---------- */
  const crumbs = $(".breadcrumbs ol");
  const activeLink = $(".sidebar .nav-link.active");
  if (crumbs && activeLink && crumbs.children.length === 2) {
    const label = activeLink.textContent.trim();
    const title = crumbs.lastElementChild.textContent.trim();
    if (label && label !== "Dashboard" && label.toLowerCase() !== title.toLowerCase()) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = activeLink.getAttribute("href");
      link.textContent = label;
      item.appendChild(link);
      crumbs.insertBefore(item, crumbs.lastElementChild);
    }
  }

  /* ---------- Keyboard shortcuts ---------- */
  const routes = ["/dashboard", "/products", "/categories", "/inventory", "/movements", "/suppliers", "/purchase-orders", "/alerts", "/reports"];
  document.addEventListener("keydown", event => {
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === "Escape") {
      const modals = openModals();
      if (modals.length) { const top = modals[modals.length - 1]; if (top._cancel) top._cancel(); else closeModal(top); return; }
      if (panel && !panel.hidden) { setPanel(false); if (bell) bell.focus(); return; }
      closeDrawer();
      return;
    }
    if (event.key === "Tab") {
      const modals = openModals();
      if (modals.length) {
        const items = focusables(modals[modals.length - 1]);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      return;
    }
    if (!shell) return;
    if (modifier && event.key === "Enter") {
      const el = document.activeElement;
      const form = isEditable(el) && el.closest("form.stack-form, form.filter-form, form.status-form");
      if (form) { event.preventDefault(); form.requestSubmit(); }
      return;
    }
    if (modifier && event.key.toLowerCase() === "k") {
      const search = $('input[type="search"]');
      if (search) { event.preventDefault(); search.focus(); search.select(); }
      return;
    }
    if (modifier && (event.key === "/" || event.code === "Slash")) {
      event.preventDefault();
      openShortcuts();
      return;
    }
    const digit = /^Digit([1-9])$/.exec(event.code || "");
    if (digit && event.altKey && !modifier && !event.shiftKey && !isEditable(event.target) && !openModals().length) {
      const href = routes[Number(digit[1]) - 1];
      // Only links the sidebar already shows for this role are reachable.
      const link = $$(".sidebar .nav-link").find(el => el.getAttribute("href") === href);
      if (link) { event.preventDefault(); window.location.href = href; }
    }
    // Alt + N: open the page's "+ Add ..." form (only where that button exists, i.e. managers on Products).
    if (event.code === "KeyN" && event.altKey && !modifier && !event.shiftKey && !isEditable(event.target) && !openModals().length) {
      const add = $("[data-open-form-modal]");
      if (add) { event.preventDefault(); add.click(); }
    }
  });

  /* ---------- Status badges: classify existing table text without touching the data ---------- */
  const TONES = {
    success: ["in stock", "active", "received", "resolved", "read", "stock in", "completed"],
    warning: ["low stock", "pending", "partially received", "partially_received", "adjustment", "pending first ess sign-in"],
    danger: ["out of stock", "critical", "cancelled", "stock out"],
    info: ["ordered", "approved", "unread", "manager"],
    neutral: ["inactive", "staff", "supervisor"]
  };
  const toneFor = text => Object.keys(TONES).find(tone => TONES[tone].includes(text));
  const BADGE_COLUMNS = ["status", "type", "movement", "role", "hr status"];
  const onAlerts = location.pathname.indexOf("/alerts") === 0;
  $$(".table-wrap table").forEach(table => {
    const heads = $$("thead th", table).map(th => th.textContent.trim().toLowerCase());
    const index = name => heads.indexOf(name);
    $$("tbody tr", table).forEach(row => {
      const cells = Array.from(row.children);
      if (cells.length !== heads.length && !row.querySelector(".actions-cell")) return;
      heads.forEach((head, i) => {
        const cell = cells[i];
        if (!cell || cell.hasAttribute("colspan") || cell.classList.contains("empty-state")) return;
        const text = cell.textContent.trim();
        if (BADGE_COLUMNS.includes(head) && text && !cell.querySelector(".status-pill")) {
          let tone = toneFor(text.toLowerCase());
          if (onAlerts && text.toLowerCase() === "active") tone = "warning";
          if (tone) {
            const badge = document.createElement("span");
            badge.className = "badge badge-" + tone;
            badge.textContent = text.replace(/_/g, " ");
            cell.textContent = "";
            cell.appendChild(badge);
            if (head === "status" && (tone === "danger" || (onAlerts && tone === "warning"))) row.classList.add("row-" + tone);
          }
        } else if (["before", "after", "previous", "updated", "on hand", "reserved", "available", "quantity", "current stock", "threshold", "minimum"].includes(head) && /^-?\d/.test(text)) {
          cell.classList.add("num");
          if (head === "available") cell.classList.add("num-strong");
        }
      });
      // Low-stock alerts: critical (zero) in red, otherwise warning in orange; resolved rows muted.
      const current = index("current stock"), threshold = index("threshold"), status = index("status");
      if (onAlerts && current > -1 && threshold > -1 && cells[current] && /^-?\d+$/.test(cells[current].textContent.trim())) {
        const value = Number(cells[current].textContent.trim());
        const resolved = status > -1 && /resolved/i.test(cells[status].textContent);
        cells[current].classList.add("stock-figure", resolved ? "stock-ok" : value <= 0 ? "stock-critical" : "stock-warning");
        if (resolved) row.classList.add("row-resolved");
        else if (value <= 0) row.classList.replace("row-warning", "row-danger") || row.classList.add("row-danger");
      }
    });
  });

  /* ---------- Password visibility ---------- */
  $$('input[type="password"]').forEach(input => {
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pw-toggle";
    button.textContent = "Show";
    button.setAttribute("aria-label", "Show password");
    button.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "Hide" : "Show";
      button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
    wrap.appendChild(button);
  });

  /* ---------- Loading state on submit (the form still submits normally) ---------- */
  document.addEventListener("submit", event => {
    const form = event.target;
    if (!form.matches || !form.matches("form") || event.defaultPrevented) return;
    const button = form.querySelector('button[type="submit"], .button-primary');
    if (!button || form.method.toLowerCase() === "get") return;
    setTimeout(() => button.classList.add("is-loading"), 0);
  });
  window.addEventListener("pageshow", () => $$(".is-loading").forEach(el => el.classList.remove("is-loading")));

  /* ---------- Product image upload: preview, validation, drag and drop, change / remove ----------
     The server re-validates everything (real file type from its bytes, 5 MB limit); this is for fast feedback. */
  $$("[data-image-upload]").forEach(box => {
    const input = $(".image-input", box), drop = $(".image-drop", box), preview = $(".image-preview", box);
    const img = $("img", preview), label = $(".image-name", preview), error = $(".image-error", box);
    const removed = $("[data-image-removed]", box);
    const maxBytes = Number(box.dataset.maxBytes) || 5 * 1024 * 1024;
    const existing = img.getAttribute("src") || "";   // image already saved on this product (edit form)
    let objectUrl = null;
    const say = message => { error.textContent = message || ""; error.hidden = !message; };
    const release = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } };
    const sizeText = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
    const showEmpty = () => { release(); img.removeAttribute("src"); label.textContent = ""; preview.hidden = true; drop.hidden = false; };
    const showExisting = () => {
      release();
      if (!existing) return showEmpty();
      img.src = existing; label.textContent = "Current image"; drop.hidden = true; preview.hidden = false;
    };
    const valid = file => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !/\.(jpe?g|png|webp)$/i.test(file.name)) { say("Choose a JPG, JPEG, PNG or WEBP image."); return false; }
      if (file.size > maxBytes) { say("That image is " + sizeText(file.size) + ". The maximum size is 5 MB."); return false; }
      if (file.size === 0) { say("That file is empty."); return false; }
      say("");
      return true;
    };
    const choose = file => {
      release();
      objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;
      label.textContent = file.name + " · " + sizeText(file.size);
      drop.hidden = true; preview.hidden = false;
      removed.value = "";
    };
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (valid(file)) choose(file);
      else { input.value = ""; showExisting(); removed.value = ""; }
    });
    $("[data-image-change]", box).addEventListener("click", () => input.click());
    $("[data-image-remove]", box).addEventListener("click", () => {
      input.value = "";
      say("");
      showEmpty();
      removed.value = existing ? "1" : "";
    });
    // Cancel / close resets the whole form, so the image area must return to its starting state too.
    const ownerForm = box.closest("form");
    if (ownerForm) ownerForm.addEventListener("reset", () => setTimeout(() => { say(""); showExisting(); removed.value = ""; }, 0));
    // The preview sits inside the field's <label>; only the Change button should reopen the file picker.
    preview.addEventListener("click", event => { if (!event.target.closest("button")) event.preventDefault(); });
    ["dragenter", "dragover"].forEach(type => box.addEventListener(type, event => { event.preventDefault(); box.classList.add("is-dragging"); }));
    ["dragleave", "drop"].forEach(type => box.addEventListener(type, event => { event.preventDefault(); box.classList.remove("is-dragging"); }));
    box.addEventListener("drop", event => {
      const files = event.dataTransfer && event.dataTransfer.files;
      const file = files && files[0];
      if (!file) return;
      if (!valid(file)) return;
      try { input.files = files; } catch (e) { say("Your browser could not attach the dropped file. Use click to upload instead."); return; }
      choose(file);
    });
  });

  /* ---------- Add-record modal (Products): open / close, and submit without leaving the page ----------
     The form still posts to the same route. Asking for JSON makes the server answer a rejected form with a
     message instead of redirecting, so errors show inside the modal; a successful save (a redirect) reloads
     the list, which then shows the server's own "Product created." notice. */
  const formModal = $("[data-form-modal]");
  if (formModal) {
    const modalForm = $("form[data-modal-form]", formModal);
    const formError = $(".form-error", formModal);
    const showFormError = message => { formError.textContent = message || ""; formError.hidden = !message; };
    $$("[data-open-form-modal]").forEach(button => button.addEventListener("click", () => {
      showFormError("");
      openModal(formModal, 'input[name="name"]');
      // Refresh the SKU preview for the current category and name.
      const category = modalForm.elements.CategoryId;
      if (category) category.dispatchEvent(new Event("change"));
    }));
    $$("[data-close-form-modal]", formModal).forEach(button => button.addEventListener("click", () => {
      closeModal(formModal);
      if (button.hasAttribute("data-reset-form") || button.classList.contains("modal-close")) { modalForm.reset(); showFormError(""); }
    }));
    modalForm.addEventListener("submit", event => {
      if (!window.fetch || !window.FormData) return;   // fall back to the normal form post
      event.preventDefault();
      const submit = $('button[type="submit"]', modalForm);
      showFormError("");
      submit.classList.add("is-loading");
      fetch(modalForm.action, {
        method: "POST", body: new FormData(modalForm), credentials: "same-origin",
        headers: { Accept: "application/json" }, redirect: "manual"
      }).then(async response => {
        if (response.type === "opaqueredirect") { window.location.reload(); return; }   // saved: the server redirected
        let message = "The product could not be saved. Please try again.";
        try { const data = await response.json(); if (data && data.error) message = data.error; } catch (e) { /* keep the default */ }
        showFormError(message);
        submit.classList.remove("is-loading");
        modalForm.scrollTop = 0;
      }).catch(() => {
        showFormError("Could not reach the server. Check your connection and try again.");
        submit.classList.remove("is-loading");
      });
    });
  }

  /* ---------- Print header date ---------- */
  $$("[data-print-date]").forEach(el => { el.textContent = new Date().toLocaleString(); });
})();
