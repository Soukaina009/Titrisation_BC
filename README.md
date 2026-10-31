# Titrisation_BC — Registre Foncier Numérique sur blockchain

Application web mobile (PWA) pour gérer un registre foncier sur la blockchain **Ethereum Sepolia** :
immatriculer des parcelles (NFT), transférer la propriété sous contrôle du conservateur, **titriser** une parcelle
en parts (jetons ERC-20) et les **vendre au public via une offre (ICO / STO)** avec KYC et remboursement automatique.

> Projet académique, déployé sur un réseau de test. Aucun fonds réel n'est engagé.

**Démo (interface)** : https://soukaina009.github.io/Titrisation_BC/

---

## Sommaire
1. [Fonctionnalités](#1-fonctionnalités)
2. [Architecture en 3 tiers](#2-architecture-en-3-tiers)
3. [Les smart contracts](#3-les-smart-contracts)
4. [Rôles et acteurs](#4-rôles-et-acteurs)
5. [Parcours complet](#5-parcours-complet)
6. [Structure du projet](#6-structure-du-projet)
7. [Installation et démarrage](#7-installation-et-démarrage)
8. [Configuration (.env)](#8-configuration-env)
9. [Déployer les contrats (Remix)](#9-déployer-les-contrats-remix)
10. [Tableau de bord et KPIs](#10-tableau-de-bord-et-kpis)
11. [API REST](#11-api-rest)
12. [Mise en ligne et usage sur téléphone](#12-mise-en-ligne-et-usage-sur-téléphone)
13. [Dépannage](#13-dépannage)
14. [Limites et perspectives](#14-limites-et-perspectives)

---

## 1. Fonctionnalités

| Module | Ce que l'on peut faire |
|---|---|
| **Registre** | Immatriculer une parcelle (NFT ERC-721), consulter son historique, rechercher par titre, ville, propriétaire |
| **Vente / transfert** | Le propriétaire propose la vente, le conservateur valide ou annule le transfert |
| **Titrisation** | Diviser une parcelle en N parts (ERC-20) via une Factory, un contrat par parcelle |
| **Offres de parts (ICO / STO)** | Créer une offre (prix par part, durée, objectif minimal), acheter, réclamer ses parts, être remboursé si l'objectif n'est pas atteint |
| **KYC** | Le conservateur autorise les investisseurs, offre par offre |
| **Journal** | Historique des opérations de vente avec lien Etherscan pour chaque transaction |
| **Tableau de bord** | KPIs, répartition par ville, activité récente, ETH levés, parts vendues |
| **PWA** | Installable sur téléphone, utilisable comme une application |

## 2. Architecture en 3 tiers

| Tier | Rôle | Technologies | Fichiers |
|---|---|---|---|
| **Présentation (UI)** | Interface, connexion au portefeuille, signature des transactions | HTML/CSS/JS, ethers.js v5, PWA | `public/` |
| **Logique (API)** | Routes REST, KPIs, indexeur d'événements | Node.js, Express, ethers v6 | `server.js`, `src/` |
| **Données** | Copie interrogeable de la blockchain + carnet d'adresses | SQLite (better-sqlite3) | `data/registre.db` |

```
 Utilisateur ─► Interface (navigateur) ─► API Express ─► SQLite ◄─ Indexeur ◄─ Blockchain (Sepolia)
                     │                                                              ▲
                     └──── portefeuille (MetaMask) : signe les transactions ────────┘
```

**Qui fait quoi.** La blockchain reste la **source de vérité** : toutes les écritures (immatriculer, vendre, titriser,
acheter des parts) passent par le portefeuille et les smart contracts. La base SQLite ne fait que *copier* les
événements des contrats pour ce que la blockchain fait mal : rechercher, agréger (KPIs), lister rapidement, et stocker
des données non publiques (noms du carnet d'adresses). La base peut être effacée et reconstruite à tout moment
(`npm run reindex`).

## 3. Les smart contracts

Solidity 0.8.20, OpenZeppelin 4.9.6. Cinq contrats répartis dans trois fichiers de `contracts/` :

| Contrat | Standard | Rôle |
|---|---|---|
| `LandTitleRegistry` | ERC-721 + AccessControl | Registre : 1 parcelle = 1 NFT unique. Rôle `CONSERVATEUR_ROLE` |
| Factory de titrisation | — | Crée un contrat de titrisation par parcelle (dans `LandSecuritizationToken.sol`) |
| `LandSecuritizationToken` | ERC-20 | Parts d'une parcelle (jetons fongibles) |
| `LandPartsSaleFactory` | — | Crée une offre publique de parts, vérifie que le vendeur est bien le bénéficiaire |
| `LandPartsSale` | ReentrancyGuard | Une offre : KYC, séquestre (escrow), objectif minimal, réclamation, remboursement |

**Pourquoi deux standards ?** Une parcelle est unique et indivisible → **ERC-721**. Ses parts sont identiques et
divisibles → **ERC-20**. Le NFT prouve la propriété, les jetons permettent de la fractionner et de la financer.

**Mécanisme de l'offre (escrow) :**
1. Le vendeur crée l'offre puis y dépose ses parts.
2. L'investisseur, autorisé par le conservateur (KYC), achète : ses parts sont **réservées**, son ETH est bloqué.
3. À la fin de la durée :
   - **objectif atteint** → les acheteurs réclament leurs parts, le vendeur retire les fonds ;
   - **objectif non atteint** → chaque acheteur se fait rembourser, le vendeur récupère ses parts.

## 4. Rôles et acteurs

| Acteur | Droits |
|---|---|
| **Conservateur** (`CONSERVATEUR_ROLE`) | Immatricule, valide les transferts, **valide le KYC** des investisseurs |
| **Propriétaire / vendeur** | Propose une vente, titrise, crée une offre, retire les fonds ou récupère les parts invendues |
| **Investisseur** | Achète des parts s'il est autorisé, réclame ses parts ou se fait rembourser |
| **Visiteur** | Consulte le registre, le tableau de bord et les offres (lecture seule) |

## 5. Parcours complet

1. **Immatriculer** une parcelle (conservateur) → NFT créé.
2. **Titriser** la parcelle (propriétaire) → un contrat ERC-20 est créé, les parts sont émises.
3. **Créer une offre** (onglet « Offres », 2 transactions) : création de l'offre, puis dépôt des parts.
4. **Autoriser les investisseurs** (conservateur, onglet détail de l'offre).
5. **Acheter** des parts (investisseur, montant = nombre de parts × prix, exact).
6. **Clôture** : réclamer les parts / retirer les fonds, ou rembourser / récupérer les parts invendues.
7. **Vérifier** chaque transaction sur Etherscan depuis le journal des opérations.

## 6. Structure du projet

```
Titrisation_BC/
├── contracts/                  Smart contracts (à déployer avec Remix)
│   ├── LandTitleRegistry.sol
│   ├── LandSecuritizationToken.sol      (token ERC-20 + factory de titrisation)
│   └── LandPartsSaleFactory.sol         (factory d'offres + offre)
├── .github/workflows/          Workflow GitHub Actions (déploiement / intégration)
├── public/                     TIER 1 : interface (PWA)
│   └── index.html              (+ manifest, service worker et icônes de la PWA)
├── server.js                   TIER 2 : serveur Express, routes API
├── src/
│   ├── abis.js                 ABI minimales des contrats
│   ├── indexer.js              Lit les événements de la blockchain
│   ├── kpis.js                 Indicateurs du tableau de bord
│   ├── offres.js               Logique des offres (statut, progression, journal)
│   └── db.js                   TIER 3 : schéma SQLite
├── data/                       Base SQLite (générée, non versionnée)
├── .env.example                Modèle de configuration (à copier en .env)
├── .gitignore
├── package.json
└── package-lock.json
```

## 7. Installation et démarrage

**Prérequis** : [Node.js](https://nodejs.org) 18 ou plus (version LTS) et [Git](https://git-scm.com).
Un portefeuille MetaMask configuré sur Sepolia, avec un peu d'ETH de test.

```bash
git clone https://github.com/Soukaina009/Titrisation_BC.git
cd Titrisation_BC
npm install
cp .env.example .env        # sous Windows : copy .env.example .env
# éditer .env (voir section suivante)
npm start
```

Ouvrir ensuite **http://localhost:9000**. Sans configuration, l'interface démarre quand même (mode portefeuille seul)
et le tableau de bord indique ce qu'il manque.

## 8. Configuration (.env)

| Variable | Obligatoire | Description |
|---|---|---|
| `RPC_URL` | oui | RPC Sepolia **qui garde l'historique** (ex. `https://ethereum-sepolia-rpc.publicnode.com`) |
| `REGISTRY_ADDRESS` | oui | Adresse de `LandTitleRegistry` |
| `FACTORY_ADDRESS` | oui | Adresse de la factory de titrisation |
| `SALE_FACTORY_ADDRESS` | oui pour les offres | Adresse de `LandPartsSaleFactory`. **À renseigner avant de créer la première offre** |
| `START_BLOCK` | oui | Bloc de déploiement du registre |
| `PORT` | non | Port du serveur (9000 par défaut) |
| `LOG_CHUNK` | non | Taille des lots de lecture des logs (2000) |
| `CONFIRMATIONS` | non | Confirmations avant indexation (1) |
| `POLL_MS` | non | Intervalle de synchronisation en ms (15000) |

**Trouver `START_BLOCK`** : sur sepolia.etherscan.io, ouvrir l'adresse du registre → « Contract Creator » → lien
« at txn » → noter le **Block**. Plus il est proche du déploiement, plus la première synchronisation est rapide.

> Si vous ajoutez `SALE_FACTORY_ADDRESS` après coup, lancez `npm run reindex` pour que l'indexeur relise l'historique.
> Ne publiez **jamais** votre fichier `.env`.

## 9. Déployer les contrats (Remix)

1. Ouvrir https://remix.ethereum.org, importer les fichiers de `contracts/`.
2. Compiler en Solidity **0.8.20**.
3. Environnement « Injected Provider – MetaMask » sur **Sepolia**.
4. Déployer dans cet ordre :
   1. `LandTitleRegistry`
   2. la factory de titrisation, dans `LandSecuritizationToken.sol` (paramètre : adresse du registre)
   3. `LandPartsSaleFactory` (paramètres : adresse du registre, adresse de la factory de titrisation)
5. Reporter les adresses dans `.env`, ainsi que le bloc de déploiement dans `START_BLOCK`.
6. Donner le `CONSERVATEUR_ROLE` au compte qui validera transferts et KYC.

Les offres se créent ensuite depuis l'interface (onglet « Offres »), pas depuis Remix : une offre déployée à la main
n'est pas suivie par l'indexeur.

## 10. Tableau de bord et KPIs

Parcelles, superficie totale et moyenne, propriétaires distincts, transferts validés, ventes en attente, titrisations
(actives / total), parts émises, répartition par ville, immatriculations par jour, activité récente, registre complet
avec recherche, carnet d'adresses. **Offres** : nombre total / en cours / réussies / échouées, ETH levés
(offres réussies uniquement), parts vendues, nombre d'investisseurs.

## 11. API REST

| Route | Contenu |
|---|---|
| `GET /api/config` | Adresses des contrats, réseau, explorateur |
| `GET /api/kpis` | Tous les indicateurs + état de synchronisation |
| `GET /api/parcelles?q=` | Liste / recherche (titre, ville, propriétaire, nom, tokenId) |
| `GET /api/parcelles/:id` | Une parcelle + historique + titrisation |
| `GET /api/titrisations` | Contrats de titrisation |
| `GET /api/offres?parcelle=` | Liste des offres (filtre optionnel par parcelle) |
| `GET /api/offres/:adresse` | Détail d'une offre + journal des opérations |
| `GET/PUT /api/contacts` | Carnet d'adresses (`PUT` avec `{"nom": "..."}`, nom vide = suppression) |

## 12. Mise en ligne et usage sur téléphone

- **Tout-en-un (recommandé)** : héberger le dossier sur un service Node gratuit (Render, Railway…) en saisissant les
  variables de `.env` dans l'interface du service. L'interface et l'API partagent la même adresse.
  Sur l'offre gratuite de Render le disque est éphémère : la base se reconstruit depuis la blockchain, mais le
  **carnet d'adresses est perdu** sans disque persistant.
- **Interface séparée (GitHub Pages)** : ouvrir une fois la page avec `?api=https://votre-serveur` pour qu'elle
  retienne l'adresse de l'API.
- **Installer sur téléphone** : ouvrir l'adresse dans Chrome ou Safari → « Ajouter à l'écran d'accueil ».

## 13. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `npm` / `git` introuvable | Non installé ou terminal pas redémarré | Installer Node.js / Git, **fermer et rouvrir VS Code** |
| `Cannot GET /` | `public/index.html` absent ou mal placé | Le remettre dans `public/`, relancer `npm start` depuis le dossier de `server.js` |
| « pruned history unavailable » | RPC sans historique | Utiliser un autre RPC Sepolia (publicnode) |
| Liste d'offres vide | `SALE_FACTORY_ADDRESS` absente du `.env` à la création | Renseigner l'adresse puis `npm run reindex` |
| « Montant ETH incorrect » | Valeur ≠ nombre de parts × prix | Envoyer exactement `coutPour(nbParts)` |
| « Pas assez de parts disponibles » | Les parts n'ont pas été déposées dans l'offre | Utiliser « Déposer des parts » dans le détail de l'offre |
| Erreur `better-sqlite3` après copie sur un autre PC | Binaire compilé pour l'ancienne machine | Supprimer `node_modules`, relancer `npm install` |
| Avertissement `memory-safe-assembly` dans Remix | Notice de dépréciation d'OpenZeppelin 4.9.6 | Sans conséquence |

## 14. Limites et perspectives

**Limites à citer dans le rapport**
- Le carnet d'adresses n'a **pas d'authentification** : à protéger avant une vraie mise en ligne.
- La base est une copie : le tableau de bord a quelques secondes de retard sur la blockchain.
- Le KYC est **par offre** : un investisseur doit être autorisé pour chaque offre.
- Les parts (ERC-20) restent librement transférables après l'offre : pas de restriction de revente.
- Les contrats ont été testés par simulation ; un audit serait nécessaire avant tout usage réel.
- Un vrai système lierait chaque adresse à une identité (CIN) **hors blockchain**, dans une base protégée :
  le carnet d'adresses en est la maquette.

**Perspectives**
- Standards de jetons de sécurité à transferts restreints (ERC-3643, ERC-1400).
- KYC global et registre d'identité on-chain.
- Marché secondaire des parts, distribution de loyers aux porteurs de parts.
- Application native ou intégration d'un oracle de prix.

## Licence
Projet pédagogique. Usage libre à des fins d'apprentissage.