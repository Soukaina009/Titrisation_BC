// Indexeur : lit les événements des smart contracts sur la blockchain et les copie dans SQLite.
// Il est idempotent (on peut le relancer sans créer de doublons) et reprend là où il s'était arrêté.
const { ethers } = require('ethers');
const { REGISTRY_ABI, FACTORY_ABI, SEC_ABI } = require('./abis');
const { getMeta, setMeta } = require('./db');

// "Parcelle Tanger" -> "Tanger" ; "Hay Riad, Rabat" -> "Rabat" (sert au KPI "répartition par ville")
function villeDepuis(localisation) {
  if (!localisation) return 'Inconnue';
  const brut = localisation.includes(',') ? localisation.split(',').pop() : localisation.trim().split(/\s+/).pop();
  const v = (brut || '').trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : 'Inconnue';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Affiche la VRAIE cause de l'erreur (au lieu de "could not coalesce error")
function detailErreur(e) {
  return [
    e.shortMessage || e.message,
    e.code,
    e.error?.message,
    e.info?.responseStatus,
    (e.info?.responseBody || '').toString().slice(0, 300)
  ].filter(Boolean).join(' | ');
}

class Indexer {
  constructor({ db, provider, registry, factory, startBlock, chunk = 2000, confirmations = 1, log = console }) {
    Object.assign(this, { db, provider, registry, factory, startBlock, chunk, confirmations, log });
    this.regIface = new ethers.Interface(REGISTRY_ABI);
    this.facIface = new ethers.Interface(FACTORY_ABI);
    this.secIface = new ethers.Interface(SEC_ABI);
    this.regContract = new ethers.Contract(registry, REGISTRY_ABI, provider);
    this.tsCache = new Map();
    this.status = { lastBlock: null, headBlock: null, lastSync: null, error: null };

    this.sql = {
      insParcelle: db.prepare(`INSERT OR IGNORE INTO parcelles
        (token_id, numero_tf, localisation, ville, superficie, proprietaire, actif, created_block, created_ts, created_tx)
        VALUES (@token_id, @numero_tf, @localisation, @ville, @superficie, @proprietaire, @actif, @block, @ts, @tx)`),
      insEvt: db.prepare(`INSERT OR IGNORE INTO evenements (type, token_id, de, vers, valeur, block, log_index, ts, tx)
        VALUES (@type, @token_id, @de, @vers, @valeur, @block, @log_index, @ts, @tx)`),
      setOwner: db.prepare('UPDATE parcelles SET proprietaire = ? WHERE token_id = ?'),
      insTit: db.prepare(`INSERT OR IGNORE INTO titrisations
        (contrat, token_id, proprietaire, parts_prevues, statut, created_block, created_ts, created_tx)
        VALUES (@contrat, @token_id, @proprietaire, @parts_prevues, 'CREEE', @block, @ts, @tx)`),
      titActive: db.prepare("UPDATE titrisations SET parts_emises = ?, statut = 'ACTIVE' WHERE contrat = ?"),
      titRachat: db.prepare("UPDATE titrisations SET parts_emises = 0, statut = 'RACHETEE' WHERE contrat = ?"),
      contrats: db.prepare('SELECT contrat FROM titrisations'),
      titToken: db.prepare('SELECT token_id FROM titrisations WHERE contrat = ?')
    };
  }

  async blockTs(n) {
    if (!this.tsCache.has(n)) {
      const b = await this.provider.getBlock(n);
      this.tsCache.set(n, b.timestamp);
      if (this.tsCache.size > 500) this.tsCache.delete(this.tsCache.keys().next().value);
    }
    return this.tsCache.get(n);
  }

    async syncOnce() {
    const head = (await this.provider.getBlockNumber()) - this.confirmations;
    this.status.headBlock = head;
    let last = Number(getMeta(this.db, 'last_block') ?? this.startBlock - 1);
    this.status.lastBlock = last;

    const MIN = 10;          // plage minimale (Alchemy gratuit accepte 10 blocs)
    const ESSAIS = 6;        // tentatives par plage avant d'abandonner
    let size = this.chunk;   // la taille est conservée d'un tour à l'autre

    while (last < head) {
      const from = last + 1;
      const to = Math.min(from + size - 1, head);
      let ok = false;

      for (let essai = 1; essai <= ESSAIS && !ok; essai++) {
        try {
          await this.indexRange(from, to);
          ok = true;
        } catch (e) {
          this.log.warn(`[indexeur] blocs ${from}-${to}, essai ${essai}/${ESSAIS} : ${detailErreur(e)}`);
          if (size > MIN) size = Math.max(MIN, Math.floor(size / 2)); // plage plus petite
          await sleep(1500 * essai);                                  // pause croissante (anti rate-limit)
          if (essai === ESSAIS) throw new Error(detailErreur(e));
        }
      }

      last = to;
      setMeta(this.db, 'last_block', last);
      this.status.lastBlock = last;
      if (size < this.chunk) size = Math.min(this.chunk, size * 2);   // on réaugmente doucement
      await sleep(150);                                               // petite pause entre deux plages
    }

    this.status.lastSync = Date.now();
    this.status.error = null;
  }

  async indexRange(from, to) {
    const events = [];
    const range = { fromBlock: from, toBlock: to };

    // 1) Registre + Factory
    for (const [addr, iface] of [[this.registry, this.regIface], [this.factory, this.facIface]]) {
      if (!addr) continue;
      for (const log of await this.provider.getLogs({ address: addr, ...range })) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) events.push({ parsed, log });
      }
    }

    // 2) Contrats de titrisation (connus + ceux découverts dans cette même plage)
    const known = new Set(this.sql.contrats.all().map(r => r.contrat));
    for (const e of events) if (e.parsed.name === 'NouvelleTitrisation') known.add(e.parsed.args.contratCree);
    if (known.size) {
      for (const log of await this.provider.getLogs({ address: [...known], ...range })) {
        const parsed = this.secIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) events.push({ parsed, log });
      }
    }
    if (!events.length) return;
    events.sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.index - b.log.index);

    // 3) Enrichissement (appels réseau) AVANT d'écrire, pour que l'écriture soit une seule transaction SQL
    for (const e of events) {
      e.ts = await this.blockTs(e.log.blockNumber);
      if (e.parsed.name === 'ParcelleImmatriculee') {
        const r = await this.regContract.consulterParcelle(e.parsed.args.tokenId);
        e.details = { localisation: r.localisation, superficie: Number(r.superficieM2), actif: r.estActive ? 1 : 0 };
      }
      if (e.parsed.name === 'NouvelleTitrisation') {
        try { e.partsPrevues = Number(await new ethers.Contract(e.parsed.args.contratCree, SEC_ABI, this.provider).totalPartsPrevues()); }
        catch { e.partsPrevues = null; }
      }
    }

    // 4) Écriture atomique
    this.db.transaction(() => { for (const e of events) this.apply(e); })();
    this.log.info(`[indexeur] blocs ${from}-${to} : ${events.length} événement(s)`);
  }

  apply({ parsed, log, ts, details, partsPrevues }) {
    const a = parsed.args;
    const base = { block: log.blockNumber, log_index: log.index, ts, tx: log.transactionHash, token_id: null, de: null, vers: null, valeur: null };
    const evt = (o) => this.sql.insEvt.run({ ...base, ...o });
    switch (parsed.name) {
      case 'ParcelleImmatriculee': {
        const token_id = Number(a.tokenId);
        this.sql.insParcelle.run({
          token_id, numero_tf: a.numeroTitreFoncier, localisation: details.localisation, ville: villeDepuis(details.localisation),
          superficie: details.superficie, proprietaire: a.proprietaire, actif: details.actif, block: base.block, ts, tx: base.tx
        });
        evt({ type: 'IMMATRICULATION', token_id, vers: a.proprietaire, valeur: a.numeroTitreFoncier });
        break;
      }
      case 'VenteProposee':
        evt({ type: 'PROPOSITION', token_id: Number(a.tokenId), de: a.vendeur, vers: a.acheteur });
        break;
      case 'TransfertValide':
        evt({ type: 'TRANSFERT', token_id: Number(a.tokenId), de: a.ancienProprietaire, vers: a.nouveauProprietaire });
        this.sql.setOwner.run(a.nouveauProprietaire, Number(a.tokenId));
        break;
      case 'PropositionAnnulee':
        evt({ type: 'ANNULATION', token_id: Number(a.tokenId) });
        break;
      case 'NouvelleTitrisation':
        this.sql.insTit.run({ contrat: a.contratCree, token_id: Number(a.parcelTokenId), proprietaire: a.proprietaire, parts_prevues: partsPrevues, block: base.block, ts, tx: base.tx });
        evt({ type: 'TITRISATION_CREEE', token_id: Number(a.parcelTokenId), de: a.proprietaire, vers: a.contratCree });
        break;
      case 'TitrisationEffectuee':
        this.sql.titActive.run(Number(a.nombreDeParts), log.address);
        evt({ type: 'PARTS_EMISES', token_id: Number(a.parcelTokenId), vers: a.beneficiaire, valeur: String(a.nombreDeParts) });
        break;
      case 'RachatDemande':
        this.sql.titRachat.run(log.address);
        evt({ type: 'RACHAT', token_id: this.sql.titToken.get(log.address)?.token_id ?? null, de: a.demandeur, valeur: String(a.partsBrulees), vers: log.address });
        break;
    }
  }

    start(intervalMs = 15000) {
    const tick = async () => {
      try { await this.syncOnce(); }
      catch (e) {
        this.status.error = detailErreur(e);
        this.log.error('[indexeur] erreur :', this.status.error);
      }
      this._timer = setTimeout(tick, intervalMs);
    };
    tick();
  }
  stop() { clearTimeout(this._timer); }
}

module.exports = { Indexer, villeDepuis };
