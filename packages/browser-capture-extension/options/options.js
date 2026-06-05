import { DEFAULT_LOCAL_VO_URL, validateCaptureSettings } from "../src/capture.js";

const urlInput = document.getElementById("localVoUrl");
const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

async function loadOptions() {
  const stored = await chrome.storage.local.get({
    localVoUrl: DEFAULT_LOCAL_VO_URL,
    token: "",
  });
  urlInput.value = stored.localVoUrl || DEFAULT_LOCAL_VO_URL;
  tokenInput.value = stored.token || "";
}

async function saveOptions() {
  try {
    const settings = validateCaptureSettings({
      localVoUrl: urlInput.value,
      token: tokenInput.value,
    });
    await chrome.storage.local.set(settings);
    setStatus("Saved", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

saveBtn.addEventListener("click", () => {
  void saveOptions();
});

void loadOptions();
