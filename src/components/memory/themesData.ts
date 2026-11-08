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
      { id: 'lion', name: 'Lion', emoji: '🦁', accent: '#F59E0B', hint: 'King of the jungle' },
      { id: 'elephant', name: 'Elephant', emoji: '🐘', accent: '#94A3B8', hint: 'Big and gentle' },
      { id: 'peacock', name: 'Peacock', emoji: '🦚', accent: '#0EA5E9', hint: 'Dancing feathers' },
      { id: 'monkey', name: 'Monkey', emoji: '🐵', accent: '#B45309', hint: 'Loves bananas' },
      { id: 'panda', name: 'Panda', emoji: '🐼', accent: '#475569', hint: 'Bamboo snack' },
      { id: 'dolphin', name: 'Dolphin', emoji: '🐬', accent: '#06B6D4', hint: 'Ocean friend' },
      { id: 'puppy', name: 'Puppy', emoji: '🐶', accent: '#F97316', hint: 'Woof woof' },
      { id: 'tiger', name: 'Bengal Tiger', emoji: '🐯', accent: '#EA580C', hint: 'Striped and brave' },
      { id: 'rabbit', name: 'Rabbit', emoji: '🐰', accent: '#F472B6', hint: 'Hoppy friend' },
      { id: 'koala', name: 'Koala', emoji: '🐨', accent: '#64748B', hint: 'Cuddly climber' },
      { id: 'owl', name: 'Owl', emoji: '🦉', accent: '#A16207', hint: 'Hoots at night' },
      { id: 'unicorn', name: 'Unicorn', emoji: '🦄', accent: '#C084FC', hint: 'Magic sparkle' },
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
      { id: 'mango', name: 'Mango', emoji: '🥭', accent: '#F59E0B', hint: 'King of fruits' },
      { id: 'strawberry', name: 'Strawberry', emoji: '🍓', accent: '#EF4444', hint: 'Sweet and juicy' },
      { id: 'apple', name: 'Apple', emoji: '🍎', accent: '#DC2626', hint: 'Crunchy treat' },
      { id: 'banana', name: 'Banana', emoji: '🍌', accent: '#EAB308', hint: 'Peel and smile' },
      { id: 'watermelon', name: 'Watermelon', emoji: '🍉', accent: '#22C55E', hint: 'Juicy and cool' },
      { id: 'grapes', name: 'Grapes', emoji: '🍇', accent: '#8B5CF6', hint: 'Little bunches' },
      { id: 'orange', name: 'Orange', emoji: '🍊', accent: '#F97316', hint: 'Sunny citrus' },
      { id: 'pineapple', name: 'Pineapple', emoji: '🍍', accent: '#D97706', hint: 'Spiky crown' },
      { id: 'kiwi', name: 'Kiwi', emoji: '🥝', accent: '#84CC16', hint: 'Tangy and green' },
      { id: 'peach', name: 'Peach', emoji: '🍑', accent: '#FB7185', hint: 'Soft and sweet' },
      { id: 'cherry', name: 'Cherry', emoji: '🍒', accent: '#DC2626', hint: 'Tiny red twins' },
      { id: 'lemon', name: 'Lemon', emoji: '🍋', accent: '#FACC15', hint: 'Sour and sunny' },
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
      { id: 'maharashtra', name: 'Maharashtra', emoji: '🏰', accent: '#F97316', hint: 'Gateway of India' },
      { id: 'punjab', name: 'Punjab', emoji: '🛕', accent: '#EAB308', hint: 'Golden Temple' },
      { id: 'kerala', name: 'Kerala', emoji: '🛶', accent: '#10B981', hint: 'Backwaters' },
      { id: 'tamil-nadu', name: 'Tamil Nadu', emoji: '💃', accent: '#EC4899', hint: 'Bharatanatyam' },
      { id: 'rajasthan', name: 'Rajasthan', emoji: '🐪', accent: '#F43F5E', hint: 'Pink City' },
      { id: 'west-bengal', name: 'West Bengal', emoji: '🌉', accent: '#6366F1', hint: 'Howrah Bridge' },
      { id: 'gujarat', name: 'Gujarat', emoji: '🥁', accent: '#F59E0B', hint: 'Garba night' },
      { id: 'goa', name: 'Goa', emoji: '🏖️', accent: '#06B6D4', hint: 'Sunny beaches' },
      { id: 'kashmir', name: 'Kashmir', emoji: '🏔️', accent: '#3B82F6', hint: 'Snowy peaks' },
      { id: 'delhi-up', name: 'Delhi & UP', emoji: '🏛️', accent: '#8B5CF6', hint: 'India Gate & Taj' },
      { id: 'assam', name: 'Assam', emoji: '🦏', accent: '#22C55E', hint: 'One-horned rhino' },
      { id: 'odisha', name: 'Odisha', emoji: '☀️', accent: '#F59E0B', hint: 'Konark Sun Temple' },
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
      { id: 'red-heart', name: 'Heart', emoji: '❤️', accent: '#EF4444', hint: 'Red' },
      { id: 'yellow-star', name: 'Star', emoji: '⭐', accent: '#F59E0B', hint: 'Yellow' },
      { id: 'blue-circle', name: 'Circle', emoji: '🔵', accent: '#3B82F6', hint: 'Blue' },
      { id: 'green-square', name: 'Square', emoji: '🟩', accent: '#22C55E', hint: 'Green' },
      { id: 'orange-triangle', name: 'Triangle', emoji: '🔺', accent: '#F97316', hint: 'Orange' },
      { id: 'purple-diamond', name: 'Diamond', emoji: '💎', accent: '#A855F7', hint: 'Purple' },
      { id: 'pink-moon', name: 'Moon', emoji: '🌙', accent: '#EC4899', hint: 'Pink' },
      { id: 'rainbow', name: 'Rainbow', emoji: '🌈', accent: '#06B6D4', hint: 'Seven colours' },
      { id: 'yellow-square', name: 'Yellow Square', emoji: '🟨', accent: '#FACC15', hint: 'Yellow' },
      { id: 'red-square', name: 'Red Square', emoji: '🟥', accent: '#EF4444', hint: 'Red' },
      { id: 'green-circle', name: 'Green Circle', emoji: '🟢', accent: '#22C55E', hint: 'Green' },
      { id: 'orange-heart', name: 'Orange Heart', emoji: '🧡', accent: '#F97316', hint: 'Orange' },
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
      { id: 'rocket', name: 'Rocket', emoji: '🚀', accent: '#6366F1', hint: 'Blast off!' },
      { id: 'fire-truck', name: 'Fire Truck', emoji: '🚒', accent: '#EF4444', hint: 'Wee-oo wee-oo' },
      { id: 'train', name: 'Train', emoji: '🚂', accent: '#F59E0B', hint: 'Choo choo!' },
      { id: 'airplane', name: 'Airplane', emoji: '✈️', accent: '#0EA5E9', hint: 'Up in the sky' },
      { id: 'police-car', name: 'Police Car', emoji: '🚓', accent: '#3B82F6', hint: 'Here to help' },
      { id: 'school-bus', name: 'School Bus', emoji: '🚌', accent: '#EAB308', hint: 'Beep beep!' },
      { id: 'tractor', name: 'Tractor', emoji: '🚜', accent: '#22C55E', hint: 'Farm helper' },
      { id: 'sailboat', name: 'Sailboat', emoji: '⛵', accent: '#06B6D4', hint: 'Hello, waves!' },
      { id: 'helicopter', name: 'Helicopter', emoji: '🚁', accent: '#0EA5E9', hint: 'Whirly bird' },
      { id: 'ambulance', name: 'Ambulance', emoji: '🚑', accent: '#EF4444', hint: 'Helping hero' },
      { id: 'taxi', name: 'Taxi', emoji: '🚕', accent: '#F59E0B', hint: 'City ride' },
      { id: 'scooter', name: 'Scooter', emoji: '🛵', accent: '#8B5CF6', hint: 'Zip around' },
    ],
  },
];

export const DIFFICULTIES: Difficulty[] = [
  { id: 'toddler', name: 'Toddler', gridLabel: '2 × 2', pairs: 2, columns: 2, icon: '👶', medalEmoji: '🌱', medalName: 'Little Sprout' },
  { id: 'easy', name: 'Easy', gridLabel: '2 × 3', pairs: 3, columns: 3, icon: '⭐', medalEmoji: '⭐', medalName: 'Bright Star' },
  { id: 'explorer', name: 'Explorer', gridLabel: '3 × 4', pairs: 6, columns: 4, icon: '🌟', medalEmoji: '🌟', medalName: 'Super Explorer' },
  { id: 'champion', name: 'Champion', gridLabel: '4 × 4', pairs: 8, columns: 4, icon: '🏆', medalEmoji: '🏆', medalName: 'Memory Champion' },
  { id: 'legend', name: 'Legend', gridLabel: '5 × 5', pairs: 12, columns: 5, icon: '👑', medalEmoji: '👑', medalName: 'Memory Legend', centerStar: true },
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
