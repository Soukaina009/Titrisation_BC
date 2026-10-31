// Indexeur : lit les événements des smart contracts sur la blockchain et les copie dans SQLite.
// Il est idempotent (on peut le relancer sans créer de doublons) et reprend là où il s'était arrêté.
const { ethers } = require('ethers');
const { REGISTRY_ABI, FACTORY_ABI, SEC_ABI, SALE_FACTORY_ABI, SALE_ABI } = require('./abis');
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
  constructor({ db, provider, registry, factory, saleFactory = '', startBlock, chunk = 2000, confirmations = 1, log = console }) {
    Object.assign(this, { db, provider, registry, factory, saleFactory, startBlock, chunk, confirmations, log });
    this.regIface = new ethers.Interface(REGISTRY_ABI);
    this.facIface = new ethers.Interface(FACTORY_ABI);
    this.secIface = new ethers.Interface(SEC_ABI);
    this.saleFacIface = new ethers.Interface(SALE_FACTORY_ABI);
    this.saleIface = new ethers.Interface(SALE_ABI);
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
      titToken: db.prepare('SELECT token_id FROM titrisations WHERE contrat = ?'),
      titParParts: db.prepare('SELECT token_id FROM titrisations WHERE lower(contrat) = lower(?)'),
      // Offres publiques de parts
      insOffre: db.prepare(`INSERT OR IGNORE INTO offres
        (contrat, parts_contrat, token_id, vendeur, prix_wei, objectif_wei, fin_ts, created_block, created_ts, created_tx)
        VALUES (@contrat, @parts_contrat, @token_id, @vendeur, @prix_wei, @objectif_wei, @fin_ts, @block, @ts, @tx)`),
      offres: db.prepare('SELECT contrat FROM offres'),
      getOffre: db.prepare('SELECT * FROM offres WHERE lower(contrat) = lower(?)'),
      updOffre: db.prepare(`UPDATE offres SET collecte_wei = @collecte_wei, rembourse_wei = @rembourse_wei,
        parts_deposees = @parts_deposees, parts_vendues = @parts_vendues, parts_reclamees = @parts_reclamees,
        parts_recuperees = @parts_recuperees, fonds_retires = @fonds_retires WHERE contrat = @contrat`),
      insOp: db.prepare(`INSERT OR IGNORE INTO operations_offre (offre, type, acteur, parts, montant_wei, block, log_index, ts, tx)
        VALUES (@offre, @type, @acteur, @parts, @montant_wei, @block, @log_index, @ts, @tx)`)
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

    // 1) Registre + Factory de titrisation + Factory d'offres
    for (const [addr, iface] of [[this.registry, this.regIface], [this.factory, this.facIface], [this.saleFactory, this.saleFacIface]]) {
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

    // 2 bis) Contrats d'offre (connus + ceux créés dans cette même plage)
    const offres = new Set(this.sql.offres.all().map(r => r.contrat));
    for (const e of events) if (e.parsed.name === 'NouvelleOffre') offres.add(e.parsed.args.offre);
    if (offres.size) {
      for (const log of await this.provider.getLogs({ address: [...offres], ...range })) {
        const parsed = this.saleIface.parseLog({ topics: [...log.topics], data: log.data });
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
      case 'NouvelleOffre': {
        const token_id = this.sql.titParParts.get(a.parts)?.token_id ?? null;
        this.sql.insOffre.run({
          contrat: a.offre, parts_contrat: a.parts, token_id, vendeur: a.vendeur,
          prix_wei: String(a.prixParPart), objectif_wei: String(a.objectifMinimal), fin_ts: Number(a.finOffre),
          block: base.block, ts, tx: base.tx
        });
        evt({ type: 'OFFRE_CREEE', token_id, de: a.vendeur, vers: a.offre });
        break;
      }
      case 'Transfer': {
        // Transfert de parts (ERC-20) : seul nous intéresse un envoi VERS une offre = dépôt de parts en vente.
        const offre = this.sql.getOffre.get(a.to);
        if (!offre || /^0x0{40}$/i.test(a.from)) break;
        this.offreOp(offre, base, ts, 'DEPOT', { acteur: a.from, parts: Number(a.value) },
          (o) => { o.parts_deposees += Number(a.value); });
        break;
      }
      case 'InvestisseurAutorise': {
        const offre = this.sql.getOffre.get(log.address); if (!offre) break;
        this.offreOp(offre, base, ts, a.statut ? 'AUTORISATION' : 'RETRAIT_AUTORISATION', { acteur: a.investisseur });
        break;
      }
      case 'PartsReservees': {
        const offre = this.sql.getOffre.get(log.address); if (!offre) break;
        const nouveau = this.offreOp(offre, base, ts, 'ACHAT', { acteur: a.acheteur, parts: Number(a.nbParts), montant: String(a.montant) },
          (o) => { o.collecte_wei = (BigInt(o.collecte_wei || 0) + BigInt(a.montant)).toString(); o.parts_vendues += Number(a.nbParts); });
        if (nouveau) evt({ type: 'ACHAT_PARTS', token_id: offre.token_id, de: a.acheteur, vers: offre.contrat, valeur: String(a.nbParts) });
        break;
      }
      case 'PartsReclamees': {
        const offre = this.sql.getOffre.get(log.address); if (!offre) break;
        this.offreOp(offre, base, ts, 'RECLAMATION', { acteur: a.acheteur, parts: Number(a.nbParts) },
          (o) => { o.parts_reclamees += Number(a.nbParts); });
        break;
      }
      case 'Remboursement': {
        const offre = this.sql.getOffre.get(log.address); if (!offre) break;
        const nouveau = this.offreOp(offre, base, ts, 'REMBOURSEMENT', { acteur: a.acheteur, montant: String(a.montant) },
          (o) => { o.rembourse_wei = (BigInt(o.rembourse_wei || 0) + BigInt(a.montant)).toString(); });
        if (nouveau) evt({ type: 'REMBOURSEMENT', token_id: offre.token_id, vers: a.acheteur, de: offre.contrat });
        break;
      }
      case 'FondsRetires': {
        const offre = this.sql.getOffre.get(log.address); if (!offre) break;
        const nouveau = this.offreOp(offre, base, ts, 'FONDS_RETIRES', { acteur: a.vendeur, montant: String(a.montant) },
          (o) => { o.fonds_retires = 1; });
        if (nouveau) evt({ type: 'FONDS_RETIRES', token_id: offre.token_id, de: offre.contrat, vers: a.vendeur });
        break;
      }
      case 'PartsInvenduesRecuperees': {
        const offre = this.sql.getOffre.get(log.address); if (!offre) break;
        this.offreOp(offre, base, ts, 'RECUPERATION', { acteur: a.vendeur, parts: Number(a.nbParts) },
          (o) => { o.parts_recuperees += Number(a.nbParts); });
        break;
      }
    }
  }

  // Enregistre une opération d'offre dans le journal ET met à jour les totaux de l'offre.
  // Idempotent : si l'événement a déjà été indexé (même transaction + même position), rien n'est compté deux fois.
  // Renvoie true si l'opération est nouvelle.
  offreOp(offre, base, ts, type, { acteur = null, parts = null, montant = null } = {}, majTotaux = null) {
    const r = this.sql.insOp.run({
      offre: offre.contrat, type, acteur, parts, montant_wei: montant,
      block: base.block, log_index: base.log_index, ts, tx: base.tx
    });
    if (!r.changes) return false;
    if (majTotaux) {
      const o = { ...this.sql.getOffre.get(offre.contrat) };
      majTotaux(o);
      this.sql.updOffre.run({
        contrat: o.contrat, collecte_wei: o.collecte_wei, rembourse_wei: o.rembourse_wei, parts_deposees: o.parts_deposees,
        parts_vendues: o.parts_vendues, parts_reclamees: o.parts_reclamees, parts_recuperees: o.parts_recuperees, fonds_retires: o.fonds_retires
      });
    }
    return true;
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
