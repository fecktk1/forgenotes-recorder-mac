const { test } = require('node:test')
const assert = require('node:assert/strict')
const { visibilityChoices } = require('../renderer/filing-options.js')
test('personal, missing, ambiguous and malformed access cannot add a tenant audience', () => {
 for (const access of [null, {}, {organizations: []}, {organizations: [{id:'a',name:'A'},{id:'b',name:'B'}]}, {organizations:[{id:'forged'}]}])
  assert.deepEqual(visibilityChoices(access), {orgId:null,choices:[['private','Private']]})
})
test('a single server-authorized organization is named without a platform default', () => {
 const scope = visibilityChoices({organizations:[{id:'mine',name:'My studio'}]})
 assert.equal(scope.orgId,'mine')
 assert.equal(scope.choices.find(([value])=>value==='tcf_internal')[1], 'Organization — My studio')
})
