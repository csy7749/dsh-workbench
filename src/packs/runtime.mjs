// Host composition only; domain handlers are pure and never perform IO.
import { checks, reviewContract, ruleChecks, reviewedExports } from './game/runtime.mjs'
export { checks, ruleChecks, reviewedExports }
export const reviewContracts = [reviewContract]
export const reviewContractFor = item => reviewContracts.find(contract => contract.kind === item?.contract?.reviewKind)
