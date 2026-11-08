/** Keys holding one nested formula node. Everything that rewrites or scans a stored expression must follow them, as well as `args`. */
export const formulaChildKeys: readonly string[] = ['value', 'condition', 'then', 'else', 'left', 'right', 'arg'];
