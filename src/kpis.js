// Couche "KPIs" : tous les indicateurs sont calculés en SQL à partir de la base.
function computeKpis(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const p = one(`SELECT COUNT(*) AS total, COALESCE(SUM(superficie),0) AS surface,
                        COALESCE(AVG(superficie),0) AS moyenne, COUNT(DISTINCT proprietaire) AS proprietaires
                 FROM parcelles`);
  const transferts = one("SELECT COUNT(*) AS n FROM evenements WHERE type = 'TRANSFERT'").n;

  // Une proposition est "en attente" si le dernier événement de vente d'une parcelle est une PROPOSITION.
  const enAttente = one(`SELECT COUNT(*) AS n FROM (
      SELECT type, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY block DESC, log_index DESC) AS rn
      FROM evenements WHERE type IN ('PROPOSITION','TRANSFERT','ANNULATION')
    ) WHERE rn = 1 AND type = 'PROPOSITION'`).n;

  const t = one(`SELECT COUNT(*) AS total,
                        COALESCE(SUM(CASE WHEN statut = 'ACTIVE' THEN 1 ELSE 0 END),0) AS actives,
                        COALESCE(SUM(CASE WHEN statut = 'ACTIVE' THEN parts_emises ELSE 0 END),0) AS parts
                 FROM titrisations`);

  return {
    parcelles: p.total,
    superficieTotale: p.surface,
    superficieMoyenne: Math.round(p.moyenne),
    proprietaires: p.proprietaires,
    transfertsValides: transferts,
    propositionsEnAttente: enAttente,
    titrisations: t.total,
    titrisationsActives: t.actives,
    partsEmises: t.parts,
    parVille: all(`SELECT ville, COUNT(*) AS nb, SUM(superficie) AS surface FROM parcelles
                   GROUP BY ville ORDER BY nb DESC, ville LIMIT 8`),
    parJour: all(`SELECT jour, nb FROM (
                    SELECT date(created_ts, 'unixepoch') AS jour, COUNT(*) AS nb FROM parcelles
                    GROUP BY jour ORDER BY jour DESC LIMIT 14) ORDER BY jour`),
    activite: all(`SELECT e.type, e.token_id, e.de, e.vers, e.valeur, e.ts, e.tx,
                          cd.nom AS de_nom, cv.nom AS vers_nom
                   FROM evenements e
                   LEFT JOIN contacts cd ON cd.address = e.de
                   LEFT JOIN contacts cv ON cv.address = e.vers
                   ORDER BY e.block DESC, e.log_index DESC LIMIT 10`)
  };
}

module.exports = { computeKpis };
