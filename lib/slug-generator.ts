import { randomBytes } from 'node:crypto';

// Comic-themed words for generating beautiful slugs
const COMIC_WORDS = {
  heroes: ['super', 'hero', 'captain', 'iron', 'spider', 'bat', 'wonder', 'flash', 'green', 'black', 'deadpool', 'wolverine', 'hulk', 'thor', 'captain'],
  villains: ['dark', 'shadow', 'evil', 'master', 'doctor', 'joker', 'lex', 'magneto', 'thanos', 'loki', 'venom', 'bane', 'riddler'],
  actions: ['strike', 'force', 'power', 'legend', 'saga', 'quest', 'battle', 'warrior', 'guardian', 'defender', 'avenger', 'justice'],
  settings: ['city', 'world', 'universe', 'realm', 'dimension', 'galaxy', 'earth', 'mars', 'moon', 'space', 'future', 'past'],
  styles: ['noir', 'manga', 'comic', 'graphic', 'epic', 'legend', 'myth', 'tale', 'story', 'chronicle', 'adventure']
};

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export function generateComicSlug(): string {
  // Generate 2-3 random words from different categories
  const categories = Object.keys(COMIC_WORDS) as (keyof typeof COMIC_WORDS)[];
  const selectedCategories = categories.sort(() => 0.5 - Math.random()).slice(0, 2 + Math.floor(Math.random() * 2));

  const words: string[] = [];
  selectedCategories.forEach(category => {
    const categoryWords = COMIC_WORDS[category];
    const randomWord = categoryWords[Math.floor(Math.random() * categoryWords.length)];
    words.push(randomWord);
  });

  // Add a random number word sometimes
  if (Math.random() > 0.7) {
    const randomNumber = NUMBERS[Math.floor(Math.random() * NUMBERS.length)];
    words.push(randomNumber);
  }

  // The suffix carries 128 bits of cryptographic randomness so the story URL is hard to guess.
  const randomString = randomBytes(16).toString('hex');

  // Combine words with hyphens and add the opaque suffix.
  const slugWords = words.join('-');
  return `${slugWords}-${randomString}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
