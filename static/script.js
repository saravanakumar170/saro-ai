(() => {
  const chatEl = document.getElementById("chat");
  const formEl = document.getElementById("chatForm");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsBackdrop = document.getElementById("settingsBackdrop");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const aiNameInput = document.getElementById("aiNameInput");
  const themeLight = document.getElementById("themeLight");
  const themeDark = document.getElementById("themeDark");
  const attachBtn = document.getElementById("attachBtn");
  const fileInput = document.getElementById("fileInput");
  const attachmentsPreview = document.getElementById("attachmentsPreview");

  const PROVIDERS = ["openai", "claude", "deepseek", "custom"];
  const TEXT_EXTENSIONS = ["txt", "md", "csv", "json", "log", "js", "py", "html", "css", "yaml", "yml", "xml"];
  const MAX_INLINE_TEXT_CHARS = 20000;

  // ---------------------------------------------------------------------
  // Settings persistence
  // ---------------------------------------------------------------------

  function loadSettings() {
    const providers = {};
    for (const p of PROVIDERS) {
      providers[p] = {
        key: localStorage.getItem(`saro_key_${p}`) || "",
        model: localStorage.getItem(`saro_model_${p}`) || "",
        baseUrl: p === "custom" ? localStorage.getItem("saro_custom_baseurl") || "" : "",
      };
    }
    return {
      theme: localStorage.getItem("saro_theme") || "light",
      aiName: localStorage.getItem("saro_ai_name") || "",
      activeProvider: localStorage.getItem("saro_active_provider") || null,
      providers,
    };
  }

  const settings = loadSettings();

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    themeLight.classList.toggle("active", theme === "light");
    themeDark.classList.toggle("active", theme === "dark");
  }

  function saveSettings() {
    localStorage.setItem("saro_theme", settings.theme);
    localStorage.setItem("saro_ai_name", settings.aiName || "");
    localStorage.setItem("saro_active_provider", settings.activeProvider || "");
    for (const p of PROVIDERS) {
      localStorage.setItem(`saro_key_${p}`, settings.providers[p].key || "");
      localStorage.setItem(`saro_model_${p}`, settings.providers[p].model || "");
      if (p === "custom") {
        localStorage.setItem("saro_custom_baseurl", settings.providers[p].baseUrl || "");
      }
    }
  }

  function populateSettingsForm() {
    aiNameInput.value = settings.aiName;
    applyTheme(settings.theme);
    document.querySelectorAll(".provider-toggle").forEach((el) => {
      el.checked = settings.activeProvider === el.dataset.provider;
    });
    document.querySelectorAll(".provider-key").forEach((el) => {
      el.value = settings.providers[el.dataset.provider]?.key || "";
    });
    document.querySelectorAll(".provider-model").forEach((el) => {
      el.value = settings.providers[el.dataset.provider]?.model || "";
    });
    const baseUrlEl = document.querySelector(".provider-baseurl");
    if (baseUrlEl) baseUrlEl.value = settings.providers.custom.baseUrl || "";
  }

  themeLight.addEventListener("click", () => applyTheme("light"));
  themeDark.addEventListener("click", () => applyTheme("dark"));

  document.querySelectorAll(".provider-toggle").forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked) {
        document.querySelectorAll(".provider-toggle").forEach((other) => {
          if (other !== el) other.checked = false;
        });
      }
    });
  });

  settingsBtn.addEventListener("click", () => {
    populateSettingsForm();
    settingsBackdrop.classList.add("open");
  });
  closeSettingsBtn.addEventListener("click", () => {
    settingsBackdrop.classList.remove("open");
    applyTheme(settings.theme); // revert any unsaved theme preview
  });
  settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsBackdrop) {
      settingsBackdrop.classList.remove("open");
      applyTheme(settings.theme);
    }
  });

  saveSettingsBtn.addEventListener("click", () => {
    settings.aiName = aiNameInput.value.trim();
    settings.theme = document.documentElement.getAttribute("data-theme") || "light";

    const checkedToggle = document.querySelector(".provider-toggle:checked");
    settings.activeProvider = checkedToggle ? checkedToggle.dataset.provider : null;

    document.querySelectorAll(".provider-key").forEach((el) => {
      settings.providers[el.dataset.provider].key = el.value.trim();
    });
    document.querySelectorAll(".provider-model").forEach((el) => {
      settings.providers[el.dataset.provider].model = el.value.trim();
    });
    const baseUrlEl = document.querySelector(".provider-baseurl");
    if (baseUrlEl) settings.providers.custom.baseUrl = baseUrlEl.value.trim();

    saveSettings();
    settingsBackdrop.classList.remove("open");
  });

  applyTheme(settings.theme);

  // ---------------------------------------------------------------------
  // Markdown rendering (with a repair pass for malformed LLM table output)
  // ---------------------------------------------------------------------

  function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function isSeparatorCell(cell) {
    return /^:?-{1,}:?$/.test(cell.trim());
  }

  function repairMarkdownTables(markdown) {
    const lines = markdown.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const next = lines[i + 1];
      const looksLikeHeader = !!line && line.includes("|") && line.trim() !== "";
      const nextHasPipe = next !== undefined && next.includes("|");

      if (looksLikeHeader && nextHasPipe) {
        const headerCells = splitTableRow(line);
        const colCount = headerCells.length;

        if (colCount >= 2) {
          const nextCells = splitTableRow(next);
          const nextIsRealSeparator = nextCells.length > 0 && nextCells.every(isSeparatorCell);

          out.push("| " + headerCells.join(" | ") + " |");

          if (nextIsRealSeparator) {
            const sepCells = [];
            for (let c = 0; c < colCount; c++) {
              const raw = (nextCells[c] || "-").trim();
              const left = raw.startsWith(":");
              const right = raw.endsWith(":") && raw.length > 1;
              sepCells.push((left ? ":" : "") + "---" + (right ? ":" : ""));
            }
            out.push("| " + sepCells.join(" | ") + " |");
            i += 2;
          } else {
            // No real separator row present — synthesize one and keep the
            // next line as the first data row instead of discarding it.
            out.push("| " + Array(colCount).fill("---").join(" | ") + " |");
            i += 1;
          }

          while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
            const cells = splitTableRow(lines[i]);
            while (cells.length < colCount) cells.push("");
            out.push("| " + cells.slice(0, colCount).join(" | ") + " |");
            i++;
          }
          continue;
        }
      }

      out.push(line);
      i++;
    }
    return out.join("\n");
  }

  function renderMarkdown(raw) {
    const repaired = repairMarkdownTables(raw);
    const html = marked.parse(repaired, { breaks: true, gfm: true });
    return DOMPurify.sanitize(html);
  }

  function enhanceCodeBlocks(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      const codeEl = pre.querySelector("code");
      let lang = "";
      if (codeEl) {
        const m = /language-(\w+)/.exec(codeEl.className || "");
        if (m) lang = m[1];
      }

      const wrapper = document.createElement("div");
      wrapper.className = "code-block";

      const header = document.createElement("div");
      header.className = "code-block-header";

      const langLabel = document.createElement("span");
      langLabel.className = "code-lang";
      langLabel.textContent = lang || "code";
      header.appendChild(langLabel);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const text = (codeEl || pre).textContent;
        navigator.clipboard
          .writeText(text)
          .then(() => {
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(() => {
              btn.textContent = "Copy";
              btn.classList.remove("copied");
            }, 1500);
          })
          .catch(() => {
            btn.textContent = "Failed";
            setTimeout(() => (btn.textContent = "Copy"), 1500);
          });
      });
      header.appendChild(btn);

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  // ---------------------------------------------------------------------
  // Chat state + message rendering
  // ---------------------------------------------------------------------

  const state = {
    history: [],
    busy: false,
    attachments: [], // { id, kind: "image"|"text", name, dataUrl?, text? }
  };

  function addUserBubble(text, attachments) {
    const wrap = document.createElement("div");
    wrap.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const images = attachments.filter((a) => a.kind === "image");
    if (images.length) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      for (const img of images) {
        const el = document.createElement("img");
        el.src = img.dataUrl;
        el.alt = img.name;
        imgWrap.appendChild(el);
      }
      bubble.appendChild(imgWrap);
    }

    if (text) {
      const textEl = document.createElement("div");
      textEl.textContent = text;
      bubble.appendChild(textEl);
    }

    wrap.appendChild(bubble);
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
    return bubble;
  }

  function addAssistantBubble() {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerHTML = '<svg viewBox="0 0 24 24"><use href="#saro-spark"></use></svg>';
    const bubble = document.createElement("div");
    bubble.className = "bubble content";
    bubble.innerHTML =
      '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
    return { wrap, bubble };
  }

  function addErrorBubble(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg error";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  // ---------------------------------------------------------------------
  // Attachments (images + text-like files)
  // ---------------------------------------------------------------------

  function fileExt(name) {
    const parts = name.split(".");
    return parts.length > 1 ? parts.pop().toLowerCase() : "";
  }

  function renderAttachmentsPreview() {
    attachmentsPreview.innerHTML = "";
    for (const a of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";

      if (a.kind === "image") {
        const img = document.createElement("img");
        img.src = a.dataUrl;
        chip.appendChild(img);
      } else {
        const icon = document.createElement("div");
        icon.className = "file-icon";
        icon.textContent = (fileExt(a.name) || "txt").slice(0, 4).toUpperCase();
        chip.appendChild(icon);
      }

      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = a.name;
      chip.appendChild(name);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "chip-remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        state.attachments = state.attachments.filter((x) => x.id !== a.id);
        renderAttachmentsPreview();
      });
      chip.appendChild(removeBtn);

      attachmentsPreview.appendChild(chip);
    }
  }

  function showAttachmentWarning(text) {
    const warn = document.createElement("div");
    warn.className = "attachment-warning";
    warn.textContent = text;
    attachmentsPreview.appendChild(warn);
    setTimeout(() => warn.remove(), 4000);
  }

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = ""; // allow re-selecting the same file later

    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          state.attachments.push({ id, kind: "image", name: file.name, dataUrl: reader.result });
          renderAttachmentsPreview();
        };
        reader.readAsDataURL(file);
        continue;
      }

      const ext = fileExt(file.name);
      if (TEXT_EXTENSIONS.includes(ext)) {
        const reader = new FileReader();
        reader.onload = () => {
          let text = String(reader.result || "");
          if (text.length > MAX_INLINE_TEXT_CHARS) {
            text = text.slice(0, MAX_INLINE_TEXT_CHARS) + "\n...(truncated)";
          }
          state.attachments.push({ id, kind: "text", name: file.name, text });
          renderAttachmentsPreview();
        };
        reader.readAsText(file);
        continue;
      }

      showAttachmentWarning(
        `"${file.name}" isn't supported yet — only images and text files (${TEXT_EXTENSIONS.join(", ")}) work right now.`
      );
    }
  });

  // ---------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  function buildOutgoingContent(typedText) {
    let text = typedText;
    for (const a of state.attachments) {
      if (a.kind === "text") {
        text += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
      }
    }
    const images = state.attachments.filter((a) => a.kind === "image");
    if (images.length === 0) {
      return text;
    }
    const parts = [];
    if (text.trim()) parts.push({ type: "text", text });
    for (const img of images) {
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
    return parts;
  }

  function buildRequestPayload() {
    const payload = {
      messages: state.history,
      ai_name: settings.aiName || null,
    };
    if (settings.activeProvider) {
      const p = settings.providers[settings.activeProvider];
      payload.provider = settings.activeProvider;
      payload.api_key = p.key || null;
      if (settings.activeProvider === "custom") {
        payload.base_url = p.baseUrl || null;
      }
      if (p.model) payload.model = p.model;
    }
    return payload;
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if ((!text && state.attachments.length === 0) || state.busy) return;

    inputEl.value = "";
    inputEl.style.height = "auto";

    const attachmentsForDisplay = state.attachments;
    const content = buildOutgoingContent(text);

    addUserBubble(text, attachmentsForDisplay);
    state.history.push({ role: "user", content });
    state.attachments = [];
    renderAttachmentsPreview();

    state.busy = true;
    sendBtn.disabled = true;
    const { bubble } = addAssistantBubble();

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestPayload()),
      });

      if (!resp.body) throw new Error("No response stream from server.");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        full += chunk;
        bubble.innerHTML = renderMarkdown(full);
        enhanceCodeBlocks(bubble);
        chatEl.scrollTop = chatEl.scrollHeight;
      }

      if (!full.trim()) {
        bubble.textContent = "(no response)";
      }
      state.history.push({ role: "assistant", content: full });
    } catch (err) {
      bubble.parentElement.remove();
      addErrorBubble(`Something went wrong: ${err.message}`);
    } finally {
      state.busy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  });
})();
