// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Même version d'OpenZeppelin que les autres contrats du projet (compatible Solidity 0.8.20).
import "@openzeppelin/contracts@4.9.6/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts@4.9.6/security/ReentrancyGuard.sol";

/// @title LandPartsSale + LandPartsSaleFactory
/// @notice Ce fichier contient DEUX contrats :
///         1) LandPartsSale : l'offre publique (ICO / STO) des parts d'UNE parcelle titrisée.
///            Objectif minimal (soft cap), remboursement si l'objectif n'est pas atteint,
///            investisseurs validés par un conservateur (KYC).
///         2) LandPartsSaleFactory : une "usine" déployée UNE SEULE FOIS, qui crée une offre
///            par simple appel depuis l'application, sans repasser par Remix.

/// Lecture des rôles du registre foncier (AccessControl) : sert à savoir qui est conservateur.
interface IRegistreRoles {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// Lecture du contrat de titrisation d'une parcelle.
interface ITitrisation {
    function beneficiaireInitial() external view returns (address);
    function estTitrise() external view returns (bool);
    function parcelTokenId() external view returns (uint256);
}

/// Lecture de la Factory de titrisation : sert à vérifier qu'un contrat de parts est bien authentique.
interface ITitrisationFactory {
    function contratTitrisationDe(uint256 parcelTokenId) external view returns (address);
}

// ============================================================================
// CONTRAT 1 : LandPartsSale (une instance = une offre)
// ============================================================================
contract LandPartsSale is ReentrancyGuard {

    // Même identifiant de rôle que dans LandTitleRegistry : keccak256("CONSERVATEUR_ROLE").
    bytes32 private constant CONSERVATEUR_ROLE = keccak256("CONSERVATEUR_ROLE");

    // ---------------- Paramètres fixés à la création ----------------
    IERC20 public immutable parts;               // contrat de titrisation (ERC-20) dont on vend les parts
    address public immutable registre;           // registre foncier : sert à vérifier le rôle conservateur
    address public immutable vendeur;            // le bénéficiaire qui met ses parts en vente
    uint256 public immutable prixParPart;        // prix d'UNE part, en wei
    uint256 public immutable objectifMinimalWei; // soft cap : montant minimal à collecter, en wei
    uint256 public immutable finOffre;           // date de fin de l'offre (timestamp)

    // ---------------- État de l'offre ----------------
    uint256 public totalCollecte;        // total d'ETH reçu
    uint256 public totalPartsReservees;  // parts achetées mais pas encore réclamées
    bool public fondsRetires;            // vrai quand le vendeur a encaissé

    mapping(address => bool) public autorise;          // liste blanche (KYC)
    mapping(address => uint256) public partsReservees; // parts réservées par acheteur
    mapping(address => uint256) public ethDepense;     // ETH dépensé par acheteur (remboursable si échec)

    // ---------------- Événements (lus par l'indexeur) ----------------
    event InvestisseurAutorise(address indexed investisseur, bool statut);
    event PartsReservees(address indexed acheteur, uint256 nbParts, uint256 montant);
    event PartsReclamees(address indexed acheteur, uint256 nbParts);
    event Remboursement(address indexed acheteur, uint256 montant);
    event FondsRetires(address indexed vendeur, uint256 montant);
    event PartsInvenduesRecuperees(address indexed vendeur, uint256 nbParts);

    constructor(
        address _parts,
        address _registre,
        address _vendeur,
        uint256 _prixParPartWei,
        uint256 _objectifMinimalWei,
        uint256 _dureeMinutes
    ) {
        require(_prixParPartWei > 0, "Prix invalide");
        require(_objectifMinimalWei > 0, "Objectif minimal invalide");
        require(_dureeMinutes > 0, "Duree invalide");
        require(_vendeur != address(0), "Vendeur invalide");
        parts = IERC20(_parts);
        registre = _registre;
        vendeur = _vendeur;
        prixParPart = _prixParPartWei;
        objectifMinimalWei = _objectifMinimalWei;
        finOffre = block.timestamp + _dureeMinutes * 1 minutes;
    }

    // ---------------- KYC : réservé aux conservateurs ----------------
    // Tout compte qui a le rôle CONSERVATEUR_ROLE sur le registre peut autoriser ou retirer un investisseur.
    // (Dans un vrai système, la vérification d'identité se fait HORS blockchain avant cet appel.)
    function autoriser(address investisseur, bool statut) external {
        require(
            IRegistreRoles(registre).hasRole(CONSERVATEUR_ROLE, msg.sender),
            "Reserve au conservateur"
        );
        require(investisseur != address(0), "Adresse invalide");
        autorise[investisseur] = statut;
        emit InvestisseurAutorise(investisseur, statut);
    }

    // ---------------- Achat : les parts sont RÉSERVÉES (séquestre) ----------------
    function acheter(uint256 nbParts) external payable nonReentrant {
        require(autorise[msg.sender], "Investisseur non autorise (KYC)");
        require(block.timestamp < finOffre, "Offre terminee");
        require(nbParts > 0, "Quantite invalide");
        require(msg.value == nbParts * prixParPart, "Montant ETH incorrect");
        require(
            parts.balanceOf(address(this)) >= totalPartsReservees + nbParts,
            "Pas assez de parts disponibles"
        );

        partsReservees[msg.sender] += nbParts;
        ethDepense[msg.sender] += msg.value;
        totalPartsReservees += nbParts;
        totalCollecte += msg.value;

        emit PartsReservees(msg.sender, nbParts, msg.value);
    }

    // ---------------- État ----------------

    /// @notice Vrai si l'adresse a le rôle conservateur (permet à l'interface d'afficher les bons boutons).
    function estConservateur(address compte) external view returns (bool) {
        return IRegistreRoles(registre).hasRole(CONSERVATEUR_ROLE, compte);
    }

    function offreReussie() public view returns (bool) {
        return totalCollecte >= objectifMinimalWei;
    }

    function tempsRestant() external view returns (uint256) {
        if (block.timestamp >= finOffre) return 0;
        return finOffre - block.timestamp;
    }

    /// @notice Montant EXACT en wei à envoyer pour acheter nbParts (évite l'erreur "Montant ETH incorrect").
    function coutPour(uint256 nbParts) external view returns (uint256) {
        return nbParts * prixParPart;
    }

    /// @notice Parts encore achetables (jamais d'erreur de soustraction).
    function partsDisponibles() external view returns (uint256) {
        uint256 solde = parts.balanceOf(address(this));
        return solde > totalPartsReservees ? solde - totalPartsReservees : 0;
    }

    // ---------------- Cas A : l'offre réussit ----------------
    function reclamerParts() external nonReentrant {
        require(block.timestamp >= finOffre, "Offre en cours");
        require(offreReussie(), "Offre echouee : utilisez rembourser()");

        uint256 n = partsReservees[msg.sender];
        require(n > 0, "Aucune part a reclamer");

        partsReservees[msg.sender] = 0;
        totalPartsReservees -= n;

        require(parts.transfer(msg.sender, n), "Transfert echoue");
        emit PartsReclamees(msg.sender, n);
    }

    function retirerFonds() external nonReentrant {
        require(msg.sender == vendeur, "Reserve au vendeur");
        require(block.timestamp >= finOffre, "Offre en cours");
        require(offreReussie(), "Objectif minimal non atteint");
        require(!fondsRetires, "Fonds deja retires");

        fondsRetires = true;
        uint256 montant = address(this).balance;

        (bool ok, ) = vendeur.call{value: montant}("");
        require(ok, "Retrait echoue");
        emit FondsRetires(vendeur, montant);
    }

    // ---------------- Cas B : l'offre échoue ----------------
    function rembourser() external nonReentrant {
        require(block.timestamp >= finOffre, "Offre en cours");
        require(!offreReussie(), "Offre reussie : pas de remboursement");

        uint256 montant = ethDepense[msg.sender];
        require(montant > 0, "Rien a rembourser");

        totalPartsReservees -= partsReservees[msg.sender];
        ethDepense[msg.sender] = 0;
        partsReservees[msg.sender] = 0;

        (bool ok, ) = msg.sender.call{value: montant}("");
        require(ok, "Remboursement echoue");
        emit Remboursement(msg.sender, montant);
    }

    // ---------------- Parts invendues ----------------
    function recupererPartsInvendues() external nonReentrant {
        require(msg.sender == vendeur, "Reserve au vendeur");
        require(block.timestamp >= finOffre, "Offre en cours");

        uint256 solde = parts.balanceOf(address(this));
        uint256 aRendre;
        if (offreReussie()) {
            // On garde en réserve les parts que les acheteurs n'ont pas encore réclamées.
            aRendre = solde > totalPartsReservees ? solde - totalPartsReservees : 0;
        } else {
            // Offre échouée : toutes les parts reviennent au vendeur.
            aRendre = solde;
        }
        require(aRendre > 0, "Aucune part a recuperer");

        require(parts.transfer(vendeur, aRendre), "Transfert echoue");
        emit PartsInvenduesRecuperees(vendeur, aRendre);
    }
}

// ============================================================================
// CONTRAT 2 : LandPartsSaleFactory (à déployer UNE SEULE FOIS)
// ============================================================================
contract LandPartsSaleFactory {

    // Le registre foncier (pour vérifier les conservateurs). Fixé une fois pour toutes.
    address public immutable registre;

    // La Factory de titrisation (pour vérifier que les parts mises en vente sont authentiques).
    address public immutable factoryTitrisation;

    // Toutes les offres créées, dans l'ordre.
    address[] public toutesLesOffres;

    // Émis à chaque offre créée : l'indexeur découvre ainsi les offres tout seul,
    // avec tous leurs paramètres, sans appel supplémentaire à la blockchain.
    event NouvelleOffre(
        address indexed offre,
        address indexed parts,
        address indexed vendeur,
        uint256 prixParPart,
        uint256 objectifMinimal,
        uint256 finOffre
    );

    constructor(address _registre, address _factoryTitrisation) {
        require(_registre != address(0), "Registre invalide");
        require(_factoryTitrisation != address(0), "Factory de titrisation invalide");
        registre = _registre;
        factoryTitrisation = _factoryTitrisation;
    }

    /// @notice Crée une offre publique pour les parts d'une parcelle titrisée.
    ///         Seul le bénéficiaire de la titrisation peut l'appeler.
    /// @param parts adresse du contrat de titrisation (LandSecuritizationToken)
    /// @param prixParPartWei prix d'une part, en wei
    /// @param objectifMinimalWei montant minimal à collecter, en wei (sinon remboursement)
    /// @param dureeMinutes durée de l'offre en minutes (7 jours = 10080)
    function creerOffre(
        address parts,
        uint256 prixParPartWei,
        uint256 objectifMinimalWei,
        uint256 dureeMinutes
    ) external returns (address) {
        // Le contrat de parts doit avoir été fabriqué par NOTRE Factory de titrisation (sinon n'importe qui
        // pourrait publier une offre sur un faux contrat de parts).
        require(
            ITitrisationFactory(factoryTitrisation).contratTitrisationDe(ITitrisation(parts).parcelTokenId()) == parts,
            "Contrat de parts non reconnu"
        );
        require(ITitrisation(parts).estTitrise(), "Parts non emises : terminez la titrisation");
        require(
            ITitrisation(parts).beneficiaireInitial() == msg.sender,
            "Seul le beneficiaire peut creer l'offre"
        );

        LandPartsSale offre = new LandPartsSale(
            parts, registre, msg.sender, prixParPartWei, objectifMinimalWei, dureeMinutes
        );

        address adresse = address(offre);
        toutesLesOffres.push(adresse);

        emit NouvelleOffre(adresse, parts, msg.sender, prixParPartWei, objectifMinimalWei, offre.finOffre());
        return adresse;
    }

    function nombreDOffres() external view returns (uint256) {
        return toutesLesOffres.length;
    }
}
