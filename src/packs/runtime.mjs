// Host composition only; domain handlers are pure and never perform IO.
import { checks, reviewContract, gameHandoffReviewContract, ruleChecks, reviewedExports } from './game/runtime.mjs'
export { checks, ruleChecks, reviewedExports }
export const reviewContracts = [reviewContract, gameHandoffReviewContract]
export const reviewContractFor = item => reviewContracts.find(contract => contract.kind === item?.contract?.reviewKind)
