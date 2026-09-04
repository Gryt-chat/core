/* Adding to this list: only nouns, only English, nothing that reads as a real
   person's name. These go in front of strangers and are read aloud in voice,
   and whoever gets one did not choose it. "Marcus" looks like a claim about
   who somebody is; "Bandit" looks like the placeholder it is. */

/**
 * Gems, metals, animals, weather, sky, and a few playful roles.
 *
 * Long enough that a room of thirty rarely doubles up, which is the whole
 * reason for the size — two people called Ruby in a member list is exactly the
 * confusion the old shared placeholder caused.
 */
export const NAME_POOL = [
  // Gems and minerals
  "Ruby", "Emerald", "Diamond", "Sapphire", "Topaz", "Opal", "Amber", "Jade",
  "Onyx", "Pearl", "Quartz", "Garnet", "Amethyst", "Turquoise", "Obsidian",
  "Marble", "Granite", "Flint", "Slate", "Crystal",

  // Metals
  "Gold", "Silver", "Copper", "Bronze", "Iron", "Steel", "Cobalt", "Pewter",
  "Platinum", "Titanium", "Brass", "Nickel",

  // Animals
  "Shark", "Turtle", "Otter", "Falcon", "Heron", "Badger", "Lynx", "Bison",
  "Walrus", "Puffin", "Osprey", "Marten", "Ibex", "Tapir", "Gecko", "Manta",
  "Narwhal", "Pelican", "Raven", "Magpie", "Sparrow", "Kestrel", "Weasel",
  "Beaver", "Moose", "Elk", "Stoat", "Hedgehog", "Mongoose", "Meerkat",
  "Albatross", "Barnacle", "Urchin", "Cuttlefish", "Seal", "Puma", "Ocelot",
  "Caribou", "Wombat", "Numbat", "Quokka", "Capybara",

  // Roles, playful
  "Sheriff", "Bandit", "Captain", "Ranger", "Scout", "Pilot", "Sailor",
  "Miner", "Baker", "Cooper", "Mason", "Tinker", "Herald", "Envoy", "Courier",
  "Gardener", "Lookout", "Skipper", "Wrangler", "Drifter",

  // Weather and sky
  "Comet", "Nebula", "Quasar", "Aurora", "Meteor", "Eclipse", "Zenith",
  "Thunder", "Cyclone", "Monsoon", "Blizzard", "Drizzle", "Gale", "Frost",
  "Ember", "Cinder", "Vapour", "Mistral", "Zephyr", "Squall",

  // Landscape
  "Canyon", "Fjord", "Glacier", "Delta", "Mesa", "Tundra", "Prairie", "Dune",
  "Reef", "Atoll", "Summit", "Ridge", "Hollow", "Meadow", "Thicket", "Bramble",
  "Harbour", "Lagoon", "Cove", "Cascade",

  // Plants
  "Cedar", "Juniper", "Willow", "Birch", "Aspen", "Alder", "Hazel", "Bracken",
  "Clover", "Fennel", "Sorrel", "Nettle", "Thistle", "Heather", "Saffron",
  "Cardamom", "Chicory", "Marigold",
] as const;

/**
 * One name from the pool.
 *
 * `Math.random` on purpose. This picks something to be called, not a secret —
 * the identity is a keypair, and the name has never been part of it. Reaching
 * for the crypto RNG here would suggest otherwise.
 */
export function pickRandomName(): string {
  return NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
}
