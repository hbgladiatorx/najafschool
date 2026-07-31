(function () {
  "use strict";

  var API = "/api/apply";
  var SCHEMA_URL = "../assets/fields.json?v=2";
  var DRAFT_KEY = "najaf.application.draft";

  var lang = localStorage.getItem("najaf.lang") || "ar";
  var schema = null;
  var step = 0;          // 0..sections.length  (the last index is the review step)
  var totalSteps = 0;
  var submitted = false;

  var el = {
    intro: document.getElementById("intro"),
    form: document.getElementById("applyForm"),
    steps: document.getElementById("steps"),
    progress: document.getElementById("progress"),
    progressSteps: document.getElementById("progressSteps"),
    progressFill: document.getElementById("progressFill"),
    stepLabel: document.getElementById("stepLabel"),
    prevBtn: document.getElementById("prevBtn"),
    nextBtn: document.getElementById("nextBtn"),
    submitBtn: document.getElementById("submitBtn"),
    status: document.getElementById("formStatus"),
    success: document.getElementById("successCard"),
    successRef: document.getElementById("successRef"),
    draftSaved: document.getElementById("draftSaved"),
    clearDraft: document.getElementById("clearDraft"),
    loadError: document.getElementById("loadError")
  };

  /* ── Language ──────────────────────────────────────────────────────── */
  function t(key, vars) {
    var s = (window.APPLY_I18N[lang] || {})[key] || window.APPLY_I18N.ar[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      });
    }
    return s;
  }

  function label(obj) {
    return obj ? (obj[lang] || obj.en || obj.ar || "") : "";
  }

  /* ── Countries ─────────────────────────────────────────────────────── */
  var COUNTRY_CODES = ("AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI KH CM CA " +
    "CV CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD " +
    "GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML " +
    "MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY PE PH PL PT QA RO " +
    "RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN " +
    "TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW HK MO PR").split(" ");

  var countryNamer = null;
  function countryName(code) {
    if (countryNamer === null) {
      try {
        countryNamer = new Intl.DisplayNames([lang], { type: "region" });
      } catch (e) {
        countryNamer = false;
      }
    }
    if (countryNamer) {
      try { return countryNamer.of(code) || code; } catch (e) { /* fall through */ }
    }
    return code;
  }

  function sortedCountries() {
    var list = COUNTRY_CODES.map(function (c) { return { code: c, name: countryName(c) }; });
    try {
      list.sort(function (a, b) { return a.name.localeCompare(b.name, lang); });
    } catch (e) {
      list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    }
    return list;
  }

  /* ── Field rendering ───────────────────────────────────────────────── */
  function fieldsOf(section) {
    return section.fields;
  }

  function allFields() {
    var out = [];
    schema.sections.forEach(function (s) {
      s.fields.forEach(function (f) { if (f.type !== "heading") out.push(f); });
    });
    return out;
  }

  function optionList(field) {
    if (field.type === "fluency") return schema.fluencyLevels;
    if (field.type === "level") {
      return schema.fluencyLevels.filter(function (l) {
        return ["beginner", "intermediate", "advanced"].indexOf(l.value) !== -1;
      });
    }
    if (field.type === "yesno") {
      return [
        { value: "yes", label: { ar: "نعم", en: "Yes" } },
        { value: "no", label: { ar: "لا", en: "No" } }
      ];
    }
    return field.options || [];
  }

  function makeField(field) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    wrap.dataset.field = field.name;
    if (field.showIf) wrap.dataset.conditional = "1";

    if (field.type === "heading") {
      var h = document.createElement("h3");
      h.className = "field-heading";
      h.textContent = label(field.label);
      wrap.className = "field-heading-wrap";
      wrap.appendChild(h);
      return wrap;
    }

    var id = "f_" + field.name;
    var isGroup = ["radio", "checkbox", "yesno", "declaration"].indexOf(field.type) !== -1;

    // Label
    var lab = document.createElement(isGroup ? "span" : "label");
    lab.className = "field-label";
    if (!isGroup) lab.setAttribute("for", id);
    lab.textContent = label(field.label);
    if (field.required) {
      var star = document.createElement("span");
      star.className = "req";
      star.textContent = " *";
      lab.appendChild(star);
    } else {
      var opt = document.createElement("span");
      opt.className = "optional";
      opt.textContent = " (" + t("optional") + ")";
      lab.appendChild(opt);
    }
    if (field.type !== "declaration") wrap.appendChild(lab);

    var control = buildControl(field, id);
    wrap.appendChild(control);

    if (field.hint) {
      var hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = label(field.hint);
      wrap.appendChild(hint);
    }
    if (field.type === "essay") {
      var counter = document.createElement("p");
      counter.className = "counter";
      counter.dataset.counter = field.name;
      wrap.appendChild(counter);
    }

    var err = document.createElement("p");
    err.className = "err";
    err.dataset.err = field.name;
    wrap.appendChild(err);
    return wrap;
  }

  function buildControl(field, id) {
    var type = field.type;

    if (type === "textarea" || type === "essay") {
      var ta = document.createElement("textarea");
      ta.id = id;
      ta.name = field.name;
      ta.rows = type === "essay" ? 9 : 4;
      return ta;
    }

    if (type === "select" || type === "fluency" || type === "level" || type === "country") {
      var sel = document.createElement("select");
      sel.id = id;
      sel.name = field.name;
      var blank = document.createElement("option");
      blank.value = "";
      blank.textContent = t("selectPlaceholder");
      sel.appendChild(blank);

      if (type === "country") {
        sortedCountries().forEach(function (c) {
          var o = document.createElement("option");
          o.value = c.code;
          o.textContent = c.name;
          sel.appendChild(o);
        });
      } else {
        optionList(field).forEach(function (o) {
          var op = document.createElement("option");
          op.value = o.value;
          op.textContent = label(o.label);
          sel.appendChild(op);
        });
      }
      return sel;
    }

    if (type === "radio" || type === "yesno") {
      var group = document.createElement("div");
      group.className = "choices";
      group.setAttribute("role", "radiogroup");
      optionList(field).forEach(function (o, i) {
        var l = document.createElement("label");
        l.className = "choice";
        var input = document.createElement("input");
        input.type = "radio";
        input.name = field.name;
        input.value = o.value;
        if (i === 0) input.id = id;
        var span = document.createElement("span");
        span.textContent = label(o.label);
        l.appendChild(input);
        l.appendChild(span);
        group.appendChild(l);
      });
      return group;
    }

    if (type === "checkbox") {
      var cgroup = document.createElement("div");
      cgroup.className = "choices";
      optionList(field).forEach(function (o, i) {
        var l = document.createElement("label");
        l.className = "choice";
        var input = document.createElement("input");
        input.type = "checkbox";
        input.name = field.name;
        input.value = o.value;
        if (i === 0) input.id = id;
        var span = document.createElement("span");
        span.textContent = label(o.label);
        l.appendChild(input);
        l.appendChild(span);
        cgroup.appendChild(l);
      });
      return cgroup;
    }

    if (type === "declaration") {
      var dl = document.createElement("label");
      dl.className = "declaration";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.name = field.name;
      cb.value = "yes";
      var span2 = document.createElement("span");
      span2.textContent = label(field.label);
      dl.appendChild(cb);
      dl.appendChild(span2);
      return dl;
    }

    if (type === "file") {
      var fwrap = document.createElement("div");
      fwrap.className = "filefield";
      var input = document.createElement("input");
      input.type = "file";
      input.id = id;
      input.name = field.name;
      input.accept = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx";
      var btn = document.createElement("label");
      btn.className = "file-btn";
      btn.setAttribute("for", id);
      btn.textContent = t("chooseFile");
      var name = document.createElement("span");
      name.className = "file-name";
      name.dataset.filename = field.name;
      var hint = document.createElement("span");
      hint.className = "file-hint";
      hint.textContent = t("fileHint");
      fwrap.appendChild(input);
      fwrap.appendChild(btn);
      fwrap.appendChild(name);
      fwrap.appendChild(hint);
      return fwrap;
    }

    var inp = document.createElement("input");
    inp.type = type === "email" ? "email" : type === "tel" ? "tel" : type === "date" ? "date" : "text";
    inp.id = id;
    inp.name = field.name;
    if (field.autocomplete) inp.autocomplete = field.autocomplete;
    if (field.ltr) inp.dir = "ltr";
    return inp;
  }

  /* ── Build the steps ───────────────────────────────────────────────── */
  function build() {
    el.steps.textContent = "";
    schema.sections.forEach(function (section, i) {
      var panel = document.createElement("section");
      panel.className = "step";
      panel.dataset.step = String(i);
      panel.hidden = i !== step;

      var h = document.createElement("h2");
      h.textContent = label(section.title);
      panel.appendChild(h);

      if (section.intro) {
        var p = document.createElement("p");
        p.className = "lede";
        p.textContent = label(section.intro);
        panel.appendChild(p);
      }

      fieldsOf(section).forEach(function (f) { panel.appendChild(makeField(f)); });
      el.steps.appendChild(panel);
    });

    // Review step
    var review = document.createElement("section");
    review.className = "step";
    review.dataset.step = String(schema.sections.length);
    review.hidden = true;
    review.innerHTML = '<h2></h2><p class="lede"></p><div id="reviewBody"></div>';
    review.querySelector("h2").textContent = t("reviewTitle");
    review.querySelector(".lede").textContent = t("reviewLede");
    el.steps.appendChild(review);

    totalSteps = schema.sections.length + 1;
    buildProgress();
  }

  function buildProgress() {
    el.progressSteps.textContent = "";
    schema.sections.forEach(function (s, i) {
      var li = document.createElement("li");
      li.textContent = label(s.title);
      li.dataset.step = String(i);
      li.addEventListener("click", function () {
        if (i < step) goTo(i);   // only jump back to a step already completed
      });
      el.progressSteps.appendChild(li);
    });
    el.progress.hidden = false;
  }

  /* ── Values ────────────────────────────────────────────────────────── */
  function valueOf(name) {
    var nodes = el.form.querySelectorAll('[name="' + name + '"]');
    if (!nodes.length) return "";
    var first = nodes[0];
    if (first.type === "checkbox" && nodes.length > 1) {
      return Array.prototype.filter.call(nodes, function (n) { return n.checked; })
        .map(function (n) { return n.value; });
    }
    if (first.type === "checkbox") return first.checked ? first.value : "";
    if (first.type === "radio") {
      var picked = Array.prototype.filter.call(nodes, function (n) { return n.checked; })[0];
      return picked ? picked.value : "";
    }
    if (first.type === "file") return first.files && first.files.length ? first.files[0] : null;
    return (first.value || "").trim();
  }

  function isVisible(field) {
    var cond = field.showIf;
    if (!cond) return true;
    var other = valueOf(cond.field);
    if (cond.equals !== undefined) return other === cond.equals;
    if (cond.notEquals !== undefined) return other !== "" && other !== cond.notEquals;
    if (cond.contains !== undefined) {
      var arr = Array.isArray(other) ? other : [other];
      return arr.indexOf(cond.contains) !== -1;
    }
    return true;
  }

  function applyConditionals() {
    allFields().forEach(function (f) {
      if (!f.showIf) return;
      var node = el.form.querySelector('[data-field="' + f.name + '"]');
      if (node) node.hidden = !isVisible(f);
    });
  }

  function countWords(s) {
    return s.trim() ? s.trim().split(/\s+/).length : 0;
  }

  /* ── Validation ────────────────────────────────────────────────────── */
  function setError(name, message) {
    var node = el.form.querySelector('[data-field="' + name + '"]');
    if (!node) return;
    var p = node.querySelector('[data-err]');
    var controls = node.querySelectorAll("input, select, textarea");
    if (message) {
      p.textContent = message;
      p.classList.add("show");
      node.classList.add("has-error");
      if (controls[0]) controls[0].setAttribute("aria-invalid", "true");
    } else {
      p.textContent = "";
      p.classList.remove("show");
      node.classList.remove("has-error");
      Array.prototype.forEach.call(controls, function (c) { c.removeAttribute("aria-invalid"); });
    }
  }

  function validateField(field) {
    if (!isVisible(field)) return null;
    var value = valueOf(field.name);
    var empty = value === "" || value === null ||
      (Array.isArray(value) && value.length === 0) ||
      (field.type === "declaration" && value !== "yes");

    if (field.required && empty) return t("errRequired");
    if (empty) return null;

    if (field.type === "email" && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(value)) return t("errEmail");

    if (field.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return t("errDate");
      if (field.name === "date_of_birth") {
        var born = new Date(value + "T00:00:00");
        var now = new Date();
        var age = now.getFullYear() - born.getFullYear();
        var m = now.getMonth() - born.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age--;
        if (born >= now) return t("errDate");
        if (age < 16 || age > 80) return t("errAge");
      }
    }

    if (field.type === "file" && value) {
      var ext = "." + (value.name.split(".").pop() || "").toLowerCase();
      if ([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".doc", ".docx"].indexOf(ext) === -1) {
        return t("errFileType");
      }
      if (value.size > 15 * 1024 * 1024) return t("errFileSize");
    }

    if (field.type === "essay") {
      var words = countWords(value);
      if (field.minWords && words < field.minWords) return t("errMinWords", { n: field.minWords });
      if (field.maxWords && words > field.maxWords) return t("errMaxWords", { n: field.maxWords });
    }

    return null;
  }

  function validateStep(index) {
    var section = schema.sections[index];
    if (!section) return true;
    var firstBad = null;
    var count = 0;

    section.fields.forEach(function (f) {
      if (f.type === "heading") return;
      var message = validateField(f);
      setError(f.name, message);
      if (message) {
        count++;
        if (!firstBad) firstBad = f.name;
      }
    });

    if (firstBad) {
      setStatus(t("errStep") + " " + t("errSummary", { n: count }), true);
      var node = el.form.querySelector('[data-field="' + firstBad + '"]');
      var control = node && node.querySelector("input, select, textarea");
      if (control) {
        control.focus({ preventScroll: true });
        node.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return false;
    }
    setStatus("");
    return true;
  }

  function setStatus(message, isError) {
    el.status.textContent = message || "";
    el.status.classList.toggle("error", !!isError);
  }

  /* ── Navigation ────────────────────────────────────────────────────── */
  function goTo(index) {
    step = index;
    Array.prototype.forEach.call(el.steps.children, function (panel) {
      panel.hidden = Number(panel.dataset.step) !== step;
    });

    var onReview = step === totalSteps - 1;
    el.prevBtn.hidden = step === 0;
    el.nextBtn.hidden = onReview;
    el.submitBtn.hidden = !onReview;
    el.nextBtn.textContent = step === totalSteps - 2 ? t("review") : t("next");
    el.intro.hidden = step > 0;

    Array.prototype.forEach.call(el.progressSteps.children, function (li, i) {
      li.classList.toggle("done", i < step);
      li.classList.toggle("current", i === step);
    });
    el.stepLabel.textContent = t("stepOf", { a: Math.min(step + 1, totalSteps), b: totalSteps });
    el.progressFill.style.width = ((step / (totalSteps - 1)) * 100).toFixed(1) + "%";

    if (onReview) renderReview();
    setStatus("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderReview() {
    var body = document.getElementById("reviewBody");
    body.textContent = "";

    schema.sections.forEach(function (section, i) {
      var card = document.createElement("div");
      card.className = "review-section";

      var head = document.createElement("div");
      head.className = "review-head";
      var h = document.createElement("h3");
      h.textContent = label(section.title);
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "linkish";
      edit.textContent = t("edit");
      edit.addEventListener("click", function () { goTo(i); });
      head.appendChild(h);
      head.appendChild(edit);
      card.appendChild(head);

      var dl = document.createElement("dl");
      section.fields.forEach(function (f) {
        if (f.type === "heading" || !isVisible(f)) return;
        var value = valueOf(f.name);
        var text;
        if (f.type === "file") {
          text = value ? value.name : "";
        } else if (Array.isArray(value)) {
          text = value.map(function (v) { return optionLabel(f, v); }).join("، ");
        } else if (f.type === "declaration") {
          text = value === "yes" ? t("yes") : "";
        } else if (["radio", "select", "fluency", "level", "yesno"].indexOf(f.type) !== -1) {
          text = optionLabel(f, value);
        } else if (f.type === "country") {
          text = value ? countryName(value) : "";
        } else {
          text = value;
        }

        var dt = document.createElement("dt");
        dt.textContent = label(f.label);
        var dd = document.createElement("dd");
        if (text) {
          dd.textContent = text;
        } else {
          dd.textContent = t("notAnswered");
          dd.className = "blank";
        }
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      card.appendChild(dl);
      body.appendChild(card);
    });
  }

  function optionLabel(field, value) {
    if (!value) return "";
    var found = optionList(field).filter(function (o) { return o.value === value; })[0];
    return found ? label(found.label) : value;
  }

  /* ── Draft ─────────────────────────────────────────────────────────── */
  var saveTimer = null;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var data = {};
      allFields().forEach(function (f) {
        if (f.type === "file") return;   // files cannot be stored in localStorage
        var v = valueOf(f.name);
        if (v !== "" && !(Array.isArray(v) && !v.length)) data[f.name] = v;
      });
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ step: step, data: data }));
        el.draftSaved.hidden = false;
        clearTimeout(el.draftSaved._hide);
        el.draftSaved._hide = setTimeout(function () { el.draftSaved.hidden = true; }, 2000);
      } catch (e) { /* private browsing, quota — draft saving is best effort */ }
    }, 600);
  }

  function loadDraft() {
    var raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
    if (!raw) return;
    var draft;
    try { draft = JSON.parse(raw); } catch (e) { return; }

    Object.keys(draft.data || {}).forEach(function (name) {
      var value = draft.data[name];
      var nodes = el.form.querySelectorAll('[name="' + name + '"]');
      if (!nodes.length) return;
      var first = nodes[0];
      if (first.type === "radio" || first.type === "checkbox") {
        var wanted = Array.isArray(value) ? value : [value];
        Array.prototype.forEach.call(nodes, function (n) {
          n.checked = wanted.indexOf(n.value) !== -1;
        });
      } else if (first.type !== "file") {
        first.value = value;
      }
    });
    applyConditionals();
    updateCounters();
  }

  function updateCounters() {
    allFields().forEach(function (f) {
      if (f.type !== "essay") return;
      var node = el.form.querySelector('[data-counter="' + f.name + '"]');
      if (!node) return;
      var words = countWords(valueOf(f.name) || "");
      if (f.minWords && words < f.minWords) {
        node.textContent = t("wordsMin", { n: words, min: f.minWords });
        node.className = "counter low";
      } else if (f.maxWords && words > f.maxWords) {
        node.textContent = t("wordsMax", { n: words, max: f.maxWords });
        node.className = "counter over";
      } else {
        node.textContent = t("words", { n: words });
        node.className = "counter ok";
      }
    });
  }

  /* ── Submission ────────────────────────────────────────────────────── */
  function submit(e) {
    e.preventDefault();
    if (submitted) return;

    // Re-check every step, not just the current one.
    for (var i = 0; i < schema.sections.length; i++) {
      if (!validateStep(i)) { goTo(i); validateStep(i); return; }
    }

    var body = new FormData();
    allFields().forEach(function (f) {
      if (!isVisible(f)) return;
      var v = valueOf(f.name);
      if (f.type === "file") {
        if (v) body.append(f.name, v, v.name);
      } else if (Array.isArray(v)) {
        v.forEach(function (item) { body.append(f.name, item); });
      } else if (v !== "") {
        body.append(f.name, v);
      }
    });
    body.append("_lang", lang);
    var honey = el.form.querySelector('[name="website"]');
    if (honey) body.append("website", honey.value);

    submitted = true;
    el.submitBtn.disabled = true;
    el.submitBtn.textContent = t("sending");
    setStatus("");

    fetch(API, { method: "POST", body: body })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (out) {
        if (out.status === 201 || (out.status === 200 && out.data.ok)) {
          onSuccess(out.data.id);
          return;
        }
        submitted = false;
        el.submitBtn.disabled = false;
        el.submitBtn.textContent = t("submit");

        if (out.status === 422 && out.data.errors) {
          showServerErrors(out.data.errors);
        } else if (out.status === 429) {
          setStatus(t("errRate"), true);
        } else if (out.status === 413) {
          setStatus(t("errTooLarge"), true);
        } else {
          setStatus(t("errServer"), true);
        }
      })
      .catch(function () {
        submitted = false;
        el.submitBtn.disabled = false;
        el.submitBtn.textContent = t("submit");
        setStatus(t("errNetwork"), true);
      });
  }

  function showServerErrors(errors) {
    var names = Object.keys(errors);
    var firstStep = null;

    names.forEach(function (name) {
      var code = errors[name];
      var message;
      if (code === "required") message = t("errRequired");
      else if (code === "email") message = t("errEmail");
      else if (code === "date") message = t("errDate");
      else if (code === "age") message = t("errAge");
      else if (code === "fileType") message = t("errFileType");
      else if (code === "fileSize") message = t("errFileSize");
      else if (code === "tooLong") message = t("errTooLong");
      else if (String(code).indexOf("minWords:") === 0) {
        message = t("errMinWords", { n: String(code).split(":")[1] });
      } else if (String(code).indexOf("maxWords:") === 0) {
        message = t("errMaxWords", { n: String(code).split(":")[1] });
      } else message = t("errInvalid");

      setError(name, message);
      schema.sections.forEach(function (s, i) {
        s.fields.forEach(function (f) {
          if (f.name === name && firstStep === null) firstStep = i;
        });
      });
    });

    setStatus(t("errSummary", { n: names.length }), true);
    if (firstStep !== null) goTo(firstStep);
  }

  function onSuccess(id) {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing to clean up */ }
    el.form.hidden = true;
    el.progress.hidden = true;
    el.intro.hidden = true;
    el.success.hidden = false;
    el.successRef.textContent = t("successRef", { id: id || "—" });
    applyStrings();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ── Wiring ────────────────────────────────────────────────────────── */
  function applyStrings() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = t("docTitle");
    document.querySelectorAll("[data-t]").forEach(function (node) {
      node.textContent = t(node.getAttribute("data-t"));
    });
    document.getElementById("langToggle").textContent = lang === "ar" ? "English" : "العربية";
  }

  function rebuildKeepingAnswers() {
    // Re-render in the other language without losing what has been typed.
    var snapshot = {};
    allFields().forEach(function (f) {
      if (f.type === "file") return;
      snapshot[f.name] = valueOf(f.name);
    });
    countryNamer = null;
    build();
    Object.keys(snapshot).forEach(function (name) {
      var value = snapshot[name];
      var nodes = el.form.querySelectorAll('[name="' + name + '"]');
      if (!nodes.length) return;
      var first = nodes[0];
      if (first.type === "radio" || first.type === "checkbox") {
        var wanted = Array.isArray(value) ? value : [value];
        Array.prototype.forEach.call(nodes, function (n) {
          n.checked = wanted.indexOf(n.value) !== -1;
        });
      } else if (first.type !== "file") {
        first.value = value;
      }
    });
    applyConditionals();
    updateCounters();
    goTo(step);
  }

  document.getElementById("langToggle").addEventListener("click", function () {
    lang = lang === "ar" ? "en" : "ar";
    localStorage.setItem("najaf.lang", lang);
    applyStrings();
    if (schema) rebuildKeepingAnswers();
  });

  el.nextBtn.addEventListener("click", function () {
    if (validateStep(step)) goTo(Math.min(step + 1, totalSteps - 1));
  });
  el.prevBtn.addEventListener("click", function () { goTo(Math.max(step - 1, 0)); });
  el.form.addEventListener("submit", submit);

  el.form.addEventListener("input", function (e) {
    applyConditionals();
    if (e.target.tagName === "TEXTAREA") updateCounters();
    if (e.target.closest(".has-error")) {
      setError(e.target.closest("[data-field]").dataset.field, null);
    }
    saveDraft();
  });

  el.form.addEventListener("change", function (e) {
    applyConditionals();
    if (e.target.type === "file") {
      var name = e.target.name;
      var display = el.form.querySelector('[data-filename="' + name + '"]');
      if (display) {
        display.textContent = e.target.files.length ? e.target.files[0].name : "";
      }
      var btn = e.target.parentNode.querySelector(".file-btn");
      if (btn) btn.textContent = e.target.files.length ? t("changeFile") : t("chooseFile");
    }
    if (e.target.closest(".has-error")) {
      setError(e.target.closest("[data-field]").dataset.field, null);
    }
    saveDraft();
  });

  el.clearDraft.addEventListener("click", function () {
    if (!window.confirm(t("clearConfirm"))) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing to clean up */ }
    el.form.reset();
    applyConditionals();
    updateCounters();
    goTo(0);
  });

  window.addEventListener("beforeunload", function (e) {
    if (submitted) return;
    var touched = allFields().some(function (f) {
      var v = valueOf(f.name);
      return v && !(Array.isArray(v) && !v.length);
    });
    if (touched) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ── Start ─────────────────────────────────────────────────────────── */
  applyStrings();
  fetch(SCHEMA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error("schema " + r.status);
      return r.json();
    })
    .then(function (data) {
      schema = data;
      build();
      loadDraft();
      // Default the signature date to today.
      var dateField = el.form.querySelector('[name="signed_date"]');
      if (dateField && !dateField.value) {
        dateField.value = new Date().toISOString().slice(0, 10);
      }
      goTo(0);
    })
    .catch(function () {
      el.form.hidden = true;
      el.loadError.hidden = false;
      el.loadError.textContent = t("errServer");
    });
})();
