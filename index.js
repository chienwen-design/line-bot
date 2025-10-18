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
      selected: false,
      name: "會員主選單",
      chatBarText: "會員功能",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: "postback", data: "my_qr" },
        },
        {
          bounds: { x: 834, y: 0, width: 833, height: 843 },
          action: { type: "postback", data: "my_info" },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: {  type: "postback", data: "edit_info" },
        },
      ],
    };

    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ 已建立 Rich Menu:", richMenuId);

    if (fs.existsSync("./richmenu.png")) {
      await client.setRichMenuImage(richMenuId, fs.createReadStream("./richmenu.png"));
      console.log("🖼️ Rich Menu 圖像上傳成功");
    } else {
      console.warn("⚠️ 找不到 richmenu.png，請確認檔案存在根目錄");
    }

    await client.setDefaultRichMenu(richMenuId);
    console.log("🚀 已設定為預設 Rich Menu");
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

// === Follow 事件：自動建立會員 ===
async function handleFollow(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);
  const result = await pool.query("SELECT * FROM members WHERE line_user_id=$1", [userId]);
  if (result.rows.length === 0) {
    await pool.query(
      "INSERT INTO members (line_user_id, name, registration_step) VALUES ($1,$2,1)",
      [userId, profile.displayName]
    );
  }
  await client.replyMessage(event.replyToken, [
   // { type: "text", text: `👋 歡迎加入會員，${profile.displayName}！` },
    { type: "text", text: "請輸入您的手機號碼（例如：0912345678）開始註冊。" },
  ]);
}

// === Postback 處理（Rich Menu） ===
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
          hero: {
            type: "image",
            url: member.photo_url || "https://cdn-icons-png.flaticon.com/512/149/149071.png",
            size: "full",
            aspectRatio: "1:1",
            aspectMode: "cover",
          },
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
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "請輸入要修改的項目：手機 / 卡號 / 照片",
    });
  }
}

// === Message 處理 ===
async function handleMessage(event) {
  const userId = event.source.userId;
  const msgType = event.message.type;
  const msgText = event.message.text?.trim();
  const result = await pool.query("SELECT * FROM members WHERE line_user_id=$1", [userId]);
  const member = result.rows[0];
  // 手動指令: 若使用者輸入「重新註冊」
  if (msgText === "重新註冊") {
    await pool.query("UPDATE members SET registration_step=1 WHERE line_user_id=$1", [userId]);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "🔄 已重新開始註冊，請輸入您的手機號碼：",
    });
    return;
  }
  if (!member) return;



  // 查詢「我的資訊」
  if (msgType === "text" && msgText === "我的資訊") {
    await handlePostback({ source: { userId }, postback: { data: "my_info" }, replyToken: event.replyToken });
    return;
  }

  // === 上傳照片 ===
  if (msgType === "image" && member.registration_step === 3) {
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

    const memberUrl = `${BASE_URL}/member/${member.id}`;
    const qrBuffer = await QRCode.toBuffer(memberUrl, { width: 300, margin: 2 });
    const qrUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: "line_qrcodes", public_id: `member_${member.id}` },
        (err, result) => (err ? reject(err) : resolve(result))
      ).end(qrBuffer);
    });

    await pool.query("UPDATE members SET qrcode=$1 WHERE id=$2", [qrUpload.secure_url, member.id]);
    await client.replyMessage(event.replyToken, [
      { type: "text", text: "📸 照片上傳成功！" },
      { type: "text", text: "✅ 註冊完成，以下是您的主選單👇" },
      createFlexMenu(qrUpload.secure_url),
    ]);
    return;
  }

// === 註冊階段控制 ===
if (member.registration_step === 1) {
  if (/^09\d{8}$/.test(msgText)) {
    // ✅ 正確手機格式
    await pool.query("UPDATE members SET phone=$1, registration_step=2 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "📱 手機號碼已登錄成功，請輸入您的會員卡號（例如：A123456）" });
  } else {
    await client.replyMessage(event.replyToken, { type: "text", text: "❌ 手機號格式不正確，請重新輸入（例如：0912345678）" });
  }
  return;
}

if (member.registration_step === 2) {
  // 卡號可用英數混合
  if (/^[A-Za-z0-9]{5,}$/.test(msgText)) {
    await pool.query("UPDATE members SET card_number=$1, registration_step=3 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "💳 會員卡號已登錄成功，請上傳您的照片以完成註冊。" });
  } else {
    await client.replyMessage(event.replyToken, { type: "text", text: "❌ 卡號格式不正確，請重新輸入（例如：A123456）" });
  }
  return;
}

if (member.registration_step === 3) {
  if (msgType === "image") {
    // ✅ 照片上傳流程（同你目前程式）
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

    // 產生 QR Code
    const memberUrl = `${BASE_URL}/member/${member.id}`;
    const qrBuffer = await QRCode.toBuffer(memberUrl, { width: 300, margin: 2 });
    const qrUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: "line_qrcodes", public_id: `member_${member.id}` },
        (err, result) => (err ? reject(err) : resolve(result))
      ).end(qrBuffer);
    });

    await pool.query("UPDATE members SET qrcode=$1, registration_step=0 WHERE id=$2", [qrUpload.secure_url, member.id]);
    await client.replyMessage(event.replyToken, [
      { type: "text", text: "📸 照片上傳成功！" },
      { type: "text", text: "✅ 註冊完成！以下是您的 QR Code 👇" },
      {
        type: "image",
        originalContentUrl: qrUpload.secure_url,
        previewImageUrl: qrUpload.secure_url,
      },
    ]);
  } else {
    // 🚫 若還沒上傳照片就亂輸入文字
    await client.replyMessage(event.replyToken, { type: "text", text: "請上傳您的照片以完成註冊。" });
  }
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
    await client.replyMessage(event.replyToken, { type: "text", text: "請輸入：手機 / 卡號 / 照片" });
    return;
  }

  // === 修改手機 ===
  if (member.registration_step === 11 && /^09\d{8}$/.test(msgText)) {
    await pool.query("UPDATE members SET phone=$1, registration_step=0 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 手機號碼已更新！" });
    return;
  }

  // === 修改卡號 ===
  if (member.registration_step === 12) {
    await pool.query("UPDATE members SET card_number=$1, registration_step=0 WHERE line_user_id=$2", [msgText, userId]);
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 會員卡號已更新！" });
    return;
  }

  // === 修改照片 ===
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
    await client.replyMessage(event.replyToken, { type: "text", text: "📸 新照片已更新完成！" });
    return;
  }

}

// === 主選單 Flex ===
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
          { type: "text", text: "🎯 會員功能選單", weight: "bold", align: "center" },
          { type: "button", style: "primary", color: "#2E86DE", action: { type: "uri", label: "我的 QR Code", uri: qrUrl } },
          { type: "button", style: "primary", color: "#00B894", action: { type: "message", label: "查詢我的資訊", text: "我的資訊" } },
        ],
      },
    },
  };
}

// === 掃碼頁面（含語音播報 + 照片） ===
app.get("/scanner", (req, res) => {
  res.send(`
    <html><head>
      <meta charset="utf-8"><title>會員掃碼驗證</title>
      <style>
        body{font-family:'Noto Sans TC';text-align:center;background:#f9f9f9;padding-top:80px;}
        input{width:80%;font-size:20px;padding:10px;}
        .result{margin-top:30px;font-size:24px;}
        .success{color:#2e7d32;}
        .error{color:#c62828;}
        img{margin-top:15px;border-radius:10px;max-width:180px;}
      </style>
    </head>
    <body>
      <h1>📷 會員掃碼驗證</h1>
      <p>請將游標放在輸入框內，使用掃碼槍掃描 QR Code</p>
      <input id="scannerInput" placeholder="請掃描 QR Code..." autofocus />
      <div id="result" class="result"></div>
      <script>
        const input=document.getElementById("scannerInput");
        const resultDiv=document.getElementById("result");
        const speak=(text)=>{
          const msg=new SpeechSynthesisUtterance(text);
          msg.lang='zh-TW';
          msg.rate=1.0;
          speechSynthesis.speak(msg);
        };
        input.addEventListener("keypress",async(e)=>{
          if(e.key==="Enter"){
            const url=input.value.trim();
            if(!url)return;
            resultDiv.innerHTML="⏳ 驗證中...";
            const res=await fetch("/api/check-member?url="+encodeURIComponent(url));
            const data=await res.json();
            if(data.success){
              resultDiv.innerHTML=\`✅ <div class='success'>會員：\${data.name} (\${data.card_number})</div><img src="\${data.photo_url}" alt="photo">\`;
              speak("會員通過");
            }else{
              resultDiv.innerHTML="❌ <span class='error'>"+data.message+"</span>";
              speak("非會員，拒絕通過");
            }
            input.value="";
          }
        });
      </script>
    </body></html>
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
  if (!member) return res.json({ success: false, message: "查無會員" });
  await pool.query(
    "INSERT INTO scan_logs (member_id, member_name, card_number, ip_address) VALUES ($1,$2,$3,$4)",
    [member.id, member.name, member.card_number, ip]
  );
  res.json({ success: true, name: member.name, card_number: member.card_number, photo_url: member.photo_url });
});

// === /logs 頁面 ===
app.get("/logs", async (req, res) => {
  const result = await pool.query("SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50");
  const rows = result.rows.map(
    (r) => `<tr><td>${r.id}</td><td>${r.member_name}</td><td>${r.card_number}</td><td>${new Date(r.scanned_at).toLocaleString()}</td><td>${r.ip_address}</td></tr>`
  ).join("");
  res.send(`
    <html><head><meta charset="utf-8"><title>刷碼紀錄</title>
    <style>
      body{font-family:'Noto Sans TC';background:#f4f6f8;padding:40px;}
      h1{text-align:center;color:#2e7d32;}
      table{width:100%;border-collapse:collapse;background:white;}
      th,td{padding:10px;border-bottom:1px solid #ddd;text-align:center;}
      th{background:#81c784;color:white;}
      tr:hover{background:#f1f8e9;}
    </style></head>
    <body>
      <h1>📋 最近 50 筆刷碼紀錄</h1>
      <table>
        <tr><th>ID</th><th>姓名</th><th>卡號</th><th>刷碼時間</th><th>IP 位址</th></tr>
        ${rows || "<tr><td colspan='5'>尚無紀錄</td></tr>"}
      </table>
    </body></html>
  `);
});

// === 啟動伺服器 ===
initializeDatabase().then(async () => {
  await setupRichMenu();
  // === 啟動伺服器 ===
initializeDatabase().then(async () => {
  await setupRichMenu();

  // 🔹 定期檢查未完成註冊的會員，超過24小時則重設
  setInterval(async () => {
    try {
      await pool.query(`
        UPDATE members
        SET registration_step = 1
        WHERE registration_step BETWEEN 1 AND 3
          AND created_at < NOW() - INTERVAL '24 HOURS'
      `);
      console.log("🕒 已自動重設超時未完成註冊的會員資料。");
    } catch (err) {
      console.error("❌ 自動重設註冊狀態失敗：", err);
    }
  }, 1000 * 60 * 60); // 每小時執行一次

  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});

