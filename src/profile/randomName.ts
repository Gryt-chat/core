/* Adding to this list: only nouns, only English, nothing that reads as a real person's name.
   Whoever gets one did not choose it, and "Marcus" looks like a claim. */

/* Gems, metals, animals, weather, plants, food and playful roles. 152 gave two Golds on one server;
   at this size a room of ten rarely doubles up, and the name tags tell any two apart. */
export const NAME_POOL = [
  // Gems and minerals
  "Ruby", "Emerald", "Diamond", "Sapphire", "Topaz", "Opal", "Amber", "Jade", "Onyx", "Pearl",
  "Quartz", "Garnet", "Amethyst", "Turquoise", "Obsidian", "Marble", "Granite", "Flint", "Slate",
  "Crystal", "Agate", "Malachite", "Basalt", "Pumice", "Mica", "Feldspar", "Gypsum", "Cinnabar",
  "Pyrite", "Zircon", "Peridot", "Spinel", "Tourmaline", "Lapis", "Chalk", "Shale", "Galena",
  "Graphite", "Ochre", "Sandstone", "Limestone", "Pebble", "Cobble",

  // Metals
  "Gold", "Silver", "Copper", "Bronze", "Iron", "Steel", "Cobalt", "Pewter", "Platinum",
  "Titanium", "Brass", "Nickel", "Zinc", "Tin", "Chrome", "Tungsten", "Bismuth", "Gallium",
  "Osmium", "Iridium", "Palladium", "Rhodium", "Lithium", "Neon", "Argon", "Xenon", "Helium",
  "Carbon",

  // Animals
  "Shark", "Turtle", "Otter", "Falcon", "Heron", "Badger", "Lynx", "Bison", "Walrus", "Puffin",
  "Osprey", "Marten", "Ibex", "Tapir", "Gecko", "Manta", "Narwhal", "Pelican", "Raven", "Magpie",
  "Sparrow", "Kestrel", "Weasel", "Beaver", "Moose", "Elk", "Stoat", "Hedgehog", "Mongoose",
  "Meerkat", "Albatross", "Barnacle", "Urchin", "Cuttlefish", "Seal", "Puma", "Ocelot", "Caribou",
  "Wombat", "Numbat", "Quokka", "Capybara", "Panda", "Koala", "Lemur", "Gibbon", "Jaguar",
  "Cheetah", "Leopard", "Panther", "Coyote", "Jackal", "Dingo", "Ferret", "Mink", "Ermine",
  "Sable", "Marmot", "Chipmunk", "Squirrel", "Hamster", "Gopher", "Raccoon", "Possum",
  "Armadillo", "Sloth", "Anteater", "Pangolin", "Aardvark", "Okapi", "Giraffe", "Zebra", "Rhino",
  "Hippo", "Camel", "Llama", "Alpaca", "Yak", "Gazelle", "Impala", "Antelope", "Kudu", "Oryx",
  "Hyena", "Mole", "Shrew", "Vole", "Dormouse", "Hare", "Rabbit", "Fox", "Wolf", "Bear", "Lion",
  "Tiger", "Bobcat", "Cougar", "Wolverine", "Mammoth", "Orca", "Dolphin", "Porpoise", "Manatee",
  "Dugong", "Beluga", "Octopus", "Squid", "Nautilus", "Lobster", "Crab", "Shrimp", "Krill",
  "Starfish", "Jellyfish", "Seahorse", "Marlin", "Tuna", "Salmon", "Trout", "Pike", "Perch",
  "Carp", "Herring", "Mackerel", "Sardine", "Anchovy", "Halibut", "Flounder", "Stingray", "Eel",
  "Barracuda", "Grouper",

  // Roles, playful
  "Sheriff", "Bandit", "Captain", "Ranger", "Scout", "Pilot", "Sailor", "Miner", "Baker",
  "Cooper", "Mason", "Tinker", "Herald", "Envoy", "Courier", "Gardener", "Lookout", "Skipper",
  "Wrangler", "Drifter", "Navigator", "Cartographer", "Keeper", "Shepherd", "Juggler", "Wizard",
  "Druid", "Bard", "Jester", "Knight", "Squire", "Tailor", "Weaver", "Brewer", "Glazier",
  "Cobbler", "Farrier", "Forager", "Nomad", "Pioneer", "Voyager", "Wanderer", "Rambler", "Hermit",
  "Pilgrim", "Sentinel", "Warden", "Steward", "Builder", "Painter", "Sculptor", "Poet", "Drummer",
  "Fiddler", "Busker", "Chef", "Barista", "Detective", "Inventor", "Alchemist", "Astronomer",
  "Botanist", "Beekeeper", "Falconer", "Trapper", "Climber", "Diver", "Surfer", "Skater",
  "Runner", "Rider", "Racer", "Champion", "Rookie", "Maverick", "Rascal", "Rogue", "Scamp",
  "Outlaw", "Pirate", "Corsair", "Buccaneer", "Admiral", "Commodore", "Bosun", "Deckhand",

  // Weather and sky
  "Comet", "Nebula", "Quasar", "Aurora", "Meteor", "Eclipse", "Zenith", "Thunder", "Cyclone",
  "Monsoon", "Blizzard", "Drizzle", "Gale", "Frost", "Ember", "Cinder", "Vapour", "Mistral",
  "Zephyr", "Squall", "Rainbow", "Sunbeam", "Moonbeam", "Starlight", "Twilight", "Dusk",
  "Daybreak", "Sunrise", "Sunset", "Solstice", "Equinox", "Galaxy", "Pulsar", "Orbit", "Cosmos",
  "Asteroid", "Satellite", "Rocket", "Crescent", "Horizon", "Mirage", "Halo", "Rain", "Hail",
  "Sleet", "Mist", "Fog", "Haze", "Breeze", "Gust", "Tempest", "Typhoon", "Hurricane", "Tornado",
  "Whirlwind", "Downpour", "Snowflake", "Snowdrift", "Icicle", "Hailstone", "Lightning",
  "Sirocco", "Rainfall", "Updraft", "Jetstream",

  // Landscape
  "Canyon", "Fjord", "Glacier", "Delta", "Mesa", "Tundra", "Prairie", "Dune", "Reef", "Atoll",
  "Summit", "Ridge", "Hollow", "Meadow", "Thicket", "Bramble", "Harbour", "Lagoon", "Cove",
  "Cascade", "Valley", "Gorge", "Ravine", "Gully", "Plateau", "Butte", "Crag", "Bluff", "Knoll",
  "Marsh", "Bog", "Fen", "Swamp", "Bayou", "Estuary", "Inlet", "Bay", "Strait", "Peninsula",
  "Island", "Islet", "Archipelago", "Volcano", "Crater", "Geyser", "Creek", "Stream", "Rapids",
  "Waterfall", "Oasis", "Steppe", "Taiga", "Jungle", "Grove", "Orchard", "Glade", "Clearing",
  "Woodland", "Badlands", "Caldera", "Shoal", "Sandbar", "Shore", "Beach", "Headland", "Cape",
  "Peak", "Pinnacle", "Spire", "Boulder", "Cavern", "Grotto", "Burrow", "Quarry",

  // Plants
  "Cedar", "Juniper", "Willow", "Birch", "Aspen", "Alder", "Hazel", "Bracken", "Clover", "Fennel",
  "Sorrel", "Nettle", "Thistle", "Heather", "Saffron", "Cardamom", "Chicory", "Marigold", "Maple",
  "Oak", "Pine", "Spruce", "Fir", "Larch", "Yew", "Elm", "Beech", "Hawthorn", "Sycamore",
  "Poplar", "Cypress", "Redwood", "Sequoia", "Baobab", "Acacia", "Bamboo", "Fern", "Moss",
  "Lichen", "Thyme", "Mint", "Oregano", "Dill", "Parsley", "Lavender", "Tarragon", "Cumin",
  "Nutmeg", "Clove", "Pepper", "Paprika", "Vanilla", "Cinnamon", "Anise", "Tulip", "Lotus",
  "Orchid", "Peony", "Lilac", "Foxglove", "Bluebell", "Snowdrop", "Primrose", "Cowslip", "Gorse",
  "Sedge", "Reed", "Kelp", "Seaweed", "Cactus", "Agave", "Aloe", "Yucca", "Acorn", "Pinecone",
  "Chestnut", "Walnut", "Almond", "Pistachio", "Cashew", "Peanut", "Coconut", "Mango", "Papaya",
  "Lemon", "Lime", "Plum", "Apricot", "Peach", "Pear", "Quince", "Fig", "Melon", "Turnip",
  "Radish", "Parsnip", "Pumpkin", "Squash", "Gourd", "Mushroom", "Toadstool",

  // Birds
  "Finch", "Lark", "Swift", "Swallow", "Starling", "Thrush", "Owl", "Eagle", "Hawk", "Kite",
  "Condor", "Vulture", "Crane", "Stork", "Egret", "Ibis", "Flamingo", "Toucan", "Parrot", "Macaw",
  "Cockatoo", "Kakapo", "Emu", "Ostrich", "Penguin", "Gannet", "Cormorant", "Tern", "Gull",
  "Plover", "Sandpiper", "Curlew", "Snipe", "Woodcock", "Grouse", "Quail", "Pheasant", "Peacock",
  "Partridge", "Dove", "Pigeon", "Rook", "Jackdaw", "Crow", "Nightjar", "Hoopoe", "Kingfisher",
  "Bunting", "Warbler", "Oriole", "Tanager", "Hummingbird", "Woodpecker", "Nuthatch", "Dipper",
  "Goldcrest",

  // Reptiles, amphibians and insects
  "Iguana", "Python", "Cobra", "Viper", "Adder", "Chameleon", "Tortoise", "Terrapin", "Newt",
  "Toad", "Frog", "Axolotl", "Salamander", "Caiman", "Beetle", "Cricket", "Firefly", "Hornet",
  "Bumblebee", "Ladybird", "Mantis", "Moth", "Butterfly", "Dragonfly", "Mayfly", "Cicada",
  "Termite", "Weevil", "Scarab", "Spider", "Scorpion",

  // Food
  "Biscuit", "Pretzel", "Waffle", "Pancake", "Muffin", "Crumpet", "Bagel", "Noodle", "Dumpling",
  "Pickle", "Pudding", "Toffee", "Fudge", "Nougat", "Marzipan", "Truffle", "Sherbet", "Sorbet",
  "Custard", "Teacake", "Scone", "Brioche", "Strudel",

  // Things
  "Lantern", "Compass", "Anchor", "Kettle", "Teapot", "Sextant", "Telescope", "Beacon",
  "Lighthouse", "Windmill", "Pinwheel", "Paddle", "Rudder", "Tiller", "Mast", "Satchel", "Kayak",
  "Canoe", "Sled", "Toboggan", "Hammock", "Button", "Thimble", "Bobbin", "Spindle", "Quill",
  "Inkwell", "Sundial", "Hourglass",
] as const;

/**
 * One name from the pool. `Math.random` on purpose: this picks something to be called, not a
 * secret, and the crypto RNG here would suggest otherwise.
 */
export function pickRandomName(): string {
  return NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
}
