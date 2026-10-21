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
  db.exec('DELETE FROM parcelles; DELETE FROM evenements; DELETE FROM titrisations; DELETE FROM meta;');
}

module.exports = { open, getMeta, setMeta, resetChainData };
