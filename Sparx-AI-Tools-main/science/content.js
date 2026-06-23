// Sparx Science AI module
// One-click flow: extract science question -> ask Gemini for JSON in a code block -> return parsed data.

(function initScienceModule() {
    if (!window.location.hostname.endsWith("science.sparx-learning.com")) return;

    const BTN_ID = "sai-science-btn";
    const AUTO_BTN_ID = "sai-science-auto-btn";
    const STATUS_ID = "sai-science-status";
    const PANEL_ID = "sai-science-panel";
    const FAIL_MODAL_ID = "sai-science-fail-modal";
    const SETTINGS_MODAL_ID = "sai-science-settings-modal";
    const MENU_ITEM_ID = "sai-science-menu-item";
    const STYLES_ID = "sai-science-styles";
    const SCIENCE_SETTINGS_KEY = "sai_science_settings";
    const DEFAULT_SETTINGS = {
        requestTimeoutMs: 25000,
        requestRetries: 2,
        geminiResponseTimeoutMs: 120000,
        stableWaitMs: 700,
        markerRetryCount: 3,
        markerRetryIntervalMs: 250,
        submitAttemptCount: 8,
        submitAttemptIntervalMs: 100,
        nudgeCount: 2,
        nudgeIntervalMs: 3000,
        autoTabSwitch: true,
        aiProvider: "gemini",
    };
    const AI_PROVIDER_LABELS = {
        gemini: "Gemini",
        chatgpt: "ChatGPT",
        claude: "Claude"
    };
    let activeRunId = 0;
    let autoModeActive = false;
    const SETTINGS_META = [
        { key: "requestTimeoutMs", label: "Request timeout (ms)", help: "Maximum total time for one request from this page before it fails." },
        { key: "requestRetries", label: "Request retries", help: "How many times to retry if a request fails or times out." },
        { key: "geminiResponseTimeoutMs", label: "AI response timeout (ms)", help: "Maximum wait for AI output after prompt submission." },
        { key: "stableWaitMs", label: "Stable wait before capture (ms)", help: "How long output must stay unchanged before capture." },
        { key: "markerRetryCount", label: "Marker retry count", help: "Extra checks for SAI_JSON_START/SAI_JSON_END before giving up." },
        { key: "markerRetryIntervalMs", label: "Marker retry interval (ms)", help: "Delay between each marker retry check." },
        { key: "submitAttemptCount", label: "Submit attempt count", help: "How many submit attempts are made after filling the prompt." },
        { key: "submitAttemptIntervalMs", label: "Submit attempt interval (ms)", help: "Delay between submit attempts." },
        { key: "nudgeCount", label: "Auto re-submit nudges", help: "How many extra submit nudges are sent while waiting for output." },
        { key: "nudgeIntervalMs", label: "Nudge interval (ms)", help: "Delay between auto re-submit nudges." }
    ];

    function isMessagingContextError(message) {
        const text = String(message || "").toLowerCase();
        return (
            text.includes("extension context invalidated") ||
            text.includes("message channel closed before a response was received")
        );
    }

    function isRetryableGeminiError(message) {
        const text = String(message || "").toLowerCase();
        return (
            text.includes("timed out waiting for gemini code response") ||
            text.includes("timed out waiting for ai code response") ||
            text.includes("incomplete_gemini_response") ||
            text.includes("gemini_stopped_responding") ||
            text.includes("ai_stopped_responding") ||
            text.includes("no code block text") ||
            text.includes("marker block not found")
        );
    }

    function sendRuntimeMessage(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(response);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    function withTimeout(promise, timeoutMs, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(message || "Operation timed out"));
            }, timeoutMs);
            promise
                .then((value) => {
                    clearTimeout(timer);
                    resolve(value);
                })
                .catch((err) => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    function getScienceSettings() {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get([SCIENCE_SETTINGS_KEY], (items) => {
                    const saved = items?.[SCIENCE_SETTINGS_KEY];
                    resolve({ ...DEFAULT_SETTINGS, ...(saved || {}) });
                });
            } catch {
                resolve({ ...DEFAULT_SETTINGS });
            }
        });
    }

    function saveScienceSettings(nextSettings) {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.set({ [SCIENCE_SETTINGS_KEY]: nextSettings }, () => resolve(true));
            } catch {
                resolve(false);
            }
        });
    }

    function ensureUi() {
        if (document.getElementById(BTN_ID)) return;
        ensureGlobalStyles();

        const btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.className = "sai-science-btn";
        btn.textContent = "Solve Science";

        const autoBtn = document.createElement("button");
        autoBtn.id = AUTO_BTN_ID;
        autoBtn.className = "sai-science-btn sai-science-auto-btn";
        autoBtn.textContent = "Auto: OFF";
        autoBtn.title = "Automatically solve, fill, submit and advance through questions";

        const status = document.createElement("div");
        status.id = STATUS_ID;
        status.className = "sai-science-status";

        btn.addEventListener("click", () => void runScienceFlow(btn, status));
        autoBtn.addEventListener("click", () => {
            autoModeActive = !autoModeActive;
            autoBtn.textContent = autoModeActive ? "Auto: ON" : "Auto: OFF";
            autoBtn.classList.toggle("sai-auto-active", autoModeActive);
            if (autoModeActive) void autoLoop(btn, status);
        });

        document.body.appendChild(btn);
        document.body.appendChild(autoBtn);
        document.body.appendChild(status);
        ensureResultPanel();
        ensureFailureModal();
        ensureSettingsModal();
    }

    function ensureGlobalStyles() {
        if (document.getElementById(STYLES_ID)) return;
        const link = document.createElement("link");
        link.id = STYLES_ID;
        link.rel = "stylesheet";
        link.href = chrome.runtime.getURL("cdn/css/sci.css");
        document.head.appendChild(link);
    }

    function ensureResultPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.className = "sai-result-panel";

        const header = document.createElement("div");
        header.className = "sai-result-header";

        const title = document.createElement("strong");
        title.textContent = "Answer Response";
        title.className = "sai-result-title";

        const actions = document.createElement("div");
        actions.className = "sai-result-actions";

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "Copy all";
        copyBtn.dataset.role = "copy";
        copyBtn.className = "sai-btn-sm";

        const fillBtn = document.createElement("button");
        fillBtn.type = "button";
        fillBtn.textContent = "Auto-fill";
        fillBtn.dataset.role = "autofill";
        fillBtn.className = "sai-btn-sm";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "Close";
        closeBtn.dataset.role = "close";
        closeBtn.className = "sai-btn-sm";

        const body = document.createElement("div");
        body.dataset.role = "content";
        body.className = "sai-result-content";

        actions.appendChild(copyBtn);
        actions.appendChild(fillBtn);
        actions.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(actions);
        panel.appendChild(header);
        panel.appendChild(body);
        document.body.appendChild(panel);

        closeBtn.addEventListener("click", () => {
            panel.classList.remove("is-open");
        });

        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(body.dataset.plainText || body.textContent || "");
            } catch (err) {
                console.error("Copy failed:", err);
            }
        });

        fillBtn.addEventListener("click", async () => {
            const answersJson = body.dataset.answersJson;
            if (!answersJson) return;
            let answers;
            try { answers = JSON.parse(answersJson); } catch { return; }
            fillBtn.disabled = true;
            fillBtn.textContent = "Filling...";
            try {
                const { filled, total } = await autoFillAnswers(answers);
                fillBtn.textContent = filled ? `Filled ${filled}/${total}` : "No fields found";
            } catch (err) {
                console.error("Auto-fill error:", err);
                fillBtn.textContent = "Fill failed";
            } finally {
                setTimeout(() => {
                    fillBtn.disabled = false;
                    fillBtn.textContent = "Auto-fill";
                }, 2500);
            }
        });
    }

    function formatPartLabel(part, idx, total) {
        const toAlphaLabel = (n) => String.fromCharCode(97 + Math.max(0, n));
        const p = String(part || "").trim().toLowerCase();
        if (!p || p === "main") return total > 1 ? `${toAlphaLabel(idx)})` : "Answer";
        const partNum = p.match(/^part\s*(\d+)$/);
        if (partNum) return `${toAlphaLabel(Number(partNum[1]) - 1)})`;
        const singleLetter = p.match(/^([a-z])\)?$/);
        if (singleLetter) return `${singleLetter[1]})`;
        return String(part || "Answer");
    }

    function buildResultPlainText(response) {
        const lines = [];
        if (response.parseError) {
            lines.push(`Parse warning: ${response.parseError}`);
            lines.push("");
        }

        if (response.data && typeof response.data === "object" && Array.isArray(response.data.answers)) {
            const answers = response.data.answers;
            lines.push("Answers");
            lines.push("");
            answers.forEach((item, idx) => {
                const label = formatPartLabel(item?.part, idx, answers.length);
                const answer = String(item?.answer || "").trim() || "(blank)";
                lines.push(`${label} ${answer}`);
            });

            if (Array.isArray(response.data.checks) && response.data.checks.length) {
                lines.push("");
                lines.push("Checks");
                lines.push("");
                response.data.checks.forEach((check) => {
                    lines.push(`- ${String(check)}`);
                });
            }
            return lines.join("\n");
        }

        if (response.raw) return String(response.raw);
        return "No response data.";
    }

    function showResultPanel(response) {
        ensureResultPanel();
        const panel = document.getElementById(PANEL_ID);
        const content = panel?.querySelector('[data-role="content"]');
        if (!panel || !content) return;

        const plainText = buildResultPlainText(response);
        content.innerHTML = "";
        content.dataset.plainText = plainText;
        content.dataset.answersJson = (response.data && Array.isArray(response.data.answers))
            ? JSON.stringify(response.data.answers)
            : "";

        if (response.parseError) {
            const warning = document.createElement("div");
            warning.textContent = `Parse warning: ${response.parseError}`;
            warning.className = "sai-result-warning";
            content.appendChild(warning);
        }

        if (response.data && typeof response.data === "object" && Array.isArray(response.data.answers)) {
            const answers = response.data.answers;
            answers.forEach((item, idx) => {
                const label = formatPartLabel(item?.part, idx, answers.length);
                const answer = String(item?.answer || "").trim() || "(blank)";

                const row = document.createElement("div");
                row.className = "sai-answer-row";

                const top = document.createElement("div");
                top.className = "sai-answer-top";

                const labelEl = document.createElement("strong");
                labelEl.textContent = label;
                labelEl.className = "sai-answer-label";

                const rowCopy = document.createElement("button");
                rowCopy.type = "button";
                rowCopy.textContent = "Copy";
                rowCopy.className = "sai-btn-row-copy";
                rowCopy.addEventListener("click", async () => {
                    try {
                        await navigator.clipboard.writeText(answer);
                    } catch (err) {
                        console.error("Row copy failed:", err);
                    }
                });

                const answerEl = document.createElement("div");
                answerEl.textContent = answer;
                answerEl.className = "sai-answer-text";

                top.appendChild(labelEl);
                top.appendChild(rowCopy);
                row.appendChild(top);
                row.appendChild(answerEl);
                content.appendChild(row);
            });

            if (Array.isArray(response.data.checks) && response.data.checks.length) {
                const checksWrap = document.createElement("div");
                checksWrap.className = "sai-checks-wrap";

                const checksTitle = document.createElement("strong");
                checksTitle.textContent = "Checks";
                checksTitle.className = "sai-checks-title";
                checksWrap.appendChild(checksTitle);

                const ul = document.createElement("ul");
                ul.className = "sai-checks-list";
                response.data.checks.forEach((check) => {
                    const li = document.createElement("li");
                    li.textContent = String(check);
                    ul.appendChild(li);
                });
                checksWrap.appendChild(ul);
                content.appendChild(checksWrap);
            }
        } else if (response.raw) {
            const raw = document.createElement("pre");
            raw.textContent = String(response.raw);
            raw.className = "sai-raw-response";
            content.appendChild(raw);
        } else {
            const none = document.createElement("div");
            none.textContent = "No response data.";
            content.appendChild(none);
        }

        panel.classList.add("is-open");
    }

    function hideResultPanel() {
        const panel = document.getElementById(PANEL_ID);
        const content = panel?.querySelector('[data-role="content"]');
        if (content) {
            content.innerHTML = "";
            content.dataset.plainText = "";
            content.dataset.answersJson = "";
        }
        if (panel) panel.classList.remove("is-open");
    }

    // --- Auto-fill helpers ---

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function getCleanCellText(cell) {
        if (!cell) return "";
        const clone = cell.cloneNode(true);
        clone.querySelectorAll('button, [role="checkbox"], input, svg').forEach((el) => el.remove());
        return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    }

    function describeCheckboxTable(partEl) {
        const tables = Array.from(partEl?.querySelectorAll("table") || []);
        for (const table of tables) {
            const rows = Array.from(table.querySelectorAll("tr"));
            if (rows.length < 2) continue;

            const headerCells = Array.from(rows[0].querySelectorAll("th,td"));
            const headers = headerCells.map((cell) => getCleanCellText(cell).toLowerCase());
            const hasTrueFalseHeaders = headers.some((h) => h === "true") && headers.some((h) => h === "false");
            if (!hasTrueFalseHeaders) continue;

            const checkboxRows = rows.slice(1).map((row) => {
                const cells = Array.from(row.querySelectorAll("td,th"));
                const statement = getCleanCellText(cells[0]);
                const choices = cells.slice(1).map((cell, idx) => {
                    const header = headers[idx + 1] || "";
                    const box = cell.querySelector('[role="checkbox"], button[type="button"], input[type="checkbox"]');
                    return box ? { label: header, el: box } : null;
                }).filter(Boolean);
                return { statement, choices };
            }).filter((row) => row.statement && row.choices.length);

            if (checkboxRows.length) return { type: "checkboxTable", rows: checkboxRows };
        }

        return null;
    }

    function getCleanBoxText(box) {
        if (!box) return "";
        const clone = box.cloneNode(true);
        clone.querySelectorAll("svg, button, input, [class*='_DotContainer_'], [class*='_Dot_']").forEach((el) => el.remove());
        return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    }

    function describeLinkBoxes(partEl) {
        const wrappers = Array.from(partEl?.querySelectorAll('[class*="_LinkBoxesWrapper_"]') || []);
        for (const wrapper of wrappers) {
            const left = Array.from(wrapper.querySelectorAll('[class*="_LinkBoxesBox_"]'))
                .filter((box) => box.querySelector('[class*="_Left_"]'))
                .map((box) => ({ label: getCleanBoxText(box), el: box }))
                .filter((item) => item.label);
            const right = Array.from(wrapper.querySelectorAll('[class*="_LinkBoxesBox_"]'))
                .filter((box) => box.querySelector('[class*="_Right_"]'))
                .map((box) => ({ label: getCleanBoxText(box), el: box }))
                .filter((item) => item.label);

            if (left.length && right.length) return { type: "linkBoxes", left, right };
        }

        return null;
    }

    // Describe what kind of input a question part has.
    // Returns { type: "keypad", fields: [...] } | { type: "choices", els: [...] } | { type: "text", els: [...] } | { type: "checkboxTable", rows: [...] } | { type: "linkBoxes", left: [...], right: [...] } | null
    function describePartInput(partEl) {
        if (!partEl) return null;

        const linkBoxes = describeLinkBoxes(partEl);
        if (linkBoxes) return linkBoxes;

        const checkboxTable = describeCheckboxTable(partEl);
        if (checkboxTable) return checkboxTable;

        // Sparx numeric keypad: readonly input with decimal inputmode (the on-screen number pad)
        const numericInputs = Array.from(partEl.querySelectorAll('input[data-ref][readonly], input[data-ref][inputmode="decimal"]'));
        if (numericInputs.length) {
            const fields = numericInputs.map((inp) => ({
                input: inp,
                keypadRef: inp.getAttribute("data-ref")
            }));
            return { type: "keypad", fields };
        }

        // Sparx multiple-choice: div[role="button"] with class containing _Option_
        const options = Array.from(partEl.querySelectorAll('[role="button"][class*="_Option_"]'));
        if (options.length >= 2) {
            const multiSelect = /select\s+all/i.test(partEl.innerText || partEl.textContent || "");
            return { type: "choices", els: options, multiSelect };
        }

        // Text inputs: textarea, regular input (including flashcard text inputs with data-ref)
        const textFields = Array.from(
            partEl.querySelectorAll('textarea, input[type="text"], input[type="number"], input:not([type]), input[data-ref]:not([readonly])')
        ).filter((el) => !el.closest(`#${PANEL_ID},#${SETTINGS_MODAL_ID},#${FAIL_MODAL_ID},#${BTN_ID},#${AUTO_BTN_ID}`));
        if (textFields.length) return { type: "text", els: textFields };

        // Generic button-choice fallback
        const buttons = Array.from(partEl.querySelectorAll("button, [role='button']")).filter((btn) => {
            if (btn.closest(`#${PANEL_ID},#${SETTINGS_MODAL_ID},#${FAIL_MODAL_ID},#${BTN_ID},#${AUTO_BTN_ID}`)) return false;
            const label = (btn.innerText || btn.textContent || "").trim();
            return label.length > 0 && label.length <= 60;
        });
        if (buttons.length >= 2) return { type: "choices", els: buttons, multiSelect: false };

        return null;
    }

    // Click an input to focus it, then wait for its keypad to appear in the DOM.
    function waitForKeypadByRef(ref, timeoutMs = 2000) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                const kp = document.querySelector(`[data-numeric-keypad="${ref}"]`);
                if (kp) { resolve(kp); return; }
                if (Date.now() < deadline) setTimeout(check, 60);
                else resolve(null);
            };
            check();
        });
    }

    // Enter a value into a Sparx numeric keypad by clicking its digit buttons.
    async function enterViaKeypad(keypadEl, valueStr) {
        const chars = String(valueStr).replace(/[^0-9.\-]/g, "");
        if (!chars) return false;

        // Click backspace enough times to clear any existing value
        const backBtn = keypadEl.querySelector("#button-back");
        if (backBtn) {
            for (let c = 0; c < 12; c++) {
                backBtn.click();
                await sleep(40);
            }
        }

        // Map of character to button id
        const charToId = {
            "1": "button-one", "2": "button-two", "3": "button-three",
            "4": "button-four", "5": "button-five", "6": "button-six",
            "7": "button-seven", "8": "button-eight", "9": "button-nine",
            "0": "button-zero", ".": "button-point", "-": "button-minus"
        };

        for (const ch of chars) {
            const btnId = charToId[ch];
            if (!btnId) continue;
            const btn = keypadEl.querySelector(`#${btnId}`);
            // Only skip if disabled AND it's not the decimal point (decimal gets enabled after first digit)
            if (!btn || (btn.classList.contains("_Disabled_3pc66_66") && ch !== ".")) continue;
            await sleep(100 + Math.random() * 120);
            btn.click();
        }

        return true;
    }

    // Find the best-matching button for a given answer string.
    function findMatchingButton(buttons, answerText) {
        const norm = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
        const target = norm(answerText);
        if (!target) return null;

        // Exact match first (case-insensitive, ignoring punctuation)
        let match = buttons.find((btn) => norm(btn.innerText || btn.textContent) === target);
        if (match) return match;

        // Starts-with match (e.g. answer "C" matches button "C – ribosome")
        match = buttons.find((btn) => norm(btn.innerText || btn.textContent).startsWith(target));
        if (match) return match;

        // Answer starts with button label (e.g. answer "C ribosome" matches button "C")
        match = buttons.find((btn) => target.startsWith(norm(btn.innerText || btn.textContent)));
        if (match) return match;

        return null;
    }

    function getChoiceLabel(btn) {
        const annotation = btn.querySelector('annotation[encoding="application/x-tex"]')?.textContent || "";
        const ceMatch = annotation.match(/\\ce\{([^}]+)\}/);
        if (ceMatch?.[1]) return ceMatch[1].replace(/\s+/g, "");

        const clone = btn.cloneNode(true);
        clone.querySelectorAll(".katex-mathml, .katex-html[aria-hidden='true'], svg").forEach((el) => el.remove());
        return (clone.innerText || clone.textContent || btn.innerText || btn.textContent || "").replace(/\s+/g, " ").trim();
    }

    function normalizeChoiceText(text) {
        return String(text || "")
            .trim()
            .toLowerCase()
            .replace(/\\ce\{([^}]+)\}/g, "$1")
            .replace(/[^a-z0-9]/g, "");
    }

    function findMatchingChoice(buttons, answerText) {
        const target = normalizeChoiceText(answerText);
        if (!target) return null;

        let match = buttons.find((btn) => normalizeChoiceText(getChoiceLabel(btn)) === target);
        if (match) return match;

        match = buttons.find((btn) => normalizeChoiceText(getChoiceLabel(btn)).startsWith(target));
        if (match) return match;

        match = buttons.find((btn) => target.startsWith(normalizeChoiceText(getChoiceLabel(btn))));
        if (match) return match;

        return findMatchingButton(buttons, answerText);
    }

    function splitChoiceAnswers(answerText) {
        return String(answerText || "")
            .replace(/\band\b/gi, ",")
            .split(/\n|,|;|\||\/|&/)
            .map((item) => item.replace(/^[-*•\d.)\s]+/, "").trim())
            .filter(Boolean);
    }

    function findMatchingChoices(buttons, answerText) {
        const parts = splitChoiceAnswers(answerText);
        const matches = [];
        const seen = new Set();

        for (const part of parts.length ? parts : [answerText]) {
            const match = findMatchingChoice(buttons, part);
            if (!match) continue;
            const key = match.getAttribute("data-ref") || getChoiceLabel(match);
            if (seen.has(key)) continue;
            seen.add(key);
            matches.push(match);
        }

        return matches;
    }

    async function clickChoiceOption(option) {
        await sleep(200 + Math.random() * 300);
        option.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await sleep(80 + Math.random() * 120);
        option.click();
    }

    function normalizeMatchText(text) {
        return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function findMatchingLinkItem(items, text) {
        const target = normalizeMatchText(text);
        if (!target) return null;

        let match = items.find((item) => normalizeMatchText(item.label) === target);
        if (match) return match;

        match = items.find((item) => normalizeMatchText(item.label).startsWith(target));
        if (match) return match;

        match = items.find((item) => target.startsWith(normalizeMatchText(item.label)));
        if (match) return match;

        return null;
    }

    function parseLinkBoxPairs(answerText) {
        const pairs = [];
        const lines = String(answerText || "")
            .split(/\n|;/)
            .map((line) => line.trim())
            .filter(Boolean);

        for (const line of lines) {
            const parts = line.split(/\s*(?:->|=>|=|:|\s-\s|\s\u2013\s|\s\u2014\s)\s*/).map((part) => part.trim()).filter(Boolean);
            if (parts.length >= 2) {
                pairs.push({ left: parts[0], right: parts.slice(1).join(" ") });
            }
        }

        return pairs;
    }

    function dispatchPointerMouse(el, type, x, y, buttonDown = true) {
        const opts = {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: buttonDown ? 1 : 0,
            view: window
        };
        try {
            el.dispatchEvent(new PointerEvent(type, { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        } catch {}

        const mouseType = type.replace("pointer", "mouse");
        if (mouseType !== type) {
            el.dispatchEvent(new MouseEvent(mouseType, opts));
        }
    }

    function countLinkLines(leftEl) {
        const wrapper = leftEl.closest('[class*="_LinkBoxesWrapper_"]');
        return wrapper?.querySelectorAll('svg line, svg path, svg polyline').length || 0;
    }

    function getDotCenter(box, sideClass) {
        const dot = box.querySelector(`[class*="${sideClass}"] [class*="_Dot_"]`)
            || box.querySelector(`[class*="${sideClass}"]`)
            || box.querySelector('[class*="_Dot_"]')
            || box;
        const rect = dot.getBoundingClientRect();
        return {
            el: dot,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
    }

    async function dragBetweenDots(startDot, endDot) {
        const moveTarget = document.documentElement || document.body;
        dispatchPointerMouse(startDot.el, "pointerover", startDot.x, startDot.y, false);
        dispatchPointerMouse(startDot.el, "pointerenter", startDot.x, startDot.y, false);
        dispatchPointerMouse(startDot.el, "pointerdown", startDot.x, startDot.y, true);
        await sleep(90);

        const steps = 14;
        for (let step = 1; step <= steps; step++) {
            const ratio = step / steps;
            const x = startDot.x + (endDot.x - startDot.x) * ratio;
            const y = startDot.y + (endDot.y - startDot.y) * ratio;
            dispatchPointerMouse(moveTarget, "pointermove", x, y, true);
            await sleep(22 + Math.random() * 18);
        }

        dispatchPointerMouse(endDot.el, "pointerover", endDot.x, endDot.y, true);
        dispatchPointerMouse(endDot.el, "pointerup", endDot.x, endDot.y, false);
        await sleep(140);
    }

    async function connectLinkBoxes(leftEl, rightEl) {
        leftEl.scrollIntoView({ block: "center", inline: "center" });
        await sleep(160);

        let before = countLinkLines(leftEl);
        const leftDot = getDotCenter(leftEl, "_Left_");
        const rightDot = getDotCenter(rightEl, "_Right_");

        await dragBetweenDots(leftDot, rightDot);
        await sleep(220);
        if (countLinkLines(leftEl) > before) return true;

        // Some builds initiate from the right-side dot instead.
        before = countLinkLines(leftEl);
        await dragBetweenDots(rightDot, leftDot);
        await sleep(220);
        if (countLinkLines(leftEl) > before) return true;

        // Fallback for click-to-link variants.
        before = countLinkLines(leftEl);
        leftDot.el.click();
        await sleep(160);
        rightDot.el.click();
        await sleep(220);
        if (countLinkLines(leftEl) > before) return true;

        return false;
    }

    async function fillLinkBoxes(inputDesc, answerText) {
        const pairs = parseLinkBoxPairs(answerText);
        let filled = 0;

        for (const pair of pairs) {
            const left = findMatchingLinkItem(inputDesc.left, pair.left);
            const right = findMatchingLinkItem(inputDesc.right, pair.right);
            if (!left?.el || !right?.el) continue;
            const connected = await connectLinkBoxes(left.el, right.el);
            if (connected) filled++;
        }

        return filled;
    }

    function parseChecklistValues(answerText, rowCount) {
        const rawLines = String(answerText || "")
            .split(/\n|;/)
            .map((line) => line.trim())
            .filter(Boolean);
        const lines = rawLines.length ? rawLines : [String(answerText || "").trim()];

        const values = [];
        for (const line of lines) {
            const normalized = line.toLowerCase();
            const tail = normalized.split(/[:=\-–—]/).pop().trim();
            const candidate = /\btrue\b/.test(tail) ? "true"
                : /\bfalse\b/.test(tail) ? "false"
                    : /\byes\b|\bcorrect\b/.test(tail) ? "true"
                        : /\bno\b|\bincorrect\b/.test(tail) ? "false"
                            : "";
            if (candidate) values.push(candidate);
        }

        if (values.length < rowCount && (rawLines.length <= 1 || values.length === 0)) {
            const compactMatches = String(answerText || "").toLowerCase().match(/\b(true|false|yes|no|correct|incorrect)\b/g) || [];
            if (compactMatches.length > values.length) {
                return compactMatches.slice(0, rowCount).map((match) =>
                    (match === "true" || match === "yes" || match === "correct") ? "true" : "false"
                );
            }
        }

        return values.slice(0, rowCount);
    }

    async function fillCheckboxTable(inputDesc, answerText) {
        const values = parseChecklistValues(answerText, inputDesc.rows.length);
        let filled = 0;

        for (let idx = 0; idx < inputDesc.rows.length; idx++) {
            const desired = values[idx];
            if (!desired) continue;

            const row = inputDesc.rows[idx];
            const choice = row.choices.find((item) => item.label === desired)
                || row.choices.find((item) => item.label.includes(desired));
            if (!choice?.el) continue;

            const checked = choice.el.getAttribute("aria-checked") === "true"
                || choice.el.checked
                || choice.el.getAttribute("data-state") === "checked";
            if (!checked) {
                choice.el.scrollIntoView({ block: "center", inline: "center" });
                await sleep(100 + Math.random() * 120);
                choice.el.click();
                await sleep(120 + Math.random() * 160);
            }
            filled++;
        }

        return filled;
    }

    // Type text into a field character-by-character with human-like timing.
    // Works for both plain inputs and React-controlled inputs.
    async function typeIntoField(field, text) {
        field.focus();
        field.click();

        // Clear existing value using React's native input value setter
        const proto = field.tagName.toLowerCase() === "textarea"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        const setVal = (v) => {
            if (nativeSetter) nativeSetter.call(field, v);
            else field.value = v;
        };

        setVal("");
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(50);

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            let delay = 45 + Math.random() * 65;
            if (Math.random() < 0.10) delay += 150 + Math.random() * 200;
            await sleep(delay);

            const keyOpts = { key: char, bubbles: true, cancelable: true };
            field.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
            field.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
            setVal(field.value + char);
            field.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
            field.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
        }

        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
    }

    // Fill all answer fields from the parsed answers array.
    async function autoFillAnswers(answers) {
        if (!Array.isArray(answers) || !answers.length) return { filled: 0, total: 0 };

        // Get only top-level _AnswerPart_ containers (exclude ones nested inside another _AnswerPart_)
        let partNodes = Array.from(document.querySelectorAll('[class*="_AnswerPart_"]'))
            .filter((el) => !el.parentElement?.closest('[class*="_AnswerPart_"]'));
        if (!partNodes.length) {
            partNodes = Array.from(document.querySelectorAll("[data-part-name]")).sort((a, b) => {
                const pa = a.getAttribute("data-part-name") || "";
                const pb = b.getAttribute("data-part-name") || "";
                if (pa === "" && pb !== "") return -1;
                if (pb === "" && pa !== "") return 1;
                return pa.localeCompare(pb);
            });
        }

        console.log("[SAI] partNodes found:", partNodes.length, partNodes.map(el => ({
            class: el.className,
            inputType: describePartInput(el)?.type,
            text: el.innerText?.slice(0, 60)
        })));
        console.log("[SAI] answers:", answers);

        let filled = 0;
        let nodeIdx = 0;

        for (let i = 0; i < answers.length; i++) {
            const answerText = String(answers[i]?.answer || "").trim();
            if (!answerText) continue;

            if (i > 0) await sleep(300 + Math.random() * 300);

            const subValues = answerText.split("\n").map((s) => s.trim()).filter(Boolean);

            // Determine how many partNodes this answer should consume.
            // If the current node is choices, always consume exactly 1 regardless of sub-values.
            const firstDesc = describePartInput(partNodes[nodeIdx] || null);
            const isSingleNodeAnswer = firstDesc?.type === "choices" || firstDesc?.type === "checkboxTable" || firstDesc?.type === "linkBoxes";
            const count = isSingleNodeAnswer ? 1 : subValues.length;

            for (let j = 0; j < count; j++) {
                const partEl = partNodes[nodeIdx] || null;
                nodeIdx++;
                const inputDesc = describePartInput(partEl);
                const val = subValues[j] ?? subValues[0] ?? answerText;

                if (j > 0) await sleep(300 + Math.random() * 300);

                if (inputDesc?.type === "keypad") {
                    const { input, keypadRef } = inputDesc.fields[0];
                    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                    input.click();
                    input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
                    await sleep(300);
                    const keypad = await waitForKeypadByRef(keypadRef, 3000);
                    console.log(`[SAI] keypad for ref ${keypadRef}:`, keypad, "val:", val);
                    if (!keypad) { console.warn(`[SAI] keypad not found for ref ${keypadRef}`); continue; }
                    const ok = await enterViaKeypad(keypad, val);
                    if (ok) filled++;
                } else if (inputDesc?.type === "text") {
                    await typeIntoField(inputDesc.els[0], val);
                    filled++;
                } else if (inputDesc?.type === "choices") {
                    if (inputDesc.multiSelect) {
                        const options = findMatchingChoices(inputDesc.els, answerText);
                        for (const option of options) {
                            await clickChoiceOption(option);
                            filled++;
                        }
                    } else {
                        const option = findMatchingChoice(inputDesc.els, answerText);
                        if (option) {
                            await clickChoiceOption(option);
                            filled++;
                        }
                    }
                } else if (inputDesc?.type === "checkboxTable") {
                    filled += await fillCheckboxTable(inputDesc, answerText);
                } else if (inputDesc?.type === "linkBoxes") {
                    filled += await fillLinkBoxes(inputDesc, answerText);
                }
            }
        }

        return { filled, total: answers.length };
    }

    function ensureSettingsModal() {
        if (document.getElementById(SETTINGS_MODAL_ID)) return;

        const modal = document.createElement("div");
        modal.id = SETTINGS_MODAL_ID;
        modal.className = "sai-modal";

        const card = document.createElement("div");
        card.className = "sai-settings-card sai-scroll";

        const title = document.createElement("h3");
        title.textContent = "Sparx AI Settings";
        title.className = "sai-modal-title";

        const form = document.createElement("div");
        form.dataset.role = "settings-form";
        form.className = "sai-settings-form";

        SETTINGS_META.forEach(({ key, label, help }) => {
            const wrap = document.createElement("label");
            wrap.className = "sai-setting-wrap";
            const labelRow = document.createElement("div");
            labelRow.className = "sai-setting-label-row";
            const labelText = document.createElement("span");
            labelText.textContent = label;
            const tip = document.createElement("span");
            tip.textContent = "(?)";
            tip.title = help;
            tip.className = "sai-setting-tip";
            labelRow.appendChild(labelText);
            labelRow.appendChild(tip);

            const input = document.createElement("input");
            input.type = "number";
            input.min = "0";
            input.step = "1";
            input.dataset.key = key;
            input.className = "sai-setting-input";
            wrap.appendChild(labelRow);
            wrap.appendChild(input);
            form.appendChild(wrap);
        });

        const boolWrap = document.createElement("label");
        boolWrap.className = "sai-bool-wrap";
        const boolLeft = document.createElement("div");
        boolLeft.className = "sai-bool-left";
        const boolTitle = document.createElement("span");
        boolTitle.textContent = "Auto tab switch";
        const boolHelp = document.createElement("span");
        boolHelp.textContent = "Focus the selected AI while generating, then return to Science tab.";
        boolHelp.className = "sai-bool-help";
        boolLeft.appendChild(boolTitle);
        boolLeft.appendChild(boolHelp);

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.dataset.boolKey = "autoTabSwitch";
        toggle.className = "sai-bool-toggle";
        boolWrap.appendChild(boolLeft);
        boolWrap.appendChild(toggle);
        form.appendChild(boolWrap);

        const providerWrap = document.createElement("label");
        providerWrap.className = "sai-setting-wrap";
        const providerLabel = document.createElement("div");
        providerLabel.className = "sai-setting-label-row";
        const providerText = document.createElement("span");
        providerText.textContent = "AI provider";
        const providerTip = document.createElement("span");
        providerTip.textContent = "(?)";
        providerTip.title = "Choose which AI website the Science solver controls.";
        providerTip.className = "sai-setting-tip";
        providerLabel.appendChild(providerText);
        providerLabel.appendChild(providerTip);

        const providerSelect = document.createElement("select");
        providerSelect.dataset.selectKey = "aiProvider";
        providerSelect.className = "sai-setting-input";
        [
            ["gemini", "Gemini"],
            ["chatgpt", "ChatGPT"],
            ["claude", "Claude"]
        ].forEach(([value, label]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            providerSelect.appendChild(option);
        });
        providerWrap.appendChild(providerLabel);
        providerWrap.appendChild(providerSelect);
        form.appendChild(providerWrap);

        const actions = document.createElement("div");
        actions.className = "sai-actions";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "Close";
        closeBtn.className = "sai-btn-secondary";

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "Save";
        saveBtn.className = "sai-btn-primary";

        closeBtn.addEventListener("click", () => {
            modal.classList.remove("is-open");
        });
        modal.addEventListener("click", (ev) => {
            if (ev.target === modal) modal.classList.remove("is-open");
        });

        saveBtn.addEventListener("click", async () => {
            const inputs = Array.from(form.querySelectorAll("input[data-key]"));
            const boolInputs = Array.from(form.querySelectorAll("input[data-bool-key]"));
            const selectInputs = Array.from(form.querySelectorAll("select[data-select-key]"));
            const next = { ...DEFAULT_SETTINGS };
            inputs.forEach((inp) => {
                const key = inp.dataset.key;
                const val = Number(inp.value);
                if (!key || Number.isNaN(val)) return;
                next[key] = Math.max(0, Math.floor(val));
            });
            boolInputs.forEach((inp) => {
                const key = inp.dataset.boolKey;
                if (!key) return;
                next[key] = Boolean(inp.checked);
            });
            selectInputs.forEach((inp) => {
                const key = inp.dataset.selectKey;
                if (!key) return;
                next[key] = inp.value || DEFAULT_SETTINGS[key];
            });
            await saveScienceSettings(next);
            modal.classList.remove("is-open");
        });

        actions.appendChild(closeBtn);
        actions.appendChild(saveBtn);
        card.appendChild(title);
        card.appendChild(form);
        card.appendChild(actions);
        modal.appendChild(card);
        document.body.appendChild(modal);
    }

    async function openSettingsModal() {
        ensureSettingsModal();
        const modal = document.getElementById(SETTINGS_MODAL_ID);
        const form = modal?.querySelector('[data-role="settings-form"]');
        if (!modal || !form) return;
        const settings = await getScienceSettings();
        const inputs = Array.from(form.querySelectorAll("input[data-key]"));
        const boolInputs = Array.from(form.querySelectorAll("input[data-bool-key]"));
        const selectInputs = Array.from(form.querySelectorAll("select[data-select-key]"));
        inputs.forEach((inp) => {
            const key = inp.dataset.key;
            if (!key) return;
            inp.value = String(settings[key] ?? DEFAULT_SETTINGS[key] ?? 0);
        });
        boolInputs.forEach((inp) => {
            const key = inp.dataset.boolKey;
            if (!key) return;
            inp.checked = Boolean(settings[key] ?? DEFAULT_SETTINGS[key]);
        });
        selectInputs.forEach((inp) => {
            const key = inp.dataset.selectKey;
            if (!key) return;
            inp.value = String(settings[key] ?? DEFAULT_SETTINGS[key] ?? "");
        });
        modal.classList.add("is-open");
    }

    function ensureGlobalMenuItem() {
        const openMenus = Array.from(document.querySelectorAll('[role="menu"]'));
        for (const menu of openMenus) {
            if (menu.querySelector(`#${MENU_ITEM_ID}`)) continue;

            const candidates = Array.from(menu.querySelectorAll("button,a,[role='menuitem']"));
            const cookieNode = candidates.find((el) => /cookie settings/i.test((el.textContent || "").trim()));

            const item = document.createElement("button");
            item.type = "button";
            item.id = MENU_ITEM_ID;
            item.setAttribute("role", "menuitem");
            item.className = cookieNode?.className || candidates[0]?.className || "";
            item.classList.add("sai-menu-item");
            const logo = document.createElement("img");
            logo.src = chrome.runtime.getURL("cdn/img/logo.png");
            logo.alt = "";
            logo.width = 16;
            logo.height = 16;
            logo.className = "sai-menu-logo";
            const text = document.createElement("span");
            text.textContent = "Sparx AI Tools";
            item.appendChild(logo);
            item.appendChild(text);

            item.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                openSettingsModal();
            });

            if (cookieNode?.parentElement === menu) {
                menu.insertBefore(item, cookieNode);
            } else if (cookieNode?.parentElement) {
                cookieNode.parentElement.insertBefore(item, cookieNode);
            } else {
                menu.insertBefore(item, menu.firstChild);
            }
        }
    }

    function ensureFailureModal() {
        if (document.getElementById(FAIL_MODAL_ID)) return;

        const modal = document.createElement("div");
        modal.id = FAIL_MODAL_ID;
        modal.className = "sai-modal";

        const card = document.createElement("div");
        card.className = "sai-fail-card";

        const title = document.createElement("h3");
        title.textContent = "Request failed";
        title.className = "sai-modal-title";

        const msg = document.createElement("p");
        msg.dataset.role = "message";
        msg.textContent = "Could not complete the Gemini request.";
        msg.className = "sai-fail-msg";

        const actions = document.createElement("div");
        actions.className = "sai-actions";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.textContent = "Close";
        cancelBtn.className = "sai-btn-secondary";

        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.textContent = "Try again";
        retryBtn.className = "sai-btn-primary";

        cancelBtn.addEventListener("click", () => {
            modal.classList.remove("is-open");
        });

        retryBtn.addEventListener("click", async () => {
            const settings = await getScienceSettings();
            sendRuntimeMessage({ type: "SCIENCE_RELOAD_GEMINI", settings })
                .catch((err) => {
                    if (!isMessagingContextError(err?.message)) {
                        console.error("AI reload failed:", err);
                    }
                })
                .finally(() => {
                    modal.classList.remove("is-open");
                });
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(retryBtn);
        card.appendChild(title);
        card.appendChild(msg);
        card.appendChild(actions);
        modal.appendChild(card);
        document.body.appendChild(modal);
    }

    function showFailureModal(message) {
        ensureFailureModal();
        const modal = document.getElementById(FAIL_MODAL_ID);
        const msg = modal?.querySelector('[data-role="message"]');
        if (!modal || !msg) return;
        msg.textContent = message || "Could not complete the Gemini request.";
        modal.classList.add("is-open");
    }

    function hideFailureModal() {
        const modal = document.getElementById(FAIL_MODAL_ID);
        if (!modal) return;
        modal.classList.remove("is-open");
    }

    function showStatus(el, text, isError) {
        el.textContent = text;
        el.classList.toggle("is-error", Boolean(isError));
        el.classList.add("is-visible");
        window.clearTimeout(showStatus._timer);
        showStatus._timer = window.setTimeout(() => {
            el.classList.remove("is-visible");
        }, 2800);
    }

    function extractTextFromTable(table) {
        const rows = Array.from(table.querySelectorAll("tr"));
        if (!rows.length) return table.innerText.trim();

        return rows
            .map((row) =>
                Array.from(row.querySelectorAll("th,td"))
                    .map((cell) => cell.innerText.replace(/\s+/g, " ").trim())
                    .filter(Boolean)
                    .join(" | ")
            )
            .filter(Boolean)
            .join("\n");
    }

    // Strip KaTeX/MathML noise from extracted text.
    // innerText picks up both the visible rendered text AND hidden annotation/mathml text.
    // We remove .katex-mathml and .katex-html aria-hidden spans before reading innerText.
    function cleanExtractedText(clone) {
        // Remove hidden KaTeX MathML (screen-reader source, contains raw LaTeX like {^3 })
        clone.querySelectorAll(".katex-mathml").forEach((el) => el.remove());
        // Remove aria-hidden katex-html duplicates
        clone.querySelectorAll('.katex-html[aria-hidden="true"]').forEach((el) => el.remove());
        // Remove answer input fields and keypads — we don't want placeholder text in the prompt
        clone.querySelectorAll('input, [data-numeric-keypad], [class*="_KeypadFloating_"], [class*="_TextFieldWarning_"]').forEach((el) => el.remove());
        return clone;
    }

    function extractQuestionText() {
        const partNodes = Array.from(document.querySelectorAll("[data-part-name]"));
        if (!partNodes.length) return null;

        const orderedParts = partNodes.sort((a, b) => {
            const pa = a.getAttribute("data-part-name") || "";
            const pb = b.getAttribute("data-part-name") || "";
            if (pa === "" && pb !== "") return -1;
            if (pb === "" && pa !== "") return 1;
            return pa.localeCompare(pb);
        });

        // Separate the first unnamed block (context text) from named parts and unnamed answer-input blocks
        const contextEls = [];   // unnamed blocks with no answer inputs — these are the question stem
        const namedParts = [];   // named parts like a), b)
        const orphanInputEls = []; // unnamed blocks that contain answer inputs — belong to the preceding named part

        for (const part of orderedParts) {
            const partName = part.getAttribute("data-part-name") || "";
            const hasInput = part.querySelector('input[data-ref], [role="button"][class*="_Option_"]');
            if (!partName && !hasInput) {
                contextEls.push(part);
            } else if (!partName && hasInput) {
                orphanInputEls.push(part);
            } else {
                namedParts.push({ partName, els: [part], orphans: [] });
            }
        }

        // Attach orphan input blocks to the most recently seen named part
        for (const orphan of orphanInputEls) {
            if (namedParts.length) {
                namedParts[namedParts.length - 1].orphans.push(orphan);
            } else {
                contextEls.push(orphan);
            }
        }

        const chunks = [];

        // Build the main question context block
        if (contextEls.length) {
            const body = [];
            for (const el of contextEls) {
                // Extract tables BEFORE cloning so we preserve their text
                const tables = Array.from(el.querySelectorAll("table"));
                const tableTexts = tables.map((t) => extractTextFromTable(t));
                const clone = cleanExtractedText(el.cloneNode(true));
                clone.querySelectorAll("table").forEach((t) => t.remove());
                clone.querySelectorAll(`#${BTN_ID},#${STATUS_ID},#${PANEL_ID},#${FAIL_MODAL_ID},#${SETTINGS_MODAL_ID}`).forEach((e) => e.remove());
                const text = clone.innerText.replace(/\s+\n/g, "\n").trim();
                if (text) body.push(text);
                tableTexts.forEach((t) => { if (t) body.push(t); });
            }
            if (body.length) chunks.push(`Main question:\n${body.join("\n")}`);
        }

        // Build named part blocks, including any orphan input blocks appended to them
        for (const { partName, els, orphans } of namedParts) {
            const body = [];
            for (const el of [...els, ...orphans]) {
                const tables = Array.from(el.querySelectorAll("table"));
                const tableTexts = tables.map((t) => extractTextFromTable(t));
                const clone = cleanExtractedText(el.cloneNode(true));
                clone.querySelectorAll("table").forEach((t) => t.remove());
                clone.querySelectorAll(`#${BTN_ID},#${STATUS_ID},#${PANEL_ID},#${FAIL_MODAL_ID},#${SETTINGS_MODAL_ID}`).forEach((e) => e.remove());
                const text = clone.innerText.replace(/\s+\n/g, "\n").trim();
                if (text) body.push(text);
                tableTexts.forEach((t) => { if (t) body.push(t); });
            }
            if (!body.length) continue;
            chunks.push(`Part ${partName}:\n${body.join("\n")}`);
        }

        return chunks.length ? chunks.join("\n\n") : null;
    }

    function extractQuestionImages() {
        const urls = [];
        const seen = new Set();
        const imgs = Array.from(document.querySelectorAll("img"));
        for (const img of imgs) {
            const src = (img.currentSrc || img.src || "").trim();
            if (!src || src.startsWith("data:image/svg+xml")) continue;
            if (img.closest("button,[role='button'],a")) continue;

            // Keep images that are in question-related containers.
            const inQuestion = Boolean(
                img.closest("[data-part-name]") ||
                img.closest('[class*="_Question_"]') ||
                img.closest('[class*="_RightImage_"]') ||
                img.closest('[class*="_ImageContainer_"]')
            );
            if (!inQuestion) continue;

            const renderedWidth = Number(img.clientWidth || img.naturalWidth || 0);
            const renderedHeight = Number(img.clientHeight || img.naturalHeight || 0);
            if (renderedWidth < 80 && renderedHeight < 80) continue;

            let absolute = "";
            try {
                absolute = new URL(src, location.href).toString();
            } catch {
                absolute = src;
            }
            if (!absolute || seen.has(absolute)) continue;

            seen.add(absolute);
            urls.push(absolute);
        }

        return urls.slice(0, 4);
    }

    function buildPrompt(questionText, requestId, imageUrls, feedbackContext) {
        const startMarker = `SAI_JSON_START:${requestId}`;
        const endMarker = `SAI_JSON_END:${requestId}`;
        const imageGuidance = Array.isArray(imageUrls) && imageUrls.length
            ? [
                "One or more images are attached to this question.",
                "IMPORTANT: Carefully examine each attached image before answering.",
                "- For identification questions (e.g. 'name this cell/structure/organism'), base your answer on what you can actually see in the image — shape, features, labels, context.",
                "- Cross-reference what you see in the image with any clues in the question text (e.g. topic, surrounding context).",
                "- Do not guess a common answer — identify specifically what is shown.",
                "Image URL backup list (in case images did not attach):",
                ...imageUrls.map((url) => `- ${url}`)
            ]
            : [];
        const imageRefusalRule = Array.isArray(imageUrls) && imageUrls.length
            ? "- Only refuse a part if it requires reading specific numerical measurements from a graph/diagram that you genuinely cannot read. Never refuse identification or description questions."
            : "- All data needed is in the question text. Do not refuse any part.";
        return [
            "You are solving a Sparx Science question.",
            "Return ONLY one markdown code block containing valid JSON.",
            "No prose before or after the code block.",
            `Output wrapper is mandatory: first line exactly "${startMarker}", last line exactly "${endMarker}".`,
            "Put the code block between these markers.",
            "Use this JSON schema exactly:",
            '{"answers":[{"part":"main|a)|b)|...","answer":"exact answer text"}],"checks":["optional short checks"]}',
            "Rules:",
            "- Answers must match the question requirements exactly.",
            "- Include every visible part.",
            "- Use plain strings only.",
            "- For longer-answer questions worth more than 2 marks, write the answer as full sentences/paragraphs, not bullet points.",
            "- If a part has multiple input fields (e.g. two separate values to calculate), put each value on its own line within the answer string, in the exact same order the fields appear in the question (top to bottom).",
            "- When a part has labelled fields (e.g. 'rate without enzyme =' then 'rate with enzyme ='), the first line of the answer must correspond to the first field, second line to the second field, and so on. Do not reorder them.",
            "- For checklist/table questions with True/False columns, put one line per table row in the exact row order, using only 'True' or 'False' after the row label, e.g. 'A covalent bond is strong: True'.",
            "- For 'Select all correct answers' multiple-choice questions, include every correct option in the same answer string, separated by commas. Do not return only one option unless only one is correct.",
            "- For match-up/linking questions, put one pair per line in the answer string, using the exact left label, then ':', then the exact matching right label, e.g. 'A: Ball and stick model'. Include every left item.",
            imageRefusalRule,
            ...imageGuidance,
            ...(feedbackContext ? [
                "",
                "IMPORTANT — Previous attempt feedback:",
                `The previous answer scored: ${feedbackContext.summary}`,
                "Marking feedback:",
                feedbackContext.feedback,
                "Use this feedback to write a better answer that addresses the missing marks.",
            ] : []),
            "Question:",
            questionText
        ].join("\n");
    }

    async function requestScienceProcess(prompt, questionText, requestId, images) {
        const settings = await getScienceSettings();
        const payload = { type: "SCIENCE_PROCESS", prompt, questionText, sourceUrl: location.href, settings, requestId, images };
        const uiTimeout = Number(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs);
        const geminiTimeout = Number(settings.geminiResponseTimeoutMs || DEFAULT_SETTINGS.geminiResponseTimeoutMs);
        const requestTimeout = Math.max(10000, uiTimeout, geminiTimeout + 15000);
        const requestRetries = Math.max(0, Number(settings.requestRetries ?? DEFAULT_SETTINGS.requestRetries));
        const runAttempt = (attempt) =>
            withTimeout(
                sendRuntimeMessage(payload).then((response) => {
                    if (!response || !response.ok) {
                        throw new Error(response?.error || "Science processing failed");
                    }
                    return response;
                }),
                requestTimeout,
                "Science request channel timed out"
            ).catch(async (err) => {
                const retryable = isMessagingContextError(err?.message) || isRetryableGeminiError(err?.message);
                if (attempt < requestRetries && retryable) {
                    // If Gemini timed out or produced incomplete output, refresh tab before retry.
                    if (isRetryableGeminiError(err?.message)) {
                        await sendRuntimeMessage({ type: "SCIENCE_RELOAD_GEMINI", settings }).catch(() => { });
                        await new Promise((r) => setTimeout(r, 1200));
                    }
                    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
                    return runAttempt(attempt + 1);
                }
                throw err;
            });

        return runAttempt(0);
    }

    // --- Auto mode helpers ---

    function isActionButtonEnabled(btn) {
        if (!btn) return false;
        const ariaDisabled = String(btn.getAttribute("aria-disabled") || "").toLowerCase() === "true";
        return !btn.disabled && !ariaDisabled;
    }

    function getButtonText(btn) {
        return (btn?.innerText || btn?.textContent || btn?.getAttribute("aria-label") || "").trim().toLowerCase();
    }

    function findSubmitButton() {
        const buttons = Array.from(document.querySelectorAll("button"));
        return buttons.find((b) => {
            const t = getButtonText(b);
            return (t === "submit" || t.startsWith("submit")) && isActionButtonEnabled(b);
        }) || buttons.find((b) => {
            const t = getButtonText(b);
            return b.classList.contains("chakra-button") && t.includes("submit") && isActionButtonEnabled(b);
        });
    }

    async function clickSubmit() {
        for (let attempt = 0; attempt < 12; attempt++) {
            const btn = findSubmitButton();
            if (btn) {
                btn.scrollIntoView({ block: "center", inline: "center" });
                await sleep(80);
                btn.click();
                return true;
            }
            await sleep(150);
        }
        return false;
    }

    function hasSubmitButton() {
        return Boolean(findSubmitButton());
    }

    function hasAnswerableQuestion() {
        const questionText = extractQuestionText();
        if (!questionText) return false;
        return Array.from(document.querySelectorAll('[class*="_AnswerPart_"], [data-part-name]'))
            .some((el) => Boolean(describePartInput(el)));
    }

    // Wait for a condition function to return true, polling every intervalMs up to timeoutMs.
    function waitFor(condFn, timeoutMs = 8000, intervalMs = 150) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                if (condFn()) { resolve(true); return; }
                if (Date.now() >= deadline) { resolve(false); return; }
                setTimeout(check, intervalMs);
            };
            check();
        });
    }

    // Wait for marking results to appear (after submit)
    // Detects either the marking results panel OR the incorrect/correct styling on the question
    function waitForMarkingResult(timeoutMs = 15000) {
        return waitFor(() => {
            if (document.querySelector('[class*="_MarkingResultsV2_"]')) return true;
            // Also detect via the bottom bar — "Try again" or "Next" appearing means marking is done
            const btns = Array.from(document.querySelectorAll("button"));
            return btns.some((b) => {
                const t = getButtonText(b);
                return t === "skip" || t.includes("try again") || t.includes("let's learn it") || t === "next";
            });
        }, timeoutMs);
    }

    // Wait for marking results to disappear (after Try again / next question)
    function waitForMarkingGone(timeoutMs = 8000) {
        return waitFor(() => {
            if (document.querySelector('[class*="_MarkingResultsV2_"]')) return false;
            const btns = Array.from(document.querySelectorAll("button"));
            const hasIncorrectAction = btns.some((b) => {
                const t = getButtonText(b);
                return t === "skip" || t.includes("try again") || t.includes("let's learn it");
            });
            return !hasIncorrectAction;
        }, timeoutMs);
    }

    // Wait for a new question to load (AnimatedPage re-renders)
    function waitForNewQuestion(prevQuestionText, timeoutMs = 10000) {
        return waitFor(() => {
            const q = extractQuestionText();
            return q && q !== prevQuestionText;
        }, timeoutMs);
    }

    // Check if the current answer is fully correct
    function isFullyCorrect() {
        // Incorrect action buttons present = incorrect
        const btns = Array.from(document.querySelectorAll("button"));
        const hasIncorrectAction = btns.some((b) => {
            const t = getButtonText(b);
            return t === "skip" || t.includes("try again") || t.includes("let's learn it");
        });
        if (hasIncorrectAction) return false;

        // Explicit marks summary
        const results = document.querySelector('[class*="_MarkingResultsV2_"]');
        if (results) {
            const summary = results.querySelector('[class*="_MarkingResultSummary_"]')?.innerText || "";
            const match = /(\d+)\s+out\s+of\s+(\d+)/.exec(summary);
            if (match) return match[1] === match[2];
            // Has results panel but no score text — check for "How to improve" section
            const hasImprove = !!results.querySelector('h3');
            if (hasImprove) return false;
        }

        // "Next" button present without "Try again" = correct
        const hasNext = btns.some((b) => {
            const t = (b.innerText || b.textContent || "").trim().toLowerCase();
            return t === "next" || t.startsWith("next");
        });
        return hasNext;
    }

    // Check if we're on a flashcard question
    function isFlashcardMode() {
        return !!document.querySelector('[class*="_FlashcardsNav_"]');
    }

    // Click the "Next" button — only exists on regular questions, not flashcards
    function clickNext() {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => {
            const t = getButtonText(b);
            return t === "next" || t.startsWith("next");
        });
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
    }

    function clickActionButton(matchFn) {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => matchFn(getButtonText(b)) && isActionButtonEnabled(b));
        if (!btn) return false;
        btn.scrollIntoView({ block: "center", inline: "center" });
        btn.click();
        return true;
    }

    function clickSkip() {
        return clickActionButton((t) => t === "skip" || t.startsWith("skip"));
    }

    function clickRetryIncorrect() {
        return clickActionButton((t) => t.includes("try again") || t.includes("let's learn it"));
    }

    function getQuestionKey(text) {
        return String(text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
    }

    async function autoLoop(btn, statusEl) {
        const autoBtn = document.getElementById(AUTO_BTN_ID);
        const MAX_ATTEMPTS_PER_QUESTION = 3;
        const MAX_INCORRECT_SKIPS = 6;
        const retriedQuestionKeys = new Set();
        let incorrectSkipCount = 0;

        while (autoModeActive) {
            // Wait for a question to be present and answerable
            await waitFor(() => hasAnswerableQuestion(), 8000);
            if (!autoModeActive) break;

            // If marking result already showing (e.g. page loaded mid-session), just advance
            if (isFullyCorrect()) {
                showStatus(statusEl, "Auto: already answered, moving to next...", false);
                const prevText = extractQuestionText();
                clickNext();
                await sleep(400);
                await waitForNewQuestion(prevText, 12000);
                await sleep(500);
                continue;
            } else if (document.querySelector('[class*="_MarkingResultsV2_"]') || Array.from(document.querySelectorAll("button")).some((b) => getButtonText(b) === "skip")) {
                const prevText = extractQuestionText();
                if (clickSkip()) {
                    showStatus(statusEl, "Auto: incorrect result already showing, skipping...", false);
                    await sleep(400);
                    await waitForNewQuestion(prevText, 12000);
                    await sleep(500);
                    continue;
                }
            }

            let attempts = 0;
            let feedbackContext = null;
            let solved = false;
            let movedOn = false;

            while (autoModeActive && attempts < MAX_ATTEMPTS_PER_QUESTION) {
                attempts++;
                const currentQuestionText = extractQuestionText();
                const currentQuestionKey = getQuestionKey(currentQuestionText);
                showStatus(statusEl, `Auto: solving (attempt ${attempts})...`, false);

                await runScienceFlow(btn, statusEl, feedbackContext);

                // Wait for the Submit button to be enabled (answer filled in)
                await waitFor(() => hasSubmitButton(), 7000);

                await sleep(400 + Math.random() * 300);
                const submitted = await clickSubmit();
                if (!submitted) {
                    showStatus(statusEl, "Auto: couldn't find Submit button.", true);
                    break;
                }

                const gotResult = await waitForMarkingResult(15000);
                if (!gotResult) {
                    showStatus(statusEl, "Auto: timed out waiting for result.", true);
                    break;
                }

                await sleep(700);

                const correct = isFullyCorrect();
                console.log("[SAI] isFullyCorrect:", correct,
                    "| retry:", Array.from(document.querySelectorAll("button")).some(b => { const t = getButtonText(b); return t.includes("try again") || t.includes("let's learn it"); }),
                    "| skip:", Array.from(document.querySelectorAll("button")).some(b => getButtonText(b) === "skip"),
                    "| next:", Array.from(document.querySelectorAll("button")).some(b => { const t=getButtonText(b); return t==="next"||t.startsWith("next"); }),
                    "| markingPanel:", !!document.querySelector('[class*="_MarkingResultsV2_"]')
                );

                if (correct) {
                    solved = true;
                    showStatus(statusEl, "Auto: correct! Moving to next...", false);
                    break;
                }

                feedbackContext = extractMarkingFeedback();
                const alreadyRetried = retriedQuestionKeys.has(currentQuestionKey);
                const shouldTryAgain = !alreadyRetried && incorrectSkipCount >= MAX_INCORRECT_SKIPS;
                const prevText = currentQuestionText;

                if (shouldTryAgain && clickRetryIncorrect()) {
                    retriedQuestionKeys.add(currentQuestionKey);
                    showStatus(statusEl, "Auto: skip limit reached, trying again once...", false);
                    await waitForMarkingGone(6000);
                    await sleep(500);
                    continue;
                }

                if (clickSkip()) {
                    incorrectSkipCount++;
                    showStatus(statusEl, alreadyRetried
                        ? "Auto: still incorrect after retry, skipping..."
                        : `Auto: incorrect, skipping (${incorrectSkipCount}/${MAX_INCORRECT_SKIPS})...`, false);
                    await sleep(400);
                    await waitForNewQuestion(prevText, 12000);
                    await sleep(500);
                    movedOn = true;
                    break;
                }

                if (clickRetryIncorrect()) {
                    retriedQuestionKeys.add(currentQuestionKey);
                    showStatus(statusEl, "Auto: skip unavailable, trying again...", false);
                    await waitForMarkingGone(6000);
                    await sleep(500);
                    continue;
                }

                showStatus(statusEl, "Auto: couldn't find Skip or Try again.", true);
                break;
            }

            if (!autoModeActive) break;
            if (movedOn) continue;

            if (!solved) {
                showStatus(statusEl, "Auto: max attempts reached. Stopping.", true);
                autoModeActive = false;
                if (autoBtn) { autoBtn.textContent = "Auto: OFF"; autoBtn.classList.remove("sai-auto-active"); }
                return;
            }

            const prevText = extractQuestionText();
            clickNext();
            await sleep(400);

            const advanced = await waitForNewQuestion(prevText, 12000);
            if (!advanced) {
                showStatus(statusEl, "Auto: no new question detected. Stopping.", true);
                autoModeActive = false;
                if (autoBtn) { autoBtn.textContent = "Auto: OFF"; autoBtn.classList.remove("sai-auto-active"); }
                break;
            }

            await sleep(500);
        }
    }

    // Extract marking feedback after submission (marks given + how to improve)
    function extractMarkingFeedback() {
        const results = document.querySelector('[class*="_MarkingResultsV2_"]');
        if (!results) return null;

        const summary = results.querySelector('[class*="_MarkingResultSummary_"]');
        const summaryText = summary?.innerText?.trim() || "";

        // Check if full marks — if so, no retry needed
        const fullMarks = /(\d+)\s+out\s+of\s+(\d+)/.exec(summaryText);
        if (fullMarks && fullMarks[1] === fullMarks[2]) return null; // perfect score

        const feedback = [];

        // "Marks given for" sections
        const details = Array.from(results.querySelectorAll('[class*="_MarkingResultDetail_"]'));
        for (const detail of details) {
            const heading = detail.querySelector("h3")?.innerText?.trim() || "";
            const items = Array.from(detail.querySelectorAll('[class*="_MarkingResultFeedback_"]'))
                .map((f) => {
                    const clone = f.cloneNode(true);
                    // Remove icon elements
                    clone.querySelectorAll('[class*="_Icon_"]').forEach((el) => el.remove());
                    return clone.innerText.replace(/\s+\n/g, "\n").trim();
                })
                .filter(Boolean);
            if (items.length) feedback.push(`${heading}\n${items.join("\n")}`);
        }

        return { summary: summaryText, feedback: feedback.join("\n\n") };
    }

    // Find and click the "Try again" button
    function clickTryAgain() {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => {
            const t = getButtonText(b);
            return t.includes("try again") || t.includes("let's learn it");
        });
        if (btn) { btn.click(); return true; }
        return false;
    }

    async function runScienceFlow(btn, statusEl, feedbackContext) {
        if (btn.disabled) return;
        const runId = ++activeRunId;
        const settings = await getScienceSettings();
        const providerLabel = AI_PROVIDER_LABELS[String(settings.aiProvider || DEFAULT_SETTINGS.aiProvider).toLowerCase()] || "AI";
        btn.disabled = true;
        btn.textContent = "Processing...";
        hideFailureModal();
        hideResultPanel();
        const progressTimer = setInterval(() => {
            if (runId !== activeRunId) return;
            showStatus(statusEl, `Still processing... ${providerLabel} can take a little while.`, false);
        }, 12000);

        try {
            const questionText = extractQuestionText();
            console.log("[SAI] extracted question:\n", questionText);
            if (!questionText) throw new Error("Could not find science question content.");
            const imageUrls = extractQuestionImages();

            showStatus(statusEl, feedbackContext
                ? `Retrying with feedback (${feedbackContext.summary})...`
                : `Question extracted (${imageUrls.length} image${imageUrls.length === 1 ? "" : "s"}). Sending to ${providerLabel}...`, false);
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const prompt = buildPrompt(questionText, requestId, imageUrls, feedbackContext || null);
            const response = await requestScienceProcess(prompt, questionText, requestId, imageUrls);

            sendRuntimeMessage({
                type: "SCIENCE_RESPONSE",
                data: response.data,
                raw: response.raw,
                parseError: response.parseError || null,
                sourceUrl: location.href
            }).catch(() => { });

            console.log("SCIENCE_RESPONSE", response.data);
            showResultPanel(response);
            hideFailureModal();

            // Auto-fill after getting answer
            if (response.data && Array.isArray(response.data.answers)) {
                await sleep(300);
                await autoFillAnswers(response.data.answers);
            }

            if (response.parseError) {
                showStatus(statusEl, "Response received, but JSON parse failed. Raw saved.", true);
            } else {
                showStatus(statusEl, "Science answer received!", false);
            }
        } catch (err) {
            console.error("Science flow error:", err);
            showStatus(statusEl, `Error: ${err.message || String(err)}`, true);
            hideResultPanel();
            if (isMessagingContextError(err?.message)) {
                showFailureModal("Request failed because extension context was refreshed. Click Try again, then run Solve Science again.");
            } else if (isRetryableGeminiError(err?.message)) {
                showFailureModal(`Request failed after auto-retry. ${providerLabel} was refreshed automatically but did not return a valid response in time.`);
            } else {
                showFailureModal(`Request failed. Use Try again to refresh ${providerLabel}, then run again.`);
            }
        } finally {
            clearInterval(progressTimer);
            btn.disabled = false;
            btn.textContent = "Solve Science";
        }
    }

    // Watch for marking results appearing after the user submits (manual mode only)
    let retryInProgress = false;
    const markingObserver = new MutationObserver(() => {
        if (retryInProgress || autoModeActive) return;
        const feedback = extractMarkingFeedback();
        if (!feedback) return;

        retryInProgress = true;
        const btn = document.getElementById(BTN_ID);
        const statusEl = document.getElementById(STATUS_ID);
        if (!btn || !statusEl) { retryInProgress = false; return; }

        setTimeout(async () => {
            try {
                const clicked = clickTryAgain();
                if (!clicked) { retryInProgress = false; return; }
                await sleep(800);
                await runScienceFlow(btn, statusEl, feedback);
            } finally {
                retryInProgress = false;
            }
        }, 1200);
    });
    markingObserver.observe(document.documentElement, { childList: true, subtree: true });

    const observer = new MutationObserver(() => ensureUi());
    ensureUi();
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const menuObserver = new MutationObserver(() => ensureGlobalMenuItem());
    menuObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
