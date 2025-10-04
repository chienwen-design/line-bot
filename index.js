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

// === 💥 修正後的 Body Parser 💥 ===
app.use(express.json({
  verify: (req, res, buf) => {
    // 將原始 Buffer 存入 req.rawBody 供 LINE SDK 驗證簽章使用
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

// === 資料庫設定 ===
const dbPath = process.env.DATABASE_PATH || "./db/database.db";
const dbDir = path.dirname(path.resolve(dbPath));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 建立資料表
db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT UNIQUE,
  name TEXT,
  phone TEXT,
  qrcode TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

const qrDir = path.resolve("./qrcodes");
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir);
app.use("/qrcodes", express.static(qrDir));
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// === 基本路由 ===
app.get("/", (req, res) => res.send("✅ LINE Webhook + QRCode Server 已啟動"));

// === Webhook 接收 LINE 事件 ===
app.post("/webhook", middleware(config), async (req, res) => {
  console.log(JSON.stringify(req.body, null, 2)); // 🔍 檢查 event 內容
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "follow") {
      await handleFollowEvent(event);
    } else if (event.type === "postback") {
      await handlePostback(event);
    }
  }
});

// === follow 事件：新會員加入 ===
async function handleFollowEvent(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);

  // 若會員不存在就建立
  let member = db.prepare("SELECT * FROM members WHERE line_user_id = ?").get(userId);
  if (!member) {
    const insert = db.prepare("INSERT INTO members (line_user_id, name) VALUES (?, ?)");
    const result = insert.run(userId, profile.displayName);
    const memberId = result.lastInsertRowid;

    // 產生專屬 QRcode
    const memberUrl = `${BASE_URL}/member/${memberId}`;
    const qrFileName = `member_${memberId}.png`;
    const qrFilePath = path.join(qrDir, qrFileName);
    await QRCode.toFile(qrFilePath, memberUrl, { width: 300, margin: 2 });
    const qrCodeUrl = `${BASE_URL}/qrcodes/${qrFileName}`;
    db.prepare("UPDATE members SET qrcode = ? WHERE id = ?").run(qrCodeUrl, memberId);
    member = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  }

  // 回傳 Flex 功能選單
  const flexMenu = createFlexMenu(member.qrcode);
  await client.replyMessage(event.replyToken, flexMenu);
}

// === postback 處理 ===
async function handlePostback(event) {
  const data = event.postback.data;
  if (data === "my_qr") {
    const userId = event.source.userId;
    const member = db.prepare("SELECT * FROM members WHERE line_user_id = ?").get(userId);
    if (member?.qrcode) {
      console.log("回傳會員 QR:", member.qrcode);
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
  }
}

//=== 更新Flex ===
app.get("/sendMenu/:userId", async (req, res) => {
  const userId = req.params.userId;
  const member = db.prepare("SELECT * FROM members WHERE id = ?").get(userId);
  if (!member) return res.status(404).send("找不到會員");
  const flexMenu = createFlexMenu(member.qrcode);
  await client.pushMessage(userId, flexMenu);
  res.send("已推送新版 Flex Menu");
});

// === 建立 Flex 選單 ===
function createFlexMenu(qrUrl) {
  return {
    type: "flex",
    altText: "會員功能選單",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🎯 會員功能選單", weight: "bold", size: "md", align: "center" },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#FF6F61",
                action: { type: "postback", label: "我的專屬QR", data: "my_qr" }
              },
              {
                type: "button",
                style: "primary",
                color: "#2D9CDB",
                action: { type: "uri", label: "查詢會員", uri: `${BASE_URL}/members` }
              },
              {
                type: "button",
                style: "primary",
                color: "#27AE60",
                action: { type: "uri", label: "加入社群", uri: "https://line.me/ti/g2/exampleCommunityLink" }
              }
            ]
          }
        ]
      }
    }
  };
}

// === API: 會員列表 ===
app.get("/members", (req, res) => {
  const members = db.prepare("SELECT * FROM members ORDER BY created_at DESC").all();
  res.json(members);
});

// === API: 單一會員 ===
app.get("/member/:id", (req, res) => {
  const { id } = req.params;
  const member = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
  if (!member) return res.status(404).json({ error: "會員不存在" });
  res.json(member);
});

// === API: 刪除單一會員 ===
app.delete("/member/:id", (req, res) => {
  const { id } = req.params;

  // 1. 檢查會員是否存在並取得資料 (為了刪除 QR Code 檔案)
  const member = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
  if (!member) return res.status(404).json({ error: "會員不存在" });

  try {
    // 2. 執行資料庫刪除
    const deleteStmt = db.prepare("DELETE FROM members WHERE id = ?");
    const result = deleteStmt.run(id);

    // 3. 刪除相關聯的 QR Code 檔案
    if (member.qrcode) {
      // 從完整的 URL 取得檔案名稱 (例如: member_123.png)
      const qrFileName = path.basename(member.qrcode);
      const qrFilePath = path.join(qrDir, qrFileName);

      // 檢查檔案是否存在後再刪除
      if (fs.existsSync(qrFilePath)) {
        fs.unlinkSync(qrFilePath);
        console.log(`已刪除 QR Code 檔案: ${qrFilePath}`);
      }
    }

    if (result.changes > 0) {
      res.json({ message: `會員 ID ${id} 及其 QR Code 檔案已成功刪除。` });
    } else {
      // 理論上前面已檢查過會員存在，此路徑不應被執行
      res.status(500).json({ error: "刪除失敗，資料庫無變動。" });
    }
  } catch (error) {
    console.error("刪除會員時發生錯誤:", error);
    res.status(500).json({ error: "伺服器錯誤，無法刪除會員。" });
  }
});

// === 啟動伺服器 ===
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
