# Registre Foncier Numérique : application en 3 parties

Application web complète pour le registre foncier sur blockchain, construite en trois parties :

| Partie | Rôle | Fichiers |
|---|---|---|
| **Interface (UI)** | Consulter, immatriculer, vendre, titriser, **offres de parts (ICO/STO)**, tableau de bord | `public/index.html` (PWA installable) |
| **KPIs** | Indicateurs calculés à partir de la base (dont les offres : `src/offres.js`) | `src/kpis.js` → `GET /api/kpis` |
| **Base de données** | SQLite : copie interrogeable de la blockchain + carnet d'adresses | `src/db.js`, `src/indexer.js`, `data/registre.db` |

```
 Utilisateur ──► Interface (navigateur) ──► API Express ──► SQLite ◄── Indexeur ◄── Blockchain (Sepolia)
                      │                                                               ▲
                      └──── portefeuille (MetaMask) : signe les transactions ─────────┘
```

**Qui fait quoi.** La blockchain reste la source de vérité : les écritures (immatriculer, vendre, titriser) passent
par le portefeuille et les smart contracts. La base ne fait que *copier* les événements des contrats pour permettre
ce que la blockchain fait mal : rechercher, agréger (KPIs), lister tout le registre rapidement, et stocker des
données qui ne doivent pas être publiques (les noms du carnet d'adresses).
Conséquence pratique : la base peut être effacée et reconstruite à tout moment (`npm run reindex`).

## Démarrage

Prérequis : Node.js 18 ou plus récent.

```bash
npm install
cp .env.example .env      # sous Windows : copy .env.example .env
# éditez .env : REGISTRY_ADDRESS, FACTORY_ADDRESS, SALE_FACTORY_ADDRESS, START_BLOCK
npm start
```

Ouvrez ensuite **http://localhost:9000**. Sans configuration, l'interface démarre quand même (mode portefeuille seul),
et l'onglet « Tableau de bord » vous dit qu'il manque la configuration.

### Trouver START_BLOCK
Sur sepolia.etherscan.io, ouvrez l'adresse de votre `LandTitleRegistry` → ligne « Contract Creator » → cliquez sur
le lien de la transaction (« at txn ») → notez le **Block** : c'est votre `START_BLOCK`. Plus il est proche de la
date de déploiement, plus la première synchronisation est rapide.

## Ce que montre le tableau de bord
Parcelles, superficie totale et moyenne, offres de parts (en cours / réussies / échouées, ETH levés, investisseurs), propriétaires distincts, transferts validés, ventes en attente
(dernier événement d'une parcelle = proposition non validée ni annulée), titrisations (actives / total),
parts émises, répartition par ville, immatriculations par jour, activité récente, registre complet avec recherche,
carnet d'adresses.

## Offres publiques de parts (ICO / STO)
Onglet **💰 Offres** : le bénéficiaire d'une parcelle titrisée lève des fonds en vendant une partie de ses parts contre de l'ETH.

1. **Créer** (bénéficiaire) : parcelle, nombre de parts, prix d'une part, objectif minimal (% de l'offre) et durée. L'interface lance 2 transactions : création de l'offre (via la `LandPartsSaleFactory`) puis dépôt des parts.
2. **Autoriser** (conservateur) : chaque investisseur est validé offre par offre (KYC, la vérification d'identité se fait hors blockchain).
3. **Acheter** (investisseur autorisé) : le coût exact en ETH est calculé par l'interface. Parts et ETH restent en séquestre dans le contrat.
4. **À la fin** : objectif atteint → les investisseurs **réclament** leurs parts et le vendeur **retire** les fonds ; sinon → chacun est **remboursé** et le vendeur **récupère** ses parts.

Chaque transaction affiche un lien **Etherscan** de vérification, et le **journal des opérations** de l'offre (alimenté par l'indexeur) donne un lien de preuve par ligne.

### Mise en place
1. Dans Remix, compilez `contracts/LandPartsSaleFactory.sol` (Solidity 0.8.20+) et déployez **uniquement** `LandPartsSaleFactory` avec 2 paramètres : l'adresse du `LandTitleRegistry` et celle de la `LandSecuritizationFactory` (la Factory de titrisation).
2. Ajoutez l'adresse obtenue dans `.env` : `SALE_FACTORY_ADDRESS=0x...` (ou dans l'onglet Offres, champ « Adresse du contrat LandPartsSaleFactory »).
3. Redémarrez `npm start` (pas besoin de `npm run reindex` : l'indexeur continue là où il en était).

Les offres créées avant ce déploiement (contrats déployés à la main dans Remix) ne sont pas suivies par l'application.

## API
| Route | Contenu |
|---|---|
| `GET /api/config` | adresses des contrats, réseau, explorateur |
| `GET /api/kpis` | tous les indicateurs + état de synchronisation |
| `GET /api/parcelles?q=` | liste/recherche (titre, ville, propriétaire, nom, tokenId) |
| `GET /api/parcelles/:id` | une parcelle + historique + titrisation |
| `GET /api/titrisations` | contrats de titrisation |
| `GET /api/offres?parcelle=` | offres de parts (statut, progression, montants) |
| `GET /api/offres/:adresse` | une offre + journal de ses opérations |
| `GET/PUT /api/contacts` | carnet d'adresses (`PUT` avec `{"nom": "..."}`, nom vide = suppression) |

## Mise en ligne (accès depuis un téléphone)
Le plus simple : héberger **tout le dossier** sur un service Node gratuit (Render, Railway…), avec les variables de
`.env` saisies dans l'interface du service. L'interface et l'API partagent alors la même adresse, sans réglage.
Attention : sur l'offre gratuite de Render le disque est éphémère. La base se reconstruit seule depuis la
blockchain au redémarrage, mais **le carnet d'adresses est perdu** sans disque persistant.
Interface ailleurs (par exemple GitHub Pages) : ouvrez-la une fois avec `?api=https://votre-serveur` pour qu'elle
retienne l'adresse de l'API.

## Limites à connaître (à citer dans le rapport)
- Le carnet d'adresses n'a **pas d'authentification** : à protéger avant une vraie mise en ligne.
- La base est une copie : le tableau de bord a quelques secondes de retard sur la blockchain (`POLL_MS`, `CONFIRMATIONS`).
- La localisation et la superficie sont lues sur le contrat au moment de l'indexation (elles ne changent pas).
- L'autorisation KYC est propre à **chaque offre** (un investisseur doit être ré-autorisé sur une nouvelle offre).
- La date de fin d'une offre se base sur l'heure de la blockchain ; l'état « Réussie / Échouée » de la liste vient de l'horloge du serveur (écart de quelques secondes possible).
- Un vrai système lierait chaque adresse à une identité (CIN) **hors blockchain**, dans une base protégée : le carnet d'adresses en est la maquette.

## Contrats
`contracts/LandTitleRegistry.sol` (registre ERC-721 + rôle conservateur), `contracts/LandSecuritizationToken.sol`
(titrisation + Factory) et `contracts/LandPartsSaleFactory.sol` (offre publique `LandPartsSale` + Factory d'offres).
Déploiement avec Remix, comme avant.
