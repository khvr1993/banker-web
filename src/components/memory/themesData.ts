import type {
  Difficulty,
  DifficultyId,
  MemoryTheme,
  PlayerId,
  PlayerProfile,
  StickerAward,
  ThemeId,
} from './types';

export const THEMES: MemoryTheme[] = [
  {
    id: 'animals',
    name: 'Cute Animals & Pets',
    shortName: 'Animals',
    tagline: 'Roar, squeak and splash with animal friends!',
    icon: '🦁',
    backIcon: '🐾',
    symbols: [
      { id: 'lion', name: 'Lion', speech: 'Lion! King of the jungle!', emoji: '🦁', accent: '#F59E0B', hint: 'King of the jungle' },
      { id: 'elephant', name: 'Elephant', speech: 'Elephant! With a big, kind heart!', emoji: '🐘', accent: '#94A3B8', hint: 'Big and gentle' },
      { id: 'peacock', name: 'Peacock', speech: 'Peacock! With beautiful feathers!', emoji: '🦚', accent: '#0EA5E9', hint: 'Dancing feathers' },
      { id: 'monkey', name: 'Monkey', speech: 'Monkey! Swinging from tree to tree!', emoji: '🐵', accent: '#B45309', hint: 'Loves bananas' },
      { id: 'panda', name: 'Panda', speech: 'Panda! Munching bamboo!', emoji: '🐼', accent: '#475569', hint: 'Bamboo snack' },
      { id: 'dolphin', name: 'Dolphin', speech: 'Dolphin! Splish, splash!', emoji: '🐬', accent: '#06B6D4', hint: 'Ocean friend' },
      { id: 'puppy', name: 'Puppy', speech: 'Puppy! Woof woof!', emoji: '🐶', accent: '#F97316', hint: 'Woof woof' },
      { id: 'tiger', name: 'Bengal Tiger', speech: 'Bengal tiger! India\'s striped superstar!', emoji: '🐯', accent: '#EA580C', hint: 'Striped and brave' },
    ],
  },
  {
    id: 'fruits',
    name: 'Juicy Fruits',
    shortName: 'Fruits',
    tagline: 'Yummy fruits full of colours and smiles!',
    icon: '🍓',
    backIcon: '🍃',
    symbols: [
      { id: 'mango', name: 'Mango', speech: 'Mango! The king of fruits!', emoji: '🥭', accent: '#F59E0B', hint: 'King of fruits' },
      { id: 'strawberry', name: 'Strawberry', speech: 'Strawberry! Sweet and juicy!', emoji: '🍓', accent: '#EF4444', hint: 'Sweet and juicy' },
      { id: 'apple', name: 'Apple', speech: 'Apple! Crunchy and healthy!', emoji: '🍎', accent: '#DC2626', hint: 'Crunchy treat' },
      { id: 'banana', name: 'Banana', speech: 'Banana! Peel and smile!', emoji: '🍌', accent: '#EAB308', hint: 'Peel and smile' },
      { id: 'watermelon', name: 'Watermelon', speech: 'Watermelon! Full of water and fun!', emoji: '🍉', accent: '#22C55E', hint: 'Juicy and cool' },
      { id: 'grapes', name: 'Grapes', speech: 'Grapes! Tiny bunches of joy!', emoji: '🍇', accent: '#8B5CF6', hint: 'Little bunches' },
      { id: 'orange', name: 'Orange', speech: 'Orange! A sunny citrus fruit!', emoji: '🍊', accent: '#F97316', hint: 'Sunny citrus' },
      { id: 'pineapple', name: 'Pineapple', speech: 'Pineapple! With a spiky crown!', emoji: '🍍', accent: '#D97706', hint: 'Spiky crown' },
    ],
  },
  {
    id: 'india',
    name: 'Incredible India',
    shortName: 'India',
    tagline: 'Visit states, monuments and culture across India!',
    icon: '🇮🇳',
    backIcon: '🪔',
    symbols: [
      { id: 'maharashtra', name: 'Maharashtra', speech: 'Maharashtra! Gateway of India!', emoji: '🏰', accent: '#F97316', hint: 'Gateway of India' },
      { id: 'punjab', name: 'Punjab', speech: 'Punjab! Golden Temple and Bhangra drums!', emoji: '🛕', accent: '#EAB308', hint: 'Golden Temple' },
      { id: 'kerala', name: 'Kerala', speech: 'Kerala! Houseboats on green backwaters!', emoji: '🛶', accent: '#10B981', hint: 'Backwaters' },
      { id: 'tamil-nadu', name: 'Tamil Nadu', speech: 'Tamil Nadu! Temple towers and Bharatanatyam!', emoji: '💃', accent: '#EC4899', hint: 'Bharatanatyam' },
      { id: 'rajasthan', name: 'Rajasthan', speech: 'Rajasthan! Camels and the Pink City!', emoji: '🐪', accent: '#F43F5E', hint: 'Pink City' },
      { id: 'west-bengal', name: 'West Bengal', speech: 'West Bengal! The grand Howrah Bridge!', emoji: '🌉', accent: '#6366F1', hint: 'Howrah Bridge' },
      { id: 'gujarat', name: 'Gujarat', speech: 'Gujarat! Dandiya and Garba dancing!', emoji: '🥁', accent: '#F59E0B', hint: 'Garba night' },
      { id: 'goa', name: 'Goa', speech: 'Goa! Sunny beaches and seashells!', emoji: '🏖️', accent: '#06B6D4', hint: 'Sunny beaches' },
      { id: 'kashmir', name: 'Kashmir', speech: 'Kashmir! Snowy peaks and shikara boats!', emoji: '🏔️', accent: '#3B82F6', hint: 'Snowy peaks' },
      { id: 'delhi-up', name: 'Delhi & UP', speech: 'Delhi and Uttar Pradesh! India Gate and Taj Mahal!', emoji: '🏛️', accent: '#8B5CF6', hint: 'India Gate & Taj' },
    ],
  },
  {
    id: 'shapes',
    name: 'Shapes & Rainbow Colours',
    shortName: 'Shapes',
    tagline: 'Find shapes and learn rainbow colours!',
    icon: '🌈',
    backIcon: '✨',
    symbols: [
      { id: 'red-heart', name: 'Heart', speech: 'Red heart! Full of love!', emoji: '❤️', accent: '#EF4444', hint: 'Red' },
      { id: 'yellow-star', name: 'Star', speech: 'Yellow star! Twinkle twinkle!', emoji: '⭐', accent: '#F59E0B', hint: 'Yellow' },
      { id: 'blue-circle', name: 'Circle', speech: 'Blue circle! Round and round!', emoji: '🔵', accent: '#3B82F6', hint: 'Blue' },
      { id: 'green-square', name: 'Square', speech: 'Green square! Four equal sides!', emoji: '🟩', accent: '#22C55E', hint: 'Green' },
      { id: 'orange-triangle', name: 'Triangle', speech: 'Orange triangle! Three pointy corners!', emoji: '🔺', accent: '#F97316', hint: 'Orange' },
      { id: 'purple-diamond', name: 'Diamond', speech: 'Purple diamond! Sparkly and bright!', emoji: '💎', accent: '#A855F7', hint: 'Purple' },
      { id: 'pink-moon', name: 'Moon', speech: 'Pink moon! Goodnight moon!', emoji: '🌙', accent: '#EC4899', hint: 'Pink' },
      { id: 'rainbow', name: 'Rainbow', speech: 'Rainbow! Seven beautiful colours!', emoji: '🌈', accent: '#06B6D4', hint: 'Seven colours' },
    ],
  },
  {
    id: 'vehicles',
    name: 'Things That Go',
    shortName: 'Vehicles',
    tagline: 'Vroom, zoom and blast off with vehicles!',
    icon: '🚀',
    backIcon: '💨',
    symbols: [
      { id: 'rocket', name: 'Rocket', speech: 'Rocket! Three, two, one, blast off!', emoji: '🚀', accent: '#6366F1', hint: 'Blast off!' },
      { id: 'fire-truck', name: 'Fire Truck', speech: 'Fire truck! Wee-oo, wee-oo!', emoji: '🚒', accent: '#EF4444', hint: 'Wee-oo wee-oo' },
      { id: 'train', name: 'Train', speech: 'Train! Choo choo, all aboard!', emoji: '🚂', accent: '#F59E0B', hint: 'Choo choo!' },
      { id: 'airplane', name: 'Airplane', speech: 'Airplane! Flying high in the sky!', emoji: '✈️', accent: '#0EA5E9', hint: 'Up in the sky' },
      { id: 'police-car', name: 'Police Car', speech: 'Police car! Here to help!', emoji: '🚓', accent: '#3B82F6', hint: 'Here to help' },
      { id: 'school-bus', name: 'School Bus', speech: 'School bus! Beep beep, off to school!', emoji: '🚌', accent: '#EAB308', hint: 'Beep beep!' },
      { id: 'tractor', name: 'Tractor', speech: 'Tractor! Working on the farm!', emoji: '🚜', accent: '#22C55E', hint: 'Farm helper' },
      { id: 'sailboat', name: 'Sailboat', speech: 'Sailboat! Sailing on the waves!', emoji: '⛵', accent: '#06B6D4', hint: 'Hello, waves!' },
    ],
  },
];

export const DIFFICULTIES: Difficulty[] = [
  { id: 'toddler', name: 'Toddler', gridLabel: '2 × 2', pairs: 2, columns: 2, icon: '👶', medalEmoji: '🌱', medalName: 'Little Sprout' },
  { id: 'easy', name: 'Easy', gridLabel: '2 × 3', pairs: 3, columns: 3, icon: '⭐', medalEmoji: '⭐', medalName: 'Bright Star' },
  { id: 'explorer', name: 'Explorer', gridLabel: '3 × 4', pairs: 6, columns: 4, icon: '🌟', medalEmoji: '🌟', medalName: 'Super Explorer' },
  { id: 'champion', name: 'Champion', gridLabel: '4 × 4', pairs: 8, columns: 4, icon: '🏆', medalEmoji: '🏆', medalName: 'Memory Champion' },
];

export const PLAYERS: Record<PlayerId, PlayerProfile> = {
  teddy: { name: 'Teddy', emoji: '🐻', color: '#F59E0B' },
  bunny: { name: 'Bunny', emoji: '🐰', color: '#EC4899' },
};

export function getTheme(themeId: ThemeId): MemoryTheme {
  return THEMES.find((theme) => theme.id === themeId) || THEMES[0];
}

export function getDifficulty(difficultyId: DifficultyId): Difficulty {
  return DIFFICULTIES.find((difficulty) => difficulty.id === difficultyId) || DIFFICULTIES[0];
}

export function getStickerAward(themeId: ThemeId, difficultyId: DifficultyId): StickerAward {
  const theme = getTheme(themeId);
  const difficulty = getDifficulty(difficultyId);
  return {
    id: `${theme.id}:${difficulty.id}`,
    themeId: theme.id,
    difficultyId: difficulty.id,
    name: `${difficulty.medalName} • ${theme.shortName}`,
    emoji: difficulty.medalEmoji,
  };
}

export const TOTAL_STICKERS = THEMES.length * DIFFICULTIES.length;
