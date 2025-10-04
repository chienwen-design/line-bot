import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { Client, middleware } from "@line/bot-sdk";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === 基本設定 ===
const BASE_URL = process.env.PUBLIC_BASE_URL || "https://f47d55e98170.ngrok-free.app";
const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const client = new Client(config);

// === 資料庫設定 ===
const dbPath = process.env.DATABASE_PATH || "./db/database.db";
// 確保資料庫目錄存在
const dbDir = path.dirname(path.resolve(dbPath));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
// 初始化資料表（若不存在則建立）
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  qrcode TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// 確保 qrcodes 資料夾存在
const qrDir = path.resolve("./qrcodes");
if (!fs.existsSync(qrDir)) {
  fs.mkdirSync(qrDir);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/qrcodes", express.static(qrDir)); // 讓 qrcodes 資料夾能被公開存取

// 首頁
app.get("/", (req, res) => {
  res.send("✅ Webhook + QRCode Server 已啟動");
});

// 註冊頁（GET）- 簡易表單
app.get("/register", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>會員註冊</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Noto Sans TC, Arial; padding: 24px; line-height: 1.6; }
    .card { border: 1px solid #eee; border-radius: 8px; padding: 16px; max-width: 520px; }
    label { display: block; margin-top: 12px; }
    input, button { font: inherit; padding: 8px 10px; width: 100%; box-sizing: border-box; }
    button { margin-top: 16px; }
    .hint { color: #666; font-size: 14px; }
  </style>
  </head>
  <body>
    <div class="card">
      <h2>會員註冊</h2>
      <form method="POST" action="/register">
        <label>姓名
          <input type="text" name="name" required />
        </label>
        <label>電話
          <input type="text" name="phone" required />
        </label>
        <button type="submit">送出</button>
      </form>
      <p class="hint">此表單以 application/x-www-form-urlencoded 送出，伺服器已支援。</p>
    </div>
  </body>
</html>
  `);
});

// Webhook 健康檢查（GET）
app.get("/webhook", (req, res) => {
  res.send("Webhook endpoint OK. 請以 POST 並附上 JSON 呼叫此路徑。");
});

// Webhook 接收訊息（POST）- 修正版本
app.post("/webhook", (req, res) => {
  // 將整個請求體作為內容（content）記錄
  // 這樣即使是 LINE 驗證請求，因為 req.body 是一個物件，它也會被記錄，且不會觸發 400 錯誤。
  const webhookBody = req.body;

  // 1. 立即回傳 200 OK
  // 這是滿足 LINE Webhook 驗證和避免超時的關鍵步驟。
  res.sendStatus(200); // 這是 express 中回傳 200 OK 的簡潔方式

  // 2. 處理/記錄訊息 (放在 res.sendStatus(200) 之後)
  // 檢查是否是 LINE 格式，如果是，再進行資料庫操作
  if (webhookBody && Array.isArray(webhookBody.events)) {
    // 這裡通常是處理真正的 LINE 訊息的地方

    // 為了符合您原本的資料庫結構，我們將整個 JSON 轉成字串存入
    const messageContent = JSON.stringify(webhookBody);

    try {
      // 記錄到資料庫（非同步操作應在回傳 200 後進行）
      db.prepare("INSERT INTO messages (content) VALUES (?)").run(messageContent);
      console.log(`✅ Received and stored LINE Webhook: ${webhookBody.events.length} events.`);
    } catch (error) {
      console.error("❌ Database error after responding 200:", error);
    }

  } else {
    // 處理非 LINE 格式的請求 (可能是您自己的測試，或其他的 Webhook)
    console.log("⚠️ Received non-LINE-standard Webhook body:", webhookBody);

    // 如果您堅持要記錄原本的單一 'message' 參數，可以這樣處理：
    if (webhookBody && webhookBody.message) {
      db.prepare("INSERT INTO messages (content) VALUES (?)").run(webhookBody.message);
      console.log(`✅ Stored custom message: ${webhookBody.message}`);
    }
  }

  // 注意：因為已經回傳 res.sendStatus(200)，後續的程式碼只是在背景執行，不會影響回傳狀態碼。
});

// 查詢所有訊息
app.get("/messages", (req, res) => {
  const messages = db.prepare("SELECT * FROM messages ORDER BY created_at DESC").all();
  res.json(messages);
});

// 新增會員並產生 QRCode (輸出 PNG 檔案)
app.post("/register", async (req, res) => {
  const { name, phone } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: "缺少 name 或 phone" });
  }

  try {
    // 檢查是否已存在
    const exists = db.prepare("SELECT * FROM members WHERE phone = ?").get(phone);
    if (exists) {
      return res.status(400).json({ error: "該會員已存在" });
    }

    // 插入會員資料
    const insert = db.prepare("INSERT INTO members (name, phone) VALUES (?, ?)");
    const result = insert.run(name, phone);

    const memberId = result.lastInsertRowid;
    const memberUrl = `${BASE_URL}/member/${memberId}`;  // QRCode 內容

    // 設定 QRCode 圖檔路徑
    const qrFileName = `member_${memberId}.png`;
    const qrFilePath = path.join(qrDir, qrFileName);

    // 產生 QRCode 並存成 PNG 檔案
    await QRCode.toFile(qrFilePath, memberUrl, {
      width: 300,
      margin: 2
    });

    // 更新 DB (存檔案路徑)
    const qrCodeUrl = `/qrcodes/${qrFileName}`;
    db.prepare("UPDATE members SET qrcode = ? WHERE id = ?").run(qrCodeUrl, memberId);

    res.json({
      success: true,
      memberId,
      name,
      phone,
      qrcode: `${BASE_URL}${qrCodeUrl}` // ✅ 建議回傳完整網址
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "新增會員失敗" });
  }
});

// 查詢所有會員
app.get("/members", (req, res) => {
  const members = db.prepare("SELECT * FROM members ORDER BY created_at DESC").all();
  res.json(members);
});

// 查詢單一會員 (含 QRCode URL)
app.get("/member/:id", (req, res) => {
  const { id } = req.params;
  const member = db.prepare("SELECT * FROM members WHERE id = ?").get(id);

  if (!member) return res.status(404).json({ error: "會員不存在" });

  res.json(member);
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
