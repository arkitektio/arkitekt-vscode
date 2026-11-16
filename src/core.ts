// The BSX language core, from @arkitektio/bsx: the same completion, hovers and checks the
// Orkestrator's BlokEditor has, and the same vocabulary and catalogs.
export {analyzeBsx, completeBsx, hoverBsx, signatureBsx, sourceCatalog} from '@arkitektio/bsx';
export type {BlokCheckScope, BsxCompletionKind, BsxEnvironment} from '@arkitektio/bsx';
export {blokViewFor, isCatalogTarget, knownCatalog, parseSpecCatalog, registerBlokCatalog} from '@arkitektio/bsx/spec/catalogs';
