// Interfaces minimales des contrats : uniquement les événements à indexer et les lectures nécessaires.
const REGISTRY_ABI = [
  'event ParcelleImmatriculee(uint256 indexed tokenId, address indexed proprietaire, string numeroTitreFoncier)',
  'event VenteProposee(uint256 indexed tokenId, address indexed vendeur, address indexed acheteur)',
  'event TransfertValide(uint256 indexed tokenId, address indexed ancienProprietaire, address indexed nouveauProprietaire)',
  'event PropositionAnnulee(uint256 indexed tokenId)',
  'function consulterParcelle(uint256 tokenId) view returns (string numeroTitreFoncier, string localisation, uint256 superficieM2, bool estActive, address proprietaireActuel)'
];

const FACTORY_ABI = [
  'event NouvelleTitrisation(uint256 indexed parcelTokenId, address indexed contratCree, address indexed proprietaire)'
];

const SEC_ABI = [
  'event TitrisationEffectuee(uint256 indexed parcelTokenId, address indexed beneficiaire, uint256 nombreDeParts)',
  'event RachatDemande(address indexed demandeur, uint256 partsBrulees)',
  // Transfer : sert à repérer les parts déposées dans une offre (voir indexer.js, cas 'Transfer')
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function totalPartsPrevues() view returns (uint256)'
];

// Usine d'offres (LandPartsSaleFactory) : un événement par offre créée.
const SALE_FACTORY_ABI = [
  'event NouvelleOffre(address indexed offre, address indexed parts, address indexed vendeur, uint256 prixParPart, uint256 objectifMinimal, uint256 finOffre)'
];

// Une offre (LandPartsSale) : tous ses événements.
const SALE_ABI = [
  'event InvestisseurAutorise(address indexed investisseur, bool statut)',
  'event PartsReservees(address indexed acheteur, uint256 nbParts, uint256 montant)',
  'event PartsReclamees(address indexed acheteur, uint256 nbParts)',
  'event Remboursement(address indexed acheteur, uint256 montant)',
  'event FondsRetires(address indexed vendeur, uint256 montant)',
  'event PartsInvenduesRecuperees(address indexed vendeur, uint256 nbParts)'
];

module.exports = { REGISTRY_ABI, FACTORY_ABI, SEC_ABI, SALE_FACTORY_ABI, SALE_ABI };
