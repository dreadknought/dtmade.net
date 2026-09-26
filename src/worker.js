const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const ALLOWED_SERVICES = new Set([
  "business-signs",
  "wall-window-graphics",
  "banners-displays",
  "decals",
  "large-format-printing",
  "tshirt-design-printing",
  "other"
]);

const ALLOWED_FILE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
  "application/postscript",
  "application/illustrator"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      return json({
        turnstileSiteKey: env.TURNSTILE_SITE_KEY,
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES
      });
    }

    if (url.pathname === "/api/quote" && request.method === "POST") {
      return handleQuote(request, env);
    }

    if (url.pathname === "/api/artwork" && request.method === "GET") {
      return handleArtworkDownload(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    await runQuoteHealthCheck(env, controller.scheduledTime);
  }
};

async function handleQuote(request, env, { skipTurnstile = false } = {}) {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart form data." }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return json({ error: "Unable to read submission." }, 400);
  }

  if (!skipTurnstile) {
    const token = stringValue(form.get("cf-turnstile-response"));

    const turnstile = await verifyTurnstile(
      token,
      request.headers.get("CF-Connecting-IP"),
      env.TURNSTILE_SECRET
    );

    if (!turnstile.success) {
      return json(
        { error: "Bot verification failed. Please try again." },
        403
      );
    }
  }

  const lead = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name: clean(form.get("name"), 100),
    company: clean(form.get("company"), 150),
    email: clean(form.get("email"), 254).toLowerCase(),
    phone: clean(form.get("phone"), 40),
    service: clean(form.get("service"), 50),
    projectDetails: clean(form.get("project_details"), 4000),
    deadline: clean(form.get("deadline"), 80),
    artworkStatus: clean(form.get("artwork_status"), 80),
    sourcePath: clean(form.get("source_path"), 500)
  };

  const validationError = validateLead(lead);

  if (validationError) {
    return json({ error: validationError }, 400);
  }

  const files = form
    .getAll("artwork")
    .filter((item) => item instanceof File && item.size > 0);

  const fileError = validateFiles(files);

  if (fileError) {
    return json({ error: fileError }, 400);
  }

  const uploaded = [];

  try {
    for (const file of files) {
      const safeName = sanitizeFilename(file.name);

      const objectKey =
        `leads/${lead.createdAt.slice(0, 10)}/${lead.id}/` +
        `${crypto.randomUUID()}-${safeName}`;

      await env.ARTWORK.put(objectKey, file.stream(), {
        httpMetadata: {
          contentType: file.type || "application/octet-stream"
        },
        customMetadata: {
          leadId: lead.id,
          originalName: file.name
        }
      });

      uploaded.push({
        id: crypto.randomUUID(),
        objectKey,
        originalName: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size
      });
    }

    const ipHash = await hashValue(
      `${
        request.headers.get("CF-Connecting-IP") || ""
      }:${env.IP_HASH_SALT || ""}`
    );

    const statements = [
      env.DB.prepare(`
        INSERT INTO leads (
          id,
          created_at,
          name,
          company,
          email,
          phone,
          service,
          project_details,
          deadline,
          artwork_status,
          source_path,
          user_agent,
          ip_hash
        ) VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          ?5,
          ?6,
          ?7,
          ?8,
          ?9,
          ?10,
          ?11,
          ?12,
          ?13
        )
      `).bind(
        lead.id,
        lead.createdAt,
        lead.name,
        lead.company || null,
        lead.email,
        lead.phone,
        lead.service,
        lead.projectDetails,
        lead.deadline || null,
        lead.artworkStatus || null,
        lead.sourcePath || null,
        request.headers.get("User-Agent") || null,
        ipHash || null
      )
    ];

    for (const file of uploaded) {
      statements.push(
        env.DB.prepare(`
          INSERT INTO lead_files (
            id,
            lead_id,
            created_at,
            original_name,
            object_key,
            content_type,
            size_bytes
          ) VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            ?6,
            ?7
          )
        `).bind(
          file.id,
          lead.id,
          lead.createdAt,
          file.originalName,
          file.objectKey,
          file.contentType,
          file.sizeBytes
        )
      );
    }

    await env.DB.batch(statements);
  } catch (error) {
    await cleanupUploads(env, uploaded);

    console.error("Failed to persist lead", error);

    return json(
      {
        error: "We couldn't save your quote request. Please try again."
      },
      500
    );
  }

  let emailError = null;

  try {
    await sendLeadEmail(env, lead, uploaded);

    await env.DB.prepare(
      "UPDATE leads SET email_sent_at = ?2, email_error = NULL WHERE id = ?1"
    )
      .bind(lead.id, new Date().toISOString())
      .run();
  } catch (error) {
    emailError = safeError(error);

    console.error("Lead saved, email notification failed", error);

    await env.DB.prepare(
      "UPDATE leads SET email_error = ?2 WHERE id = ?1"
    )
      .bind(lead.id, emailError.slice(0, 1000))
      .run();
  }

  return json(
    {
      ok: true,
      leadId: lead.id,
      notificationSent: !emailError
    },
    201
  );
}

async function runQuoteHealthCheck(env, scheduledTime) {
  const now = new Date(scheduledTime || Date.now());
  const testId = `healthcheck-${now.toISOString()}`;

  const form = new FormData();

  form.set("name", "DTMADE Health Check");
  form.set("company", "Dahntahn Made");
  form.set("email", env.LEAD_EMAIL_FROM || "quotes@dtmade.net");
  form.set("phone", "4125550100");
  form.set("service", "other");

  form.set(
    "project_details",
    [
      "AUTOMATED DAILY QUOTE HEALTH CHECK",
      "",
      testId,
      "",
      "Do not process this quote."
    ].join("\n")
  );

  form.set("deadline", "Automated test");
  form.set("artwork_status", "Test artwork");
  form.set("source_path", "/automated-health-check");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <rect width="100" height="100" fill="white"/>
  <text x="10" y="50" font-size="10">DTMADE TEST</text>
</svg>
  `.trim();

  form.append(
    "artwork",
    new File(
      [svg],
      `dtmade-healthcheck-${now.toISOString().slice(0, 10)}.svg`,
      {
        type: "image/svg+xml"
      }
    )
  );

  const request = new Request("https://dtmade.net/api/quote", {
    method: "POST",
    body: form,
    headers: {
      "User-Agent": "DTMADE-Synthetic-Monitor/1.0"
    }
  });

  const response = await handleQuote(request, env, {
    skipTurnstile: true
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `DTMADE quote health check failed: ` +
      `${response.status} ${JSON.stringify(result)}`
    );
  }

  if (!result.notificationSent) {
    throw new Error(
      "DTMADE quote health check saved the quote " +
      `but email notification failed: ${JSON.stringify(result)}`
    );
  }

  console.log("DTMADE quote health check succeeded", {
    testId,
    leadId: result.leadId
  });
}

function validateLead(lead) {
  if (lead.name.length < 2) {
    return "Please enter your name.";
  }

  if (!isValidEmail(lead.email)) {
    return "Please enter a valid email address.";
  }

  if (lead.phone.length < 7) {
    return "Please enter a valid phone number.";
  }

  if (!ALLOWED_SERVICES.has(lead.service)) {
    return "Please choose a valid service.";
  }

  if (lead.projectDetails.length < 10) {
    return "Please tell us a little more about the project.";
  }

  return null;
}

function validateFiles(files) {
  if (files.length > MAX_FILES) {
    return `Please upload no more than ${MAX_FILES} files.`;
  }

  let total = 0;

  for (const file of files) {
    total += file.size;

    if (file.size > MAX_FILE_BYTES) {
      return (
        `${file.name} is too large. ` +
        `Maximum file size is ${formatBytes(MAX_FILE_BYTES)}.`
      );
    }

    if (file.type && !ALLOWED_FILE_TYPES.has(file.type)) {
      return `${file.name} is not an allowed file type.`;
    }
  }

  if (total > MAX_TOTAL_BYTES) {
    return (
      `Total upload size must be under ` +
      `${formatBytes(MAX_TOTAL_BYTES)}.`
    );
  }

  return null;
}

async function verifyTurnstile(token, remoteIp, secret) {
  if (!token || !secret) {
    return { success: false };
  }

  const body = new FormData();

  body.append("secret", secret);
  body.append("response", token);

  if (remoteIp) {
    body.append("remoteip", remoteIp);
  }

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body
    }
  );

  if (!response.ok) {
    return { success: false };
  }

  return response.json();
}

async function sendLeadEmail(env, lead, files) {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  if (!env.ARTWORK_LINK_SECRET) {
    throw new Error("ARTWORK_LINK_SECRET is not configured");
  }

  const fileLines = files.length
    ? (
        await Promise.all(
          files.map(async (file) => {
            const url = await createArtworkLink(
              env,
              file.objectKey
            );

            return [
              `• ${file.originalName} (${formatBytes(file.sizeBytes)})`,
              `  Download: ${url}`
            ].join("\n");
          })
        )
      ).join("\n")
    : "No artwork uploaded.";

  const text = [
    `New quote request — ${env.BUSINESS_NAME || "Sign Shop"}`,
    "",
    `Lead ID: ${lead.id}`,
    `Name: ${lead.name}`,
    `Company: ${lead.company || "—"}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone}`,
    `Service: ${serviceLabel(lead.service)}`,
    `Deadline: ${lead.deadline || "—"}`,
    `Artwork: ${lead.artworkStatus || "—"}`,
    "",
    "Project details:",
    lead.projectDetails,
    "",
    "Files:",
    fileLines,
    "",
    `Source: ${lead.sourcePath || "—"}`
  ].join("\n");

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.LEAD_EMAIL_FROM,
        to: [env.LEAD_EMAIL_TO],
        reply_to: lead.email,
        subject: "dtmade quote",
        text
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Email provider returned ${response.status}: ` +
      `${await response.text()}`
    );
  }
}

async function handleArtworkDownload(request, env) {
  if (!env.ARTWORK_LINK_SECRET) {
    return json(
      {
        error: "Artwork links are not configured."
      },
      500
    );
  }

  const url = new URL(request.url);

  const key = url.searchParams.get("key") || "";
  const expires = Number(
    url.searchParams.get("expires") || 0
  );
  const sig = url.searchParams.get("sig") || "";

  if (!key || !expires || !sig) {
    return json(
      {
        error: "Invalid artwork link."
      },
      400
    );
  }

  if (Date.now() > expires * 1000) {
    return json(
      {
        error: "This artwork link has expired."
      },
      410
    );
  }

  const expected = await signArtworkLink(
    env.ARTWORK_LINK_SECRET,
    key,
    expires
  );

  if (!timingSafeEqual(sig, expected)) {
    return json(
      {
        error: "Invalid artwork link."
      },
      403
    );
  }

  const object = await env.ARTWORK.get(key);

  if (!object) {
    return json(
      {
        error: "Artwork not found."
      },
      404
    );
  }

  const headers = new Headers();

  object.writeHttpMetadata(headers);

  headers.set(
    "Cache-Control",
    "private, no-store"
  );

  headers.set(
    "X-Content-Type-Options",
    "nosniff"
  );

  const originalName =
    object.customMetadata?.originalName ||
    key.split("/").pop() ||
    "artwork";

  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`
  );

  return new Response(
    object.body,
    {
      headers
    }
  );
}

async function createArtworkLink(env, key) {
  const ttl = Number(
    env.ARTWORK_LINK_TTL_SECONDS || 2592000
  );

  const expires =
    Math.floor(Date.now() / 1000) + ttl;

  const sig = await signArtworkLink(
    env.ARTWORK_LINK_SECRET,
    key,
    expires
  );

  const base = (
    env.SITE_URL || "https://dtmade.net"
  ).replace(/\/$/, "");

  const params = new URLSearchParams({
    key,
    expires: String(expires),
    sig
  });

  return `${base}/api/artwork?${params.toString()}`;
}

async function signArtworkLink(secret, key, expires) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const data = new TextEncoder().encode(
    `${key}\n${expires}`
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    data
  );

  return toBase64Url(
    new Uint8Array(signature)
  );
}

function toBase64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;

  for (let i = 0; i < a.length; i++) {
    mismatch |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return mismatch === 0;
}

async function cleanupUploads(env, uploaded) {
  await Promise.allSettled(
    uploaded.map((file) =>
      env.ARTWORK.delete(file.objectKey)
    )
  );
}

function clean(value, maxLength) {
  return stringValue(value)
    .replace(/\0/g, "")
    .trim()
    .slice(0, maxLength);
}

function stringValue(value) {
  return typeof value === "string"
    ? value
    : "";
}

function isValidEmail(value) {
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    value.length <= 254
  );
}

function sanitizeFilename(name) {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return (cleaned || "upload").slice(0, 180);
}

async function hashValue(value) {
  if (!value) {
    return "";
  }

  const data =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return [
    ...new Uint8Array(digest)
  ]
    .map((byte) =>
      byte
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
}

function serviceLabel(value) {
  return {
    "business-signs": "Business Signs",
    "wall-window-graphics":
      "Window & Wall Graphics",
    "banners-displays":
      "Banners, Displays & Event Graphics",
    "decals":
      "Decals & Stickers",
    "large-format-printing":
      "Large-Format Printing",
    "tshirt-design-printing":
      "T-Shirt Design & Printing",
    "other":
      "Something Else"
  }[value] || value;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return (
    `${(bytes / 1024 / 1024).toFixed(1)} MB`
  );
}

function safeError(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}