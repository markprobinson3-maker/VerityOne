import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export interface AccountUiPreferences {
  show_google_email: boolean;
}

export interface AccountUiPreferenceWriteResult {
  previous: AccountUiPreferences;
  next: AccountUiPreferences;
}

export const DEFAULT_ACCOUNT_UI_PREFERENCES: AccountUiPreferences = {
  show_google_email: true,
};

function normalizePreferences(row: any | null | undefined): AccountUiPreferences {
  if (!row) return { ...DEFAULT_ACCOUNT_UI_PREFERENCES };
  return {
    show_google_email: row.show_google_email !== false,
  };
}

function isMissingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === "42P01";
}

export async function readAccountUiPreferences(
  sql: SqlTag,
  accountId: string,
): Promise<AccountUiPreferences> {
  try {
    const [row] = await sql`
      SELECT show_google_email
      FROM account_ui_preferences
      WHERE account_id = ${accountId}::uuid
    `;
    return normalizePreferences(row);
  } catch (e) {
    if (isMissingTable(e)) return { ...DEFAULT_ACCOUNT_UI_PREFERENCES };
    throw e;
  }
}

export async function writeAccountUiPreferences(
  sql: SqlTag,
  accountId: string,
  preferences: AccountUiPreferences,
): Promise<AccountUiPreferenceWriteResult> {
  if (preferences.show_google_email !== true && preferences.show_google_email !== false) {
    throw new Error("show_google_email must be boolean");
  }
  const previous = await readAccountUiPreferences(sql, accountId);
  const [row] = await sql`
    INSERT INTO account_ui_preferences (account_id, show_google_email)
    VALUES (${accountId}::uuid, ${preferences.show_google_email})
    ON CONFLICT (account_id) DO UPDATE
    SET show_google_email = EXCLUDED.show_google_email,
        updated_at = now()
    RETURNING show_google_email
  `;
  return {
    previous,
    next: normalizePreferences(row),
  };
}
