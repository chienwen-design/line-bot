import 'dotenv/config';
import { Client } from "@line/bot-sdk";
import fs from "fs";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://f47d55e98170.ngrok-free.app";
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new Client(config);

async function createRichMenu() {
  // 1️⃣ 定義 Rich Menu 結構
  const richMenu = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: "會員主選單",
    chatBarText: "會員功能",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: { type: "postback", data: "my_qr" } // 點擊 → webhook 收 my_qr
      },
      {
        bounds: { x: 834, y: 0, width: 833, height: 843 },
        action: { type: "postback", data: "my_info" }
      },
      {
        bounds: { x: 1667, y: 0, width: 833, height: 843 },
        action: { type: "postback", data: "edit_info" }
      }
    ]
  };

  try {
    // 2️⃣ 建立 Rich Menu
    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ 建立成功，RichMenu ID:", richMenuId);

    // 3️⃣ 上傳圖像（2500x843 PNG/JPG）
    await client.setRichMenuImage(richMenuId, fs.createReadStream("./richmenu.png"));
    console.log("🖼️ 已上傳圖像");

    // 4️⃣ 設為預設
    await client.setDefaultRichMenu(richMenuId);
    console.log("🚀 已設定為預設 Rich Menu");
  } catch (err) {
    console.error("❌ 建立失敗:", err);
  }
}

createRichMenu();