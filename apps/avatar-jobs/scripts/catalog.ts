/**
 * The character catalog (owner decision 2026-10-05): 20 free companions per category, all drawn
 * in the roster's chibi style and animated like Chalito (five drawings each). The original six
 * roster characters are spread into their categories. Prompts feed generate-roster.ts.
 */
export const CATEGORIES = [
  "animals",
  "people",
  "food",
  "sports",
  "professions",
  "emotions",
  "objects",
  "mexican",
  "fantasy",
  "space",
  "seasons",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CatalogCharacter {
  id: string;
  category: Category;
  name: { es: string; en: string };
  blurb: { es: string; en: string };
  /** Design description sent to the image model (style is appended by the generator). */
  prompt: string;
}

const c = (
  category: Category,
  id: string,
  es: string,
  en: string,
  blurbEs: string,
  blurbEn: string,
  prompt: string,
): CatalogCharacter => ({ id, category, name: { es, en }, blurb: { es: blurbEs, en: blurbEn }, prompt });

export const CATALOG: readonly CatalogCharacter[] = [
  // Animals: the five original animal companions plus fifteen new ones.
  c("animals", "bruno", "Bruno", "Bruno", "Un osito tranquilo y paciente.", "A calm, patient bear.",
    "Bruno, a chubby honey-brown teddy bear with a cream muzzle and belly patch, small round ears, a little red scarf"),
  c("animals", "luna", "Luna", "Luna", "Una gatita curiosa.", "A curious kitten.",
    "Luna, a fluffy grey kitten with big green eyes, white paws and chest, a pink nose, a thin crescent-moon collar charm"),
  c("animals", "tito", "Tito", "Tito", "Un búho atento a todo.", "An owl who notices everything.",
    "Tito, a round little owl with soft brown and cream feathers, huge amber eyes, tiny tufted ears, small wings"),
  c("animals", "canela", "Canela", "Canela", "Una zorrita lista y rápida.", "A quick, clever fox.",
    "Canela, a small orange fox with a white-tipped bushy tail, white chest, dark paws, big curious eyes"),
  c("animals", "nube", "Nube", "Nube", "Una conejita suave y alegre.", "A soft, cheerful bunny.",
    "Nube, a fluffy white bunny with long floppy ears with pink insides, a pink nose, a round cotton tail, sky-blue eyes"),
  c("animals", "firulais", "Firulais", "Firulais", "Un perrito leal y juguetón.", "A loyal, playful puppy.",
    "Firulais, a small tan and white puppy with floppy ears, a wagging tail, a blue collar with a round gold tag, a happy pink tongue"),
  c("animals", "bambu", "Bambú", "Bambu", "Un panda que nunca tiene prisa.", "A panda who's never in a hurry.",
    "Bambu, a round black-and-white baby panda holding a small green bamboo sprig, soft fuzzy fur, sleepy kind eyes"),
  c("animals", "pinguino", "Pingo", "Pingo", "Un pingüino elegante y torpe.", "A dapper, clumsy penguin.",
    "Pingo, a little emperor-style penguin chick with a sleek black back, white belly, orange beak and feet, a tiny red bow tie"),
  c("animals", "koala", "Koko", "Koko", "Una koala que da los mejores abrazos.", "A koala who gives the best hugs.",
    "Koko, a fluffy grey koala with big round white-tufted ears, a large dark oval nose, a cream belly, a small eucalyptus leaf"),
  c("animals", "axo", "Axo", "Axo", "Un ajolote que siempre sonríe.", "An axolotl who's always smiling.",
    "Axo, a pink Mexican axolotl standing upright, feathery pink-magenta gill fronds on both sides of the head, a wide gentle smile, tiny hands, a short tail"),
  c("animals", "tortu", "Tortu", "Tortu", "Una tortuga sabia y sin estrés.", "A wise, stress-free turtle.",
    "Tortu, a small green tortoise standing upright with a domed olive shell with hexagon pattern, round glasses, a calm wise smile"),
  c("animals", "trompi", "Trompi", "Trompi", "Una elefantita que nunca olvida.", "A little elephant who never forgets.",
    "Trompi, a baby elephant with soft lavender-grey skin, big floppy ears with pink insides, a curled-up trunk, a small yellow flower behind one ear"),
  c("animals", "jirafa", "Jacinta", "Jacinta", "Una jirafa que ve todo desde arriba.", "A giraffe who sees it all from above.",
    "Jacinta, a young giraffe with a short chibi neck, golden-yellow fur with orange-brown patches, small horn ossicones, long eyelashes"),
  c("animals", "leo", "Leo", "Leo", "Un leoncito valiente.", "A brave little lion.",
    "Leo, a lion cub with golden fur, a fluffy round orange mane, a tufted tail, a confident friendly grin"),
  c("animals", "chango", "Chango", "Chango", "Un monito travieso.", "A mischievous little monkey.",
    "Chango, a small brown monkey with a peach face and belly, big round ears, a long curly tail, holding a banana"),
  c("animals", "rana", "Rita", "Rita", "Una ranita brincona.", "A bouncy little frog.",
    "Rita, a bright green frog standing upright, big round eyes on top of the head, a pale yellow belly, a tiny lily-pad hat"),
  c("animals", "pulpo", "Pulpi", "Pulpi", "Un pulpo que hace ocho cosas a la vez.", "An octopus who multitasks with eight arms.",
    "Pulpi, a round coral-orange octopus with eight curly tentacles, light spots on the head, big friendly eyes"),
  c("animals", "cochi", "Cochi", "Cochi", "Una cerdita alegre y glotona.", "A cheerful, foodie piglet.",
    "Cochi, a round pink piglet standing upright, a curly tail, a big snout, small floppy ears, a little blue overall strap"),
  c("animals", "pato", "Paco", "Paco", "Un patito con mucha personalidad.", "A duckling with big personality.",
    "Paco, a fluffy yellow duckling with an orange bill and feet, a tiny sailor cap"),
  c("animals", "perezoso", "Lento", "Lento", "Un perezoso que te recuerda descansar.", "A sloth who reminds you to rest.",
    "Lento, a sloth with shaggy light-brown fur, a cream face with dark eye patches, a sleepy peaceful smile, long curved claws, hugging a small pillow"),
];
