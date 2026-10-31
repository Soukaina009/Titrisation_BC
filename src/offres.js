// Offres publiques de parts (ICO / STO) : lecture de la base et calculs d'affichage.
// Les montants sont stockés en wei (TEXT) ; tous les calculs se font en BigInt pour ne jamais perdre de précision.

const WEI = 10n ** 18n;

// "3000000000000000" (wei) -> "0.003" (ETH), sans zéros inutiles.
function weiToEth(wei) {
  let b;
  try { b = BigInt(wei ?? 0); } catch { b = 0n; }
  const entier = b / WEI;
  const frac = (b % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${entier}.${frac}` : `${entier}`;
}

// EN_COURS tant que la date de fin n'est pas passée ; ensuite REUSSIE si l'objectif minimal est atteint, sinon ECHOUEE.
function statutOffre(row, nowSec) {
  if (nowSec < Number(row.fin_ts)) return 'EN_COURS';
  return BigInt(row.collecte_wei || 0) >= BigInt(row.objectif_wei || 0) ? 'REUSSIE' : 'ECHOUEE';
}

// Progression en % de l'objectif minimal (peut dépasser 100 : on plafonne l'affichage à 100 côté interface).
function progression(row) {
  const objectif = BigInt(row.objectif_wei || 0);
  if (objectif === 0n) return 100;
  return Number((BigInt(row.collecte_wei || 0) * 1000n) / objectif) / 10;
}

const BASE_SELECT = `SELECT o.*, p.numero_tf, p.localisation, c.nom AS vendeur_nom,
    (SELECT COUNT(DISTINCT acteur) FROM operations_offre x WHERE x.offre = o.contrat AND x.type = 'ACHAT') AS investisseurs,
    (SELECT COUNT(*) FROM operations_offre x WHERE x.offre = o.contrat) AS nb_operations
  FROM offres o
  LEFT JOIN parcelles p ON p.token_id = o.token_id
  LEFT JOIN contacts c ON c.address = o.vendeur`;

function decorate(row, nowSec) {
  const deposees = Number(row.parts_deposees || 0);
  const vendues = Number(row.parts_vendues || 0);
  const recuperees = Number(row.parts_recuperees || 0);
  const maxWei = BigInt(row.prix_wei || 0) * BigInt(deposees);   // ce que l'offre rapporterait si tout se vendait
  return {
    ...row,
    statut: statutOffre(row, nowSec),
    prix_eth: weiToEth(row.prix_wei),
    objectif_eth: weiToEth(row.objectif_wei),
    collecte_eth: weiToEth(row.collecte_wei),
    rembourse_eth: weiToEth(row.rembourse_wei),
    max_wei: maxWei.toString(),
    max_eth: weiToEth(maxWei),
    objectif_atteint: BigInt(row.collecte_wei || 0) >= BigInt(row.objectif_wei || 0),
    parts_disponibles: Math.max(0, deposees - recuperees - vendues),
    progression: progression(row),
    temps_restant: Math.max(0, Number(row.fin_ts) - nowSec)
  };
}

function listOffres(db, nowSec = Math.floor(Date.now() / 1000)) {
  return db.prepare(`${BASE_SELECT} ORDER BY o.created_ts DESC`).all().map(r => decorate(r, nowSec));
}

function offreDetail(db, contrat, nowSec = Math.floor(Date.now() / 1000)) {
  const row = db.prepare(`${BASE_SELECT} WHERE lower(o.contrat) = lower(?)`).get(String(contrat));
  if (!row) return null;
  return { ...decorate(row, nowSec), operations: operationsOffre(db, row.contrat) };
}

function operationsOffre(db, contrat, limit = 200) {
  return db.prepare(`SELECT op.type, op.acteur, op.parts, op.montant_wei, op.ts, op.tx, c.nom AS acteur_nom
      FROM operations_offre op LEFT JOIN contacts c ON c.address = op.acteur
      WHERE lower(op.offre) = lower(?) ORDER BY op.block DESC, op.log_index DESC LIMIT ?`)
    .all(String(contrat), limit)
    .map(o => ({ ...o, montant_eth: o.montant_wei != null ? weiToEth(o.montant_wei) : null }));
}

// Indicateurs de levée de fonds pour le tableau de bord.
function offresKpis(db, nowSec = Math.floor(Date.now() / 1000)) {
  const rows = db.prepare('SELECT * FROM offres').all();
  let enCours = 0, reussies = 0, echouees = 0, partsVendues = 0;
  let leves = 0n, enCoursWei = 0n;
  for (const r of rows) {
    const s = statutOffre(r, nowSec);
    if (s === 'EN_COURS') { enCours++; enCoursWei += BigInt(r.collecte_wei || 0); partsVendues += Number(r.parts_vendues || 0); }
    else if (s === 'REUSSIE') { reussies++; leves += BigInt(r.collecte_wei || 0); partsVendues += Number(r.parts_vendues || 0); }
    else echouees++;
  }
  const investisseurs = db.prepare("SELECT COUNT(DISTINCT acteur) AS n FROM operations_offre WHERE type = 'ACHAT'").get().n;
  return {
    total: rows.length, enCours, reussies, echouees,
    ethLeves: weiToEth(leves), ethEnCours: weiToEth(enCoursWei),
    partsVendues, investisseurs
  };
}

module.exports = { weiToEth, statutOffre, listOffres, offreDetail, operationsOffre, offresKpis };
