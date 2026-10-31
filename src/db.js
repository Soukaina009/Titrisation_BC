// Couche "base de données" : SQLite, un seul fichier (data/registre.db).
// La blockchain reste la source de vérité ; cette base est une copie interrogeable
// (recherche, agrégats pour les KPIs) + des données hors chaîne (carnet d'adresses).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parcelles (
  token_id      INTEGER PRIMARY KEY,
  numero_tf     TEXT,
  localisation  TEXT,
  ville         TEXT,
  superficie    INTEGER,
  proprietaire  TEXT,
  actif         INTEGER DEFAULT 1,
  created_block INTEGER,
  created_ts    INTEGER,
  created_tx    TEXT
);
CREATE TABLE IF NOT EXISTS evenements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type      TEXT NOT NULL,
  token_id  INTEGER,
  de        TEXT,
  vers      TEXT,
  valeur    TEXT,
  block     INTEGER,
  log_index INTEGER,
  ts        INTEGER,
  tx        TEXT,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS idx_evt_token ON evenements (token_id);
CREATE INDEX IF NOT EXISTS idx_evt_type  ON evenements (type);
CREATE TABLE IF NOT EXISTS titrisations (
  contrat       TEXT PRIMARY KEY,
  token_id      INTEGER,
  proprietaire  TEXT,
  parts_prevues INTEGER,
  parts_emises  INTEGER DEFAULT 0,
  statut        TEXT DEFAULT 'CREEE',
  created_block INTEGER,
  created_ts    INTEGER,
  created_tx    TEXT
);
-- Offres publiques de parts (ICO / STO). Les montants en wei sont en TEXT : ils dépassent 2^63 (9,2 ETH).
CREATE TABLE IF NOT EXISTS offres (
  contrat          TEXT PRIMARY KEY,
  parts_contrat    TEXT,
  token_id         INTEGER,
  vendeur          TEXT,
  prix_wei         TEXT,
  objectif_wei     TEXT,
  fin_ts           INTEGER,
  collecte_wei     TEXT DEFAULT '0',
  rembourse_wei    TEXT DEFAULT '0',
  parts_deposees   INTEGER DEFAULT 0,
  parts_vendues    INTEGER DEFAULT 0,
  parts_reclamees  INTEGER DEFAULT 0,
  parts_recuperees INTEGER DEFAULT 0,
  fonds_retires    INTEGER DEFAULT 0,
  created_block    INTEGER,
  created_ts       INTEGER,
  created_tx       TEXT
);
CREATE TABLE IF NOT EXISTS operations_offre (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  offre       TEXT NOT NULL,
  type        TEXT NOT NULL,
  acteur      TEXT,
  parts       INTEGER,
  montant_wei TEXT,
  block       INTEGER,
  log_index   INTEGER,
  ts          INTEGER,
  tx          TEXT,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS idx_op_offre ON operations_offre (offre);
CREATE TABLE IF NOT EXISTS contacts (
  address TEXT PRIMARY KEY,
  nom     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

// Vide tout ce qui vient de la blockchain (le carnet d'adresses est conservé) pour reconstruire la base.
function resetChainData(db) {
  db.exec('DELETE FROM parcelles; DELETE FROM evenements; DELETE FROM titrisations; DELETE FROM offres; DELETE FROM operations_offre; DELETE FROM meta;');
}

module.exports = { open, getMeta, setMeta, resetChainData };
