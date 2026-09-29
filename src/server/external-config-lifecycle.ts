/** Run fallible external-state reconciliation before journaling, then apply runtime state afterward. */
export function reconcileObservedExternal(
  reconcileBeforeJournal: () => void,
  recordObserved: (afterJournal: () => void) => void,
  applyAfterJournal: () => void,
): void {
  reconcileBeforeJournal();
  recordObserved(applyAfterJournal);
}
