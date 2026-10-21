// Serveur : API REST (données + KPIs) + service de l'interface (dossier public/) + indexeur.
require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const { ethers } = require('ethers');
const { open, getMeta, resetChainData } = require('./src/db');
const { computeKpis } = require('./src/kpis');
const { Indexer } = require('./src/indexer');

const cfg = {
  port: Number(process.env.PORT || 3000),
  rpc: process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  registry: process.env.REGISTRY_ADDRESS || '',
  factory: process.env.FACTORY_ADDRESS || '',
  startBlock: process.env.START_BLOCK !== undefined && process.env.START_BLOCK !== '' ? Number(process.env.START_BLOCK) : null,
  chunk: Number(process.env.LOG_CHUNK || 2000),
  confirmations: Number(process.env.CONFIRMATIONS || 1),
  pollMs: Number(process.env.POLL_MS || 15000),
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'registre.db')
};
const EXPLORERS = { 1: 'https://etherscan.io', 11155111: 'https://sepolia.etherscan.io', 80002: 'https://amoy.polygonscan.com' };

const db = open(cfg.dbFile);
const app = express();
app.use(cors());
app.use(express.json());

let chainId = null;
let indexer = null;

app.get('/api/config', (_req, res) => res.json({
  registry: cfg.registry || null, factory: cfg.factory || null, chainId,
  explorer: process.env.EXPLORER_URL || EXPLORERS[chainId] || null
}));

app.get('/api/kpis', (_req, res) => {
  res.json({
    ...computeKpis(db),
    sync: { ...(indexer ? indexer.status : { lastBlock: null, headBlock: null, lastSync: null, error: 'Indexeur non démarré (REGISTRY_ADDRESS manquante ?)' }),
            chainId, registry: cfg.registry || null }
  });
});

app.get('/api/parcelles', (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const rows = db.prepare(`SELECT p.*, c.nom AS proprietaire_nom FROM parcelles p
      LEFT JOIN contacts c ON c.address = p.proprietaire
      WHERE lower(p.numero_tf) LIKE @q OR lower(p.localisation) LIKE @q OR lower(p.ville) LIKE @q
         OR lower(p.proprietaire) LIKE @q OR lower(COALESCE(c.nom,'')) LIKE @q OR CAST(p.token_id AS TEXT) = @exact
      ORDER BY p.token_id DESC LIMIT @limit OFFSET @offset`).all({ q, exact: String(req.query.q || '').trim(), limit, offset });
  res.json(rows);
});

app.get('/api/parcelles/:id', (req, res) => {
  const row = db.prepare(`SELECT p.*, c.nom AS proprietaire_nom FROM parcelles p
      LEFT JOIN contacts c ON c.address = p.proprietaire WHERE p.token_id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Parcelle inconnue dans la base' });
  const historique = db.prepare('SELECT type, de, vers, valeur, ts, tx FROM evenements WHERE token_id = ? ORDER BY block, log_index').all(row.token_id);
  const titrisation = db.prepare('SELECT * FROM titrisations WHERE token_id = ?').get(row.token_id) || null;
  res.json({ ...row, historique, titrisation });
});

app.get('/api/titrisations', (_req, res) => res.json(db.prepare('SELECT * FROM titrisations ORDER BY created_ts DESC').all()));

app.get('/api/contacts', (_req, res) => res.json(db.prepare('SELECT address, nom FROM contacts ORDER BY nom').all()));
app.put('/api/contacts/:address', (req, res) => {
  const nom = String(req.body?.nom || '').trim().slice(0, 60);
  if (!ethers.isAddress(req.params.address)) return res.status(400).json({ error: 'Adresse invalide' });
  const address = ethers.getAddress(req.params.address);
  if (!nom) { db.prepare('DELETE FROM contacts WHERE address = ?').run(address); return res.json({ address, nom: null }); }
  db.prepare('INSERT INTO contacts (address, nom) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET nom = excluded.nom').run(address, nom);
  res.json({ address, nom });
});

app.use(express.static(path.join(__dirname, 'public')));

async function startIndexer() {
  if (!cfg.registry) { console.warn('[indexeur] REGISTRY_ADDRESS non défini : renseignez-le dans .env pour remplir la base.'); return; }
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  try { chainId = Number((await provider.getNetwork()).chainId); }
  catch (e) { console.error('[indexeur] RPC injoignable :', e.shortMessage || e.message); setTimeout(startIndexer, 10000); return; }
  const local = chainId === 31337 || chainId === 1337;
  let startBlock = cfg.startBlock ?? (local ? 0 : null);
  if (startBlock === null) { console.error('[indexeur] START_BLOCK manquant : indiquez dans .env le numéro du bloc de déploiement du registre (visible sur Etherscan).'); return; }
  if (process.argv.includes('--reindex')) { resetChainData(db); console.log('[indexeur] base vidée, reconstruction depuis la blockchain.'); }
  indexer = new Indexer({ db, provider, registry: cfg.registry, factory: cfg.factory, startBlock, chunk: cfg.chunk, confirmations: cfg.confirmations });
  indexer.start(cfg.pollMs);
}

if (require.main === module) {
  app.listen(cfg.port, () => console.log(`Application : http://localhost:${cfg.port}  (base : ${cfg.dbFile})`));
  startIndexer();
}

module.exports = { app, db, cfg, startIndexer, getIndexer: () => indexer, setChainId: (c) => { chainId = c; } };
