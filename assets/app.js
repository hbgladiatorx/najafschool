(function () {
  "use strict";

  var FORM_ACTION =
    "https://docs.google.com/forms/d/e/1FAIpQLSe2_YE8zh-seaksC2WyedkJhGbS6S3-e6BZpAtc7gWrYv3LZg/formResponse";

  var html = document.documentElement;
  var lang = localStorage.getItem("najaf.lang") || "ar";

  /* ── Language ─────────────────────────────────────── */
  function t(key) {
    var d = window.I18N[lang];
    return (d && d[key]) != null ? d[key] : window.I18N.ar[key] || "";
  }

  function applyLang(next) {
    lang = next;
    localStorage.setItem("najaf.lang", lang);
    html.lang = lang;
    html.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = t("docTitle");

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var v = window.I18N[lang][el.getAttribute("data-i18n")];
      if (v != null) el.innerHTML = v;
    });

    var toggle = document.getElementById("langToggle");
    toggle.textContent = lang === "ar" ? "English" : "العربية";
    toggle.setAttribute(
      "aria-label",
      lang === "ar" ? "Switch to English" : "التبديل إلى العربية"
    );

    // Re-render any error messages already on screen in the new language.
    document.querySelectorAll(".err.show").forEach(function (p) {
      p.textContent = t(p.dataset.errKey || "errRequired");
    });
    var status = document.getElementById("formStatus");
    if (status && status.dataset.key) status.textContent = t(status.dataset.key);
  }

  document.getElementById("langToggle").addEventListener("click", function () {
    applyLang(lang === "ar" ? "en" : "ar");
  });

  /* ── Header & navigation ──────────────────────────── */
  var header = document.getElementById("siteHeader");
  var nav = document.querySelector(".site-nav");
  var navToggle = document.getElementById("navToggle");

  navToggle.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
  });
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A") {
      nav.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    }
  });

  var onScroll = function () {
    header.classList.toggle("scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var links = Array.prototype.slice.call(nav.querySelectorAll("a"));
  if ("IntersectionObserver" in window) {
    var obs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          links.forEach(function (a) {
            a.classList.toggle(
              "active",
              a.getAttribute("href") === "#" + en.target.id
            );
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    links.forEach(function (a) {
      var s = document.querySelector(a.getAttribute("href"));
      if (s) obs.observe(s);
    });
  }

  /* ── Application form ─────────────────────────────── */
  var form = document.getElementById("applyForm");
  var statusEl = document.getElementById("formStatus");
  var submitBtn = document.getElementById("submitBtn");
  var successCard = document.getElementById("successCard");

  function fieldOf(el) {
    return el.closest(".field");
  }

  function setError(el, key) {
    var field = fieldOf(el);
    if (!field) return;
    var p = field.querySelector("[data-err]");
    if (!p) return;
    if (key) {
      p.dataset.errKey = key;
      p.textContent = t(key);
      p.classList.add("show");
      el.classList.add("invalid");
      el.setAttribute("aria-invalid", "true");
    } else {
      p.classList.remove("show");
      p.textContent = "";
      delete p.dataset.errKey;
      el.classList.remove("invalid");
      el.removeAttribute("aria-invalid");
    }
  }

  function validate() {
    var firstBad = null;

    form.querySelectorAll("input[required]").forEach(function (el) {
      if (el.type === "radio") return;
      var ok = el.value.trim() !== "";
      setError(el, ok ? null : "errRequired");
      if (!ok && !firstBad) firstBad = el;
    });

    var radios = form.querySelectorAll('input[type="radio"][required]');
    if (radios.length) {
      var group = form.querySelectorAll('input[name="' + radios[0].name + '"]');
      var chosen = Array.prototype.some.call(group, function (r) {
        return r.checked;
      });
      setError(radios[0], chosen ? null : "errChoose");
      if (!chosen && !firstBad) firstBad = radios[0];
    }

    return firstBad;
  }

  form.addEventListener("input", function (e) {
    if (e.target.classList.contains("invalid")) setError(e.target, null);
  });
  form.addEventListener("change", function (e) {
    if (e.target.type === "radio") setError(e.target, null);
  });

  function setStatus(key, isError) {
    if (key) {
      statusEl.dataset.key = key;
      statusEl.textContent = t(key);
    } else {
      delete statusEl.dataset.key;
      statusEl.textContent = "";
    }
    statusEl.classList.toggle("error", !!isError);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var bad = validate();
    if (bad) {
      setStatus("errFix", true);
      bad.focus();
      bad.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }

    setStatus(null);
    submitBtn.disabled = true;
    submitBtn.textContent = t("sending");

    // Google Forms rejects cross-origin reads, so post through a hidden
    // iframe: the request still reaches the sheet, the response is discarded.
    var frameName = "gf_sink";
    var frame = document.getElementById(frameName);
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = frameName;
      frame.name = frameName;
      frame.style.display = "none";
      document.body.appendChild(frame);
    }

    var proxy = document.createElement("form");
    proxy.action = FORM_ACTION;
    proxy.method = "POST";
    proxy.target = frameName;
    proxy.style.display = "none";

    new FormData(form).forEach(function (value, key) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      proxy.appendChild(input);
    });

    document.body.appendChild(proxy);

    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      proxy.remove();
      submitBtn.disabled = false;
      submitBtn.textContent = t("submit");
      form.hidden = true;
      successCard.hidden = false;
      successCard.scrollIntoView({ block: "center", behavior: "smooth" });
    };

    frame.addEventListener("load", finish, { once: true });
    setTimeout(finish, 2500); // fallback if the iframe load event never fires
    proxy.submit();
  });

  document.getElementById("againBtn").addEventListener("click", function () {
    form.reset();
    form.querySelectorAll(".invalid").forEach(function (el) {
      setError(el, null);
    });
    setStatus(null);
    successCard.hidden = true;
    form.hidden = false;
  });

  applyLang(lang);
})();
