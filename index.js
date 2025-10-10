// === 匯入套件 ===
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
  process.env.PUBLIC_BASE_URL || "https://f47d55e98170.ngrok-free.app";
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
    client.release();
    console.log("✅ PostgreSQL 資料表初始化成功");
  } catch (err) {
    console.error("❌ PostgreSQL 資料表初始化失敗", err);
  }
}

app.get("/", (req, res) =>
  res.send("✅ LINE Webhook + Cloudinary Photo Upload Server 已啟動")
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
    const qrCodeBuffer = await QRCode.toBuffer(memberUrl, {
      width: 300,
      margin: 2,
    });

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
      // 從 LINE API 取得圖片串流
      const stream = await client.getMessageContent(messageId);

      // 上傳至 Cloudinary
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

      // 回覆成功訊息
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

  // === 處理文字訊息 ===
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
          {
            type: "text",
            text: "🎯 會員功能選單",
            weight: "bold",
            size: "md",
            align: "center",
          },
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
                action: {
                  type: "message",
                  label: "📸 上傳照片",
                  text: "我要上傳照片",
                },
              },
              {
                type: "button",
                style: "primary",
                color: "#F39C12",
                action: {
                  type: "postback",
                  label: "📞 修改電話",
                  data: "edit_phone",
                },
              },
            ],
          },
        ],
      },
    },
  };
}

// === 啟動伺服器 ===
initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
