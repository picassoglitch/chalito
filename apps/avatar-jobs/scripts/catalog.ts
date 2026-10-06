/**
 * Image prompts for the character catalog. Ids, categories, names and blurbs live in
 * @chalito/roster (packages/roster/src/catalog.ts, the single source of truth); this file only adds
 * the design description sent to the image model (generate-roster.ts appends the style).
 */
import {
  CATALOG as ROSTER_CATALOG,
  CATEGORIES as ROSTER_CATEGORIES,
  type CatalogEntry,
  type CatalogId,
} from "@chalito/roster";

export const CATEGORIES = ROSTER_CATEGORIES.map((c) => c.id);
export type { Category } from "@chalito/roster";

export interface CatalogCharacter extends CatalogEntry {
  /** Design description sent to the image model (style is appended by the generator). */
  prompt: string;
}

/** One prompt per catalog id (the type makes a missing or unknown id a compile error). */
export const PROMPTS: Record<CatalogId, string> = {
  // Animals.
  bruno:
    "Bruno, a chubby honey-brown teddy bear with a cream muzzle and belly patch, small round ears, a little red scarf",
  luna: "Luna, a fluffy grey kitten with big green eyes, white paws and chest, a pink nose, a thin crescent-moon collar charm",
  tito: "Tito, a round little owl with soft brown and cream feathers, huge amber eyes, tiny tufted ears, small wings",
  canela: "Canela, a small orange fox with a white-tipped bushy tail, white chest, dark paws, big curious eyes",
  nube: "Nube, a fluffy white bunny with long floppy ears with pink insides, a pink nose, a round cotton tail, sky-blue eyes",
  firulais:
    "Firulais, a small tan and white puppy with floppy ears, a wagging tail, a blue collar with a round gold tag, a happy pink tongue",
  bambu:
    "Bambu, a round black-and-white baby panda holding a small green bamboo sprig, soft fuzzy fur, sleepy kind eyes",
  pinguino:
    "Pingo, a little emperor-style penguin chick with a sleek black back, white belly, orange beak and feet, a tiny red bow tie",
  koala:
    "Koko, a fluffy grey koala with big round white-tufted ears, a large dark oval nose, a cream belly, a small eucalyptus leaf",
  axo: "Axo, a pink Mexican axolotl standing upright, feathery pink-magenta gill fronds on both sides of the head, a wide gentle smile, tiny hands, a short tail",
  tortu:
    "Tortu, a small green tortoise standing upright with a domed olive shell with hexagon pattern, round glasses, a calm wise smile",
  trompi:
    "Trompi, a baby elephant with soft lavender-grey skin, big floppy ears with pink insides, a curled-up trunk, a small yellow flower behind one ear",
  jirafa:
    "Jacinta, a young giraffe with a short chibi neck, golden-yellow fur with orange-brown patches, small horn ossicones, long eyelashes",
  leo: "Leo, a lion cub with golden fur, a fluffy round orange mane, a tufted tail, a confident friendly grin",
  chango:
    "Chango, a small brown monkey with a peach face and belly, big round ears, a long curly tail, holding a banana",
  rana: "Rita, a bright green frog standing upright, big round eyes on top of the head, a pale yellow belly, a tiny lily-pad hat",
  pulpo: "Pulpi, a round coral-orange octopus with eight curly tentacles, light spots on the head, big friendly eyes",
  cochi:
    "Cochi, a round pink piglet standing upright, a curly tail, a big snout, small floppy ears, a little blue overall strap",
  pato: "Paco, a fluffy yellow duckling with an orange bill and feet, a tiny sailor cap",
  perezoso:
    "Lento, a sloth with shaggy light-brown fur, a cream face with dark eye patches, a sleepy peaceful smile, long curved claws, hugging a small pillow",
  // People.
  chalito:
    "Chalito, a small human-ish companion: a cheerful round-faced kid-like figure in an oversized teal hoodie with the hood down, short messy dark hair, big warm brown eyes, rosy cheeks, a tiny glowing yellow star clip in the hair",
  abuela:
    "Doña Chela, a sweet chubby grandmother with a grey hair bun, round glasses, a lilac cardigan over a floral dress, holding a mug of hot chocolate",
  abuelo:
    "Don Beto, a kind grandfather with a white mustache, a flat cap, a brown vest over a white shirt, suspenders, a wooden cane",
  bebe: "Bebe Lalo, a chubby toddler in a light-blue onesie with a pacifier clipped on, a single curl of hair on top, big curious eyes",
  sofi: "Sofi, a lively young girl with two curly pigtails tied with yellow ribbons, a red t-shirt with a star, denim shorts, sneakers",
  skater:
    "Max, a teen skater with a backwards orange cap, a loose grey t-shirt, baggy cargo shorts, holding a skateboard",
  gamer:
    "Pixel, a young woman gamer with short purple hair, big headphones around the neck, a black hoodie with a pixel heart, holding a game controller",
  artista:
    "Painter Frida, an artist with a black beret, a paint-splattered apron, a paintbrush tucked behind the ear, holding a colorful palette",
  rockero:
    "Rocko, a rocker with spiky black hair, a black leather jacket with pins, ripped jeans, an electric guitar slung on the back",
  bailarina:
    "Bela, a ballerina with a neat hair bun, a pink tutu and leotard, ballet slippers, standing on tiptoe with arms in a soft curve",
  hipster:
    "Brayan, a young man with a big neat brown beard, a beanie, a plaid flannel shirt, round glasses, holding a takeaway coffee cup",
  mama: "Mama Lupita, a warm young mother with a long dark braid, a mustard sweater, jeans, a tote bag, a loving smile",
  papa: "Papa Tono, a cheerful dad with short dark hair, a light stubble, a polo shirt, khaki shorts, sandals, a grill spatula",
  estudiante:
    "Valeria, a university student with a high ponytail, a green sweater, a backpack, holding a stack of books",
  deportista:
    "Diego, a sporty young man in a tracksuit with white stripes, a sweatband on the forehead, running shoes, a water bottle",
  nerd: "Memo, a nerdy boy with big square glasses, a neat side part, a sweater vest over a collared shirt, holding a laptop",
  influencer:
    "Kimmy, a trendy young woman with long wavy pink-blonde hair, sunglasses on top of the head, a crop jacket, holding a phone for a selfie",
  viajero:
    "Tomas, a backpacker with a big hiking backpack, a bucket hat, a camera around the neck, a map in hand, hiking boots",
  dj: "DJ Neon, a DJ with a sleek black bob with a neon-blue streak, big glowing headphones, a sparkly jacket, one hand raised",
  rapero: "MC Chuy, a rapper with a gold chain, an oversized red hoodie, a flat-brim cap, holding a microphone",
  // Food.
  taquito:
    "Taquito, a cute folded corn tortilla taco character filled with al pastor meat, pineapple, cilantro and onion, with a face, tiny arms and legs",
  concha:
    "Conchita, a round Mexican concha sweet bun character with a pink sugar shell pattern on top, a face, tiny arms and legs",
  aguacate:
    "Avocadito, a halved avocado character with a big round brown pit as the belly, green skin, a face, tiny arms and legs",
  elote:
    "Elotito, a corn-on-the-cob character on a stick covered in mayo, cheese and red chili powder, a face, tiny arms",
  pizza:
    "Peperoni, a pizza slice character with melty cheese, pepperoni circles, a golden crust on top, a face, tiny arms and legs",
  sushi:
    "Maki, a sushi roll character with a seaweed wrap, white rice and a salmon-orange center, a face, tiny arms and legs",
  dona: "Dony, a round donut character with pink frosting and rainbow sprinkles, a face, tiny arms and legs",
  helado:
    "Scoop, an ice cream cone character with a strawberry scoop on top, a cherry, a waffle cone body, a face, tiny arms",
  hamburguesa:
    "Burgy, a burger character with a sesame bun, lettuce, cheese and a patty, a face on the patty, tiny arms and legs",
  papas: "Fry Guy, a red carton of golden french fries with a face on the carton, tiny arms and legs",
  fresa: "Berry, a red strawberry character with seeds, a green leafy crown, a face, tiny arms and legs",
  platano: "Banano, a yellow banana character half peeled at the top like a hairdo, a face, tiny arms and legs",
  tamal:
    "Tamalito, a tamale character wrapped in a corn husk open at the top showing yellow masa, a face, tiny arms and legs",
  churro: "Churro, a long golden ridged churro character dusted with cinnamon sugar, a face, tiny arms and legs",
  cafe: "Coffee Cup, a steaming mug of coffee with a latte-art heart, a face on the mug, tiny arms and legs",
  galleta: "Cookie, a round chocolate chip cookie character, golden brown, a face, tiny arms and legs",
  pan: "Bolillo, a crusty Mexican bolillo bread roll character with a slit on top, a face, tiny arms and legs",
  sandia:
    "Melony, a watermelon slice character with red flesh, black seeds and a green rind, a face, tiny arms and legs",
  brocoli:
    "Brocco, a broccoli floret character with a bushy green top like hair, a light green stalk body, a face, tiny arms and legs",
  pastel:
    "Cupcake, a cupcake character with swirly vanilla frosting, a cherry and sprinkles, a striped paper cup body, a face, tiny arms",
  // Sports.
  futbolista:
    "Golazo, a soccer player kid in a green jersey with number 10, white shorts, cleats, a soccer ball under one foot",
  basquet:
    "Dunk, a basketball player girl in an orange jersey, a headband, high-top sneakers, spinning a basketball on one finger",
  beisbol: "Homer, a baseball player in a pinstriped uniform and cap, a baseball glove, a wooden bat over the shoulder",
  tenista: "Ace, a tennis player girl in a white tennis outfit, a visor, holding a tennis racket and a yellow ball",
  nadador: "Splash, a swimmer with a blue swim cap, goggles on the forehead, a swimsuit, a towel over the shoulder",
  boxeador: "Champ, a boxer in red boxing gloves, red shorts with a gold belt, a confident friendly pose",
  luchador:
    "Mystic, a chibi Mexican lucha libre wrestler with a silver and blue mask, a cape, wrestling boots, a flexing pose",
  ciclista: "Pedal, a cyclist in a yellow cycling jersey, a helmet, cycling shorts, standing beside a small bicycle",
  corredora:
    "Bolt, a runner girl with a ponytail, a race bib number on a tank top, running shorts, running shoes, ready-to-run pose",
  gimnasta: "Gymmy, a gymnast girl in a sparkly purple leotard, a ribbon wand swirling around her",
  surfista: "Wave, a surfer with sun-bleached hair, board shorts with hibiscus print, holding a surfboard",
  patinadora: "Skates, a figure skater girl in a light-blue sparkly dress, white ice skates, a graceful twirl pose",
  karateca: "Kata, a karate kid in a white gi with a black belt, a headband, a karate stance",
  golfista: "Birdie, a golfer in a argyle sweater vest, a flat cap, holding a golf club, a golf ball at the feet",
  portero:
    "Keeper, a soccer goalkeeper in a bright yellow long-sleeve jersey, big padded gloves, holding a soccer ball",
  voleibol: "Spike, a volleyball player girl in a jersey and knee pads, holding a white and blue volleyball",
  escalador:
    "Summit, a rock climber with a helmet, a harness with carabiners, a coiled rope over the shoulder, chalky hands",
  ajedrez: "Check, a chess player girl with round glasses, a neat sweater, holding a big white knight chess piece",
  yoga: "Zen, a yoga practitioner in leggings and a tank top, a hair bun, standing in tree pose on a rolled-out mat",
  futbolamericano:
    "Touchdown, an American football player with a helmet, big shoulder pads, a jersey, holding a football",
  // Professions.
  doctora: "Dr. Health, a doctor with a white coat, a stethoscope around the neck, a clipboard, a kind smile",
  enfermero: "Nurse Ramon, a male nurse in teal scrubs, a lanyard badge, holding a small first-aid kit",
  abogada:
    "Attorney Justa, a lawyer in a navy suit with a neat bun, holding a briefcase and a small scales-of-justice emblem pin",
  bombero: "Firefighter Blaze, a firefighter in a red helmet and yellow-striped fire suit, holding a fire hose",
  policia: "Officer Paz, a friendly police officer in a blue uniform and cap with a star badge, a whistle",
  chef: "Chef Pepe, a chef with a tall white toque, a white double-breasted jacket, a curly mustache, holding a wooden spoon",
  maestra: "Teacher Rosy, a teacher with glasses, a cardigan, holding a book and a pointer, an apple on the book",
  astronauta:
    "Astro, an astronaut in a white space suit with a round helmet visor up, mission patches, a small flag patch",
  cientifica: "Dr. Atom, a scientist in a lab coat with safety goggles on her head, holding a bubbling green flask",
  programador:
    "Dev, a programmer in a hoodie with a laptop under the arm, a coffee mug, a lanyard, slightly messy hair",
  constructor:
    "Builder Tony, a construction worker in a yellow hard hat, an orange safety vest, a tool belt, holding a wrench",
  piloto:
    "Captain Sky, an airline pilot in a navy uniform with gold stripes, a pilot cap with wings badge, aviator sunglasses",
  veterinaria: "Vet Mimi, a veterinarian in light-green scrubs, a stethoscope, holding a small puppy",
  cartero: "Mailman Lucho, a mail carrier with a blue cap, a satchel full of letters, holding an envelope",
  granjero: "Farmer Pancho, a farmer with a straw hat, denim overalls, a plaid shirt, holding a basket of vegetables",
  dentista: "Dr. Smile, a dentist in a white coat and mask pulled down, holding a giant toothbrush, a sparkling smile",
  mecanico: "Mechanic Nacho, a mechanic in grease-stained blue coveralls, a cap, a wrench, a smudge on the cheek",
  detective: "Detective Lens, a detective in a tan trench coat and deerstalker hat, holding a magnifying glass",
  fotografa: "Photo Fer, a photographer with a big camera, a camera strap, a vest with pockets, a beanie",
  contador: "Accountant Ruben, an accountant in a shirt and tie with a calculator, a pencil behind the ear, glasses",
  // Emotions: each blob embodies one feeling (the emotion drawings still vary them).
  alegria: "Joy, a round sunny-yellow blob creature with sparkles around it, tiny arms and feet, a radiant personality",
  calma:
    "Calm, a soft pale-blue cloud-like blob creature with a gentle face, tiny arms and feet, floating little bubbles",
  amor: "Love, a heart-shaped pink creature with tiny arms and feet, little floating hearts around it",
  valentia:
    "Courage, a round orange blob creature wearing a tiny red superhero cape, a little lightning mark on its chest",
  curiosidad:
    "Curiosity, a teal blob creature with one antenna ending in a question-mark curl, big inquisitive eyes, tiny arms and feet",
  esperanza: "Hope, a small glowing soft-green blob creature holding a tiny sprouting plant, a gentle warm glow",
  gratitud: "Gratitude, a warm peach-colored blob creature with hands together, a small golden halo of light",
  orgullo: "Pride, a purple blob creature with a small gold medal around its neck, chest puffed out",
  nervios: "Jitters, a small lime-green blob creature with wobbly outline lines, a tiny sweat drop, fidgeting hands",
  enojo: "Grumpy, a round red blob creature with tiny steam puffs on its head, crossed arms, small stubby feet",
  tristeza: "Blue, a teardrop-shaped soft blue creature with tiny arms and feet, a little raincloud hat",
  sorpresa:
    "Wow, a star-shaped bright yellow-orange creature with tiny arms and feet, little exclamation sparkles around it",
  sueno:
    "Sleepy, a lavender blob creature in a striped nightcap, holding a tiny pillow, little floating Z letters shapes",
  risa: "Giggles, a bubbly bright-pink blob creature with rosy cheeks, holding its belly, tiny musical notes around",
  paz: "Peace, a white dove-like round creature with tiny wings, holding a small olive branch, a serene look",
  emocion: "Hype, a bright electric-blue blob creature with little confetti bursting around it, tiny arms raised",
  timidez: "Shy, a small pastel-pink blob creature partly hiding behind its own tiny hands, blushing cheeks",
  confianza: "Confidence, a teal blob creature wearing tiny cool sunglasses, a thumbs up, a little crown",
  nostalgia: "Nostalgia, a sepia-toned soft brown blob creature holding a tiny old photo, a gentle wistful look",
  ternura: "Tenderness, a fluffy cream-colored round creature with tiny bunny-like ears, holding a small heart",
  // Objects.
  lampara:
    "Lampy, a little desk lamp character with a glowing yellow bulb, a face on the lampshade, tiny arms and legs",
  taza: "Mugsy, a white ceramic mug character with a blue stripe, a face, tiny arms and legs, a little steam swirl",
  libro: "Booky, a red hardcover book character, slightly open, a face on the cover, tiny arms and legs",
  lapiz: "Pencil, a yellow pencil character with a pink eraser top, a sharpened tip as the feet, a face, tiny arms",
  reloj: "Tick Tock, a round red alarm clock character with two bells on top, a face on the dial, tiny arms and legs",
  celular: "Phoney, a smartphone character with a face on the screen, a colorful case, tiny arms and legs",
  audifonos: "Beats, a pair of over-ear headphones character, with a face on the headband, music notes around",
  trompo:
    "Spinny, a colorful wooden Mexican trompo spinning top character with painted stripes, a string, a face, tiny arms",
  mochila: "Packy, a green school backpack character with pockets, a face on the front, the straps as arms, tiny feet",
  paraguas:
    "Brolly, an open yellow umbrella character with a curved handle as the leg, a face under the canopy, tiny arms",
  camara:
    "Clicky, a retro instant camera character with a big lens as a nose, a face, tiny arms and legs, a little photo coming out",
  planta:
    "Sprout, a terracotta flowerpot character with a small green succulent growing on top, a face on the pot, tiny arms and legs",
  vela: "Candle, a short white candle character with a warm flickering flame on top, a face, tiny arms",
  globo: "Balloony, a round red party balloon character with a curly string, a face, tiny arms",
  consola:
    "Joystick, a game controller character with colorful buttons, a face between the joysticks, tiny arms and legs",
  tostadora:
    "Toasty, a shiny silver toaster character with two slices of toast popping out like hair, a face, tiny arms and legs",
  calcetin: "Sock, a striped colorful sock character with a face, tiny arms, standing on its heel",
  cubo: "Cuby, a colorful puzzle cube character with a face on the front, tiny arms and legs",
  lata: "Canny, a red soda can character with little fizz bubbles, a face, tiny arms and legs",
  dado: "Dicey, a white rounded dice character with black dots, a face on the front side, tiny arms and legs",
  // Mexican culture.
  mariachi: "Mariachi Chente, a mariachi in a black charro suit with silver buttons, a big sombrero, holding a guitar",
  catrina:
    "Catrina, a friendly cute Catrina with a sugar-skull painted face, a big flowered hat, a long elegant purple dress, marigold flowers",
  alebrije:
    "Alebrije, a fantastical Oaxacan alebrije creature, part jaguar part dragon, covered in bright painted patterns and colorful wings",
  charro: "Charro Lalo, a charro horseman in a decorated suede suit, a wide embroidered sombrero, a lasso",
  adelita:
    "Adelita, a brave revolutionary-era woman with long braids, a rebozo shawl, a long skirt, a determined smile",
  jarocha: "Jarocha, a dancer in a white lace Veracruz dress, a red flower in the hair, a lace fan",
  calaverita:
    "Sugar Skull, a cute sugar-skull character with colorful icing decorations, flower eyes, tiny arms and legs",
  pinata:
    "Pinata, a classic seven-pointed star piñata character with colorful tissue paper and streamers, a face in the center",
  xolo: "Xolo, a hairless grey Xoloitzcuintle dog with big upright ears, a little tuft on the head, a colorful collar",
  lotero:
    "The Rooster, a proud cute rooster character inspired by the lotería card, red comb, colorful tail feathers, standing tall",
  frutero: "Fruit Man, a street fruit vendor with an apron and a cart umbrella hat, holding a cup of fruit with chili",
  danzante:
    "Aztec Dancer, a concheros dancer with a colorful feathered headdress, ankle seed rattles, a decorated tunic",
  quetzal: "Quetzal, a resplendent quetzal bird with emerald-green feathers, a red belly, a long flowing tail",
  nopal: "Nopalito, a cute nopal cactus character made of rounded paddles with pink tuna fruits, a face, tiny arms",
  chapulin: "Grasshopper, a green chibi grasshopper with big eyes, long hopping legs, tiny antennae",
  tlaloc:
    "Rainy, a cute rain spirit inspired by pre-Hispanic art, round goggle eyes, a turquoise rain cloud crown, tiny rain drops",
  trajinera:
    "Xochi, a girl with a flower crown holding a little painted wooden trajinera boat with painted flower decorations",
  matraca: "Matraca, a colorful wooden matraca noisemaker character with painted flowers, a face, tiny arms and legs",
  cempasuchil:
    "Marigold, a cempasuchil marigold flower character with ruffled orange petals as hair, a green stem body, tiny leaf arms",
  "pan-muerto":
    "Pan de Muerto, a round sugar-dusted pan de muerto bread character with bone-shaped decorations on top, a face, tiny arms and legs",
  // Fantasy & myth.
  dragon: "Drako, a baby dragon with green scales, small bat wings, a cream belly, tiny horns, a puff of smoke",
  unicornio: "Uni, a white unicorn standing upright with a pastel rainbow mane, a golden spiral horn, sparkles",
  mago: "Wizard Merl, a little wizard with a long white beard, a starry blue pointed hat and robe, a glowing wand",
  bruja: "Witchy, a friendly little witch with a purple pointed hat, a black dress, striped stockings, a broomstick",
  hada: "Fairy Lila, a tiny fairy with translucent butterfly wings, a lilac petal dress, a sparkling wand",
  sirena: "Marina, a mermaid with long teal hair, a seashell top, a shimmering turquoise tail, sitting upright",
  robot: "Robo, a round friendly robot with a screen face, an antenna, metal arms, a small heart light on the chest",
  alien: "Zorg, a little green alien with big black glossy eyes, two antennae, a silver jumpsuit",
  fantasma: "Boo, a cute white sheet ghost with a wavy bottom, rosy cheeks, a tiny floating glow",
  vampiro:
    "Count Dracu, a cute little vampire with slicked-back hair, a high-collar black and red cape, tiny fangs, holding a tomato",
  caballero: "Sir Brave, a little knight in shiny armor with a red plume on the helmet, a shield, a wooden sword",
  princesa:
    "Princess Aurora, a princess with a small golden tiara, a flowing gown, a sword at her side, confident pose",
  fenix: "Phoenix, a baby phoenix bird with flame-like red, orange and gold feathers, glowing ember sparkles",
  yeti: "Yeti, a fluffy white yeti with blue-grey face and hands, small horns, a cozy scarf",
  duende: "Gnome, a garden gnome with a tall red pointed hat, a big white beard, a blue tunic, holding a mushroom",
  pegaso: "Pegasus, a small white winged horse standing upright, feathered wings, a light-blue mane",
  kraken: "Kraky, a purple baby kraken with curly tentacles, a tiny pirate hat, big shiny eyes",
  ninja:
    "Ninja Shadow, a chibi ninja in a dark navy outfit with a mask showing only the eyes, a headband, a toy throwing star",
  pirata:
    "Captain Beard, a little pirate with a tricorn hat, an eye patch, a striped shirt, a treasure map, a parrot on the shoulder",
  genio:
    "Genie, a blue genie with a swirling smoke tail instead of legs, a topknot, gold bracelets, holding a small golden lamp",
  // Vehicles & space.
  cohete: "Rocky Rocket, a red and white rocket character with round windows as eyes, fins as feet, a small flame",
  planeta: "Saturny, a small orange planet character with a tilted ring, a face, tiny arms and feet",
  estrella: "Twinkle, a glowing yellow five-pointed star character with a face, tiny arms and legs",
  lunita: "Moony, a crescent moon character in a sleeping cap, a face, tiny arms",
  sol: "Sunny, a round smiling sun with rays, wearing tiny sunglasses, tiny arms and legs",
  cometa: "Comet, a glowing icy-blue comet character with a long sparkly tail, a face, tiny arms",
  ovni: "UFO, a silver flying saucer with a glass dome, colorful lights around the rim, a face on the dome",
  satelite: "Sat, a small satellite character with blue solar panel wings, an antenna, a face on its body",
  "astronauta-perro": "Laika, a little dog astronaut in a white space suit with a round clear bubble helmet",
  carro: "Zoom, a red race car character with headlights as eyes, a grille smile, big wheels, a number on the side",
  camion: "Trucky, a yellow dump truck character with headlights as eyes, a smiling bumper, chunky wheels",
  tren: "Choo, a steam locomotive character with a smokestack puffing a cloud, a face on the front, red and blue colors",
  avion: "Jetty, a small white and blue airplane character with a face on the nose, wings as arms",
  barco: "Boaty, a little red and white tugboat character with a smokestack, porthole eyes, a life ring",
  helicoptero: "Heli, a small orange rescue helicopter character with spinning rotor, a windshield face",
  submarino: "Subby, a yellow submarine character with round porthole eyes, a periscope, little bubbles",
  moto: "Vroom, a sleek blue motorcycle character with a headlight eye, handlebars as arms",
  bici: "Bikey, a mint-green vintage bicycle character with a basket of flowers, a face on the front basket",
  "agujero-negro":
    "Black Hole, a cute round dark purple swirling black hole character with a glowing purple accretion ring, a face",
  tierra:
    "Earthy, a small planet Earth character with blue oceans, green continents, a little cloud, a face, tiny arms and legs",
  // Seasons & holidays.
  santa: "Santa, a chibi Santa Claus with a big white beard, a red suit with white fur trim, a gift sack",
  reno: "Reindeer, a baby reindeer with brown fur, antlers, a shiny red nose, a jingle bell collar",
  "muneco-nieve": "Snowy, a snowman with a carrot nose, coal buttons, a red scarf, a top hat, stick arms",
  elfo: "Elf, a Christmas elf in a green outfit with a pointed hat with a bell, pointy ears, curled shoes",
  calabaza:
    "Pumpkin, a cute jack-o-lantern pumpkin character with a friendly carved face, a green stem, tiny arms and legs",
  momia: "Mummy, a cute chibi mummy wrapped in loose bandages with one big eye peeking out, tiny arms",
  "conejo-pascua": "Easter Bunny, a pastel bunny holding a basket of painted eggs, a bow tie",
  cupido: "Cupid, a chubby baby cupid with small white wings, a heart-tipped bow and arrow",
  pavo: "Turkey, a round turkey with a fan of colorful tail feathers, a pilgrim hat",
  trebol: "Clover, a little leprechaun-style character in green with a top hat and a four-leaf clover",
  primavera: "Spring, a flower-fairy girl with a crown of blossoms, a dress made of petals, a butterfly on her hand",
  verano: "Summer, a beachgoer with sunglasses, a floral shirt, swim trunks, an inflatable ring, a beach ball",
  otono: "Autumn, a kid in a cozy orange sweater and scarf, holding a pumpkin spice drink, falling maple leaves around",
  invierno: "Winter, a kid bundled up in a puffy blue coat, earmuffs, mittens, a snowflake on the mitten",
  "ano-nuevo":
    "New Year, a party character in a sparkly gold outfit and party hat, holding a sparkler, confetti around",
  rosca: "Rosca, a round rosca de reyes sweet bread character with colorful candied fruit, a face, tiny arms and legs",
  "rey-mago":
    "Wise King, one of the three wise kings in a jeweled crown and a purple velvet robe, holding a small gift box",
  posada: "Posada, a kid holding a small lit candle and a paper lantern, a cozy poncho, Christmas posada spirit",
  pino: "Pine, a small Christmas tree character with ornaments, a star on top, a face, tiny arms and legs",
  regalo: "Gifty, a wrapped gift box character with a big red bow on top, a face, tiny arms and legs",
};

export const CATALOG: readonly CatalogCharacter[] = ROSTER_CATALOG.map((c) => ({ ...c, prompt: PROMPTS[c.id] }));
