import { get, now, run } from "./pg";
import { mergeSettings, type KpiSettings } from "./kpi-rules";

/**
 * Settings the chairman changes without a deployment: one row per key,
 * holding JSON, with who changed it last and when. Read on every page that
 * needs them — they are a handful of small rows and a cache would be one
 * more thing to invalidate.
 */

export async function readSetting<T>(key: string): Promise<T | null> {
  const row = await get<{ value: T }>("SELECT value FROM settings WHERE key = ?", key);
  return row ? row.value : null;
}

export async function writeSetting(key: string, value: unknown, userId: number): Promise<void> {
  await run(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?::jsonb, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    key,
    JSON.stringify(value),
    userId,
    now(),
  );
}

export const KPI_SETTINGS_KEY = "kpi";

/** The KPI model's settings: what is stored, over the defaults. */
export async function kpiSettings(): Promise<KpiSettings> {
  return mergeSettings(await readSetting(KPI_SETTINGS_KEY));
}

export async function kpiSettingsMeta(): Promise<{ updated_by_name: string | null; updated_at: string | null }> {
  const row = await get<{ updated_by_name: string | null; updated_at: string | null }>(
    `SELECT u.full_name AS updated_by_name, s.updated_at
       FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?`,
    KPI_SETTINGS_KEY,
  );
  return row ?? { updated_by_name: null, updated_at: null };
}
