import type { Locale } from "../types";

export const LOCALES: Locale[] = ["uz", "uzc", "ru", "en"];

export const LOCALE_LABELS: Record<Locale, string> = {
  uz: "O'zbekcha",
  uzc: "Ўзбекча",
  ru: "Русский",
  en: "English",
};

export const LOCALE_SHORT: Record<Locale, string> = {
  uz: "UZ",
  uzc: "ЎЗ",
  ru: "RU",
  en: "EN",
};

export const DEFAULT_LOCALE: Locale = "uz";
