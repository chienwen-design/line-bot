import express from "express";
import dotenv from "dotenv";
import { Pool } from "pg";
import QRCode from "qrcode";
import { Client, middleware } from "@line/bot-sdk";
import { v2 as cloudinary } from 'cloudinary';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// === 基本設定 ===
const BASE_URL = process.env.PUBLIC_BASE_URL || "https://f47d55e98170.ngrok-free.app";
const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};
const client = new Client(config);

// === PostgreSQL 資料庫設定 ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// === Cloudinary 雲端儲存設定 ===
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// === 初始化資料庫 ===
async function initializeDatabase() {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        line_user_id VARCHAR(255) UNIQUE,
        name VARCHAR(255),
        phone VARCHAR(255),
        qrcode TEXT,
        waiting_for_phone BOOLEAN DEFAULT FALSE, -- 💥 新增狀態欄位
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    client.release();
    console.log("✅ PostgreSQL 資料表初始化成功");
  } catch (err) {
    console.error("❌ PostgreSQL 資料表初始化失敗", err);
  }
}

app.get("/", (req, res) => res.send("✅ LINE Webhook + QRCode Server 已啟動 (PostgreSQL/Cloudinary)"));

// === Webhook 接收 LINE 事件 ===
app.post("/webhook", middleware(config), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "follow") {
      await handleFollowEvent(event);
    } else if (event.type === "postback") {
      await handlePostback(event);
    } else if (event.type === "message") {
      await handleMessage(event);
    }
  }
});

// === follow 事件：新會員加入 ===
async function handleFollowEvent(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);

  let memberResult = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  let member = memberResult.rows[0];

  if (!member) {
    const insertResult = await pool.query(
      "INSERT INTO members (line_user_id, name, waiting_for_phone) VALUES ($1, $2, $3) RETURNING id, created_at",
      [userId, profile.displayName, true]
    );
    const memberId = insertResult.rows[0].id;

    const memberUrl = `${BASE_URL}/member/${memberId}`;
    const qrCodeBuffer = await QRCode.toBuffer(memberUrl, { width: 300, margin: 2 });

    const uploadResult = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({
        folder: "line_qrcodes",
        public_id: `member_${memberId}`
      }, (error, result) => {
        if (error) reject(error);
        resolve(result);
      }).end(qrCodeBuffer);
    });

    const qrCodeUrl = uploadResult.secure_url;
    await pool.query("UPDATE members SET qrcode = $1 WHERE id = $2", [qrCodeUrl, memberId]);
  } else {
    await pool.query("UPDATE members SET waiting_for_phone = true WHERE line_user_id = $1", [userId]);
  }

  await client.replyMessage(event.replyToken, [
    { type: "text", text: `🎉 歡迎加入會員，${profile.displayName}！` },
    { type: "text", text: "請輸入您的聯絡電話（例如：0912345678），以完成會員資料。" }
  ]);
}

// === 處理一般文字訊息 ===
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const phoneRegex = /^09\d{8}$/;

  // 查詢會員資料
  const result = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  const member = result.rows[0];

  if (!member) {
    await client.replyMessage(event.replyToken, { type: "text", text: "⚠️ 查無會員資料，請重新加入。" });
    return;
  }

  // === 功能1：使用者主動要求修改電話 ===
  if (text === "修改電話") {
    await pool.query("UPDATE members SET waiting_for_phone = true WHERE line_user_id = $1", [userId]);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "🔄 請輸入您的新聯絡電話（例如：0912345678）"
    });
    return;
  }

  // === 功能2：正在等待電話輸入時 ===
  if (member.waiting_for_phone) {
    if (phoneRegex.test(text)) {
      await pool.query("UPDATE members SET phone = $1, waiting_for_phone = false WHERE line_user_id = $2", [text, userId]);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `✅ 您的電話已更新為：${text}`
      });
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 請輸入正確的手機格式（例如：0912345678）"
      });
    }
    return;
  }

  // === 功能3：一般情境輸入非指令 ===
  if (/^\d+$/.test(text)) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 若要修改電話，請輸入「修改電話」"
    });
    return;
  }
}

// === postback 處理 ===
async function handlePostback(event) {
  const data = event.postback.data;
  const userId = event.source.userId;

  const memberResult = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  const member = memberResult.rows[0];

  if (data === "my_qr") {
    if (member?.qrcode) {
      await client.replyMessage(event.replyToken, {
        type: "image",
        originalContentUrl: member.qrcode,
        previewImageUrl: member.qrcode,
      });
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 尚未產生專屬 QR Code，請稍後再試。",
      });
    }
  } else if (data === "my_info") {
    if (member) {
      const userInfo = `
【我的會員資訊】
📝 姓名: ${member.name || '未設定'}
📞 電話: ${member.phone || '未設定'}
🆔 會員 ID: ${member.id}
📅 加入日期: ${new Date(member.created_at).toLocaleDateString()}
      `.trim();

      await client.replyMessage(event.replyToken, [
        { type: "text", text: userInfo },
        { type: "text", text: "若要修改電話，請輸入「修改電話」" }
      ]);
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 查無您的會員資訊，請嘗試重新加入或聯繫客服。",
      });
    }
  }
}

// === API: 查詢所有會員 ===
app.get("/members", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, phone, line_user_id, created_at FROM members ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("查詢所有會員失敗:", error);
    res.status(500).json({ error: "伺服器錯誤，無法取得會員列表。" });
  }
});

// === API: 查詢單一會員 ===
app.get("/member/:id", async (req, res) => {
  const { id } = req.params;
  const memberResult = await pool.query("SELECT * FROM members WHERE id = $1", [id]);
  const member = memberResult.rows[0];
  if (!member) return res.status(404).json({ error: "會員不存在" });
  res.json(member);
});

// === 啟動伺服器 ===
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
