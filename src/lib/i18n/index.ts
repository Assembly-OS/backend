import type { Locale } from "../types";
import uz, { type Dictionary, type MessageKey } from "./dictionaries/uz";
import uzc from "./dictionaries/uzc";
import ru from "./dictionaries/ru";
import en from "./dictionaries/en";

const DICTIONARIES: Record<Locale, Dictionary> = { uz, uzc, ru, en };

export type { Dictionary, MessageKey };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? uz;
}

export type Translator = (key: MessageKey) => string;

export function createTranslator(locale: Locale): Translator {
  const dict = getDictionary(locale);
  return (key) => dict[key] ?? key;
}
