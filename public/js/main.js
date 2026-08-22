let config = null;
let turnstileWidgetId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.querySelector("#quote-form");
  const service = document.querySelector("#service");
  const sourcePath = document.querySelector("#source-path");

  sourcePath.value = location.pathname + location.search;

  document.querySelectorAll("[data-service]").forEach((link) => {
    link.addEventListener("click", () => {
      service.value = link.dataset.service || "";
    });
  });

  try {
    const response = await fetch("/api/config", { headers: { "Accept": "application/json" } });
    config = await response.json();
    renderTurnstileWhenReady(config.turnstileSiteKey);
  } catch {
    setStatus("Unable to load the quote form security check. Please refresh the page.", true);
  }

  form.addEventListener("submit", submitQuote);
});

function renderTurnstileWhenReady(siteKey) {
  if (!siteKey || siteKey.startsWith("REPLACE_")) {
    setStatus("Turnstile is not configured yet.", true);
    return;
  }

  const attempt = () => {
    if (window.turnstile) {
      turnstileWidgetId = window.turnstile.render("#turnstile-container", {
        sitekey: siteKey,
        action: "quote_request",
        theme: "light"
      });
      return;
    }
    setTimeout(attempt, 100);
  };

  attempt();
}

async function submitQuote(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const submitButton = document.querySelector("#submit-button");
  const files = [...document.querySelector("#artwork").files];

  if (!form.reportValidity()) return;

  const fileError = validateFiles(files);
  if (fileError) {
    setStatus(fileError, true);
    return;
  }

  const token = window.turnstile && turnstileWidgetId !== null
    ? window.turnstile.getResponse(turnstileWidgetId)
    : "";

  if (!token) {
    setStatus("Please complete the security check.", true);
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Sending…";
  setStatus("Uploading files and saving your request…");

  try {
    const data = new FormData(form);
    data.set("cf-turnstile-response", token);

    const response = await fetch("/api/quote", {
      method: "POST",
      body: data,
      headers: { "Accept": "application/json" }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to submit quote request.");
    }

    form.hidden = true;
    const panel = document.querySelector("#success-panel");
    panel.hidden = false;
    document.querySelector("#lead-id").textContent = `Reference: ${result.leadId}`;

    if (!result.notificationSent) {
      panel.insertAdjacentHTML(
        "beforeend",
        "<p><strong>Your request is saved.</strong> The email notification had a problem, so we can still recover the lead from the database.</p>"
      );
    }
  } catch (error) {
    setStatus(error.message || "Something went wrong. Please try again.", true);
    if (window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Send Quote Request";
  }
}

function validateFiles(files) {
  if (!config) return null;
  if (files.length > config.maxFiles) return `Please choose no more than ${config.maxFiles} files.`;

  let total = 0;
  for (const file of files) {
    total += file.size;
    if (file.size > config.maxFileBytes) {
      return `${file.name} is larger than ${formatBytes(config.maxFileBytes)}.`;
    }
  }
  if (total > config.maxTotalBytes) {
    return `Total upload size must be under ${formatBytes(config.maxTotalBytes)}.`;
  }
  return null;
}

function setStatus(message, isError = false) {
  const status = document.querySelector("#form-status");
  status.textContent = message || "";
  status.classList.toggle("error", isError);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
