require("dotenv").config();

const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const ROCKET_PERCENT = Number(process.env.ROCKET_PERCENT || 1.75);
const BB_PERCENT = Number(process.env.BB_PERCENT || 0);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не найден");
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error("❌ CHANNEL_ID не найден");
  process.exit(1);
}

const db = new sqlite3.Database("./history.db");

db.run(`
  CREATE TABLE IF NOT EXISTS calculations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT,
    amount REAL,
    rocket_rate REAL,
    bb_rate REAL,
    rocket_percent REAL,
    bb_percent REAL,
    rocket_final_rate REAL,
    bb_final_rate REAL,
    rocket_result REAL,
    bb_result REAL,
    difference REAL,
    office_profit REAL,
    telegram_chat_id TEXT,
    telegram_message_id INTEGER
  )
`);

db.run(`ALTER TABLE calculations ADD COLUMN office_profit REAL`, () => {});
db.run(`ALTER TABLE calculations ADD COLUMN telegram_chat_id TEXT`, () => {});
db.run(`ALTER TABLE calculations ADD COLUMN telegram_message_id INTEGER`, () => {});

function format(num) {
  return Number(num).toLocaleString("ru-RU", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  });
}

function toNumber(value) {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

function parseNumber(value) {
  value = value.toString().trim().replace(/\s/g, "");

  if (value.includes(",") && value.includes(".")) {
    value = value.replace(/\./g, "").replace(",", ".");
  } else if (value.includes(".")) {
    const parts = value.split(".");

    if (parts.length > 1 && parts[parts.length - 1].length === 3) {
      value = value.replace(/\./g, "");
    }
  } else if (value.includes(",")) {
    value = value.replace(",", ".");
  }

  return Number(value);
}

async function telegram(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function sendToTelegram(chatId, message) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: message
  });
}

async function deleteTelegramMessage(chatId, messageId) {
  return telegram("deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}

function calculateData(amount, rocketRate, bbRate, rocketPercent, bbPercent) {
  const rocketPercentValue = rocketRate * rocketPercent / 100;
  const rocketFinalRate = rocketRate - rocketPercentValue;
  const rocketResult = amount / rocketFinalRate;

  const bbPercentValue = bbRate * bbPercent / 100;
  const bbFinalRate = bbRate - bbPercentValue;
  const bbResult = amount / bbFinalRate;

  const difference = bbResult - rocketResult;
  const officeProfit = rocketPercentValue;

  return {
    rocketFinalRate,
    rocketResult,
    bbFinalRate,
    bbResult,
    difference,
    officeProfit
  };
}

function makeMessage(amount, rocketRate, bbRate, rocketPercent, result, id) {
  return `
🧮 Новый расчет

🆔 ID расчета: ${id}

💰 Сумма: ${format(amount)}

🚀 Rocket курс: ${format(rocketRate)} (-${rocketPercent}% = ${format(result.rocketFinalRate)})
🔵 BB курс: ${format(bbRate)}
💵 Прибыль Офиса: ${rocketPercent}% = ${format(result.officeProfit)}

🔥 Разница: ${format(result.difference)}

🕒 Время: ${new Date().toLocaleString("ru-RU", {
  timeZone: "Asia/Tashkent"
})}
`;
}

function saveCalculation(amount, rocketRate, bbRate, rocketPercent, bbPercent, result, chatId, messageId = 0) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO calculations
      (
        created_at,
        amount,
        rocket_rate,
        bb_rate,
        rocket_percent,
        bb_percent,
        rocket_final_rate,
        bb_final_rate,
        rocket_result,
        bb_result,
        difference,
        office_profit,
        telegram_chat_id,
        telegram_message_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        new Date().toISOString(),
        amount,
        rocketRate,
        bbRate,
        rocketPercent,
        bbPercent,
        result.rocketFinalRate,
        result.bbFinalRate,
        result.rocketResult,
        result.bbResult,
        result.difference,
        result.officeProfit,
        String(chatId),
        messageId
      ],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

function updateTelegramMessageId(id, messageId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE calculations SET telegram_message_id = ? WHERE id = ?`,
      [messageId, id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

function getCalculationById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM calculations WHERE id = ?`, [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function deleteCalculationById(id) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM calculations WHERE id = ?`, [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function resetHistory() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`DELETE FROM calculations`, (err) => {
        if (err) {
          reject(err);
          return;
        }

        db.run(`DELETE FROM sqlite_sequence WHERE name='calculations'`, (err2) => {
          if (err2) {
            reject(err2);
            return;
          }

          resolve(true);
        });
      });
    });
  });
}

function parseTelegramCalculation(text) {
  const lines = text.split("\n").map(x => x.trim()).filter(Boolean);

  if (lines.length < 2) return null;

  const rates = lines[0].split("-").map(x => x.trim());

  if (rates.length !== 2) return null;

  const rocketRate = parseNumber(rates[0]);
  const bbRate = parseNumber(rates[1]);
  const amount = parseNumber(lines[1]);

  if (!rocketRate || !bbRate || !amount) return null;

  return { rocketRate, bbRate, amount };
}

function parseRuDate(dateStr) {
  const parts = dateStr.split(".");

  if (parts.length !== 3) return null;

  const day = parts[0].padStart(2, "0");
  const month = parts[1].padStart(2, "0");
  const year = parts[2];

  return `${year}-${month}-${day}`;
}

const monthNames = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"
];

function makePeriodTitle(fromStr, toStr) {
  const fromParts = fromStr.split(".");
  const toParts = toStr.split(".");

  const fromDay = Number(fromParts[0]);
  const toDay = Number(toParts[0]);
  const monthIndex = Number(toParts[1]) - 1;

  return `${fromDay}-${toDay} ${monthNames[monthIndex]}`;
}

function getPeriodStats(fromDate, toDate) {
  return new Promise((resolve, reject) => {
    const start = `${fromDate}T00:00:00.000Z`;
    const end = `${toDate}T23:59:59.999Z`;

    db.all(
      `
      SELECT * FROM calculations
      WHERE created_at BETWEEN ? AND ?
      ORDER BY created_at ASC
      `,
      [start, end],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        let totalAmount = 0;
        let totalOfficeProfit = 0;
        let totalDifference = 0;

        rows.forEach(row => {
          totalAmount += Number(row.amount || 0);
          totalOfficeProfit += Number(row.office_profit || 0);
          totalDifference += Number(row.difference || 0);
        });

        resolve({
          count: rows.length,
          totalAmount,
          totalOfficeProfit,
          totalDifference
        });
      }
    );
  });
}

app.get("/", (req, res) => {
  res.send("Backend работает ✅");
});

app.post("/calculate", async (req, res) => {
  try {
    const amount = toNumber(req.body.amount);
    const rocketRate = toNumber(req.body.rocketRate);
    const bbRate = toNumber(req.body.bbRate);
    const rocketPercent = toNumber(req.body.rocketPercent);
    const bbPercent = toNumber(req.body.bbPercent);

    if (!amount || !rocketRate || !bbRate) {
      return res.status(400).json({
        success: false,
        message: "Неправильные данные"
      });
    }

    const result = calculateData(amount, rocketRate, bbRate, rocketPercent, bbPercent);

    const id = await saveCalculation(
      amount,
      rocketRate,
      bbRate,
      rocketPercent,
      bbPercent,
      result,
      CHANNEL_ID,
      0
    );

    const message = makeMessage(amount, rocketRate, bbRate, rocketPercent, result, id);

    const telegramResponse = await sendToTelegram(CHANNEL_ID, message);
    const messageId = telegramResponse.result.message_id;

    await updateTelegramMessageId(id, messageId);

    res.json({
      success: true,
      id,
      message: "Расчет сохранен и отправлен в Telegram"
    });

  } catch (error) {
    console.error("❌ Ошибка:", error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

let lastUpdateId = 0;

async function startTelegramListener() {
  console.log("🤖 Telegram listener started");

  while (true) {
    try {
      const data = await telegram("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 25
      });

      for (const update of data.result) {
        lastUpdateId = update.update_id;

        const messageObj = update.message || update.channel_post;

        if (!messageObj || !messageObj.text) continue;

        const chatId = messageObj.chat.id;
        const text = messageObj.text.trim();
        const lowerText = text.toLowerCase();

        if (lowerText === "/start") {
          await sendToTelegram(chatId, `
Привет 👋

Расчет:
509 - 494
258.800

Итог за период:
итог 01.05.2026 15.05.2026

Удалить расчет:
удалить 15

Очистить всю историю:
сброс
`);
          continue;
        }

        if (lowerText === "сброс") {
          await resetHistory();

          await sendToTelegram(chatId, `
🗑 История полностью очищена

Следующий расчет начнется с ID 1
`);
          continue;
        }

        if (lowerText.startsWith("итог")) {
          const parts = text.split(/\s+/);

          if (parts.length !== 3) {
            await sendToTelegram(chatId, `
⚠️ Формат команды:

итог 01.05.2026 15.05.2026
`);
            continue;
          }

          const fromDate = parseRuDate(parts[1]);
          const toDate = parseRuDate(parts[2]);

          if (!fromDate || !toDate) {
            await sendToTelegram(chatId, "⚠️ Дату пиши так: 01.05.2026");
            continue;
          }

          const stats = await getPeriodStats(fromDate, toDate);
          const periodTitle = makePeriodTitle(parts[1], parts[2]);

          const answer = `
🧮 Расчет за ${periodTitle}

💰 Сумма: ${format(stats.totalAmount)}

💵 Прибыль Офиса: ${ROCKET_PERCENT}% = ${format(stats.totalOfficeProfit)}

🔥 Разница: ${format(stats.totalDifference)}

🕒 Время: ${new Date().toLocaleString("ru-RU", {
  timeZone: "Asia/Tashkent"
})}
`;

          await sendToTelegram(chatId, answer);
          continue;
        }

        if (lowerText.startsWith("удалить")) {
          const parts = text.split(/\s+/);
          const id = Number(parts[1]);

          if (!id) {
            await sendToTelegram(chatId, "⚠️ Формат: удалить 15");
            continue;
          }

          const row = await getCalculationById(id);

          if (!row) {
            await sendToTelegram(chatId, `⚠️ Расчет с ID ${id} не найден`);
            continue;
          }

          if (row.telegram_chat_id && row.telegram_message_id) {
            try {
              await deleteTelegramMessage(row.telegram_chat_id, row.telegram_message_id);
            } catch (error) {
              console.log("⚠️ Не удалось удалить сообщение Telegram:", error.message);
            }
          }

          await deleteCalculationById(id);

          await sendToTelegram(chatId, `✅ Расчет ID ${id} удален из базы`);
          continue;
        }

        const parsed = parseTelegramCalculation(text);

        if (!parsed) continue;

        const { amount, rocketRate, bbRate } = parsed;

        if (rocketRate <= bbRate) {
          await sendToTelegram(chatId, "⚠️ Rocket курс должен быть больше BB курса!");
          continue;
        }

        const result = calculateData(
          amount,
          rocketRate,
          bbRate,
          ROCKET_PERCENT,
          BB_PERCENT
        );

        const id = await saveCalculation(
          amount,
          rocketRate,
          bbRate,
          ROCKET_PERCENT,
          BB_PERCENT,
          result,
          chatId,
          0
        );

        const answer = makeMessage(
          amount,
          rocketRate,
          bbRate,
          ROCKET_PERCENT,
          result,
          id
        );

        const telegramResponse = await sendToTelegram(chatId, answer);
        const messageId = telegramResponse.result.message_id;

        await updateTelegramMessageId(id, messageId);
      }

    } catch (error) {
      console.error("❌ Telegram listener error:", error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

const server = app.listen(PORT, () => {
  console.log(`✅ Server started on port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);

  startTelegramListener();
});

server.on("error", (error) => {
  console.error("❌ Server error:", error.message);
});