import express from "express";
import dotenv from "dotenv";
import { Pool } from "pg";
import QRCode from "qrcode";
import { Client, middleware } from "@line/bot-sdk";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === LINE Bot 設定 ===
const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};
const client = new Client(config);

// === Cloudinary 設定 ===
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// === PostgreSQL 設定 ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BASE_URL = process.env.PUBLIC_BASE_URL;

// === 初始化資料庫 ===
async function initializeDatabase() {
  const client = await pool.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      line_user_id VARCHAR(255) UNIQUE,
      name VARCHAR(255),
      phone VARCHAR(50),
      card_number VARCHAR(100),
      qrcode TEXT,
      photo_url TEXT,
      registration_step INTEGER DEFAULT 1,
      last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id SERIAL PRIMARY KEY,
      member_id INTEGER REFERENCES members(id),
      member_name VARCHAR(255),
      card_number VARCHAR(100),
      scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(100)
    );
  `);
  client.release();
  console.log("✅ PostgreSQL 資料表初始化完成");
}

// === Rich Menu 自動建立 ===
async function setupRichMenu() {
  try {
    const menus = await client.getRichMenuList();
    if (menus.length > 0) {
      console.log("🟢 已存在 Rich Menu，略過建立");
      return;
    }
    const richMenu = {
      size: { width: 2500, height: 843 },
      selected: false, // 預設縮起來
      name: "會員主選單",
      chatBarText: "會員功能",
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "postback", data: "my_qr" } },
        { bounds: { x: 834, y: 0, width: 833, height: 843 }, action: { type: "postback", data: "my_info" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "postback", data: "edit_info" } },
      ],
    };

    const richMenuId = await client.createRichMenu(richMenu);
    if (fs.existsSync("./richmenu.png")) {
      await client.setRichMenuImage(richMenuId, fs.createReadStream("./richmenu.png"));
      console.log("🖼️ Rich Menu 圖像上傳成功");
    }
    await client.setDefaultRichMenu(richMenuId);
    console.log("✅ 已設定預設 Rich Menu");
  } catch (err) {
    console.error("❌ Rich Menu 建立失敗:", err);
  }
}

// === Webhook 主入口 ===
app.post("/webhook", middleware(config), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    if (event.type === "follow") await handleFollow(event);
    else if (event.type === "message") await handleMessage(event);
    else if (event.type === "postback") await handlePostback(event);
  }
});

// === Follow 事件 ===
async function handleFollow(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);
  const result = await pool.query("SELECT * FROM members WHERE line_user_id=$1", [userId]);
  if (result.rows.length === 0) {
    await pool.query("INSERT INTO members (line_user_id, name, registration_step) VALUES ($1,$2,1)", [userId, profile.displayName]);
  } 

  await client.replyMessage(event.replyToken, [
    { type: "text", text: `👋 歡迎加入會員，${profile.displayName}！` },
    { type: "text", text: "請輸入您的手機號碼（例如：0912345678）開始註冊。" },
  ]);
}

// === Postback 事件 ===
async function handlePostback(event) {
  const userId = event.source.userId;
  const data = event.postback.data;
  const result = await pool.query("SELECT * FROM members WHERE line_user_id=$1", [userId]);
  const member = result.rows[0];
  if (!member) return;

  if (data === "my_qr") {
    if (member.qrcode) {
      await client.replyMessage(event.replyToken, {
        type: "image",
        originalContentUrl: member.qrcode,
        previewImageUrl: member.qrcode,
      });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: "⚠️ 尚未完成註冊，沒有 QR Code。" });
    }
  }

  if (data === "my_info") {
    if (member.registration_step === 0) {
      await client.replyMessage(event.replyToken, {
        type: "flex",
        altText: "我的會員資料",
        contents: {
          type: "bubble",
          hero: { type: "image", url: member.photo_url || "https://cdn-icons-png.flaticon.com/512/149/149071.png", size: "full" },
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: `姓名：${member.name}` },
              { type: "text", text: `電話：${member.phone}` },
              { type: "text", text: `卡號：${member.card_number}` },
            ],
          },
        },
      });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: "⚠️ 您尚未完成註冊。" });
    }
  }

  if (data === "edit_info") {
    await pool.query("UPDATE members SET registration_step=10 WHERE line_user_id=$1", [userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "請輸入要修改的項目：手機 / 卡號 / 照片" });
  }
}

// === Message 事件 ===
async function handleMessage(event) {
  const userId = event.source.userId;
  const msgType = event.message.type;
  const msgText = event.message.text?.trim();
  if (msgType !== "text" && msgType !== "image") return;

  // 手動重新註冊
  if (msgType === "text" && msgText === "重新註冊") {
    const result = await pool.query("SELECT * FROM members WHERE line_user_id=$1", [userId]);
    if (result.rows.length === 0) return;
    await pool.query("UPDATE members SET phone=NULL, card_number=NULL, photo_url=NULL, qrcode=NULL, registration_step=1 WHERE line_user_id=$1", [userId]);
    await client.replyMessage(event.replyToken, [
      { type: "text", text: "🔄 已重新開始註冊流程！" },
	  { type: "text", text: "請依照順序輸入資料（手機 → 卡號 → 照片）" },
      { type: "text", text: "請輸入您的手機號碼（例如：0912345678）" },
    ]);
    return;
  }

  const result = await pool.query("SELECT * FROM members WHERE line_user_id=$1", [userId]);
  const member = result.rows[0];
  if (!member) return;
  await pool.query("UPDATE members SET last_active=NOW() WHERE line_user_id=$1", [userId]);

  // === 註冊流程 ===
  if (member.registration_step === 1 && /^09\d{8}$/.test(msgText)) {
    await pool.query("UPDATE members SET phone=$1, registration_step=2 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "📱 手機號碼已登錄成功，請輸入您的會員卡號（例如：A123456）" });
    return;
  }
  if (member.registration_step === 2) {
    if (/^[A-Za-z0-9]{5,}$/.test(msgText)) {
      await pool.query("UPDATE members SET card_number=$1, registration_step=3 WHERE line_user_id=$2", [msgText, userId]);
      await client.replyMessage(event.replyToken, { type: "text", text: "💳 會員卡號已登錄成功，請上傳您的照片以完成註冊。" });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: "❌ 卡號格式不正確，請重新輸入（例如：A123456）" });
    }
    return;
  }
  if (member.registration_step === 3 && msgType === "image") {
    const messageId = event.message.id;
    const stream = await client.getMessageContent(messageId);
    const upload = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "member_photos", public_id: `member_${member.id}_${Date.now()}` },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.pipe(uploadStream);
    });
    const photoUrl = upload.secure_url;
    await pool.query("UPDATE members SET photo_url=$1 WHERE line_user_id=$2", [photoUrl, userId]);
    const memberUrl = `${BASE_URL}/member/${member.id}`;
    const qrBuffer = await QRCode.toBuffer(memberUrl, { width: 300, margin: 2 });
    const qrUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: "line_qrcodes", public_id: `member_${member.id}`, overwrite: true },
        (err, result) => (err ? reject(err) : resolve(result))
      ).end(qrBuffer);
    });
    await pool.query("UPDATE members SET qrcode=$1, registration_step=0 WHERE id=$2", [qrUpload.secure_url, member.id]);
    await client.replyMessage(event.replyToken, [
      { type: "text", text: "📸 照片上傳成功！" },
      { type: "text", text: "✅ 註冊完成，以下是您的會員 QR Code 👇" },
      { type: "image", originalContentUrl: qrUpload.secure_url, previewImageUrl: qrUpload.secure_url },
    ]);
    return;
  }

  // === 修改資料流程 ===
  if (member.registration_step === 10) {
    if (msgText.includes("手機")) {
      await pool.query("UPDATE members SET registration_step=11 WHERE line_user_id=$1", [userId]);
      await client.replyMessage(event.replyToken, { type: "text", text: "請輸入新的手機號碼：" });
      return;
    }
    if (msgText.includes("卡號")) {
      await pool.query("UPDATE members SET registration_step=12 WHERE line_user_id=$1", [userId]);
      await client.replyMessage(event.replyToken, { type: "text", text: "請輸入新的會員卡號：" });
      return;
    }
    if (msgText.includes("照片")) {
      await pool.query("UPDATE members SET registration_step=13 WHERE line_user_id=$1", [userId]);
      await client.replyMessage(event.replyToken, { type: "text", text: "請上傳新的會員照片。" });
      return;
    }
  }
  if (member.registration_step === 11 && /^09\d{8}$/.test(msgText)) {
    await pool.query("UPDATE members SET phone=$1, registration_step=0 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 手機號碼已更新！" });
    return;
  }
  if (member.registration_step === 12) {
    await pool.query("UPDATE members SET card_number=$1, registration_step=0 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 會員卡號已更新！" });
    return;
  }
  if (member.registration_step === 13 && msgType === "image") {
    const messageId = event.message.id;
    const stream = await client.getMessageContent(messageId);
    const upload = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "member_photos", public_id: `member_${member.id}_${Date.now()}` },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.pipe(uploadStream);
    });
    const photoUrl = upload.secure_url;
    await pool.query("UPDATE members SET photo_url=$1, registration_step=0 WHERE line_user_id=$2", [photoUrl, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "📸 照片已更新完成！" });
    return;
  }
}

// === 掃碼頁面 ===
app.get("/scanner", (req, res) => {
  res.send(`
<html>
<head>
<meta charset="utf-8">
<title>會員掃碼驗證</title>
<style>
body {
  font-family: 'Noto Sans TC', sans-serif;
  text-align: center;
  background: #f8f9fa;
  padding-top: 60px;
}
input {
  font-size: 20px;
  padding: 10px;
  width: 80%;
  border: 1px solid #ccc;
  border-radius: 8px;
}
#result {
  margin-top: 40px;
  font-size: 20px;
}
.member-card {
  display: inline-block;
  padding: 20px;
  border-radius: 16px;
  background: white;
  box-shadow: 0 0 10px rgba(0,0,0,0.1);
}
.member-card img {
  width: 150px;
  height: 150px;
  border-radius: 50%;
  object-fit: cover;
  margin-top: 10px;
}
.fade-out {
  opacity: 0;
  transition: opacity 1s ease-out;
}
</style>
</head>
<body>
  <h1>📷 會員掃碼驗證</h1>
  <p>請掃描 QR Code（或輸入網址後按 Enter）</p>
  <input id="scannerInput" autofocus />
  <div id="result"></div>

<script>
const input = document.getElementById("scannerInput");
const result = document.getElementById("result");

// 語音播報
const speak = (text) => {
  const msg = new SpeechSynthesisUtterance(text);
  msg.lang = 'zh-TW';
  speechSynthesis.speak(msg);
};

// 顯示結果
const showResult = (html, speakText, autoClear = true) => {
  result.innerHTML = html;
  if (speakText) speak(speakText);

  // ✅ 自動 5 秒清空畫面
  if (autoClear) {
    setTimeout(() => {
      result.classList.add("fade-out");
      setTimeout(() => {
        result.innerHTML = "";
        result.classList.remove("fade-out");
      }, 1000);
    }, 5000);
  }
};

input.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    const url = input.value.trim();
    input.value = "";
    showResult("⏳ 驗證中...", null, false);

    try {
      const res = await fetch("/api/check-member?url=" + encodeURIComponent(url));
      const data = await res.json();

      if (data.success) {
        showResult(
          \`
          <div class="member-card">
            <h2>✅ 會員通過</h2>
            <p><strong>\${data.name}</strong></p>
            <p>卡號：\${data.card_number}</p>
            <img src="\${data.photo_url || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" alt="會員照片" />
          </div>
          \`,
          \`會員 \${data.name} 通過\`
        );
      } else {
        showResult("<h2 style='color:red;'>❌ " + data.message + "</h2>", "非會員，拒絕通過");
      }
    } catch (err) {
      showResult("<h2 style='color:red;'>伺服器錯誤</h2>", "系統錯誤");
    }
  }
});
</script>
</body>
</html>
`);
});



// === API: 掃碼驗證 ===
app.get("/api/check-member", async (req, res) => {
  const { url } = req.query;
  const match = url.match(/\/member\/(\d+)/);
  if (!match) return res.json({ success: false, message: "無效 QR Code" });
  const id = match[1];
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const result = await pool.query("SELECT * FROM members WHERE id=$1", [id]);
  const member = result.rows[0];
  if (!member) return res.json({ success: false, message: "查無會員，請先掃QR碼加入..." });
  await pool.query("INSERT INTO scan_logs (member_id, member_name, card_number, ip_address) VALUES ($1,$2,$3,$4)", [member.id, member.name, member.card_number, ip]);
  res.json({ success: true, name: member.name, card_number: member.card_number, photo_url: member.photo_url });
});

// === /logs 頁面 ===
app.get("/logs", async (req, res) => {
  const result = await pool.query("SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50");
  const rows = result.rows.map(r => `<tr><td>${r.id}</td><td>${r.member_name}</td><td>${r.card_number}</td><td>${new Date(r.scanned_at).toLocaleString()}</td><td>${r.ip_address}</td></tr>`).join("");
  res.send(`<html><head><meta charset="utf-8"><style>table{border-collapse:collapse;width:100%;}th,td{padding:10px;border:1px solid #ddd;}</style></head><body><h2>📋 最近50筆刷碼紀錄</h2><table><tr><th>ID</th><th>姓名</th><th>卡號</th><th>時間</th><th>IP</th></tr>${rows}</table></body></html>`);
});

// === 定期重設未完成註冊 ===
setInterval(async () => {
  await pool.query("UPDATE members SET registration_step=1 WHERE registration_step BETWEEN 1 AND 3 AND last_active < NOW() - INTERVAL '24 HOURS'");
  console.log("🕒 自動重設超時未完成註冊的會員");
}, 1000 * 60 * 60);

// === 啟動 ===
initializeDatabase().then(async () => {
  await setupRichMenu();
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
