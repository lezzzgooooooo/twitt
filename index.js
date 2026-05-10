const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const REST_BASE = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
const POST_TTL_MS = 2 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function userIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.socket.remoteAddress || "";
}

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sb(path, options = {}) {
  const res = await fetch(`${REST_BASE}${path}`, {
    ...options,
    headers: sbHeaders(options.headers || {}),
  });

  const text = await res.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text}`);
  }

  return { res, data };
}

function pickUsername(user_id, usernameFromBody) {
  const name = String(usernameFromBody || "").trim();
  return name.length ? name : user_id;
}

async function getProfile(user_id) {
  const { data } = await sb(
    `/profiles?select=*&user_id=eq.${encodeURIComponent(user_id)}&limit=1`,
    { method: "GET", headers: { Accept: "application/json" } }
  );

  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function loadVerifiedUsernames() {
  const { data } = await sb(
    `/verified_users?select=username`,
    { method: "GET", headers: { Accept: "application/json" } }
  );

  const rows = Array.isArray(data) ? data : [];
  return new Set(rows.map((row) => row.username));
}

async function upsertProfile(user_id, username, avatar_url, req) {
  await sb(`/profiles?on_conflict=user_id`, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id,
      username,
      avatar_url: avatar_url || null,
      ip_address: userIp(req),
      last_seen_at: nowIso(),
    }),
  });
}

app.get("/", (req, res) => {
  res.send("Aippy social backend running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/profile", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const profile = await getProfile(user_id);

    if (!profile) {
      return res.json({ exists: false, profile: null });
    }

    res.json({ exists: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/profile", async (req, res) => {
  try {
    const { user_id, username, avatar_url } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const cleanUsername = pickUsername(user_id, username);
    const cleanAvatar = String(avatar_url || "").trim();

    await upsertProfile(user_id, cleanUsername, cleanAvatar, req);
    const profile = await getProfile(user_id);

    res.json({ status: "saved", profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/touch", async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const profile = await getProfile(user_id);
    if (!profile) return res.status(404).json({ error: "profile not found" });

    await upsertProfile(user_id, profile.username, profile.avatar_url || null, req);
    const updated = await getProfile(user_id);

    res.json({ status: "ok", profile: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/post", async (req, res) => {
  try {
    const { user_id, content, image_url } = req.body || {};
     if (!user_id || (!content?.trim() && !image_url)) {
      return res.status(400).json({
      error: "user_id and either content or image_url are required",
      });
    }

    const profile = await getProfile(user_id);
    if (!profile) {
      return res.status(400).json({ error: "profile does not exist" });
    }

    const expires_at = new Date(Date.now() + POST_TTL_MS).toISOString();

    await sb(`/posts`, {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
body: JSON.stringify({
  user_id,
  username: profile.username,
  avatar_url: profile.avatar_url || null,
  content: content?.trim() || "",
  image_url: image_url || null,
  created_at: nowIso(),
  expires_at,
}),
    });

    res.json({ status: "posted", expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/feed", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 100);

    const { data: posts } = await sb(
      `/feed_posts?select=*&expires_at=gt.${encodeURIComponent(nowIso())}&order=created_at.desc&limit=${limit}`,
      { method: "GET", headers: { Accept: "application/json" } }
    );

    const rows = Array.isArray(posts) ? posts : [];
    const verifiedSet = await loadVerifiedUsernames();

    let likedSet = new Set();

    if (user_id && rows.length) {
      const ids = rows.map((p) => p.id).filter(Boolean);
      if (ids.length) {
        const { data: likes } = await sb(
          `/likes?select=post_id&user_id=eq.${encodeURIComponent(user_id)}&post_id=in.(${ids.join(",")})`,
          { method: "GET", headers: { Accept: "application/json" } }
        );

        likedSet = new Set((Array.isArray(likes) ? likes : []).map((row) => row.post_id));
      }
    }

    const normalized = rows.map((post) => ({
      ...post,
      like_count: Number(post.like_count || 0),
      reply_count: Number(post.reply_count || 0),
      verified: verifiedSet.has(post.username),
      liked_by_me: likedSet.has(post.id),
    }));

    res.json(normalized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/like", async (req, res) => {
  try {
    const { user_id, post_id } = req.body || {};
    if (!user_id || !post_id) {
      return res.status(400).json({ error: "user_id and post_id are required" });
    }

    const profile = await getProfile(user_id);
    if (!profile) return res.status(400).json({ error: "profile does not exist" });

    await sb(`/likes?on_conflict=post_id,user_id`, {
      method: "POST",
      headers: {
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({
        post_id,
        user_id,
        created_at: nowIso(),
      }),
    });

    res.json({ status: "liked" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/like", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || req.body?.user_id || "").trim();
    const post_id = String(req.query.post_id || req.body?.post_id || "").trim();

    if (!user_id || !post_id) {
      return res.status(400).json({ error: "user_id and post_id are required" });
    }

    await sb(
      `/likes?user_id=eq.${encodeURIComponent(user_id)}&post_id=eq.${encodeURIComponent(post_id)}`,
      { method: "DELETE" }
    );

    res.json({ status: "unliked" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/liked", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "").trim();
    const post_id = String(req.query.post_id || "").trim();

    if (!user_id || !post_id) {
      return res.status(400).json({ error: "user_id and post_id are required" });
    }

    const { data } = await sb(
      `/likes?select=id&user_id=eq.${encodeURIComponent(user_id)}&post_id=eq.${encodeURIComponent(post_id)}&limit=1`,
      { method: "GET", headers: { Accept: "application/json" } }
    );

    res.json({ liked: Array.isArray(data) && data.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reply", async (req, res) => {
  try {
    const { user_id, post_id, content } = req.body || {};
    if (!user_id || !post_id || !content?.trim()) {
      return res.status(400).json({ error: "user_id, post_id, and content are required" });
    }

    const profile = await getProfile(user_id);
    if (!profile) return res.status(400).json({ error: "profile does not exist" });

    await sb(`/replies`, {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        post_id,
        user_id,
        username: profile.username,
        avatar_url: profile.avatar_url || null,
        content: content.trim(),
        created_at: nowIso(),
      }),
    });

    res.json({ status: "replied" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/replies", async (req, res) => {
  try {
    const post_id = String(req.query.post_id || "").trim();
    if (!post_id) return res.status(400).json({ error: "post_id is required" });

    const { data } = await sb(
      `/replies?select=*&post_id=eq.${encodeURIComponent(post_id)}&order=created_at.asc`,
      { method: "GET", headers: { Accept: "application/json" } }
    );

    const rows = Array.isArray(data) ? data : [];
    const verifiedSet = await loadVerifiedUsernames();

    res.json(
      rows.map((reply) => ({
        ...reply,
        verified: verifiedSet.has(reply.username),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/verified", async (req, res) => {
  try {
    const username = String(req.query.username || "").trim();
    if (!username) return res.status(400).json({ error: "username is required" });

    const verifiedSet = await loadVerifiedUsernames();
    res.json({ verified: verifiedSet.has(username) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aippy social backend running on port ${PORT}`);
});
