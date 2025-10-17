import express from "express";
import dotenv from "dotenv";
import { Pool } from "pg";
import QRCode from "qrcode";
import { Client, middleware } from "@line/bot-sdk";
import { v2 as cloudinary } from "cloudinary";

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
  console.log("✅ PostgreSQL 資料表初始化完成（members, scan_logs）");
}

// === LINE webhook ===
app.post("/webhook", middleware(config), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "follow") await handleFollowEvent(event);
    else if (event.type === "message") await handleMessageEvent(event);
  }
});

// === 使用者加入 ===
async function handleFollowEvent(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);

  let result = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  let member = result.rows[0];

  if (!member) {
    await pool.query(
      `INSERT INTO members (line_user_id, name, registration_step)
       VALUES ($1, $2, 1)`,
      [userId, profile.displayName]
    );
  }

  await client.replyMessage(event.replyToken, [
    // { type: "text", text: `👋 歡迎加入會員，${profile.displayName}！` },
    { type: "text", text: "請先輸入您的手機號碼（例如：0912345678）以完成第一步。" },
  ]);
}

// === 處理使用者訊息 ===
async function handleMessageEvent(event) {
  const userId = event.source.userId;
  const messageType = event.message.type;

  const result = await pool.query("SELECT * FROM members WHERE line_user_id = $1", [userId]);
  const member = result.rows[0];
  if (!member) return;

  // === 📸 上傳照片階段 ===
  if (messageType === "image") {
    if (member.registration_step === 3) {
      const messageId = event.message.id;
      const stream = await client.getMessageContent(messageId);

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "member_photos",
            public_id: `member_${member.id}_${Date.now()}`,
            resource_type: "image",
          },
          (error, result) => (error ? reject(error) : resolve(result))
        );
        stream.pipe(uploadStream);
      });

      const photoUrl = uploadResult.secure_url;

      await pool.query(
        "UPDATE members SET photo_url=$1, registration_step=0 WHERE line_user_id=$2",
        [photoUrl, userId]
      );

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
        { type: "text", text: "✅ 會員資料建立完成！以下是您的功能選單👇" },
        createFlexMenu(qrUpload.secure_url)
      ]);
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "目前不是上傳照片階段喔～請依照指示操作。",
      });
    }
    return;
  }

  const text = event.message.text.trim();

  // Step 1：輸入手機
  if (member.registration_step === 1) {
    if (/^09\d{8}$/.test(text)) {
      await pool.query(
        "UPDATE members SET phone=$1, registration_step=2 WHERE line_user_id=$2",
        [text, userId]
      );
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "✅ 手機號碼已登錄成功，請輸入您的會員卡號（例如：A123456）。",
      });
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 手機格式錯誤，請重新輸入（例如：0912345678）",
      });
    }
    return;
  }

  // Step 2：輸入會員卡號
  if (member.registration_step === 2) {
    await pool.query(
      "UPDATE members SET card_number=$1, registration_step=3 WHERE line_user_id=$2",
      [text, userId]
    );
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "💳 會員卡號已登錄成功，請上傳一張您的照片（可用於會員識別）。",
    });
    return;
  }

  if (member.registration_step === 3) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "請上傳您的照片（可用於會員識別）。",
    });
    return;
  }

  if (member.registration_step === 0) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ 您已完成會員註冊，可使用主選單功能。",
    });
    return;
  }
}

// === Flex 主選單 ===
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
          {
            type: "button",
            style: "primary",
            color: "#2E86DE",
            action: { type: "uri", label: "我的 QR Code", uri: qrUrl },
          },
          {
            type: "button",
            style: "primary",
            color: "#00B894",
            action: { type: "message", label: "查詢我的資訊", text: "我的資訊" },
          },
        ],
      },
    },
  };
}

// === 會員頁面 (QR Code 掃描用) ===
app.get("/member/:id", async (req, res) => {
  const memberId = req.params.id;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const result = await pool.query("SELECT * FROM members WHERE id=$1", [memberId]);
  const member = result.rows[0];

  if (!member) return res.send(`<h1>⚠️ 查無此會員</h1>`);

  await pool.query(
    "INSERT INTO scan_logs (member_id, member_name, card_number, ip_address) VALUES ($1,$2,$3,$4)",
    [member.id, member.name, member.card_number, ip]
  );

  res.send(`
    <html><body style="text-align:center;padding-top:50px;">
      <h1>✅ 會員驗證成功</h1>
      <p>姓名：${member.name}</p>
      <p>電話：${member.phone}</p>
      <p>會員卡號：${member.card_number}</p>
      <img src="${member.photo_url}" width="200" style="border-radius:10px;margin-top:10px;">
    </body></html>
  `);
});

// === 刷碼紀錄頁面 ===
app.get("/logs", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50"
  );
  const rows = result.rows
    .map(
      (r) => `
        <tr>
          <td>${r.id}</td>
          <td>${r.member_name}</td>
          <td>${r.card_number}</td>
          <td>${new Date(r.scanned_at).toLocaleString()}</td>
          <td>${r.ip_address}</td>
        </tr>`
    )
    .join("");
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

// === 掃碼器頁面（顯示會員照片） ===
app.get("/scanner", (req, res) => {
  res.send(`
    <html>
      <head>
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
          input.addEventListener("keypress",async(e)=>{
            if(e.key==="Enter"){
              const url=input.value.trim();
              if(!url)return;
              resultDiv.innerHTML="⏳ 驗證中...";
              const res=await fetch("/api/check-member?url="+encodeURIComponent(url));
              const data=await res.json();
              if(data.success){
                resultDiv.innerHTML=\`✅ <div class='success'>會員：\${data.name} (\${data.card_number})</div>
                  <img src="\${data.photo_url}" alt="photo">\`;
              }else{
                resultDiv.innerHTML="❌ <span class='error'>"+data.message+"</span>";
              }
              input.value="";
            }
          });
        </script>
      </body>
    </html>
  `);
});

// === API：檢查會員並回傳照片 ===
app.get("/api/check-member", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ success: false, message: "未提供 URL" });
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
  res.json({
    success: true,
    name: member.name,
    card_number: member.card_number,
    photo_url: member.photo_url,
  });
});

// === 啟動伺服器 ===
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
