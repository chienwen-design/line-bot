import express from "express";
import dotenv from "dotenv";
import { Pool } from "pg"; // 💥 替換 SQLite 3 💥
import QRCode from "qrcode";
import { Client, middleware } from "@line/bot-sdk";
import { v2 as cloudinary } from 'cloudinary'; // 💥 新增 Cloudinary 雲端儲存 💥

// 移除 fs 和 path 的 import，因為不再處理本地檔案系統

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === 修正後的 Body Parser (保留，供 LINE SDK 驗證簽章使用) ===
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

// === 💥 PostgreSQL 資料庫設定 💥 ===
// Render 會將連線 URL 注入到 DATABASE_URL 環境變數中
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 對於 Render 環境，通常需要設定 SSL
  ssl: {
    rejectUnauthorized: false
  }
});

// === 💥 Cloudinary 雲端儲存設定 💥 ===
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});


// === 💥 初始化資料庫函式 (用於建立資料表) 💥 ===
async function initializeDatabase() {
  try {
    const client = await pool.connect();
    // 使用 PostgreSQL 語法
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY, -- PostgreSQL 的自動遞增
        line_user_id VARCHAR(255) UNIQUE,
        name VARCHAR(255),
        phone VARCHAR(255),
        qrcode TEXT,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    client.release();
    console.log("✅ PostgreSQL 資料表初始化成功");
  } catch (err) {
    console.error("❌ PostgreSQL 資料表初始化失敗", err);
  }
}

// 移除本地 QR code 資料夾設定

// === 基本路由 ===
app.get("/", (req, res) => res.send("✅ LINE Webhook + QRCode Server 已啟動 (PostgreSQL/Cloudinary)"));

// === Webhook 接收 LINE 事件 ===
// 為了避免重複處理，將兩個 /webhook post 路由合併
app.post("/webhook", middleware(config), async (req, res) => {
  console.log(JSON.stringify(req.body, null, 2)); // 🔍 檢查 event 內容
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "follow") {
      await handleFollowEvent(event);
    } else if (event.type === "postback") {
      await handlePostback(event);
    } else if (event.type === "message" && event.message.text === "我的專屬 QR") {
      // 模擬 postback 行為
      await handlePostback({ ...event, postback: { data: "my_qr" } });
    } else if (event.type === "message" && event.message.text === "我的資訊") {
      // 模擬 postback 行為
      await handlePostback({ ...event, postback: { data: "my_info" } });
    }
  }
});

// === follow 事件：新會員加入 (Async/Await + PostgreSQL + Cloudinary) ===
async function handleFollowEvent(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);

  // 1. 檢查會員是否存在 (PostgreSQL 查詢)
  let memberResult = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  let member = memberResult.rows[0];

  if (!member) {
    // 2. 插入新會員並取得 ID (PostgreSQL 插入)
    const insertResult = await pool.query(
      "INSERT INTO members (line_user_id, name) VALUES ($1, $2) RETURNING id, created_at",
      [userId, profile.displayName]
    );
    const memberId = insertResult.rows[0].id;

    // 3. 產生專屬 QRcode 的 URL
    const memberUrl = `${BASE_URL}/member/${memberId}`;
    const qrCodeBuffer = await QRCode.toBuffer(memberUrl, { width: 300, margin: 2 });
    
    // 💥 上傳到 Cloudinary 💥
    const uploadResult = await new Promise((resolve, reject) => {
        // 使用 upload_stream 上傳 Buffer，不需儲存到本地
        cloudinary.uploader.upload_stream({
            folder: "line_qrcodes", // 設定資料夾
            public_id: `member_${memberId}` // 設定公開 ID
        }, (error, result) => {
            if (error) reject(error);
            resolve(result);
        }).end(qrCodeBuffer);
    });

    const qrCodeUrl = uploadResult.secure_url;

    // 4. 更新資料庫的 qrcode 欄位 (PostgreSQL 更新)
    await pool.query("UPDATE members SET qrcode = $1 WHERE id = $2 RETURNING *", [qrCodeUrl, memberId]);
    
    // 重新取得完整的 member 資料
    memberResult = await pool.query("SELECT * FROM members WHERE id = $1", [memberId]);
    member = memberResult.rows[0];
  }

  // 回傳 Flex 功能選單
  const flexMenu = createFlexMenu(member.qrcode);
  await client.replyMessage(event.replyToken, flexMenu);
}

// === postback 處理 (新增 my_info 邏輯) ===
async function handlePostback(event) {
  const data = event.postback.data;
  const userId = event.source.userId;

  // PostgreSQL 查詢
  const memberResult = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  const member = memberResult.rows[0];

  if (data === "my_qr") {
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
  } else if (data === "my_info") { // 💥 處理 "我的資訊" postback 💥
    if (member) {
      // 構建一個簡單的文字回覆
      const userInfo = `
【我的會員資訊】
📝 姓名: ${member.name || '未設定'}
📞 電話: ${member.phone || '未設定'}
🆔 會員 ID: ${member.id}
📅 加入日期: ${new Date(member.created_at).toLocaleDateString()}
      `.trim();
      
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: userInfo,
      });
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 查無您的會員資訊，請嘗試重新加入或聯繫客服。",
      });
    }
  }
}

//=== 更新Flex (PostgreSQL) ===
app.get("/sendMenu/:userId", async (req, res) => {
  const userId = req.params.userId;
  const memberResult = await pool.query("SELECT * FROM members WHERE id = $1", [userId]);
  const member = memberResult.rows[0];

  if (!member) return res.status(404).send("找不到會員");
  const flexMenu = createFlexMenu(member.qrcode);
  // 注意：這裡的 userId 應該是 Line 的 userId，不是 member.id。
  // 為了程式碼的健壯性，我們用 line_user_id 來 push message
  await client.pushMessage(member.line_user_id, flexMenu); 
  res.send("已推送新版 Flex Menu");
});

// === 建立 Flex 選單 (按鈕改為我的資訊) ===
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
                action: { type: "postback", label: "我的QR", data: "my_qr" }
              },
              {
                type: "button",
                style: "primary",
                color: "#2D9CDB",
                // 💥 查詢會員改為查詢個人的 Postback 💥
                action: { type: "postback", label: "我的資訊", data: "my_info" } 
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

// === API: 會員列表 (已移除，避免公開查詢所有會員) ===

// === API: 單一會員 (PostgreSQL) ===
app.get("/member/:id", async (req, res) => {
  const { id } = req.params;
  const memberResult = await pool.query("SELECT * FROM members WHERE id = $1", [id]);
  const member = memberResult.rows[0];
  if (!member) return res.status(404).json({ error: "會員不存在" });
  res.json(member);
});

// === API: 刪除單一會員 (PostgreSQL + Cloudinary 刪除) ===
app.delete("/member/:id", async (req, res) => {
  const { id } = req.params;

  // 1. 檢查會員是否存在並取得資料 
  const memberResult = await pool.query("SELECT * FROM members WHERE id = $1", [id]);
  const member = memberResult.rows[0];
  if (!member) return res.status(404).json({ error: "會員不存在" });

  try {
    // 2. 刪除 Cloudinary 上的 QR Code 檔案 (如果存在)
    if (member.qrcode) {
        // 假設 public_id 格式為 line_qrcodes/member_ID
        const publicId = `line_qrcodes/member_${id}`; 
        await cloudinary.uploader.destroy(publicId);
        console.log(`已刪除 Cloudinary 上的 QR Code: ${publicId}`);
    }

    // 3. 執行資料庫刪除 (PostgreSQL)
    const deleteResult = await pool.query("DELETE FROM members WHERE id = $1", [id]);

    if (deleteResult.rowCount > 0) {
      res.json({ message: `會員 ID ${id} 及其 QR Code 檔案已成功刪除。` });
    } else {
      res.status(500).json({ error: "刪除失敗，資料庫無變動。" });
    }
  } catch (error) {
    console.error("刪除會員時發生錯誤:", error);
    res.status(500).json({ error: "伺服器錯誤，無法刪除會員或檔案。" });
  }
});

// === 啟動伺服器 ===
// 啟動前先初始化資料庫
initializeDatabase().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});