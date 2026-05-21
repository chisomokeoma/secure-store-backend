// Nigeria — 36 states + the Federal Capital Territory (Abuja).
// `region` is the official 6-zone geopolitical grouping (NW/NE/NC/SW/SE/SS).
// Static — does not change at runtime.

export type NigerianRegion =
  | 'NORTH_CENTRAL'
  | 'NORTH_EAST'
  | 'NORTH_WEST'
  | 'SOUTH_EAST'
  | 'SOUTH_SOUTH'
  | 'SOUTH_WEST';

export interface NigerianState {
  name: string;
  code: string; // 2-letter code used commonly in Nigerian datasets (NIPOST)
  region: NigerianRegion;
  capital: string;
}

export const NIGERIAN_STATES: ReadonlyArray<NigerianState> = [
  { name: 'Abia', code: 'AB', region: 'SOUTH_EAST', capital: 'Umuahia' },
  { name: 'Adamawa', code: 'AD', region: 'NORTH_EAST', capital: 'Yola' },
  { name: 'Akwa Ibom', code: 'AK', region: 'SOUTH_SOUTH', capital: 'Uyo' },
  { name: 'Anambra', code: 'AN', region: 'SOUTH_EAST', capital: 'Awka' },
  { name: 'Bauchi', code: 'BA', region: 'NORTH_EAST', capital: 'Bauchi' },
  { name: 'Bayelsa', code: 'BY', region: 'SOUTH_SOUTH', capital: 'Yenagoa' },
  { name: 'Benue', code: 'BE', region: 'NORTH_CENTRAL', capital: 'Makurdi' },
  { name: 'Borno', code: 'BO', region: 'NORTH_EAST', capital: 'Maiduguri' },
  { name: 'Cross River', code: 'CR', region: 'SOUTH_SOUTH', capital: 'Calabar' },
  { name: 'Delta', code: 'DE', region: 'SOUTH_SOUTH', capital: 'Asaba' },
  { name: 'Ebonyi', code: 'EB', region: 'SOUTH_EAST', capital: 'Abakaliki' },
  { name: 'Edo', code: 'ED', region: 'SOUTH_SOUTH', capital: 'Benin City' },
  { name: 'Ekiti', code: 'EK', region: 'SOUTH_WEST', capital: 'Ado-Ekiti' },
  { name: 'Enugu', code: 'EN', region: 'SOUTH_EAST', capital: 'Enugu' },
  { name: 'FCT', code: 'FC', region: 'NORTH_CENTRAL', capital: 'Abuja' },
  { name: 'Gombe', code: 'GO', region: 'NORTH_EAST', capital: 'Gombe' },
  { name: 'Imo', code: 'IM', region: 'SOUTH_EAST', capital: 'Owerri' },
  { name: 'Jigawa', code: 'JI', region: 'NORTH_WEST', capital: 'Dutse' },
  { name: 'Kaduna', code: 'KD', region: 'NORTH_WEST', capital: 'Kaduna' },
  { name: 'Kano', code: 'KN', region: 'NORTH_WEST', capital: 'Kano' },
  { name: 'Katsina', code: 'KT', region: 'NORTH_WEST', capital: 'Katsina' },
  { name: 'Kebbi', code: 'KE', region: 'NORTH_WEST', capital: 'Birnin Kebbi' },
  { name: 'Kogi', code: 'KO', region: 'NORTH_CENTRAL', capital: 'Lokoja' },
  { name: 'Kwara', code: 'KW', region: 'NORTH_CENTRAL', capital: 'Ilorin' },
  { name: 'Lagos', code: 'LA', region: 'SOUTH_WEST', capital: 'Ikeja' },
  { name: 'Nasarawa', code: 'NA', region: 'NORTH_CENTRAL', capital: 'Lafia' },
  { name: 'Niger', code: 'NI', region: 'NORTH_CENTRAL', capital: 'Minna' },
  { name: 'Ogun', code: 'OG', region: 'SOUTH_WEST', capital: 'Abeokuta' },
  { name: 'Ondo', code: 'ON', region: 'SOUTH_WEST', capital: 'Akure' },
  { name: 'Osun', code: 'OS', region: 'SOUTH_WEST', capital: 'Osogbo' },
  { name: 'Oyo', code: 'OY', region: 'SOUTH_WEST', capital: 'Ibadan' },
  { name: 'Plateau', code: 'PL', region: 'NORTH_CENTRAL', capital: 'Jos' },
  { name: 'Rivers', code: 'RI', region: 'SOUTH_SOUTH', capital: 'Port Harcourt' },
  { name: 'Sokoto', code: 'SO', region: 'NORTH_WEST', capital: 'Sokoto' },
  { name: 'Taraba', code: 'TA', region: 'NORTH_EAST', capital: 'Jalingo' },
  { name: 'Yobe', code: 'YO', region: 'NORTH_EAST', capital: 'Damaturu' },
  { name: 'Zamfara', code: 'ZA', region: 'NORTH_WEST', capital: 'Gusau' },
];
