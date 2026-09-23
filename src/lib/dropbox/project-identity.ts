/** Preserve the old folder identity for durable jobs enqueued before a rename. */
export function renamedDropboxIdentity(ids: Record<string, unknown>, safeName: string) {
  const aliases = Array.isArray(ids.dropbox_safe_name_aliases) ? ids.dropbox_safe_name_aliases : []
  return {
    ...ids,
    dropbox_safe_name: safeName,
    dropbox_safe_name_aliases: [...new Set([...aliases, ids.dropbox_safe_name])]
      .filter((value): value is string => typeof value === 'string' && !!value && value !== safeName),
  }
}
