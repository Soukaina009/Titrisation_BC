// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Version épinglée à 4.9.6 pour rester compatible avec le compilateur Solidity 0.8.20
// (voir la même remarque dans LandTitleRegistry.sol).
import "@openzeppelin/contracts@4.9.6/token/ERC20/ERC20.sol";

/// @title LandSecuritizationToken + LandSecuritizationFactory
/// @notice Ce fichier contient DEUX contrats :
///         1) LandSecuritizationToken : la titrisation d'UNE parcelle précise (inchangé depuis la version précédente).
///         2) LandSecuritizationFactory : une "usine" qui déploie automatiquement un nouveau
///            LandSecuritizationToken pour chaque parcelle, sans avoir à repasser par Remix.
///            C'est ce 2e contrat qu'on déploie UNE SEULE FOIS, pour toujours.
/// @dev C'est ici la couche "financière" du projet : elle implémente techniquement (tokenisation)
///      le mécanisme prévu par la loi marocaine 33-06 sur la titrisation.

interface ILandTitleRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function proposerVente(uint256 tokenId, address acheteur) external;
}

// ============================================================================
// CONTRAT 1 : LandSecuritizationToken (une instance = une parcelle titrisée)
// ============================================================================
// Ce contrat ne change pas de logique par rapport à avant : la seule différence est qu'il
// n'est plus déployé "à la main" depuis Remix, mais automatiquement par la Factory ci-dessous.
contract LandSecuritizationToken is ERC20 {

    address public immutable landRegistry;
    uint256 public immutable parcelTokenId;

    address public beneficiaireInitial;
    uint256 public totalPartsPrevues;
    bool public estTitrise;

    event TitrisationEffectuee(uint256 indexed parcelTokenId, address indexed beneficiaire, uint256 nombreDeParts);
    event RachatDemande(address indexed demandeur, uint256 partsBrulees);

    constructor(
        address _landRegistry,
        uint256 _parcelTokenId,
        address _beneficiaire,
        uint256 _totalParts,
        string memory _nomToken,
        string memory _symboleToken
    ) ERC20(_nomToken, _symboleToken) {
        landRegistry = _landRegistry;
        parcelTokenId = _parcelTokenId;
        beneficiaireInitial = _beneficiaire;
        totalPartsPrevues = _totalParts;
    }

    /// @notice Émet les parts numériques une fois que le NFT foncier a été officiellement transféré
    ///         à ce contrat (via LandTitleRegistry.proposerVente + validerTransfert).
    function initierTitrisation() external {
        require(!estTitrise, "Cette parcelle est deja titrisee");
        require(msg.sender == beneficiaireInitial, "Seul le beneficiaire designe peut titriser");

        address proprietaireActuelDuNFT = ILandTitleRegistry(landRegistry).ownerOf(parcelTokenId);
        require(
            proprietaireActuelDuNFT == address(this),
            "Le titre foncier n'a pas encore ete transfere a ce contrat"
        );

        estTitrise = true;
        _mint(msg.sender, totalPartsPrevues);

        emit TitrisationEffectuee(parcelTokenId, msg.sender, totalPartsPrevues);
    }

    /// @notice Permet à celui qui détient 100% des parts de redemander la pleine propriété
    ///         individuelle du titre foncier (sortie de la titrisation).
    function demanderRachat() external {
        require(estTitrise, "Cette parcelle n'est pas (ou plus) titrisee");

        uint256 partsDetenues = balanceOf(msg.sender);
        require(partsDetenues == totalSupply(), "Il faut detenir 100% des parts pour racheter la parcelle");

        estTitrise = false;
        _burn(msg.sender, partsDetenues);

        ILandTitleRegistry(landRegistry).proposerVente(parcelTokenId, msg.sender);

        emit RachatDemande(msg.sender, partsDetenues);
    }
}

// ============================================================================
// CONTRAT 2 : LandSecuritizationFactory (à déployer UNE SEULE FOIS, pour toujours)
// ============================================================================
// Une "Factory" (usine) est un patron de conception très courant en Solidity : au lieu de
// redéployer manuellement un contrat identique à chaque fois qu'on en a besoin (ce qui nous
// obligeait à repasser par Remix pour chaque parcelle), on déploie UNE FOIS ce contrat "usine",
// et c'est LUI qui fabrique tous les contrats suivants directement depuis la blockchain,
// en une seule transaction, sans jamais rouvrir Remix.
contract LandSecuritizationFactory {

    // L'adresse du registre foncier est fixée une fois pour toutes : cette Factory ne sert
    // qu'à titriser des parcelles appartenant à CE registre précis.
    address public immutable landRegistry;

    // "mapping" clé → valeur : pour chaque tokenId de parcelle, on retient l'adresse du contrat
    // de titrisation qui lui est associé (address(0) si la parcelle n'a jamais été titrisée).
    // C'est ce qui permet à la DApp de retrouver automatiquement le bon contrat sans que
    // l'utilisateur ait à copier-coller une adresse à la main.
    mapping(uint256 => address) public contratTitrisationDe;

    // "array" (tableau dynamique) qui garde une trace de TOUS les contrats créés par cette
    // Factory, dans l'ordre, utile pour lister l'historique complet depuis un site web.
    address[] public tousLesContrats;

    // Événement émis à chaque nouvelle titrisation créée : la DApp peut écouter cet événement
    // pour afficher automatiquement la liste des parcelles titrisées, sans configuration manuelle.
    event NouvelleTitrisation(uint256 indexed parcelTokenId, address indexed contratCree, address indexed proprietaire);

    constructor(address _landRegistry) {
        landRegistry = _landRegistry;
    }

    /// @notice Crée automatiquement un nouveau contrat LandSecuritizationToken pour une parcelle,
    ///         sans jamais avoir besoin de repasser par Remix. Le propriétaire de la parcelle
    ///         appelle simplement cette fonction lui-même, directement depuis la DApp.
    /// @param parcelTokenId l'identifiant de la parcelle (NFT) à titriser
    /// @param totalParts le nombre total de parts à émettre (ex: 1000)
    /// @param nomToken le nom du token de parts (ex: "Parts Parcelle Rabat")
    /// @param symboleToken le symbole du token (ex: "PPR")
    function creerTitrisation(
        uint256 parcelTokenId,
        uint256 totalParts,
        string memory nomToken,
        string memory symboleToken
    ) external returns (address) {
        // On empêche de créer deux contrats de titrisation différents pour la même parcelle.
        require(contratTitrisationDe[parcelTokenId] == address(0), "Cette parcelle a deja un contrat de titrisation");

        // Seul le propriétaire ACTUEL de la parcelle (vérifié en direct sur le registre) peut
        // décider de la titriser — exactement comme dans la vraie vie, personne d'autre ne
        // peut décider à sa place de transformer son bien en parts financières.
        require(
            ILandTitleRegistry(landRegistry).ownerOf(parcelTokenId) == msg.sender,
            "Seul le proprietaire actuel peut titriser sa parcelle"
        );

        // ------------------------------------------------------------------
        // C'est ICI que la magie de la Factory opère : le mot-clé "new" déploie
        // un TOUT NOUVEAU contrat directement depuis le code Solidity, avec ses
        // propres paramètres, sans jamais passer par l'interface de Remix.
        // Le bénéficiaire (_beneficiaire) est automatiquement msg.sender : puisqu'on
        // vient de vérifier que c'est bien lui le propriétaire, pas besoin de le
        // redemander séparément.
        // ------------------------------------------------------------------
        LandSecuritizationToken nouveauContrat = new LandSecuritizationToken(
            landRegistry,
            parcelTokenId,
            msg.sender,
            totalParts,
            nomToken,
            symboleToken
        );

        address adresseDuNouveauContrat = address(nouveauContrat);

        // On enregistre ce nouveau contrat pour pouvoir le retrouver facilement plus tard.
        contratTitrisationDe[parcelTokenId] = adresseDuNouveauContrat;
        tousLesContrats.push(adresseDuNouveauContrat);

        emit NouvelleTitrisation(parcelTokenId, adresseDuNouveauContrat, msg.sender);

        return adresseDuNouveauContrat;
    }

    /// @notice Renvoie le nombre total de titrisations créées jusqu'à présent par cette Factory.
    function nombreDeTitrisations() external view returns (uint256) {
        return tousLesContrats.length;
    }
}
