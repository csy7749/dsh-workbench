// 复现老大两个反例的一行探针（只读，不写库）。
import { validateInputSchema } from '../src/workflow/m1-kernel.mjs'

const attempt = (label, fn) => {
  try {
    console.log(JSON.stringify({ probe: label, result: fn() }))
  } catch (error) {
    console.log(JSON.stringify({ probe: label, error: { code: error.code, detail: error.detail ?? error.message } }))
  }
}

attempt('required-as-string', () => validateInputSchema({ type: 'object', required: 'plan' }, {}))
attempt('minimum-2-rounds-1', () => validateInputSchema({ type: 'object', properties: { rounds: { type: 'integer', minimum: 2 } } }, { rounds: 1 }))
attempt('minimum-2-rounds-2', () => validateInputSchema({ type: 'object', properties: { rounds: { type: 'integer', minimum: 2 } } }, { rounds: 2 }))
attempt('self-made-min-2-rounds-1', () => validateInputSchema({ type: 'object', properties: { rounds: { type: 'integer', min: 2 } } }, { rounds: 1 }))
// 第三轮复核的三个反例：约束与类型不相容时，白名单以前放过、值校验却永远不生效。
attempt('minimum-without-type-rounds-not-a-number', () => validateInputSchema({ type: 'object', properties: { rounds: { minimum: 2 } } }, { rounds: 'not-a-number' }))
attempt('string-with-minimum-x', () => validateInputSchema({ type: 'object', properties: { plan: { type: 'string', minimum: 2 } } }, { plan: 'x' }))
attempt('number-with-minlength-0', () => validateInputSchema({ type: 'object', properties: { rounds: { type: 'number', minLength: 3 } } }, { rounds: 0 }))
// 相容的约束仍然生效，别把所有约束一刀切拒掉。
attempt('compatible-minimum-2-rounds-1', () => validateInputSchema({ type: 'object', properties: { rounds: { type: 'number', minimum: 2 } } }, { rounds: 1 }))
attempt('compatible-minimum-2-rounds-2', () => validateInputSchema({ type: 'object', properties: { rounds: { type: 'number', minimum: 2 } } }, { rounds: 2 }))
// 第四轮复核的两个反例：原型链成员冒充声明/输入字段，显式 properties:null 冒充空 schema。
attempt('prototype-required-toString', () => validateInputSchema({ type: 'object', properties: {}, required: ['toString'] }, {}))
attempt('prototype-required-constructor', () => validateInputSchema({ type: 'object', properties: {}, required: ['constructor'] }, {}))
attempt('inherited-value-plan', () => validateInputSchema({ type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] }, Object.create({ plan: 'inherited' })))
attempt('properties-null', () => validateInputSchema({ type: 'object', properties: null }, {}))
attempt('own-key-plan-ok', () => validateInputSchema({ type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] }, { plan: 'ok' }))
