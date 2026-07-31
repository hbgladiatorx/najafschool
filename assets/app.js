(function () {
  "use strict";


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

  applyLang(lang);
})();
