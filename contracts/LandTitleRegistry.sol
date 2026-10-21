// SPDX-License-Identifier: MIT
// ↑ "SPDX-License-Identifier" est une ligne obligatoire (sinon le compilateur affiche un warning).
//   Elle indique sous quelle licence le code est publié. "MIT" = licence libre très permissive.

pragma solidity ^0.8.20;
// ↑ "pragma" indique au compilateur QUELLE version de Solidity utiliser.
//   Le symbole "^" veut dire "cette version ou toute version compatible plus récente (0.8.x)".
//   Depuis Solidity 0.8, les dépassements de nombres (overflow/underflow) sont automatiquement
//   bloqués par le compilateur (avant, il fallait une librairie externe "SafeMath").

// ------------------------------------------------------------------
// IMPORTS : on réutilise du code déjà écrit et audité par OpenZeppelin,
// plutôt que de réinventer la logique NFT et la gestion des rôles.
// Remix va automatiquement les télécharger depuis GitHub.
// ------------------------------------------------------------------
// On précise la VERSION exacte d'OpenZeppelin (4.9.6) pour éviter que Remix télécharge
// automatiquement une version plus récente qui exigerait un compilateur Solidity plus récent
// que 0.8.20 (erreur "Source file requires different compiler version").
import "@openzeppelin/contracts@4.9.6/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts@4.9.6/access/AccessControl.sol";

/// @title LandTitleRegistry
/// @notice Registre foncier numérique : chaque parcelle immatriculée devient un NFT (ERC-721).
/// @dev Les commentaires précédés de "///" sont des commentaires "NatSpec" : Solidity les reconnaît
///      officiellement et des outils (Remix, Etherscan) les affichent automatiquement comme documentation.

// "contract" = mot-clé qui déclare un smart contract (l'équivalent d'une "classe" en programmation objet).
// "is ERC721, AccessControl" = HÉRITAGE : notre contrat récupère toutes les fonctions de ces deux contrats.
contract LandTitleRegistry is ERC721, AccessControl {

    // ================================================================
    // 1. DÉCLARATION DES RÔLES
    // ================================================================

    // "bytes32" est un type de donnée : une suite fixe de 32 octets. On l'utilise ici comme
    // identifiant unique de rôle. keccak256() est une fonction de hachage cryptographique :
    // elle transforme le texte "CONSERVATEUR_ROLE" en une empreinte numérique unique et fixe.
    // "public" = visible et lisible par n'importe qui, gratuitement, depuis l'extérieur.
    // "constant" = la valeur est calculée une seule fois à la compilation, jamais modifiée (économise du gas).
    bytes32 public constant CONSERVATEUR_ROLE = keccak256("CONSERVATEUR_ROLE");

    // ================================================================
    // 2. STRUCTURES DE DONNÉES
    // ================================================================

    // "struct" permet de regrouper plusieurs informations liées sous un seul type personnalisé,
    // comme un petit tableau/objet. Ici, chaque parcelle a ses propres informations cadastrales.
    struct Parcelle {
        string numeroTitreFoncier; // Numéro officiel du titre foncier (ex: délivré par l'ANCFCC)
        string localisation;       // Référence cadastrale ou hash IPFS du plan géométrique
        uint256 superficieM2;      // Superficie en mètres carrés. "uint256" = entier positif, 256 bits.
        bool estActive;            // Permet de "désactiver" un titre (ex: fusion de parcelles) sans le supprimer
    }

    // ================================================================
    // 3. VARIABLES D'ÉTAT (stockées en permanence sur la blockchain)
    // ================================================================

    // "mapping" est l'équivalent d'un dictionnaire / table de correspondance clé → valeur.
    // Ici : identifiant du NFT (tokenId) → informations de la parcelle correspondante.
    mapping(uint256 => Parcelle) private _parcelles;

    // Un second mapping pour gérer les demandes de vente en attente de validation.
    // tokenId => adresse de l'acheteur proposé (address(0) si aucune demande en cours).
    mapping(uint256 => address) public propositionAchat;

    // Compteur interne pour générer des identifiants de parcelle uniques et croissants.
    // "private" = accessible uniquement à l'intérieur de ce contrat.
    uint256 private _prochainTokenId;

    // ================================================================
    // 4. ÉVÉNEMENTS
    // ================================================================
    // Un "event" ne coûte presque rien en gas et sert à "logger" une action importante.
    // Les applications externes (sites web, indexeurs) écoutent ces événements en temps réel
    // pour savoir ce qui se passe sur le contrat, sans avoir à scanner toute la blockchain.

    event ParcelleImmatriculee(uint256 indexed tokenId, address indexed proprietaire, string numeroTitreFoncier);
    event VenteProposee(uint256 indexed tokenId, address indexed vendeur, address indexed acheteur);
    event TransfertValide(uint256 indexed tokenId, address indexed ancienProprietaire, address indexed nouveauProprietaire);
    event PropositionAnnulee(uint256 indexed tokenId);

    // ================================================================
    // 5. CONSTRUCTEUR
    // ================================================================
    // Le "constructor" s'exécute UNE SEULE FOIS, au moment du déploiement du contrat.
    constructor() ERC721("Titre Foncier Marocain", "TFM") {
        // "msg.sender" est une variable globale Solidity : l'adresse qui a envoyé la transaction
        // en cours. Ici, au déploiement, c'est l'adresse qui déploie le contrat (ex: l'ANCFCC).

        // On donne à l'administrateur du déploiement le rôle "admin" par défaut d'AccessControl,
        // ce qui lui permet ensuite d'attribuer/révoquer le rôle CONSERVATEUR_ROLE à d'autres adresses.
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // On donne aussi directement le rôle de conservateur au déployeur pour pouvoir tester tout de suite.
        _grantRole(CONSERVATEUR_ROLE, msg.sender);
    }

    // ================================================================
    // 6. IMMATRICULATION D'UNE NOUVELLE PARCELLE (création du NFT)
    // ================================================================

    /// @notice Crée un nouveau titre foncier numérique et le rattache à un propriétaire.
    /// @dev "onlyRole(...)" est un MODIFIER fourni par AccessControl : il exécute une vérification
    ///      AVANT le corps de la fonction, et bloque l'exécution (revert) si la condition échoue.
    ///      Seule une adresse ayant le rôle CONSERVATEUR_ROLE peut appeler cette fonction.
    function immatriculerParcelle(
        address proprietaire,          // "address" = type représentant un compte/portefeuille Ethereum
        string memory numeroTitreFoncier, // "memory" = donnée temporaire, effacée après l'exécution
        string memory localisation,
        uint256 superficieM2
    )
        public                          // visible et appelable depuis l'extérieur du contrat
        onlyRole(CONSERVATEUR_ROLE)     // condition d'accès : seul le conservateur peut immatriculer
        returns (uint256)               // la fonction renvoie l'identifiant du nouveau NFT créé
    {
        // "require" vérifie une condition ; si elle est fausse, TOUTE la transaction est annulée
        // (rollback complet, le gas déjà consommé n'est pas remboursé) et le message d'erreur est renvoyé.
        require(proprietaire != address(0), "Adresse proprietaire invalide");
        require(bytes(numeroTitreFoncier).length > 0, "Numero de titre foncier requis");

        uint256 nouveauTokenId = _prochainTokenId;
        _prochainTokenId++; // on incrémente le compteur pour la prochaine parcelle

        // "_safeMint" est une fonction INTERNE héritée d'ERC721 : elle crée le NFT et l'attribue au propriétaire.
        // On l'utilise plutôt qu'un simple "mint" car elle vérifie que l'adresse destinataire peut bien
        // recevoir des NFT (sécurité supplémentaire si le destinataire est un autre contrat).
        _safeMint(proprietaire, nouveauTokenId);

        // On enregistre les informations cadastrales associées à ce nouveau token.
        _parcelles[nouveauTokenId] = Parcelle({
            numeroTitreFoncier: numeroTitreFoncier,
            localisation: localisation,
            superficieM2: superficieM2,
            estActive: true
        });

        // "emit" déclenche l'événement défini plus haut, pour que le monde extérieur soit notifié.
        emit ParcelleImmatriculee(nouveauTokenId, proprietaire, numeroTitreFoncier);

        return nouveauTokenId;
    }

    // ================================================================
    // 7. PROCESSUS DE TRANSFERT EN 2 ÉTAPES (comme une vente notariée réelle)
    // ================================================================
    // Étape A : le propriétaire propose une vente à un acheteur précis.
    // Étape B : le conservateur (l'autorité) valide et exécute réellement le transfert.
    // Ce flux imite le rôle réel du notaire/conservateur qui valide un acte avant transcription.

    /// @notice Le propriétaire actuel propose de vendre sa parcelle à une adresse précise.
    function proposerVente(uint256 tokenId, address acheteur) public {
        // "ownerOf" est une fonction fournie par ERC721 : elle renvoie le propriétaire actuel du NFT.
        require(ownerOf(tokenId) == msg.sender, "Seul le proprietaire peut proposer une vente");
        require(acheteur != address(0), "Adresse acheteur invalide");
        require(_parcelles[tokenId].estActive, "Parcelle inactive");

        propositionAchat[tokenId] = acheteur;

        emit VenteProposee(tokenId, msg.sender, acheteur);
    }

    /// @notice Le propriétaire peut annuler sa proposition avant validation.
    function annulerProposition(uint256 tokenId) public {
        require(ownerOf(tokenId) == msg.sender, "Seul le proprietaire peut annuler");
        require(propositionAchat[tokenId] != address(0), "Aucune proposition en cours");

        delete propositionAchat[tokenId]; // "delete" remet la variable à sa valeur par defaut (ici address(0))

        emit PropositionAnnulee(tokenId);
    }

    /// @notice Seul le conservateur (l'autorité foncière) peut valider et exécuter le transfert.
    ///         C'est cette étape qui représente, dans la vraie vie, l'enregistrement officiel
    ///         du changement de propriétaire par l'ANCFCC.
    function validerTransfert(uint256 tokenId) public onlyRole(CONSERVATEUR_ROLE) {
        address acheteur = propositionAchat[tokenId];
        require(acheteur != address(0), "Aucune proposition de vente en attente");

        address vendeur = ownerOf(tokenId);

        // On efface la proposition avant le transfert (bonne pratique : éviter la réentrance).
        delete propositionAchat[tokenId];

        // "_transfer" est une fonction INTERNE d'ERC721 (pas exposée publiquement).
        // Contrairement à "transferFrom" (public), elle ne peut être appelée que depuis
        // l'intérieur du contrat, ce qui empêche un transfert direct sans validation officielle.
        _transfer(vendeur, acheteur, tokenId);

        emit TransfertValide(tokenId, vendeur, acheteur);
    }

    // ================================================================
    // 8. BLOCAGE DES TRANSFERTS "LIBRES" HÉRITÉS D'ERC721
    // ================================================================
    // Par défaut, ERC721 permet à n'importe quel propriétaire de transférer librement son NFT
    // via transferFrom/safeTransferFrom. Ici, on veut FORCER le passage par validerTransfert().
    // "override" indique qu'on réécrit une fonction déjà définie dans le contrat parent (ERC721).

    function transferFrom(address, address, uint256) public pure override(ERC721) {
        // "pure" = cette fonction ne lit ni ne modifie aucune donnée de la blockchain.
        // "revert" arrête immédiatement l'exécution avec un message d'erreur explicite.
        revert("Transfert direct interdit : utilisez proposerVente() puis validerTransfert()");
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override(ERC721) {
        revert("Transfert direct interdit : utilisez proposerVente() puis validerTransfert()");
    }

    // ================================================================
    // 9. FONCTIONS DE LECTURE (consultation publique et gratuite)
    // ================================================================
    // "view" = la fonction lit des données mais n'en modifie aucune. Appeler une fonction "view"
    // depuis l'extérieur (ex: un site web) ne coûte AUCUN gas, car aucune transaction n'est créée.

    /// @notice Consulter toutes les informations cadastrales d'une parcelle.
    function consulterParcelle(uint256 tokenId)
        public
        view
        returns (
            string memory numeroTitreFoncier,
            string memory localisation,
            uint256 superficieM2,
            bool estActive,
            address proprietaireActuel
        )
    {
        require(_ownerOf(tokenId) != address(0), "Cette parcelle n'existe pas");
        Parcelle memory p = _parcelles[tokenId];
        return (p.numeroTitreFoncier, p.localisation, p.superficieM2, p.estActive, ownerOf(tokenId));
    }

    // ================================================================
    // 10. COMPATIBILITÉ ENTRE HÉRITAGES MULTIPLES
    // ================================================================
    // ERC721 ET AccessControl définissent tous les deux une fonction "supportsInterface".
    // Quand on hérite des deux, Solidity EXIGE qu'on précise explicitement comment les combiner.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
        // "super" appelle la version de la fonction définie dans le(s) contrat(s) parent(s).
    }
}
