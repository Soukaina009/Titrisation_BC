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
  'function totalPartsPrevues() view returns (uint256)'
];

module.exports = { REGISTRY_ABI, FACTORY_ABI, SEC_ABI };
