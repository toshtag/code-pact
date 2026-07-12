// TypeScript 7 does not yet expose the classic compiler API through the stable
// package entry, so AST inspection scripts use the pinned TypeScript 6 alias.
// Remove this adapter once TypeScript 7 provides a stable replacement.
import ts from "typescript-compiler-api";

export default ts;
