// Faux backend ChirpStack v4 en mémoire, pour le mode démo (aucun serveur requis).
// Imite les réponses JSON de grpc-gateway (chirpstack-rest-api) : camelCase,
// timestamps ISO 8601, entiers 64 bits sérialisés en chaînes.
// options.lang ('fr' par défaut, ou 'en') : langue des données générées. Les tirages aléatoires sont
// identiques dans les deux langues (mêmes DevEUI, mêmes clés, mêmes métriques pour une même graine).

// ---------------------------------------------------------------------------
// Aléatoire déterministe
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hash FNV-1a 32 bits, pour dériver des graines stables (métriques).
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRand(seed) {
  const next = mulberry32(seed);
  const r = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    hex: (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(next() * 16).toString(16);
      return s;
    },
    uuid: () => {
      const b = [];
      for (let i = 0; i < 16; i++) b.push(Math.floor(next() * 256));
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
      const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
  return r;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const HEX16 = /^[0-9a-f]{16}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

// Lecture d'un champ en camelCase ou snake_case.
function snake(camel) {
  return camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}
function has(obj, camel) {
  return obj != null && typeof obj === 'object' && (camel in obj || snake(camel) in obj);
}
function get(obj, camel) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (camel in obj) return obj[camel];
  return obj[snake(camel)];
}

// Codes gRPC -> HTTP, comme grpc-gateway.
const GRPC = {
  InvalidArgument: { code: 3, status: 400 },
  NotFound: { code: 5, status: 404 },
  AlreadyExists: { code: 6, status: 409 },
  Internal: { code: 13, status: 500 },
  Unauthenticated: { code: 16, status: 401 },
};

class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const notFound = (id) => new ApiError('NotFound', `Object does not exist (id: ${id})`);
const invalid = (msg) => new ApiError('InvalidArgument', msg);

// Valide un UUID comme le ferait le crate uuid côté ChirpStack.
function parseUuid(v, field) {
  const s = v == null ? '' : String(v);
  if (s === '') throw invalid('invalid length: expected length 32 for simple format, found 0');
  if (!UUID_RE.test(s)) throw invalid(`invalid ${field}: ${s}`);
  const h = s.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function paginate(items, q) {
  const total = items.length;
  const offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  // limit absent : tout renvoyer ; limit=0 explicite : liste vide (comme ChirpStack).
  const rawLimit = q.get('limit');
  const limit = rawLimit == null || rawLimit === '' ? total : Math.max(0, parseInt(rawLimit, 10) || 0);
  return { totalCount: String(total), result: items.slice(offset, offset + limit) };
}

function byName(a, b) {
  return a.name.localeCompare(b.name, 'fr', { numeric: true });
}

// ---------------------------------------------------------------------------
// Vocabulaire anglais (données générées en français puis converties mot à mot)
// ---------------------------------------------------------------------------

// Jetons des noms de devices : correspondance injective, donc l'unicité des noms est conservée.
const NAME_EN = {
  'R+0': 'L0', 'R+1': 'L1', 'R+2': 'L2', 'R+3': 'L3', 'R+4': 'L4',
  Salle: 'Room', Bureau: 'Office', Accueil: 'Lobby',
  CPT: 'MTR', EAU: 'WATER', GAZ: 'GAS', CAL: 'HEAT',
  TD: 'DB', TGBT: 'MSB', SS: 'B1', SAN: 'WC', CHF: 'BLR', CUIS: 'KIT', SST: 'SUB',
  CTA: 'AHU', CTA1: 'AHU1', CTA2: 'AHU2', ECS: 'DHW', DEP: 'SUP', RET: 'RTN',
  LT: 'PLANT', TOIT: 'ROOF', PK: 'CP', N: 'P',
};
const enTokens = (s) => s.split('-').map((x) => NAME_EN[x] ?? x).join('-');

// Niveaux : R+1 → L1, R-1 → B1, N-2 → P-2 (parking), Toiture → Roof.
function floorEn(f) {
  if (/^R\+\d$/.test(f)) return `L${f.slice(2)}`;
  if (/^R-\d$/.test(f)) return `B${f.slice(2)}`;
  if (/^N-\d$/.test(f)) return `P-${f.slice(2)}`;
  return { Toiture: 'Roof', SS: 'B1' }[f] ?? f;
}

const ZONE_EN = { Nord: 'North', Sud: 'South', Est: 'East', Ouest: 'West', Centre: 'Centre', 'Local technique': 'Plant room' };
const LOT_EN = { CVC: 'HVAC', CFO: 'Electrical', PLB: 'Plumbing', Essais: 'Testing' };
const FLUID_EN = { electricite: 'electricity', eau: 'water', gaz: 'gas', calories: 'heat' };
const ROOM_EN = { Salle: 'room', Bureau: 'office', 'Open-space': 'open-space', Accueil: 'lobby' };

// ---------------------------------------------------------------------------
// Catalogue des données de démo
// ---------------------------------------------------------------------------

const PROFILES = [
  { key: 'elsys', name: 'Elsys ERS CO2', prefix: 'a81758fffe', interval: [10, 15] },
  { key: 'adeunis', name: 'Adeunis Temp 4', prefix: '0018b2', interval: [15, 30] },
  { key: 'milesight', name: 'Milesight EM300-TH', prefix: '24e124', interval: [10, 20] },
  { key: 'watteco', name: 'Watteco Flasho', prefix: '70b3d5e75e', interval: [10, 60] },
  { key: 'dragino', name: 'Dragino LHT65N', prefix: 'a84041', interval: [20, 20] },
  { key: 'nke', name: 'Nke Remote Temp', prefix: '70b3d5e75f', interval: [15, 30] },
];

const ZONES = ['Nord', 'Sud', 'Est', 'Ouest', 'Centre'];
const FLOORS = ['R+0', 'R+1', 'R+2', 'R+3', 'R+4'];

// Générateurs de noms/tags par application.
const APPS = [
  {
    key: 'A',
    name: 'Bâtiment A — Confort',
    description: 'Sondes de confort (CO2, température, hygrométrie) des bureaux et salles du bâtiment A',
    nameEn: 'Building A — Comfort',
    descriptionEn: 'Comfort sensors (CO2, temperature, humidity) in the offices and rooms of building A',
    count: 60,
    make(r, i, en) {
      const p = r.pick(['elsys', 'elsys', 'elsys', 'milesight', 'milesight', 'milesight', 'nke', 'adeunis']);
      const floor = r.pick(FLOORS);
      const lvl = floor.slice(2);
      const room = r.pick(['Salle', 'Bureau', 'Bureau', 'Open-space', 'Accueil']);
      const num = `${lvl}${String(r.int(1, 30)).padStart(2, '0')}`;
      const kind = p === 'elsys' ? 'CO2' : p === 'milesight' ? 'TH' : 'TEMP';
      const label = { CO2: 'Sonde CO2/T/HR', TH: 'Sonde T/HR', TEMP: 'Sonde de température' }[kind];
      const name = `${kind}-${floor}-${room}-${num}`;
      const zone = r.pick(ZONES);
      if (en) {
        const labelEn = { CO2: 'CO2/T/RH sensor', TH: 'T/RH sensor', TEMP: 'Temperature sensor' }[kind];
        return {
          profile: p,
          name: enTokens(name),
          description: `${labelEn} — ${ROOM_EN[room]} ${num}`,
          tags: { building: 'A', floor: floorEn(floor), zone: ZONE_EN[zone], lot: 'HVAC', usage: 'comfort' },
        };
      }
      return {
        profile: p,
        name,
        description: `${label} — ${room.toLowerCase()} ${num}`,
        tags: { batiment: 'A', etage: floor, zone, lot: 'CVC', usage: 'confort' },
      };
    },
  },
  {
    key: 'B',
    name: 'Bâtiment B — Comptage',
    description: 'Comptage énergétique et fluides du bâtiment B (décret tertiaire)',
    nameEn: 'Building B — Metering',
    descriptionEn: 'Energy and utility metering for building B',
    count: 140,
    make(r, i, en) {
      const x = r.next();
      if (x < 0.72) {
        const fluide = r.pick(['ELEC', 'ELEC', 'ELEC', 'EAU', 'EAU', 'GAZ', 'CAL']);
        const loc = {
          ELEC: r.pick(['TGBT', 'TD-R+1', 'TD-R+2', 'TD-R+3', 'TD-SS']),
          EAU: r.pick(['SS', 'R+0', 'SAN-R+1', 'SAN-R+2']),
          GAZ: r.pick(['CHF', 'CUIS']),
          CAL: r.pick(['SST', 'CTA', 'CHF']),
        }[fluide];
        const lot = { ELEC: 'CFO', EAU: 'PLB', GAZ: 'CVC', CAL: 'CVC' }[fluide];
        const fl = { ELEC: 'electricite', EAU: 'eau', GAZ: 'gaz', CAL: 'calories' }[fluide];
        const n = String(r.int(1, 40)).padStart(2, '0');
        const etage = loc.includes('R+') ? loc.slice(loc.indexOf('R+')) : loc === 'SS' || loc === 'TD-SS' ? 'R-1' : 'R+0';
        if (en) {
          const fe = FLUID_EN[fl];
          return {
            profile: 'watteco',
            name: enTokens(`CPT-${fluide}-${loc}-${n}`),
            description: `${fe.charAt(0).toUpperCase() + fe.slice(1)} meter (pulse output) — ${enTokens(loc)}`,
            tags: { building: 'B', floor: floorEn(etage), lot: LOT_EN[lot], fluid: fe, usage: 'metering' },
          };
        }
        return {
          profile: 'watteco',
          name: `CPT-${fluide}-${loc}-${n}`,
          description: `Compteur ${fl} (sortie impulsion) — ${loc}`,
          tags: { batiment: 'B', etage, lot, fluide: fl, usage: 'comptage' },
        };
      }
      if (x < 0.9) {
        const circuit = r.pick(['DEP', 'RET']);
        const loc = r.pick(['CHF', 'SST', 'CTA1', 'CTA2', 'ECS']);
        const n = String(r.int(1, 20)).padStart(2, '0');
        if (en) {
          return {
            profile: 'adeunis',
            name: enTokens(`T-${circuit}-${loc}-${n}`),
            description: `${circuit === 'DEP' ? 'Supply' : 'Return'} temperature ${enTokens(loc)}`,
            tags: { building: 'B', floor: 'B1', lot: 'HVAC', zone: 'Plant room', usage: 'metering' },
          };
        }
        return {
          profile: 'adeunis',
          name: `T-${circuit}-${loc}-${n}`,
          description: `Température ${circuit === 'DEP' ? 'départ' : 'retour'} ${loc}`,
          tags: { batiment: 'B', etage: 'R-1', lot: 'CVC', zone: 'Local technique', usage: 'comptage' },
        };
      }
      const n = String(r.int(1, 30)).padStart(2, '0');
      const name = `TH-LT-${r.pick(['SS', 'R+0', 'TOIT'])}-${n}`;
      const etage = r.pick(['R-1', 'R+0', 'Toiture']);
      if (en) {
        return {
          profile: 'milesight',
          name: enTokens(name),
          description: 'Plant room ambient conditions',
          tags: { building: 'B', floor: floorEn(etage), lot: 'HVAC', zone: 'Plant room', usage: 'monitoring' },
        };
      }
      return {
        profile: 'milesight',
        name,
        description: 'Ambiance local technique',
        tags: { batiment: 'B', etage, lot: 'CVC', zone: 'Local technique', usage: 'surveillance' },
      };
    },
  },
  {
    key: 'P',
    name: "Parking — Qualité d'air",
    description: "Surveillance de la qualité d'air et de l'ambiance du parking souterrain",
    nameEn: 'Car park — Air quality',
    descriptionEn: 'Air quality and ambient monitoring of the underground car park',
    count: 35,
    make(r, i, en) {
      const lvl = r.pick(['N-1', 'N-2', 'N-3']);
      const z = `Z${String(r.int(1, 12)).padStart(2, '0')}`;
      const co2 = r.chance(0.45);
      if (en) {
        const lv = floorEn(lvl);
        return {
          profile: co2 ? 'elsys' : 'dragino',
          name: enTokens(`${co2 ? 'AIR' : 'TH'}-PK-${lvl}-${z}`),
          description: co2 ? `Car park air quality ${lv}, zone ${z}` : `Car park temperature/humidity ${lv}, zone ${z}`,
          tags: { building: 'Car park', floor: lv, zone: z, lot: 'HVAC', usage: 'air_quality' },
        };
      }
      return {
        profile: co2 ? 'elsys' : 'dragino',
        name: `${co2 ? 'AIR' : 'TH'}-PK-${lvl}-${z}`,
        description: co2 ? `Qualité d'air parking ${lvl}, zone ${z}` : `Température/humidité parking ${lvl}, zone ${z}`,
        tags: { batiment: 'Parking', etage: lvl, zone: z, lot: 'CVC', usage: 'qualite_air' },
      };
    },
  },
  {
    key: 'T',
    name: 'Test terrain',
    description: 'Capteurs en essai de portée et de recette avant déploiement',
    nameEn: 'Field test',
    descriptionEn: 'Sensors under range and acceptance testing before deployment',
    count: 12,
    make(r, i, en) {
      const p = PROFILES[i % PROFILES.length].key;
      const short = { elsys: 'ELSYS', adeunis: 'ADEUNIS', milesight: 'EM300', watteco: 'FLASHO', dragino: 'LHT65N', nke: 'NKE' }[p];
      const name = `TEST-${short}-${String(Math.floor(i / PROFILES.length) + 1).padStart(2, '0')}`;
      // Listes de même longueur : même tirage dans les deux langues.
      const description = r.pick(en
        ? ['Range test', 'Pre-installation acceptance', 'Returned for analysis (RMA)', 'Test bench']
        : ['Essai de portée', 'Recette avant pose', 'Retour SAV à analyser', 'Banc de test']);
      return {
        profile: p,
        name,
        description,
        tags: en ? { building: 'Lab', lot: 'Testing', usage: 'test' } : { batiment: 'Labo', lot: 'Essais', usage: 'test' },
      };
    },
  },
];

const GATEWAYS = [
  { name: 'GW-BAT-A-TOITURE', nameEn: 'GW-BLDG-A-ROOF', description: 'Kerlink iStation — toiture bâtiment A', descriptionEn: 'Kerlink iStation — building A roof', prefix: '7276ff002e06', state: 'ONLINE', loc: [48.8566, 2.3522, 42] },
  { name: 'GW-BAT-B-R+3', nameEn: 'GW-BLDG-B-L3', description: 'Milesight UG65 — local technique R+3 bâtiment B', descriptionEn: 'Milesight UG65 — level 3 plant room, building B', prefix: '24e124fffef4', state: 'ONLINE', loc: [48.8571, 2.3531, 18] },
  { name: 'GW-PARKING-N-1', nameEn: 'GW-CARPARK-P-1', description: 'Milesight UG65 — parking niveau -1', descriptionEn: 'Milesight UG65 — car park level -1', prefix: '24e124fffef5', state: 'ONLINE', loc: [48.8562, 2.3527, -3] },
  { name: 'GW-BAT-B-SS', nameEn: 'GW-BLDG-B-B1', description: 'Kerlink Wirnet iFemtoCell — sous-sol bâtiment B (alimentation coupée ?)', descriptionEn: 'Kerlink Wirnet iFemtoCell — building B basement (power cut?)', prefix: '7276ff00390a', state: 'OFFLINE', loc: [48.8570, 2.3533, -4] },
  { name: 'GW-SPARE-01', nameEn: 'GW-SPARE-01', description: 'Passerelle de rechange, pas encore installée', descriptionEn: 'Spare gateway, not installed yet', prefix: '0016c001ff1e', state: 'NEVER_SEEN', loc: [0, 0, 0] },
];

const FREQS = [868100000, 868300000, 868500000, 867100000, 867300000, 867500000, 867700000, 867900000];

// ---------------------------------------------------------------------------
// Génération de l'état initial
// ---------------------------------------------------------------------------

function buildState(seed, now, lang = 'fr') {
  const r = makeRand(seed);
  const en = lang === 'en';

  const tenant = {
    id: r.uuid(),
    name: en ? 'OpenGTB Demo' : 'Démo OpenGTB',
    description: en ? 'Demo tenant (fictitious data)' : 'Tenant de démonstration (données fictives)',
    createdAt: now - 420 * DAY,
    updatedAt: now - 30 * DAY,
  };

  const applications = new Map();
  for (const a of APPS) {
    const created = now - r.int(200, 400) * DAY;
    applications.set(r.uuid(), {
      key: a.key,
      tenantId: tenant.id,
      name: en ? a.nameEn : a.name,
      description: en ? a.descriptionEn : a.description,
      createdAt: created,
      updatedAt: created + r.int(1, 100) * DAY,
    });
  }
  for (const [id, a] of applications) a.id = id;

  const profiles = new Map();
  const profileByKey = {};
  for (const p of PROFILES) {
    const id = r.uuid();
    const created = now - r.int(250, 400) * DAY;
    const prof = {
      id,
      key: p.key,
      tenantId: tenant.id,
      name: p.name,
      createdAt: created,
      updatedAt: created + r.int(0, 60) * DAY,
    };
    profiles.set(id, prof);
    profileByKey[p.key] = prof;
  }

  const gateways = new Map();
  for (const g of GATEWAYS) {
    const gatewayId = g.prefix + r.hex(16 - g.prefix.length);
    const created = now - r.int(150, 380) * DAY;
    gateways.set(gatewayId, {
      tenantId: tenant.id,
      gatewayId,
      name: en ? g.nameEn : g.name,
      description: en ? g.descriptionEn : g.description,
      location: { latitude: g.loc[0], longitude: g.loc[1], altitude: g.loc[2], source: 'UNKNOWN', accuracy: 0 },
      properties: {},
      createdAt: created,
      updatedAt: created + r.int(0, 100) * DAY,
      state: g.state,
      // ONLINE : décalage recalculé à chaque requête pour rester « en ligne ».
      seenOffset: g.state === 'ONLINE' ? r.int(5, 50) * 1000 : g.state === 'OFFLINE' ? r.int(2, 5) * DAY + r.int(0, 23) * HOUR : null,
    });
  }

  const devices = new Map();
  const keys = new Map();
  const names = new Set();
  const appList = [...applications.values()];

  for (const app of appList) {
    const def = APPS.find((a) => a.key === app.key);
    for (let i = 0; i < def.count; i++) {
      let d;
      let guard = 0;
      do {
        d = def.make(r, i, en);
      } while (names.has(d.name) && ++guard < 50);
      if (names.has(d.name)) d.name += `-${i}`;
      names.add(d.name);

      const pdef = PROFILES.find((p) => p.key === d.profile);
      let devEui;
      do devEui = pdef.prefix + r.hex(16 - pdef.prefix.length);
      while (devices.has(devEui));

      // Répartition de la dernière activité.
      const x = r.next();
      let lastSeen = null;
      if (x < 0.65) lastSeen = now - r.int(1, 24 * 60 - 1) * MIN;
      else if (x < 0.75) lastSeen = now - r.int(24 * 60, 7 * 24 * 60) * MIN;
      else if (x < 0.83) lastSeen = now - r.int(7 * 24 * 60, 30 * 24 * 60) * MIN;
      else if (x < 0.9) lastSeen = now - r.int(31, 240) * DAY - r.int(0, 24 * 60) * MIN;

      const createdAt = (lastSeen ?? now) - r.int(3, 300) * DAY - r.int(0, 24 * 60) * MIN;
      const updatedAt = createdAt + Math.floor(r.next() * ((lastSeen ?? now) - createdAt));

      let deviceStatus = null;
      if (lastSeen != null && r.chance(0.92)) {
        const external = d.profile === 'watteco' ? r.chance(0.1) : false;
        let battery = r.chance(0.08) ? r.float(2, 19.5) : r.float(35, 100);
        if (external) battery = 0;
        deviceStatus = { margin: r.int(-3, 25), externalPowerSource: external, batteryLevel: round1(battery) };
      }

      const rssiBase = r.int(-112, -65);
      devices.set(devEui, {
        devEui,
        name: d.name,
        description: d.description,
        applicationId: app.id,
        deviceProfileId: profileByKey[d.profile].id,
        skipFcntCheck: false,
        isDisabled: false,
        variables: {},
        tags: d.tags,
        joinEui: '0000000000000000',
        createdAt,
        updatedAt,
        lastSeenAt: lastSeen,
        deviceStatus,
        interval: r.int(pdef.interval[0], pdef.interval[1]),
        rssiBase,
      });

      if (r.chance(0.8)) {
        keys.set(devEui, {
          nwkKey: r.hex(32),
          appKey: '00000000000000000000000000000000',
          genAppKey: '',
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
  }

  return { tenant, applications, profiles, gateways, devices, keys };
}

// ---------------------------------------------------------------------------
// Sérialisation façon grpc-gateway
// ---------------------------------------------------------------------------

function tenantJson(t) {
  return {
    id: t.id,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    name: t.name,
    description: t.description,
    canHaveGateways: true,
    privateGatewaysUp: false,
    privateGatewaysDown: false,
    maxGatewayCount: 0,
    maxDeviceCount: 0,
  };
}

function applicationJson(a) {
  return { id: a.id, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt), name: a.name, description: a.description };
}

function profileJson(p) {
  return {
    id: p.id,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    name: p.name,
    region: 'EU868',
    macVersion: 'LORAWAN_1_0_3',
    regParamsRevision: 'RP002_1_0_3',
    supportsOtaa: true,
    supportsClassB: false,
    supportsClassC: false,
  };
}

function gatewayJson(g, now) {
  const out = {
    tenantId: g.tenantId,
    gatewayId: g.gatewayId,
    name: g.name,
    description: g.description,
    location: { ...g.location },
    properties: { ...g.properties },
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
  };
  if (g.seenOffset != null) out.lastSeenAt = iso(now - g.seenOffset);
  out.state = g.state;
  return out;
}

function deviceListItemJson(d, profiles) {
  const out = {
    devEui: d.devEui,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
  if (d.lastSeenAt != null) out.lastSeenAt = iso(d.lastSeenAt);
  out.name = d.name;
  out.description = d.description;
  out.deviceProfileId = d.deviceProfileId;
  out.deviceProfileName = profiles.get(d.deviceProfileId)?.name ?? '';
  if (d.deviceStatus) out.deviceStatus = { ...d.deviceStatus };
  out.tags = { ...d.tags };
  return out;
}

function deviceGetJson(d) {
  const out = {
    device: {
      devEui: d.devEui,
      name: d.name,
      description: d.description,
      applicationId: d.applicationId,
      deviceProfileId: d.deviceProfileId,
      skipFcntCheck: d.skipFcntCheck,
      isDisabled: d.isDisabled,
      variables: { ...d.variables },
      tags: { ...d.tags },
      joinEui: d.joinEui,
    },
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
  if (d.lastSeenAt != null) out.lastSeenAt = iso(d.lastSeenAt);
  if (d.deviceStatus) out.deviceStatus = { ...d.deviceStatus };
  out.classEnabled = 'CLASS_A';
  return out;
}

// ---------------------------------------------------------------------------
// Métriques de lien (déterministes par device et par intervalle)
// ---------------------------------------------------------------------------

function truncate(ms, agg) {
  const d = new Date(ms);
  if (agg === 'HOUR') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  if (agg === 'DAY') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms, agg) {
  if (agg === 'HOUR') return ms + HOUR;
  if (agg === 'DAY') return ms + DAY;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function mainDr(rssi) {
  if (rssi > -95) return 5;
  if (rssi > -103) return 4;
  if (rssi > -108) return 3;
  if (rssi > -112) return 2;
  if (rssi > -115) return 1;
  return 0;
}

// Mesures historisées (GET /metrics), comme celles déclarées dans un Device Profile ChirpStack.
const MEASUREMENTS = {
  elsys: [['temperature', 'Température', 'GAUGE'], ['humidity', 'Humidité', 'GAUGE'], ['co2', 'CO2', 'GAUGE']],
  adeunis: [['temperature', 'Température', 'GAUGE']],
  milesight: [['temperature', 'Température', 'GAUGE'], ['humidity', 'Humidité', 'GAUGE']],
  watteco: [['index', 'Index énergie (Wh)', 'COUNTER'], ['pulses', 'Impulsions', 'ABSOLUTE']],
  dragino: [['temperature', 'Température', 'GAUGE'], ['humidity', 'Humidité', 'GAUGE'], ['battery_v', 'Tension pile', 'GAUGE']],
  nke: [['temperature', 'Température', 'GAUGE']],
};
const MEASUREMENT_EN = {
  'Température': 'Temperature',
  'Humidité': 'Humidity',
  'Index énergie (Wh)': 'Energy index (Wh)',
  'Impulsions': 'Pulses',
  'Tension pile': 'Battery voltage',
};

function measureValue(key, d, t, r, aggHours) {
  const hour = new Date(t).getUTCHours() + 2; // heure locale approximative
  const day = new Date(t).getUTCDay();
  const work = day >= 1 && day <= 5 && hour >= 8 && hour <= 18;
  const seed = (hashStr(d.devEui) % 100) / 100;
  const daily = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
  switch (key) {
    case 'temperature': return round1(20 + seed * 2 + daily * 1.4 + (work ? 0.6 : -0.4) + r.float(-0.3, 0.3));
    case 'humidity': return round1(48 - seed * 6 - daily * 4 + r.float(-1.5, 1.5));
    case 'co2': return Math.round((work ? 650 + seed * 450 : 430 + seed * 40) + r.float(-30, 30));
    case 'battery_v': return Math.round((3.05 + seed * 0.1 - (t - d.createdAt) / (365 * 24 * HOUR) * 0.08) * 1000) / 1000;
    case 'pulses': return Math.round((work ? 120 : 35) * aggHours * (0.8 + r.float(0, 0.4)));
    default: return 0;
  }
}

function deviceMetrics(d, startMs, endMs, agg, now, en = false) {
  const defs = MEASUREMENTS[d.profile] || [];
  const timestamps = [];
  const series = defs.map(() => []);
  const aliveFrom = d.createdAt;
  const aliveTo = d.lastSeenAt == null ? null : Math.min(d.lastSeenAt, now);
  const aggHours = agg === 'HOUR' ? 1 : agg === 'DAY' ? 24 : 24 * 30;
  // Index d'énergie : compteur croissant depuis la création du device.
  const indexAt = (t) => Math.round(150000 + ((hashStr(d.devEui) % 50) + 20) * ((t - aliveFrom) / HOUR));
  let t = truncate(startMs, agg);
  let guard = 0;
  while (t <= endMs && guard++ < 20000) {
    const tEnd = nextBucket(t, agg);
    timestamps.push(iso(t));
    const alive = aliveTo != null && Math.min(tEnd, aliveTo) > Math.max(t, aliveFrom);
    const r = makeRand(hashStr(`${d.devEui}|m|${agg}|${t}`));
    defs.forEach(([key], i) => {
      if (!alive) return series[i].push(0);
      series[i].push(key === 'index' ? indexAt(Math.min(tEnd, aliveTo)) : measureValue(key, d, t, r, aggHours));
    });
    t = tEnd;
  }
  const metrics = {};
  defs.forEach(([key, name, kind], i) => {
    metrics[key] = { name: en ? MEASUREMENT_EN[name] ?? name : name, timestamps, datasets: [{ label: key, data: series[i] }], kind };
  });
  const alarm = en ? { name: 'Alarm', value: 'no' } : { name: 'Alarme', value: 'non' };
  const states = d.profile === 'dragino' ? { alarm } : {};
  return { metrics, states };
}

function linkMetrics(d, startMs, endMs, agg, now) {
  const timestamps = [];
  const rx = [];
  const rssi = [];
  const snr = [];
  const perFreq = new Map();
  const perDr = new Map();
  const errors = new Map();
  const buckets = [];

  const aliveFrom = d.createdAt;
  const aliveTo = d.lastSeenAt == null ? null : Math.min(d.lastSeenAt, now);
  const perHour = 60 / d.interval;
  const dr0 = mainDr(d.rssiBase);

  let t = truncate(startMs, agg);
  let guard = 0;
  while (t <= endMs && guard++ < 20000) {
    const tEnd = nextBucket(t, agg);
    buckets.push(t);
    timestamps.push(iso(t));
    const r = makeRand(hashStr(`${d.devEui}|${agg}|${t}`));

    // Recouvrement entre l'intervalle et la période d'activité du device.
    let count = 0;
    if (aliveTo != null) {
      const overlap = Math.min(tEnd, aliveTo) - Math.max(t, aliveFrom);
      if (overlap > 0) {
        let factor = r.float(0.88, 1);
        if (r.chance(0.04)) factor *= r.float(0, 0.5); // perte ponctuelle
        count = Math.round((overlap / HOUR) * perHour * factor);
        if (aliveTo >= t && aliveTo < tEnd) count = Math.max(1, count);
      }
    }
    rx.push(count);

    if (count > 0) {
      const rs = clamp(d.rssiBase + r.float(-4, 4), -118, -60);
      rssi.push(round1(rs));
      snr.push(round1(clamp(-12 + ((rs + 118) * 22) / 58 + r.float(-1.5, 1.5), -12, 10)));
    } else {
      rssi.push(0);
      snr.push(0);
    }

    const fc = new Map();
    const dc = new Map();
    for (let i = 0; i < count; i++) {
      const f = FREQS[Math.floor(r.next() * FREQS.length)];
      fc.set(f, (fc.get(f) ?? 0) + 1);
      let dr = dr0;
      if (r.chance(0.15)) dr = clamp(dr0 + (r.chance(0.5) ? 1 : -1), 0, 5);
      dc.set(dr, (dc.get(dr) ?? 0) + 1);
    }
    for (const [f, c] of fc) {
      if (!perFreq.has(f)) perFreq.set(f, new Map());
      perFreq.get(f).set(t, c);
    }
    for (const [dr, c] of dc) {
      if (!perDr.has(dr)) perDr.set(dr, new Map());
      perDr.get(dr).set(t, c);
    }
    if (count > 0 && r.chance(0.03)) {
      const label = r.pick(['UPLINK_FCNT_RETRANSMISSION', 'UPLINK_FCNT_RETRANSMISSION', 'UPLINK_MIC']);
      if (!errors.has(label)) errors.set(label, new Map());
      errors.get(label).set(t, r.int(1, 2));
    }
    t = tEnd;
  }

  const sparse = (m) =>
    [...m.keys()]
      .sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))))
      .map((k) => ({ label: String(k), data: buckets.map((b) => m.get(k).get(b) ?? 0) }));

  const metric = (name, datasets, kind) => ({ name, timestamps: [...timestamps], datasets, kind });

  return {
    rxPackets: metric('Received', [{ label: 'rx_count', data: rx }], 'ABSOLUTE'),
    gwRssi: metric('RSSI', [{ label: 'rssi', data: rssi }], 'GAUGE'),
    gwSnr: metric('SNR', [{ label: 'snr', data: snr }], 'GAUGE'),
    rxPacketsPerFreq: metric('Received / frequency', sparse(perFreq), 'ABSOLUTE'),
    rxPacketsPerDr: metric('Received / DR', sparse(perDr), 'ABSOLUTE'),
    errors: metric('Errors', sparse(errors), 'ABSOLUTE'),
  };
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export function createDemoBackend(options = {}) {
  const seed = Number.isFinite(options.seed) ? options.seed : 42;
  const en = options.lang === 'en';
  const state = buildState(seed, Date.now(), en ? 'en' : 'fr');
  const { tenant, applications, profiles, gateways, devices, keys } = state;

  // Latence simulée : générateur distinct pour ne pas perturber les données.
  const latency = mulberry32(seed ^ 0x5eed);

  function search(items, q) {
    const s = (q.get('search') ?? '').trim().toLowerCase();
    return s ? items.filter((x) => x.name.toLowerCase().includes(s)) : items;
  }

  function filterTenant(items, q, required) {
    const raw = q.get('tenantId') ?? q.get('tenant_id');
    if (raw == null || raw === '') {
      if (required) parseUuid('', 'tenantId');
      return items;
    }
    const id = parseUuid(raw, 'tenantId');
    return items.filter((x) => x.tenantId === id);
  }

  function readDevice(body) {
    const dev = get(body, 'device');
    if (dev == null || typeof dev !== 'object') throw invalid('device is required');
    return dev;
  }

  function checkProfile(raw) {
    const id = parseUuid(raw, 'deviceProfileId');
    if (!profiles.has(id)) throw invalid(`device-profile does not exist (id: ${id})`);
    return id;
  }

  function checkApplication(raw) {
    const id = parseUuid(raw, 'applicationId');
    if (!applications.has(id)) throw invalid(`application does not exist (id: ${id})`);
    return id;
  }

  function checkJoinEui(raw) {
    const s = raw == null || raw === '' ? '0000000000000000' : String(raw).toLowerCase();
    if (!HEX16.test(s)) throw invalid(`invalid joinEui: ${raw}`);
    return s;
  }

  function mustDevice(devEui) {
    const d = devices.get(devEui.toLowerCase());
    if (!d) throw notFound(devEui);
    return d;
  }

  function readKeys(body) {
    const k = get(body, 'deviceKeys');
    if (k == null || typeof k !== 'object') throw invalid('deviceKeys is required');
    const nwkKey = String(get(k, 'nwkKey') ?? '');
    if (!HEX32.test(nwkKey)) throw invalid(`invalid nwkKey: expected 32 hex characters, got "${nwkKey}"`);
    const rawApp = get(k, 'appKey');
    const appKey = rawApp == null || rawApp === '' ? '00000000000000000000000000000000' : String(rawApp);
    if (!HEX32.test(appKey)) throw invalid(`invalid appKey: expected 32 hex characters, got "${appKey}"`);
    return { nwkKey: nwkKey.toLowerCase(), appKey: appKey.toLowerCase() };
  }

  // Table de routage : [méthode, regex, handler(match, query, body)].
  const routes = [
    ['GET', /^\/api\/tenants$/, (m, q) => paginate(search([tenant], q).map(tenantJson), q)],

    ['GET', /^\/api\/applications$/, (m, q) => {
      const items = search(filterTenant([...applications.values()], q, true), q).sort(byName);
      return paginate(items.map(applicationJson), q);
    }],

    ['GET', /^\/api\/device-profiles$/, (m, q) => {
      const items = search(filterTenant([...profiles.values()], q, true), q).sort(byName);
      return paginate(items.map(profileJson), q);
    }],

    ['GET', /^\/api\/gateways$/, (m, q) => {
      const now = Date.now();
      const items = search(filterTenant([...gateways.values()], q, false), q).sort(byName);
      return paginate(items.map((g) => gatewayJson(g, now)), q);
    }],

    ['GET', /^\/api\/devices$/, (m, q) => {
      const appId = parseUuid(q.get('applicationId') ?? q.get('application_id') ?? '', 'applicationId');
      let items = [...devices.values()].filter((d) => d.applicationId === appId);
      const s = (q.get('search') ?? '').trim().toLowerCase();
      if (s) items = items.filter((d) => d.name.toLowerCase().includes(s) || d.devEui.includes(s));
      const dp = q.get('deviceProfileId') ?? q.get('device_profile_id');
      if (dp) {
        const id = parseUuid(dp, 'deviceProfileId');
        items = items.filter((d) => d.deviceProfileId === id);
      }
      items.sort(byName);
      return paginate(items.map((d) => deviceListItemJson(d, profiles)), q);
    }],

    ['POST', /^\/api\/devices$/, (m, q, body) => {
      const dev = readDevice(body);
      const devEui = String(get(dev, 'devEui') ?? '').toLowerCase();
      if (!HEX16.test(devEui)) throw invalid(`invalid devEui: expected 16 hex characters, got "${devEui}"`);
      const applicationId = checkApplication(get(dev, 'applicationId'));
      const deviceProfileId = checkProfile(get(dev, 'deviceProfileId'));
      const joinEui = checkJoinEui(get(dev, 'joinEui'));
      if (devices.has(devEui)) throw new ApiError('AlreadyExists', 'Object already exists');
      const now = Date.now();
      devices.set(devEui, {
        devEui,
        name: String(get(dev, 'name') ?? ''),
        description: String(get(dev, 'description') ?? ''),
        applicationId,
        deviceProfileId,
        skipFcntCheck: Boolean(get(dev, 'skipFcntCheck')),
        isDisabled: Boolean(get(dev, 'isDisabled')),
        variables: clone(get(dev, 'variables') ?? {}),
        tags: clone(get(dev, 'tags') ?? {}),
        joinEui,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
        deviceStatus: null,
        interval: 15,
        rssiBase: -60 - (hashStr(devEui) % 50),
      });
      return {};
    }],

    ['GET', /^\/api\/devices\/([^/]+)$/, (m) => deviceGetJson(mustDevice(m[1]))],

    ['PUT', /^\/api\/devices\/([^/]+)$/, (m, q, body) => {
      const d = mustDevice(m[1]);
      const dev = readDevice(body);
      // Valider avant de modifier quoi que ce soit.
      const patch = {};
      if (has(dev, 'name')) patch.name = String(get(dev, 'name') ?? '');
      if (has(dev, 'description')) patch.description = String(get(dev, 'description') ?? '');
      if (has(dev, 'deviceProfileId')) patch.deviceProfileId = checkProfile(get(dev, 'deviceProfileId'));
      if (has(dev, 'applicationId') && get(dev, 'applicationId')) patch.applicationId = checkApplication(get(dev, 'applicationId'));
      if (has(dev, 'tags')) patch.tags = clone(get(dev, 'tags') ?? {});
      if (has(dev, 'variables')) patch.variables = clone(get(dev, 'variables') ?? {});
      if (has(dev, 'isDisabled')) patch.isDisabled = Boolean(get(dev, 'isDisabled'));
      if (has(dev, 'skipFcntCheck')) patch.skipFcntCheck = Boolean(get(dev, 'skipFcntCheck'));
      if (has(dev, 'joinEui')) patch.joinEui = checkJoinEui(get(dev, 'joinEui'));
      Object.assign(d, patch, { updatedAt: Date.now() });
      return {};
    }],

    ['DELETE', /^\/api\/devices\/([^/]+)$/, (m) => {
      const d = mustDevice(m[1]);
      devices.delete(d.devEui);
      keys.delete(d.devEui);
      return {};
    }],

    ['GET', /^\/api\/devices\/([^/]+)\/keys$/, (m) => {
      const d = mustDevice(m[1]);
      const k = keys.get(d.devEui);
      if (!k) throw notFound(d.devEui);
      return {
        deviceKeys: { nwkKey: k.nwkKey, appKey: k.appKey, genAppKey: k.genAppKey },
        createdAt: iso(k.createdAt),
        updatedAt: iso(k.updatedAt),
      };
    }],

    ['POST', /^\/api\/devices\/([^/]+)\/keys$/, (m, q, body) => {
      const d = mustDevice(m[1]);
      const k = readKeys(body);
      if (keys.has(d.devEui)) throw new ApiError('AlreadyExists', 'Object already exists');
      const now = Date.now();
      keys.set(d.devEui, { ...k, genAppKey: '', createdAt: now, updatedAt: now });
      return {};
    }],

    ['PUT', /^\/api\/devices\/([^/]+)\/keys$/, (m, q, body) => {
      const d = mustDevice(m[1]);
      const k = readKeys(body);
      const cur = keys.get(d.devEui);
      if (!cur) throw notFound(d.devEui);
      Object.assign(cur, k, { updatedAt: Date.now() });
      return {};
    }],

    ['DELETE', /^\/api\/devices\/([^/]+)\/keys$/, (m) => {
      const d = mustDevice(m[1]);
      if (!keys.has(d.devEui)) throw notFound(d.devEui);
      keys.delete(d.devEui);
      return {};
    }],

    ['GET', /^\/api\/devices\/([^/]+)\/metrics$/, (m, q) => {
      const d = mustDevice(m[1]);
      const start = Date.parse(q.get('start') ?? '');
      const end = Date.parse(q.get('end') ?? '');
      if (Number.isNaN(start) || Number.isNaN(end)) throw invalid('invalid start/end timestamp');
      const agg = (q.get('aggregation') ?? 'HOUR').toUpperCase();
      if (!['HOUR', 'DAY', 'MONTH'].includes(agg)) throw invalid(`invalid aggregation: ${agg}`);
      const key = profiles.get(d.deviceProfileId)?.key;
      return deviceMetrics({ ...d, profile: key }, start, end, agg, Date.now(), en);
    }],

    ['GET', /^\/api\/devices\/([^/]+)\/link-metrics$/, (m, q) => {
      const d = mustDevice(m[1]);
      const start = Date.parse(q.get('start') ?? '');
      const end = Date.parse(q.get('end') ?? '');
      if (Number.isNaN(start)) throw invalid('invalid start timestamp');
      if (Number.isNaN(end)) throw invalid('invalid end timestamp');
      const agg = (q.get('aggregation') ?? 'HOUR').toUpperCase();
      if (!['HOUR', 'DAY', 'MONTH'].includes(agg)) throw invalid(`invalid aggregation: ${agg}`);
      return linkMetrics(d, start, end, agg, Date.now());
    }],
  ];

  function handle(method, path, body) {
    const url = new URL(path, 'http://demo.local');
    const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const decoded = decodeURIComponent(p);
    for (const [meth, re, fn] of routes) {
      if (meth !== method) continue;
      const m = decoded.match(re);
      if (m) return { status: 200, json: fn(m, url.searchParams, body ?? null) };
    }
    return { status: 404, json: { code: 5, message: en ? `route not simulated in demo mode: ${method} ${path}` : `route non simulée en mode démo: ${method} ${path}`, details: [] } };
  }

  return {
    async request(method, path, body = null) {
      const delay = 15 + latency() * 45;
      await new Promise((res) => setTimeout(res, delay));
      const verb = String(method || 'GET').toUpperCase();
      let res;
      try {
        res = handle(verb, String(path), clone(body));
      } catch (e) {
        if (e instanceof ApiError) {
          const g = GRPC[e.kind];
          res = { status: g.status, json: { code: g.code, message: e.message, details: [] } };
        } else {
          res = { status: 500, json: { code: GRPC.Internal.code, message: String(e?.message ?? e), details: [] } };
        }
      }
      return { status: res.status, json: clone(res.json) };
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-test : `node web/js/demo.js`
// ---------------------------------------------------------------------------

function isMainModule() {
  if (typeof process === 'undefined' || !process.argv || !process.argv[1]) return false;
  try {
    const norm = (s) => s.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const self = norm(decodeURIComponent(new URL(import.meta.url).pathname));
    const argv = norm(process.argv[1]);
    return self === argv || self.endsWith('/' + argv) || self === argv + '.js';
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const assert = (cond, msg) => {
    if (!cond) throw new Error('Échec : ' + msg);
  };

  (async () => {
    const api = createDemoBackend();
    const call = (m, p, b) => api.request(m, p, b);

    // Tenants, applications, profils, gateways
    const t = await call('GET', '/api/tenants?limit=10&offset=0');
    assert(t.status === 200 && t.json.totalCount === '1' && t.json.result[0].name === 'Démo OpenGTB', 'tenants');
    const tenantId = t.json.result[0].id;
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tenantId), 'format UUID v4');

    const apps = await call('GET', `/api/applications?tenantId=${tenantId}&limit=100`);
    assert(apps.json.totalCount === '4' && apps.json.result.length === 4, 'applications');
    const appByName = Object.fromEntries(apps.json.result.map((a) => [a.name, a.id]));
    const appA = appByName['Bâtiment A — Confort'];
    const appB = appByName['Bâtiment B — Comptage'];
    const appP = appByName["Parking — Qualité d'air"];
    const appT = appByName['Test terrain'];
    assert(appA && appB && appP && appT, 'noms des applications');

    const noTenant = await call('GET', '/api/applications?limit=10');
    assert(noTenant.status === 400 && noTenant.json.code === 3, 'tenantId manquant -> 400');

    const dps = await call('GET', `/api/device-profiles?tenantId=${tenantId}&limit=100`);
    assert(dps.json.totalCount === '6' && dps.json.result.every((p) => p.region === 'EU868'), 'device-profiles');
    const dpByName = Object.fromEntries(dps.json.result.map((p) => [p.name, p.id]));

    const gws = await call('GET', `/api/gateways?tenantId=${tenantId}&limit=100`);
    const states = gws.json.result.map((g) => g.state);
    assert(gws.json.totalCount === '5', 'gateways');
    assert(states.filter((s) => s === 'ONLINE').length === 3 && states.includes('OFFLINE') && states.includes('NEVER_SEEN'), 'états gateways');
    assert(gws.json.result.every((g) => /^[0-9a-f]{16}$/.test(g.gatewayId)), 'gatewayId 16 hex');
    assert(!('lastSeenAt' in gws.json.result.find((g) => g.state === 'NEVER_SEEN')), 'NEVER_SEEN sans lastSeenAt');

    // Volumes et pagination
    const counts = {};
    let all = [];
    for (const [k, id] of Object.entries({ A: appA, B: appB, P: appP, T: appT })) {
      const r = await call('GET', `/api/devices?applicationId=${id}&limit=1000&offset=0`);
      counts[k] = parseInt(r.json.totalCount, 10);
      all = all.concat(r.json.result);
    }
    assert(counts.A === 60 && counts.B === 140 && counts.P === 35 && counts.T === 12, 'volumes ' + JSON.stringify(counts));
    assert(all.every((d) => /^[0-9a-f]{16}$/.test(d.devEui) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(d.createdAt)), 'format devEui / ISO');
    const never = all.filter((d) => !d.lastSeenAt).length;
    assert(never > 10 && never < 45, 'proportion jamais vus: ' + never);
    assert(all.some((d) => d.deviceStatus && d.deviceStatus.batteryLevel < 20), 'piles faibles');

    const p1 = await call('GET', `/api/devices?applicationId=${appB}&limit=50&offset=0`);
    const p3 = await call('GET', `/api/devices?applicationId=${appB}&limit=50&offset=100`);
    assert(p1.json.result.length === 50 && p3.json.result.length === 40 && p3.json.totalCount === '140', 'pagination');
    const seen = new Set();
    for (let off = 0; off < 140; off += 30) {
      const r = await call('GET', `/api/devices?applicationId=${appB}&limit=30&offset=${off}`);
      r.json.result.forEach((d) => seen.add(d.devEui));
    }
    assert(seen.size === 140, 'pages disjointes');

    // Recherche
    const s1 = await call('GET', `/api/devices?applicationId=${appB}&search=cpt-eau&limit=100`);
    assert(s1.json.result.length > 0 && s1.json.result.every((d) => d.name.includes('CPT-EAU')), 'search nom');
    assert(s1.json.totalCount === String(s1.json.result.length), 'totalCount après filtre');
    const target = p1.json.result[3];
    const s2 = await call('GET', `/api/devices?applicationId=${appB}&search=${target.devEui.slice(6, 14)}&limit=100`);
    assert(s2.json.result.some((d) => d.devEui === target.devEui), 'search devEui');
    const f = await call('GET', `/api/devices?applicationId=${appA}&deviceProfileId=${dpByName['Elsys ERS CO2']}&limit=100`);
    assert(f.json.result.length > 0 && f.json.result.every((d) => d.deviceProfileName === 'Elsys ERS CO2'), 'filtre profil');

    // Création
    const newEui = '0011223344556677';
    const create = await call('POST', '/api/devices', {
      device: { dev_eui: newEui.toUpperCase(), name: 'CO2-R+2-Salle-299', application_id: appT, device_profile_id: dpByName['Elsys ERS CO2'], tags: { batiment: 'A' } },
    });
    assert(create.status === 200 && JSON.stringify(create.json) === '{}', 'création');
    const listT = await call('GET', `/api/devices?applicationId=${appT}&limit=100`);
    assert(listT.json.totalCount === '13' && listT.json.result.some((d) => d.devEui === newEui && !d.lastSeenAt), 'device créé listé');

    const dup = await call('POST', '/api/devices', { device: { devEui: newEui, name: 'x', applicationId: appA, deviceProfileId: dpByName['Elsys ERS CO2'] } });
    assert(dup.status === 409 && dup.json.code === 6 && dup.json.message === 'Object already exists', 'doublon 409');
    const dup2 = await call('POST', '/api/devices', { device: { devEui: all[0].devEui, name: 'x', applicationId: appT, deviceProfileId: dpByName['Elsys ERS CO2'] } });
    assert(dup2.status === 409, 'doublon inter-applications');
    const bad1 = await call('POST', '/api/devices', { device: { devEui: 'zz', applicationId: appA, deviceProfileId: dpByName['Elsys ERS CO2'] } });
    assert(bad1.status === 400 && bad1.json.code === 3, 'devEui invalide');
    const bad2 = await call('POST', '/api/devices', { device: { devEui: 'aaaaaaaaaaaaaaaa', applicationId: appA, deviceProfileId: '' } });
    assert(bad2.status === 400 && bad2.json.message === 'invalid length: expected length 32 for simple format, found 0', 'profil vide');
    const bad3 = await call('POST', '/api/devices', { device: { devEui: 'aaaaaaaaaaaaaaaa', applicationId: '00000000-0000-4000-8000-000000000000', deviceProfileId: dpByName['Elsys ERS CO2'] } });
    assert(bad3.status === 400, 'application inconnue');

    // Lecture / mise à jour
    const g = await call('GET', `/api/devices/${newEui}`);
    assert(g.status === 200 && g.json.device.applicationId === appT && g.json.classEnabled === 'CLASS_A' && g.json.device.joinEui === '0000000000000000', 'get device');
    const upd = await call('PUT', `/api/devices/${newEui}`, { device: { ...g.json.device, tags: { batiment: 'A', etage: 'R+2' }, deviceProfileId: dpByName['Milesight EM300-TH'] } });
    assert(upd.status === 200, 'update');
    const g2 = await call('GET', `/api/devices/${newEui}`);
    assert(g2.json.device.tags.etage === 'R+2', 'tags mis à jour');
    const l2 = await call('GET', `/api/devices?applicationId=${appT}&search=${newEui}&limit=10`);
    assert(l2.json.result[0].deviceProfileName === 'Milesight EM300-TH', 'deviceProfileName recalculé');
    const nf = await call('GET', '/api/devices/ffffffffffffffff');
    assert(nf.status === 404 && nf.json.code === 5 && nf.json.message === 'Object does not exist (id: ffffffffffffffff)', 'get 404');
    const nfu = await call('PUT', '/api/devices/ffffffffffffffff', { device: { name: 'x' } });
    assert(nfu.status === 404, 'put 404');

    // Clés
    const k0 = await call('GET', `/api/devices/${newEui}/keys`);
    assert(k0.status === 404, 'pas de clés');
    const kb = await call('POST', `/api/devices/${newEui}/keys`, { deviceKeys: { nwkKey: '1234' } });
    assert(kb.status === 400, 'nwkKey invalide');
    const key = '000102030405060708090a0b0c0d0e0f';
    const k1 = await call('POST', `/api/devices/${newEui}/keys`, { device_keys: { nwk_key: key, app_key: '' } });
    assert(k1.status === 200, 'création clés snake_case');
    const k2 = await call('POST', `/api/devices/${newEui}/keys`, { deviceKeys: { nwkKey: key } });
    assert(k2.status === 409, 'clés doublon 409');
    const k3 = await call('GET', `/api/devices/${newEui}/keys`);
    assert(k3.json.deviceKeys.nwkKey === key && k3.json.deviceKeys.genAppKey === '', 'lecture clés');
    const k4 = await call('PUT', `/api/devices/${newEui}/keys`, { deviceKeys: { nwkKey: 'ff'.repeat(16), appKey: '00'.repeat(16) } });
    const k5 = await call('GET', `/api/devices/${newEui}/keys`);
    assert(k4.status === 200 && k5.json.deviceKeys.nwkKey === 'ff'.repeat(16), 'update clés');
    const kd = await call('DELETE', `/api/devices/${newEui}/keys`);
    const k6 = await call('GET', `/api/devices/${newEui}/keys`);
    assert(kd.status === 200 && k6.status === 404, 'suppression clés');
    const kNf = await call('POST', '/api/devices/ffffffffffffffff/keys', { deviceKeys: { nwkKey: key } });
    assert(kNf.status === 404, 'clés device absent');
    let withKeys = 0;
    for (const d of all.slice(0, 50)) if ((await call('GET', `/api/devices/${d.devEui}/keys`)).status === 200) withKeys++;
    assert(withKeys >= 30 && withKeys <= 48, 'environ 80 % de clés: ' + withKeys);

    // Migration delete + create et suppression des clés
    const mig = all.find((d) => d.devEui !== newEui && d.lastSeenAt);
    const migFull = (await call('GET', `/api/devices/${mig.devEui}`)).json.device;
    await call('POST', `/api/devices/${newEui}/keys`, { deviceKeys: { nwkKey: key } });
    assert((await call('DELETE', `/api/devices/${mig.devEui}`)).status === 200, 'delete');
    assert((await call('GET', `/api/devices/${mig.devEui}`)).status === 404, 'delete -> 404');
    assert((await call('GET', `/api/devices/${mig.devEui}/keys`)).status === 404, 'clés supprimées avec le device');
    assert((await call('DELETE', `/api/devices/${mig.devEui}`)).status === 404, 'double delete 404');
    const recreate = await call('POST', '/api/devices', { device: { ...migFull, applicationId: appP } });
    assert(recreate.status === 200, 'recréation (migration)');
    const listP = await call('GET', `/api/devices?applicationId=${appP}&limit=1`);
    assert(listP.json.totalCount === '36', 'migration visible');
    assert((await call('DELETE', `/api/devices/${newEui}`)).status === 200, 'delete device créé');
    assert((await call('GET', `/api/devices/${newEui}/keys`)).status === 404, 'clés du device créé supprimées');

    // Métriques
    const now = Date.now();
    const recent = all.find((d) => d.lastSeenAt && now - Date.parse(d.lastSeenAt) < 2 * HOUR && d.devEui !== mig.devEui);
    const start = new Date(now - 24 * HOUR).toISOString();
    const end = new Date(now).toISOString();
    const lm = await call('GET', `/api/devices/${recent.devEui}/link-metrics?start=${start}&end=${end}&aggregation=HOUR`);
    assert(lm.status === 200 && lm.json.rxPackets.timestamps.length === 25, 'métriques horaires: ' + lm.json.rxPackets?.timestamps.length);
    assert(lm.json.rxPackets.kind === 'ABSOLUTE' && lm.json.gwRssi.kind === 'GAUGE' && lm.json.rxPackets.datasets[0].label === 'rx_count', 'métriques format');
    const rxData = lm.json.rxPackets.datasets[0].data;
    const rssiData = lm.json.gwRssi.datasets[0].data;
    assert(rxData.reduce((a, b) => a + b, 0) > 0, 'paquets reçus');
    assert(rxData.every((c, i) => (c === 0 ? rssiData[i] === 0 : rssiData[i] <= -60 && rssiData[i] >= -118)), 'RSSI cohérent');
    const sumFreq = lm.json.rxPacketsPerFreq.datasets.reduce((a, ds) => a + ds.data.reduce((x, y) => x + y, 0), 0);
    assert(sumFreq === rxData.reduce((a, b) => a + b, 0), 'somme par fréquence');
    const lm2 = await call('GET', `/api/devices/${recent.devEui}/link-metrics?start=${start}&end=${end}&aggregation=HOUR`);
    assert(JSON.stringify(lm2.json) === JSON.stringify(lm.json), 'métriques déterministes');
    const ghost = all.find((d) => !d.lastSeenAt);
    const lm3 = await call('GET', `/api/devices/${ghost.devEui}/link-metrics?start=${new Date(now - 7 * DAY).toISOString()}&end=${end}&aggregation=DAY`);
    assert(lm3.json.rxPackets.timestamps.length === 8 && lm3.json.rxPackets.datasets[0].data.every((x) => x === 0), 'jamais vu -> 0 paquet');
    const lmBad = await call('GET', `/api/devices/${recent.devEui}/link-metrics?end=${end}`);
    assert(lmBad.status === 400, 'start manquant');

    // Route inconnue, déterminisme
    const unk = await call('GET', '/api/users');
    assert(unk.status === 404 && unk.json.code === 5 && unk.json.message === 'route non simulée en mode démo: GET /api/users', 'route inconnue');
    const tA = (await createDemoBackend({ seed: 42 }).request('GET', '/api/tenants')).json.result[0].id;
    const tB = (await createDemoBackend({ seed: 7 }).request('GET', '/api/tenants')).json.result[0].id;
    assert(tA === tenantId && tB !== tenantId, 'déterminisme du seed');

    // Version anglaise : mêmes tirages (DevEUI, clés), textes en anglais.
    const fr2 = createDemoBackend();
    const enApi = createDemoBackend({ lang: 'en' });
    const tEn = (await enApi.request('GET', '/api/tenants')).json.result[0];
    assert(tEn.name === 'OpenGTB Demo' && tEn.id === tenantId, 'tenant anglais');
    const appsEn = (await enApi.request('GET', `/api/applications?tenantId=${tenantId}`)).json.result.map((a) => a.name).sort();
    assert(JSON.stringify(appsEn) === JSON.stringify(['Building A — Comfort', 'Building B — Metering', 'Car park — Air quality', 'Field test']), 'applications anglaises ' + appsEn);
    const appsFr2 = (await fr2.request('GET', `/api/applications?tenantId=${tenantId}`)).json.result;
    const appsEnFull = (await enApi.request('GET', `/api/applications?tenantId=${tenantId}`)).json.result;
    let euisFr = [];
    let euisEn = [];
    const namesEn = [];
    for (const a of appsFr2) euisFr = euisFr.concat((await fr2.request('GET', `/api/devices?applicationId=${a.id}`)).json.result.map((d) => d.devEui));
    for (const a of appsEnFull) {
      const list = (await enApi.request('GET', `/api/devices?applicationId=${a.id}`)).json.result;
      euisEn = euisEn.concat(list.map((d) => d.devEui));
      namesEn.push(...list.map((d) => d.name));
    }
    assert(euisFr.length === 247 && JSON.stringify([...euisFr].sort()) === JSON.stringify([...euisEn].sort()), 'mêmes DevEUI en anglais');
    assert(new Set(namesEn).size === namesEn.length && namesEn.some((n) => /^CO2-L\d-/.test(n)) && !namesEn.some((n) => /R\+|Salle|Bureau/.test(n)), 'noms anglais');
    const unkEn = await enApi.request('GET', '/api/users');
    assert(unkEn.json.message === 'route not simulated in demo mode: GET /api/users', 'route inconnue (anglais)');

    console.log('demo.js OK');
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
