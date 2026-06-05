import {
  DEFAULT_LOCAL_VO_URL,
  buildIntakePayload,
  extractReadablePageText,
  intakeUrl,
  validateCaptureSettings,
} from "../src/capture.js";

const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("capture");
const optionsBtn = document.getElementById("options");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

async function readSettings() {
  const stored = await chrome.storage.local.get({
    localVoUrl: DEFAULT_LOCAL_VO_URL,
    token: "",
  });
  return validateCaptureSettings(stored);
}

async function activeHttpTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("Open an http(s) page before capturing.");
  }
  return tab;
}

async function extractFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title || "",
      text: document.body?.innerText || document.documentElement?.innerText || "",
    }),
  });
  return {
    title: String(result?.result?.title || ""),
    text: extractReadablePageText({
      body: { innerText: String(result?.result?.text || "") },
      documentElement: { innerText: "" },
    }),
  };
}

async function postCapture() {
  captureBtn.disabled = true;
  setStatus("Capturing...");
  try {
    const settings = await readSettings();
    const tab = await activeHttpTab();
    const extracted = await extractFromTab(tab.id);
    const payload = buildIntakePayload(tab, extracted);
    const res = await fetch(intakeUrl(settings.localVoUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.error || `Local VO returned HTTP ${res.status}`);
    }
    setStatus(`Saved ${body.relative_path || "capture"}`, "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    captureBtn.disabled = false;
  }
}

captureBtn.addEventListener("click", () => {
  void postCapture();
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
