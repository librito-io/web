export const MARKETING_CRUFT_FIXTURES = [
  {
    name: "annie_bot",
    raw:
      "WINNER OF THE 2024 BIG BOOK PRIZE\n" +
      "A NEW YORK TIMES BEST BOOK OF THE YEAR\n" +
      "“A dazzling debut.” —The New York Times\n" +
      "Annie Bot is a robot designed to be the perfect girlfriend.\n" +
      "Source: Penguin Random House",
    cleaned: "Annie Bot is a robot designed to be the perfect girlfriend.",
  },
  {
    name: "all_caps_award_only",
    raw: "MOST ANTICIPATED FALL READ\nThe story begins on a Tuesday.",
    cleaned: "The story begins on a Tuesday.",
  },
  {
    name: "trailing_pull_quote",
    raw: "A sweeping epic about family.\n" + "“Breathtaking.” —Vogue",
    cleaned: "A sweeping epic about family.",
  },
  {
    name: "no_cruft",
    raw: "A clean blurb that says nothing about awards or quotes.",
    cleaned: "A clean blurb that says nothing about awards or quotes.",
  },
  {
    name: "openlibrary_passes_clean",
    raw: "Open Library descriptions ship without marketing chrome.",
    cleaned: "Open Library descriptions ship without marketing chrome.",
  },
  {
    name: "midline_quote_is_kept",
    raw: 'Smith said "hello" — and waved at the reader walking past.',
    cleaned: 'Smith said "hello" — and waved at the reader walking past.',
  },
  {
    name: "favourite_uk_spelling",
    raw: "OUR FAVOURITE BOOK OF 2025\nA quiet character study.",
    cleaned: "A quiet character study.",
  },
];
