import express from "express";
import dotenv from "dotenv";
import { Pool } from "pg";
import QRCode from "qrcode";
import { Client, middleware } from "@line/bot-sdk";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// === 基本設定 ===
const BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://example.ngrok-free.app";
const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};
const client = new Client(config);

// === PostgreSQL 設定 ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Cloudinary 設定 ===
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// === 初始化資料庫 ===
async function initializeDatabase() {
  try {
    const client = await pool.connect();

    // === 會員表 ===
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        line_user_id VARCHAR(255) UNIQUE,
        name VARCHAR(255),
        phone VARCHAR(255),
        qrcode TEXT,
        waiting_for_phone BOOLEAN DEFAULT FALSE,
        pending_phone VARCHAR(255),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // === 刷碼紀錄表 ===
    await client.query(`
      CREATE TABLE IF NOT EXISTS scan_logs (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id),
        member_name VARCHAR(255),
        scanned_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(100)
      );
    `);

    client.release();
    console.log("✅ PostgreSQL 資料表初始化成功（members, scan_logs）");
  } catch (err) {
    console.error("❌ PostgreSQL 資料表初始化失敗", err);
  }
}

app.get("/", (req, res) =>
  res.send("✅ LINE + Cloudinary + 掃碼系統 已啟動")
);

// === Webhook 主邏輯 ===
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

// === follow 事件 ===
async function handleFollowEvent(event) {
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);

  let memberResult = await pool.query(
    "SELECT * FROM members WHERE line_user_id = $1",
    [userId]
  );
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
      cloudinary.uploader
        .upload_stream(
          {
            folder: "line_qrcodes",
            public_id: `member_${memberId}`,
          },
          (error, result) => {
            if (error) reject(error);
            resolve(result);
          }
        )
        .end(qrCodeBuffer);
    });

    const qrCodeUrl = uploadResult.secure_url;
    await pool.query("UPDATE members SET qrcode = $1 WHERE id = $2", [
      qrCodeUrl,
      memberId,
    ]);
  } else {
    await pool.query(
      "UPDATE members SET waiting_for_phone = true WHERE line_user_id = $1",
      [userId]
    );
  }

  await client.replyMessage(event.replyToken, [
    { type: "text", text: `🎉 歡迎加入會員，${profile.displayName}！` },
    {
      type: "text",
      text: "請輸入您的聯絡電話（例如：0912345678），以完成會員資料。",
    },
  ]);
}

// === 處理訊息事件 ===
async function handleMessage(event) {
  const userId = event.source.userId;

  // === 📸 處理圖片上傳 ===
  if (event.message.type === "image") {
    const messageId = event.message.id;

    try {
      const stream = await client.getMessageContent(messageId);

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "photo_area",
            public_id: `${userId}_${Date.now()}`,
            resource_type: "image",
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.pipe(uploadStream);
      });

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `📸 照片上傳成功！\n✅ 已儲存於雲端 photo_area\n🌐 ${uploadResult.secure_url}`,
      });
    } catch (err) {
      console.error("❌ 上傳圖片錯誤：", err);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 照片上傳失敗，請稍後再試。",
      });
    }
    return;
  }

  const text = event.message.text.trim();
  const phoneRegex = /^09\d{8}$/;

  const result = await pool.query(
    "SELECT * FROM members WHERE line_user_id = $1",
    [userId]
  );
  const member = result.rows[0];

  if (!member) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 查無會員資料，請重新加入。",
    });
    return;
  }

  // === 觸發上傳照片 ===
  if (text === "我要上傳照片") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "請直接傳送您要上傳的照片給我 📷",
    });
    return;
  }

  // === 修改電話 ===
  if (text === "修改電話") {
    await pool.query(
      "UPDATE members SET waiting_for_phone = true WHERE line_user_id = $1",
      [userId]
    );
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "🔄 請輸入您的新聯絡電話（例如：0912345678）",
    });
    return;
  }

  // === 等待電話輸入 ===
  if (member.waiting_for_phone) {
    if (phoneRegex.test(text)) {
      if (member.phone) {
        await pool.query(
          "UPDATE members SET pending_phone = $1 WHERE line_user_id = $2",
          [text, userId]
        );
        await client.replyMessage(event.replyToken, {
          type: "template",
          altText: "是否要更新您的電話？",
          template: {
            type: "confirm",
            text: `您目前的電話為：${member.phone}\n是否要更新為：${text}？`,
            actions: [
              { type: "postback", label: "是", data: "confirm_update_phone_yes" },
              { type: "postback", label: "否", data: "confirm_update_phone_no" },
            ],
          },
        });
        return;
      }
      await updatePhoneAndSendMenu(userId, text, event.replyToken);
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 請輸入正確的手機格式（例如：0912345678）",
      });
    }
    return;
  }

  if (/^\d+$/.test(text)) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 若要修改電話，請輸入「修改電話」",
    });
  }
}

// === 處理 Postback ===
async function handlePostback(event) {
  const data = event.postback.data;
  const userId = event.source.userId;
  const memberResult = await pool.query(
    "SELECT * FROM members WHERE line_user_id = $1",
    [userId]
  );
  const member = memberResult.rows[0];
  if (!member) return;

  if (data === "confirm_update_phone_yes" && member.pending_phone) {
    await updatePhoneAndSendMenu(userId, member.pending_phone, event.replyToken);
    await pool.query(
      "UPDATE members SET pending_phone = NULL WHERE line_user_id = $1",
      [userId]
    );
    return;
  }

  if (data === "confirm_update_phone_no") {
    await pool.query(
      "UPDATE members SET pending_phone = NULL, waiting_for_phone = false WHERE line_user_id = $1",
      [userId]
    );
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❎ 已取消電話更新。",
    });
    return;
  }

  if (data === "my_qr" && member.qrcode) {
    await client.replyMessage(event.replyToken, {
      type: "image",
      originalContentUrl: member.qrcode,
      previewImageUrl: member.qrcode,
    });
    return;
  }

  if (data === "my_info") {
    const userInfo = `
【我的會員資訊】
📝 姓名: ${member.name || "未設定"}
📞 電話: ${member.phone || "未設定"}
🆔 會員 ID: ${member.id}
📅 加入日期: ${new Date(member.created_at).toLocaleDateString()}
    `.trim();

    if (!member.phone) {
      await pool.query(
        "UPDATE members SET waiting_for_phone = true WHERE line_user_id = $1",
        [userId]
      );
      await client.replyMessage(event.replyToken, [
        { type: "text", text: userInfo },
        {
          type: "text",
          text: "⚠️ 您尚未設定聯絡電話，請輸入您的電話（例如：0912345678）以完成會員資料。",
        },
      ]);
      return;
    }

    await client.replyMessage(event.replyToken, [
      { type: "text", text: userInfo },
      {
        type: "text",
        text: "若要修改電話，請點選下方「📞 修改電話」按鈕或輸入「修改電話」",
      },
    ]);
    return;
  }

  if (data === "edit_phone") {
    await pool.query(
      "UPDATE members SET waiting_for_phone = true WHERE line_user_id = $1",
      [userId]
    );
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "🔄 請輸入您的新聯絡電話（例如：0912345678）",
    });
  }
}

// === 更新電話並推送 Flex Menu ===
async function updatePhoneAndSendMenu(userId, phone, replyToken) {
  await pool.query(
    "UPDATE members SET phone = $1, waiting_for_phone = false WHERE line_user_id = $2",
    [phone, userId]
  );
  const updated = await pool.query(
    "SELECT * FROM members WHERE line_user_id = $1",
    [userId]
  );
  const updatedMember = updated.rows[0];
  const flexMenu = createFlexMenu(updatedMember.qrcode);

  await client.replyMessage(replyToken, [
    { type: "text", text: `✅ 您的電話已更新為：${phone}` },
    { type: "text", text: "以下是您的會員功能選單👇" },
    flexMenu,
  ]);
}

// === Flex Menu ===
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
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#FF6F61",
                action: { type: "postback", label: "我的QR", data: "my_qr" },
              },
              {
                type: "button",
                style: "primary",
                color: "#2D9CDB",
                action: { type: "postback", label: "我的資訊", data: "my_info" },
              },
              {
                type: "button",
                style: "primary",
                color: "#8E44AD",
                action: { type: "message", label: "📸 上傳照片", text: "我要上傳照片" },
              },
              {
                type: "button",
                style: "primary",
                color: "#F39C12",
                action: { type: "postback", label: "📞 修改電話", data: "edit_phone" },
              },
            ],
          },
        ],
      },
    },
  };
}

// === 顯示會員身分頁面 ===
app.get("/member/:id", async (req, res) => {
  const memberId = req.params.id;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  try {
    const result = await pool.query("SELECT * FROM members WHERE id = $1", [memberId]);
    const member = result.rows[0];

    if (!member) {
      res.send(`<html><body><h1>⚠️ 非會員 QR Code</h1></body></html>`);
      return;
    }

    // 寫入刷碼紀錄
    await pool.query(
      "INSERT INTO scan_logs (member_id, member_name, ip_address) VALUES ($1,$2,$3)",
      [member.id, member.name || "未設定", ip]
    );

    res.send(`
      <html><body style="text-align:center;padding-top:50px;">
        <h1>✅ 驗證成功</h1>
        <p>會員姓名：${member.name}</p>
        <p>會員編號：${member.id}</p>
      </body></html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("伺服器錯誤");
  }
});

// === 查詢 API：供掃碼槍頁面使用 ===
app.get("/api/check-member", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: "缺少網址" });

  try {
    const match = url.match(/\/member\/(\d+)/);
    if (!match) return res.json({ success: false, message: "無效QR內容" });

    const memberId = match[1];
    const result = await pool.query("SELECT * FROM members WHERE id = $1", [memberId]);
    const member = result.rows[0];

    if (!member) return res.json({ success: false, message: "❌ 非會員QR Code" });

    await pool.query(
      "INSERT INTO scan_logs (member_id, member_name, ip_address) VALUES ($1,$2,$3)",
      [member.id, member.name || "未設定", req.ip]
    );

    res.json({ success: true, name: member.name, id: member.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "伺服器錯誤" });
  }
});

// === 掃碼器頁面 ===
app.get("/scanner", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <title>會員掃碼驗證</title>
        <style>
          body { font-family:'Noto Sans TC',sans-serif;text-align:center;background:#f9f9f9;padding-top:100px; }
          h1 { color:#2c3e50; }
          input { width:80%;font-size:20px;padding:10px;margin-top:20px; }
          .result { margin-top:30px;font-size:24px; }
          .success { color:#2e7d32; }
          .error { color:#c62828; }
        </style>
      </head>
      <body>
        <h1>📷 會員掃碼驗證系統</h1>
        <p>請將游標放在輸入框內，掃描會員QR Code</p>
        <input id="scannerInput" placeholder="請掃描QR Code..." autofocus />
        <div class="result" id="result"></div>
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
                resultDiv.innerHTML="✅ <span class='success'>歡迎會員："+data.name+"</span>";
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

// === 顯示最近 50 筆刷碼紀錄 ===
app.get("/logs", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50"
    );
    const logs = result.rows;

    const rows = logs
      .map(
        (log) => `
        <tr>
          <td>${log.id}</td>
          <td>${log.member_id}</td>
          <td>${log.member_name}</td>
          <td>${new Date(log.scanned_at).toLocaleString()}</td>
          <td>${log.ip_address}</td>
        </tr>
      `
      )
      .join("");

    res.send(`
      <html>
        <head>
          <meta charset="utf-8">
          <title>刷碼紀錄查詢</title>
          <style>
            body { font-family: 'Noto Sans TC', sans-serif; background: #f4f6f8; padding: 40px; }
            h1 { color: #2e7d32; text-align: center; }
            table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
            th, td { padding: 10px; border-bottom: 1px solid #ddd; text-align: center; }
            th { background: #81c784; color: white; }
            tr:hover { background-color: #f1f8e9; }
            .refresh { text-align: center; margin-top: 20px; }
            button { padding: 10px 20px; background: #388e3c; color: white; border: none; border-radius: 5px; cursor: pointer; }
            button:hover { background: #2e7d32; }
          </style>
        </head>
        <body>
          <h1>📋 最近 50 筆刷碼紀錄</h1>
          <div class="refresh">
            <button onclick="window.location.reload()">🔄 重新整理</button>
          </div>
          <table>
            <tr><th>ID</th><th>會員ID</th><th>姓名</th><th>刷碼時間</th><th>IP位址</th></tr>
            ${rows || "<tr><td colspan='5'>尚無刷碼紀錄</td></tr>"}
          </table>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ 無法讀取刷碼紀錄：", err);
    res.status(500).send("伺服器錯誤，請稍後再試。");
  }
});


// === 啟動伺服器 ===
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
