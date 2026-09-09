/**
 * The Signage and Advertising catalogue supplied by the client.
 *
 * These seed as DRAFTS (isActive: false, QUOTE_ONLY). They exist in the admin
 * panel so the team can work through them, but they are absent from the public
 * API and the sitemap until someone adds a price and a real photograph. That
 * ordering is deliberate: publishing ~60 empty product pages at once would be
 * thin content on a domain whose existing pages already rank.
 *
 * Descriptions say what each product IS. Specifications, sizes, materials and
 * MOQ are left empty on purpose — those are commercial claims about what
 * MRPrint World supplies, and inventing them would mislead customers and
 * create disputes at quoting time. The team fills them in.
 *
 * `categories` may list more than one: "Corporate Signage" genuinely belongs
 * under both Indoor and Custom Signage, and gets ONE record with ONE URL
 * rather than two competing pages.
 */

export const NEW_PRODUCTS = [
  /* ── SIGNAGE › Outdoor ────────────────────────────────────────────────── */
  {
    slug: 'acrylic-sign-board',
    name: 'Acrylic Sign Board',
    categories: ['outdoor-signage'],
    shortDescription: 'Precision-cut acrylic signage with a clean, premium finish for storefronts and facades.',
    description:
      'Sign boards fabricated from cast or extruded acrylic sheet, cut to shape and finished for outdoor use. Acrylic holds colour and gloss well, takes both printed and applied vinyl graphics, and can be mounted flush, stood off the wall on spacers, or illuminated from behind. A common choice where a business wants a cleaner, more contemporary look than flex.',
  },
  {
    slug: 'flex-sign-board',
    name: 'Flex Sign Board',
    categories: ['outdoor-signage'],
    shortDescription: 'Cost-effective printed flex signage stretched over a fabricated frame.',
    description:
      'Large-format printed flex mounted on a welded frame — the workhorse of outdoor retail signage. Flex covers large areas economically, suits frequent campaign changes, and can be supplied as a plain fascia or lit from within for night-time visibility. Available in front-lit and back-lit grades depending on how the sign is illuminated.',
  },
  {
    slug: 'led-sign-board',
    name: 'LED Sign Board',
    categories: ['outdoor-signage'],
    shortDescription: 'Illuminated sign boards using energy-efficient LED modules for day-and-night visibility.',
    description:
      'Sign boards built around LED modules rather than conventional tube lighting. LEDs draw less power, run cooler, and last considerably longer, which matters on a sign that stays lit every night. Used across storefront fascias, pylon signs and building-mounted branding where the sign has to remain legible after dark.',
  },
  {
    slug: 'backlit-sign-board',
    name: 'Backlit Sign Board',
    categories: ['outdoor-signage'],
    shortDescription: 'Signage lit from behind, so the graphics glow evenly against a bright face.',
    description:
      'The light source sits behind a translucent face, pushing light through the graphic so the whole panel glows. Backlit construction gives the most even night-time appearance and is the usual choice for premium retail fascias, showroom frontage and brand-standard signage where consistency across locations matters.',
  },
  {
    slug: 'frontlit-sign-board',
    name: 'Frontlit Sign Board',
    categories: ['outdoor-signage'],
    shortDescription: 'Signage lit from the front, keeping graphics crisp and colours true after dark.',
    description:
      'Illumination is directed onto the face of the sign from the front rather than through it. Front-lit construction keeps dense colours and fine detail reading accurately at night, and is generally more economical than backlit for large areas. Common on hoardings, building signage and large fascia boards.',
  },
  {
    slug: '3d-letter-signage',
    name: '3D Letter Signage',
    categories: ['outdoor-signage'],
    shortDescription: 'Individually fabricated dimensional letters mounted directly to a facade.',
    description:
      'Letters built as individual three-dimensional forms rather than printed onto a flat panel, then mounted directly to the building. The depth casts a shadow that lifts the name off the wall and reads as a considerable step up from flat signage. Fabricated in acrylic, metal or composite depending on the finish and the exposure.',
  },
  {
    slug: 'channel-letter-signage',
    name: 'Channel Letter Signage',
    categories: ['outdoor-signage'],
    shortDescription: 'Hollow fabricated letters built to house internal illumination.',
    description:
      'Each letter is fabricated as a hollow channel — a returned side wall with a face — so lighting can be installed inside. The construction is the standard for illuminated brand signage on retail and commercial frontage, and can be finished to glow from the face, from behind as a halo, or both.',
  },
  {
    slug: 'led-channel-letters',
    name: 'LED Channel Letters',
    categories: ['outdoor-signage'],
    shortDescription: 'Channel letters fitted with LED modules for even, low-power illumination.',
    description:
      'Channel letter construction with LED modules installed inside each letter. LEDs light the letter evenly without the hot spots older tube lighting produced, draw far less power over a full night of operation, and reduce how often anyone needs to get back up to the sign for maintenance.',
  },
  {
    slug: 'acrylic-letters',
    name: 'Acrylic Letters',
    categories: ['outdoor-signage'],
    shortDescription: 'Individually cut acrylic letters for interior and exterior brand signage.',
    description:
      'Letters cut from solid acrylic sheet on a laser or CNC router, finished on the edges and supplied ready to mount. Available in a wide range of colours and thicknesses, with the option of a polished or matt face. Used for reception walls, shopfronts and directional signage where clean letterforms matter more than illumination.',
  },

  /* ── SIGNAGE › Indoor ─────────────────────────────────────────────────── */
  {
    slug: 'reception-sign',
    name: 'Reception Sign',
    categories: ['indoor-signage'],
    shortDescription: 'The primary brand statement behind a reception desk.',
    description:
      'Signage designed for the wall a visitor sees first. Typically built as dimensional lettering or a backlit logo panel in acrylic, metal or a combination, sized to the wall and finished to match the interior. This is usually the single most photographed piece of signage in a building, so finish quality carries more weight here than anywhere else.',
  },
  {
    slug: 'office-signage',
    name: 'Office Signage',
    categories: ['indoor-signage'],
    shortDescription: 'A coordinated set of interior signage across an office floor.',
    description:
      'Interior signage covering the elements an office needs to function and to look considered — department markers, wall graphics, glass manifestation, cabin identifiers and wayfinding. Supplied as a coordinated set so that materials, type and finish stay consistent across the floor rather than accumulating piecemeal.',
  },
  {
    slug: 'room-name-plates',
    name: 'Room Name Plates',
    categories: ['indoor-signage'],
    shortDescription: 'Wall or door-mounted plates identifying rooms and meeting spaces.',
    description:
      'Plates that identify a room by name, number or function. Available in acrylic, metal or engraved laminate, with fixed or slide-in interchangeable inserts where a room changes use. Slide-in versions are worth specifying wherever teams reshuffle, since the plate then never needs remaking.',
  },
  {
    slug: 'door-signs',
    name: 'Door Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Door-mounted signage for identification, instruction and access.',
    description:
      'Signage fixed to or beside a door — occupant names, room function, push and pull indicators, access restrictions and operational notices. Produced in materials suited to constant handling, with adhesive, screw or standoff fixing depending on the door.',
  },
  {
    slug: 'floor-signs',
    name: 'Floor Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Durable floor graphics for direction, safety and promotion.',
    description:
      'Printed graphics applied directly to the floor using laminates rated for foot traffic. Used for directional arrows, distancing markers, hazard zones and promotional placement in retail. The anti-slip laminate is the part that matters — it determines both safety and how long the graphic survives.',
  },
  {
    slug: 'safety-signs',
    name: 'Safety Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Hazard, mandatory, prohibition and emergency signage for workplaces.',
    description:
      'Signage covering workplace hazard warnings, mandatory PPE, prohibitions, first aid and emergency routes. Produced on substrates suited to the environment — from printed vinyl on board for offices through to rigid, chemical-resistant panels for industrial floors. Photoluminescent options are available where signage must stay readable in a power failure.',
  },
  {
    slug: 'fire-safety-signs',
    name: 'Fire Safety Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Fire equipment, exit route and assembly point signage.',
    description:
      'Signage identifying fire extinguishers, hose reels, alarm call points, escape routes and assembly points. Supplied in standard formats and sizes, with photoluminescent material available so that exit routes remain visible when lighting fails or smoke reduces visibility.',
  },
  {
    slug: 'washroom-signs',
    name: 'Washroom Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Washroom identification and accessibility signage.',
    description:
      'Signage identifying washrooms by gender, accessibility and facilities such as baby-change. Produced in acrylic, metal or engraved laminate to match the surrounding interior, with tactile and braille variants available where accessibility standards apply.',
  },
  {
    slug: 'parking-signs',
    name: 'Parking Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Bay allocation, direction and restriction signage for parking areas.',
    description:
      'Signage for parking areas — reserved and visitor bays, accessible spaces, entry and exit direction, height restrictions and no-parking notices. Produced on weather-resistant substrates for open areas, with post, wall and ceiling-hung mounting depending on the site.',
  },
  {
    slug: 'acrylic-office-signs',
    name: 'Acrylic Office Signs',
    categories: ['indoor-signage'],
    shortDescription: 'Clean acrylic signage for interior office environments.',
    description:
      'Interior signage produced in acrylic — name plates, department markers, wall-mounted logos and directional panels. Acrylic suits office interiors because it can be finished clear, frosted or in solid colour, and mounted flush or stood off the wall on polished standoffs for a lighter, more deliberate look.',
  },
  {
    // Genuinely belongs in two branches — one record, one URL, listed in both.
    slug: 'corporate-signage',
    name: 'Corporate Signage',
    categories: ['indoor-signage', 'custom-signage'],
    shortDescription: 'Signage programmes rolled out to a single standard across corporate premises.',
    description:
      'Signage produced to a defined corporate identity and applied consistently across offices, plants and branches — reception branding, wayfinding, department identification and external building signage. The value here is repeatability: the same specification delivered to every location, so a brand looks identical whether someone visits the head office or a regional branch.',
  },

  /* ── SIGNAGE › Retail ─────────────────────────────────────────────────── */
  {
    slug: 'shop-front-signage',
    name: 'Shop Front Signage',
    categories: ['retail-signage'],
    shortDescription: 'The main fascia sign carrying a shop’s name to the street.',
    description:
      'The primary sign across a shop frontage. Built as a flex fascia, ACP panel with applied lettering, or fabricated dimensional letters depending on budget and the look required. This is the sign that has to work at distance, at speed and after dark, so legibility and illumination decide its value more than detail does.',
  },
  {
    slug: 'retail-store-signage',
    name: 'Retail Store Signage',
    categories: ['retail-signage'],
    shortDescription: 'A full signage package for the inside of a retail space.',
    description:
      'The signage a store needs beyond its fascia — department markers, category headers, wall graphics, window vinyl, offer boards and till-point signage. Supplied as one coordinated package so a store reads as a single environment rather than an accumulation of separate jobs.',
  },
  {
    slug: 'brand-boards',
    name: 'Brand Boards',
    categories: ['retail-signage'],
    shortDescription: 'Branded boards identifying a brand’s presence within a retail space.',
    description:
      'Boards carrying a brand’s identity inside a store or dealership — wall-mounted panels, shop-in-shop branding and authorised-dealer boards. Usually produced to a brand’s own specification and rolled out across a dealer or retail network, where matching the standard exactly is the whole point.',
  },
  {
    slug: 'display-boards',
    name: 'Display Boards',
    categories: ['retail-signage'],
    shortDescription: 'Boards for presenting information, products or notices.',
    description:
      'Boards used to present information in a fixed location — product information, notices, schedules and directories. Produced as printed rigid panels, framed boards or systems with changeable inserts where content is updated regularly.',
  },
  {
    slug: 'promotional-signage',
    name: 'Promotional Signage',
    categories: ['retail-signage'],
    shortDescription: 'Short-run signage for offers, launches and seasonal campaigns.',
    description:
      'Signage produced for a defined campaign period — offer announcements, launches, festival promotions and clearance. Because the lifespan is short, these are built for fast turnaround and economical production rather than long-term durability, and are often produced as a set covering multiple locations at once.',
  },
  {
    slug: 'counter-signs',
    name: 'Counter Signs',
    categories: ['retail-signage'],
    shortDescription: 'Compact signage for counters, till points and service desks.',
    description:
      'Small-format signage sited on or beside a counter — service information, payment options, offers and queue guidance. Produced as free-standing acrylic holders, printed blocks or clip frames, sized so they inform without crowding the counter.',
  },
  {
    slug: 'shelf-talkers',
    name: 'Shelf Talkers',
    categories: ['retail-signage'],
    shortDescription: 'Small printed cards that project from a shelf edge to flag a product.',
    description:
      'Printed cards fixed to a shelf edge so they project into the aisle and interrupt a shopper scanning the shelf. Used to call out offers, new lines and product claims at the exact point of decision. Produced in volume for retail chains, usually as part of a wider campaign rollout.',
  },
  {
    slug: 'menu-boards',
    name: 'Menu Boards',
    categories: ['retail-signage'],
    shortDescription: 'Wall-mounted or backlit menu displays for food service.',
    description:
      'Menu displays for restaurants, cafés and quick-service outlets. Produced as printed panels, backlit light boxes, or framed systems with changeable inserts where pricing and items move frequently. Backlit construction is the usual choice where the menu sits above a counter and has to be read from the door.',
  },
  {
    slug: 'price-boards',
    name: 'Price Boards',
    categories: ['retail-signage'],
    shortDescription: 'Boards displaying pricing, with fixed or changeable numerals.',
    description:
      'Boards presenting prices clearly at a distance — retail price lists, fuel pricing, service rates and rate cards. Available as fixed printed panels or with changeable numerals and slide-in inserts where prices move often enough that reprinting is impractical.',
  },
  {
    // Second genuine multi-category case from the supplied list.
    slug: 'promotional-boards',
    name: 'Promotional Boards',
    categories: ['retail-signage', 'event-advertising'],
    shortDescription: 'Printed boards supporting promotions in stores and at events.',
    description:
      'Rigid printed boards used to carry a promotional message, in a retail environment or at an event. Produced on foam board, sunboard or ACP depending on how long they need to last and whether they will be handled, transported or mounted outdoors.',
  },

  /* ── SIGNAGE › Custom ─────────────────────────────────────────────────── */
  {
    slug: 'custom-name-boards',
    name: 'Custom Name Boards',
    categories: ['custom-signage'],
    shortDescription: 'Name boards made to a specific design, size and material.',
    description:
      'Name boards produced to a brief rather than from a catalogue — non-standard sizes, specific materials, particular finishes or a design supplied by the customer. Fabricated in acrylic, metal, wood or composite, with engraving, printing or cut lettering as the design requires.',
  },
  {
    slug: 'house-name-plates',
    name: 'House Name Plates',
    categories: ['custom-signage'],
    shortDescription: 'Personalised nameplates for homes and residences.',
    description:
      'Nameplates for residential entrances, gates and doors. Produced in acrylic, brass, steel, wood and stone-effect materials, with engraved, embossed or cut lettering. Often personalised with a family name, house number or motif, and specified to survive continuous outdoor exposure.',
  },
  {
    slug: 'society-signage',
    name: 'Society Signage',
    categories: ['custom-signage'],
    shortDescription: 'Entrance, block, wing and notice signage for residential societies.',
    description:
      'Signage packages for housing societies and apartment complexes — entrance name boards, block and wing identification, flat numbering, notice boards, parking allocation and common-area instruction. Usually specified as a complete set so that an entire complex reads consistently.',
  },
  {
    slug: 'school-signage',
    name: 'School Signage',
    categories: ['custom-signage'],
    shortDescription: 'Identification, wayfinding and display signage for schools.',
    description:
      'Signage for educational premises — main entrance boards, block and classroom identification, laboratory and library signage, notice and display boards, and safety signage. Materials are chosen for durability under constant contact, and mounting heights for the age group using the space.',
  },
  {
    slug: 'hospital-signage',
    name: 'Hospital Signage',
    categories: ['custom-signage'],
    shortDescription: 'Departmental, directional and safety signage for healthcare premises.',
    description:
      'Signage for hospitals, clinics and diagnostic centres — department identification, floor directories, directional wayfinding, ward and room numbering, and mandatory safety notices. Healthcare wayfinding carries unusual weight because visitors are often unfamiliar with the building and under stress, so clarity outranks decoration.',
  },
  {
    slug: 'restaurant-signage',
    name: 'Restaurant Signage',
    categories: ['custom-signage'],
    shortDescription: 'Frontage, interior and menu signage for food-service venues.',
    description:
      'Signage across a restaurant or café — exterior fascia and projecting signs, interior branding and wall graphics, menu displays, and operational signage for washrooms and service areas. Produced so the exterior draws people in and the interior holds the same identity once they are seated.',
  },
  {
    slug: 'industrial-signage',
    name: 'Industrial Signage',
    categories: ['custom-signage'],
    shortDescription: 'Robust signage for factories, warehouses and plants.',
    description:
      'Signage built for industrial environments — plant and unit identification, zone and bay marking, machinery labelling, hazard and mandatory safety notices, and traffic direction within a site. Specified on substrates that survive dust, heat, chemicals, washdown and vehicle movement, where ordinary interior signage would not last.',
  },
  {
    slug: 'custom-logo-signage',
    name: 'Custom Logo Signage',
    categories: ['custom-signage'],
    shortDescription: 'A brand’s logo fabricated as a physical sign.',
    description:
      'A logo reproduced as a physical object — cut, fabricated or moulded to match the artwork, in the correct colours and proportions. Produced in acrylic, metal, composite or a combination, flat or dimensional, illuminated or plain. Reproducing brand geometry accurately at scale is the whole job here.',
  },

  /* ── ADVERTISING › Banners & Displays ─────────────────────────────────── */
  {
    slug: 'vinyl-banners',
    name: 'Vinyl Banners',
    categories: ['banners-displays'],
    shortDescription: 'Printed vinyl banners for indoor and outdoor display.',
    description:
      'Banners printed on vinyl substrate, finished with hemmed edges and eyelets for tensioned mounting. Vinyl holds colour well and tolerates outdoor exposure, making it a common choice for campaign banners, event branding and site hoardings where the banner has to survive weather and be reused.',
  },
  {
    slug: 'exhibition-backdrops',
    name: 'Exhibition Backdrops',
    categories: ['banners-displays'],
    shortDescription: 'Large-format branded backdrops for exhibition stands.',
    description:
      'The main branded surface of an exhibition stand, printed large-format and mounted on a portable frame. Supplied as fabric or vinyl on pop-up, tension or modular framing, sized to the stand and packed to travel. Setup speed matters as much as print quality when a stand has to be built the morning it opens.',
  },
  {
    slug: 'table-top-standees',
    name: 'Table Top Standees',
    categories: ['banners-displays'],
    shortDescription: 'Compact roll-up or fixed standees sized for a table.',
    description:
      'Small standees designed to sit on a table or counter rather than the floor. Supplied as miniature roll-up units or fixed printed panels with a folding base, used at reception desks, trade counters and exhibition tables where a full-height standee would be out of scale.',
  },
  {
    slug: 'hanging-banners',
    name: 'Hanging Banners',
    categories: ['banners-displays'],
    shortDescription: 'Banners suspended from ceilings or overhead structures.',
    description:
      'Banners hung from a ceiling, truss or overhead structure so they read above the crowd. Printed single or double sided, finished with pockets, eyelets or a rigid top and bottom rail. Used in malls, showrooms, exhibition halls and event venues where floor space is unavailable or sightlines are blocked.',
  },
  {
    slug: 'pole-banners',
    name: 'Pole Banners',
    categories: ['banners-displays'],
    shortDescription: 'Street-pole mounted banners for outdoor campaigns.',
    description:
      'Banners mounted to street poles or lamp posts using bracket hardware, usually installed as a repeating run along a road or approach. Printed double sided on outdoor-grade material so they read in both directions of travel, and used for civic campaigns, events and area branding.',
  },

  /* ── ADVERTISING › Promotional Displays ───────────────────────────────── */
  {
    slug: 'table-display',
    name: 'Table Display',
    categories: ['promotional-displays'],
    shortDescription: 'Branded display units designed to sit on a table or counter.',
    description:
      'Display units sized for a table or counter, holding product, literature or a promotional message. Produced in acrylic, printed board or a combination, either as a fixed unit or as a flat-packed one that assembles on site.',
  },
  {
    slug: 'product-display-stand',
    name: 'Product Display Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Free-standing units built to present product at retail.',
    description:
      'Floor-standing units built to hold and present product in a retail environment. Fabricated in acrylic, metal, board or a combination, with shelves, hooks or trays according to what is being displayed, and branded to the campaign. Built around the product’s actual weight and dimensions rather than a standard shell.',
  },
  {
    slug: 'brochure-stand',
    name: 'Brochure Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Stands holding brochures at reception, events and showrooms.',
    description:
      'Stands that hold brochures upright and visible. Produced as floor-standing or table-top units in acrylic or metal, single or multi-pocket, in fixed and portable formats. Used at reception areas, exhibition stands, showrooms and hotel lobbies.',
  },
  {
    slug: 'leaflet-stand',
    name: 'Leaflet Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Compact stands for leaflets, flyers and inserts.',
    description:
      'Stands sized for leaflets and flyers rather than full brochures. Available as single or tiered multi-pocket units in acrylic or card, for counters, waiting areas and information points where several titles are offered side by side.',
  },
  {
    slug: 'poster-stand',
    name: 'Poster Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Free-standing frames that display a poster at eye level.',
    description:
      'Free-standing frames holding a printed poster upright. Supplied as snap frames on a base, A-boards or tension systems, with the poster changeable so the same stand carries successive campaigns. Used in retail entrances, lobbies, events and showrooms.',
  },
  {
    slug: 'menu-stand',
    name: 'Menu Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Table-top and free-standing holders for menus.',
    description:
      'Holders that present a menu on a table or at an entrance. Produced in acrylic, metal or wood as tent-style, single-sided or multi-page units, with changeable inserts so the venue can update items and prices without replacing the stand.',
  },
  {
    slug: 'qr-code-stand',
    name: 'QR Code Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Compact stands presenting a scannable QR code.',
    description:
      'Small stands that hold a printed QR code where a customer can scan it — payment codes at a till, digital menus on a table, feedback links, and links to catalogues or offers. Produced in acrylic or printed board, sized so the code scans reliably at arm’s length.',
  },
  {
    slug: 'acrylic-display-stand',
    name: 'Acrylic Display Stand',
    categories: ['promotional-displays'],
    shortDescription: 'Clear acrylic stands for product, literature and signage.',
    description:
      'Display stands fabricated from clear or coloured acrylic, cut and formed to hold product, print or signage. Acrylic suits display work because it is visually recessive — it presents what is on it without competing — and can be printed, engraved or left plain.',
  },
  {
    slug: 'product-display-boards',
    name: 'Product Display Boards',
    categories: ['promotional-displays'],
    shortDescription: 'Boards presenting a product range, samples or specifications.',
    description:
      'Boards that present a product range in one view — sample panels, colour and finish ranges, specification charts and comparison displays. Produced as rigid printed panels or as fabricated boards with mounted physical samples, for showrooms, dealer counters and trade stands.',
  },

  /* ── ADVERTISING › Event Advertising ──────────────────────────────────── */
  {
    slug: 'event-backdrops',
    name: 'Event Backdrops',
    categories: ['event-advertising'],
    shortDescription: 'Large printed backdrops forming the branded wall of an event.',
    description:
      'The main branded surface behind an event — press walls, sponsor boards and step-and-repeat backdrops. Printed on fabric or flex and mounted on a frame or truss, sized to the space and to how it will be photographed, since a backdrop’s real audience is usually the coverage afterwards.',
  },
  {
    slug: 'stage-backdrops',
    name: 'Stage Backdrops',
    categories: ['event-advertising'],
    shortDescription: 'Full-width printed backdrops for stages and platforms.',
    description:
      'Backdrops covering the full width of a stage, printed large-format and rigged to the stage structure. Used for conferences, ceremonies, product launches and cultural events. Colour and contrast are specified with stage lighting in mind, because a backdrop that reads well in daylight can wash out under a lighting rig.',
  },
  {
    slug: 'photo-booth-backdrops',
    name: 'Photo Booth Backdrops',
    categories: ['event-advertising'],
    shortDescription: 'Branded backdrops designed for photographs at events.',
    description:
      'Backdrops built specifically to be photographed against — repeating logo patterns, themed designs and framed setups. Printed on low-sheen material so camera flash does not blow out the branding, and sized so the logo stays in frame regardless of how the shot is composed.',
  },
  {
    slug: 'welcome-boards',
    name: 'Welcome Boards',
    categories: ['event-advertising'],
    shortDescription: 'Entrance boards greeting guests and setting the event identity.',
    description:
      'Boards positioned at an entrance to greet guests and carry the event’s identity — the occasion, hosts, sponsors or programme. Produced as printed rigid boards, framed panels or fabricated units, in formats ranging from a single easel board to a full entrance installation.',
  },
  {
    slug: 'direction-boards',
    name: 'Direction Boards',
    categories: ['event-advertising'],
    shortDescription: 'Temporary wayfinding boards guiding guests around a venue.',
    description:
      'Boards that guide guests through a venue — entry routes, hall and session identification, registration, parking, seating and facilities. Produced for temporary use and rapid deployment, on stands or fixings that install and strike quickly without marking the venue.',
  },
  {
    slug: 'event-standees',
    name: 'Event Standees',
    categories: ['event-advertising'],
    shortDescription: 'Portable standees carrying event branding and information.',
    description:
      'Free-standing units carrying event branding, schedules, sponsor recognition or directions. Supplied as roll-up or rigid standees that transport flat and set up in moments, then move around the venue as the event needs change.',
  },
  {
    slug: 'exhibition-graphics',
    name: 'Exhibition Graphics',
    categories: ['event-advertising'],
    shortDescription: 'The full printed graphics package for an exhibition stand.',
    description:
      'The printed elements that dress an exhibition stand — wall graphics, fascia branding, counter wraps, floor graphics and hanging signage. Produced as a coordinated set to a stand’s dimensions so everything aligns on site, which is where mismatched graphics usually reveal themselves.',
  },
  {
    slug: 'exhibition-panels',
    name: 'Exhibition Panels',
    categories: ['event-advertising'],
    shortDescription: 'Rigid printed panels forming the walls of an exhibition stand.',
    description:
      'Rigid printed panels forming the structural surfaces of a stand — walls, dividers, product boards and information panels. Produced on substrates chosen for how many times the stand will be assembled, since panels that travel to several shows a year need to survive transport as much as display.',
  },
  {
    slug: 'stall-branding',
    name: 'Stall Branding',
    categories: ['event-advertising'],
    shortDescription: 'Complete branding of a stall or booth at an exhibition or fair.',
    description:
      'End-to-end branding of a stall or booth — fascia, walls, counter, flooring graphics, hanging signage and supporting collateral. Supplied and installed as one package so the stall reads as a single designed environment rather than separate pieces brought together on site.',
  },
]

/**
 * Existing products renamed as part of the client's Signage restructure, and
 * the products split out of a combination record.
 *
 * "ACP LED 3D Sign Boards" is split into three per the client's decision. The
 * ORIGINAL keeps its indexed slug (acp-led-sign-boards) and becomes "ACP Sign
 * Board"; the other two are created new. That preserves the ranking URL while
 * still delivering the split.
 */
export const SPLIT_RENAMES = {
  'acp-led-sign-boards': {
    name: 'ACP Sign Board',
    categories: ['outdoor-signage'],
    shortDescription: 'Aluminium composite panel sign boards with a clean, flat, weather-resistant face.',
    description:
      'Sign boards built on aluminium composite panel — two aluminium skins bonded to a polymer core. ACP stays flat over large spans, resists weather without corroding, and takes applied vinyl, printed graphics or mounted lettering. It is the standard substrate for modern shopfront fascias and building signage.',
  },
}
