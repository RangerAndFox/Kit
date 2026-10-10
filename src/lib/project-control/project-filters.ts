/** Operational choices are views, never a deletion/archival policy. */
export function isOperationalProject(projectNumber: string, lifecycle: string): boolean {
  return /^\d{3,4}[a-z]?$/i.test(projectNumber.trim()) && !['9998', '9876'].includes(projectNumber.trim())
    && /^(active|on hold|needs review)$/i.test(lifecycle.trim())
}

/** Native spill ranges update on human edits AND API provisioning. No trigger
 * or periodic list rewrite is required. Sort numeric prefix, then suffix. */
export function projectFilterFormula(history = false): string {
  const lifecycle = history ? '' : ',REGEXMATCH(states,"^(active|on hold|needs review)$")'
  return '=IFNA(LET(ids,ARRAYFORMULA(UPPER(TRIM(Projects!A5:A))),states,ARRAYFORMULA(LOWER(TRIM(Projects!F5:F))),chosen,UNIQUE(FILTER(ids,REGEXMATCH(ids,"^[0-9]{3,4}[A-Z]?$"),ids<>"9998",ids<>"9876"' + lifecycle + ')),SORT(chosen,ARRAYFORMULA(VALUE(REGEXEXTRACT(chosen,"^[0-9]+"))),TRUE,chosen,TRUE)),"")'
}
