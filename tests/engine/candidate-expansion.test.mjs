import test from 'node:test';
import assert from 'node:assert/strict';
import {isSupportedCandidateExpansion} from '../../packages/ai-engine/vendor/trio/src/shared/candidateExpansion.ts';

test('rejects a remote white pocket instead of moving a source region into it',()=>{
 assert.equal(isSupportedCandidateExpansion({x:.4,y:.2,width:.05,height:.06},{x:.45,y:.28,width:.005,height:.005}),false);
 assert.equal(isSupportedCandidateExpansion({x:.4,y:.2,width:.05,height:.06},{x:.6,y:.2,width:.1,height:.1}),false);
});
test('rejects a tiny interior island even when it is inside the original text bounds',()=>{
 assert.equal(isSupportedCandidateExpansion({x:.4,y:.2,width:.05,height:.06},{x:.42,y:.22,width:.005,height:.005}),false);
});
test('retains a supported larger overlapping bubble interior and equal bounds',()=>{
 const source={x:.4,y:.2,width:.05,height:.06};
 assert.equal(isSupportedCandidateExpansion(source,{x:.38,y:.18,width:.1,height:.1}),true);
 assert.equal(isSupportedCandidateExpansion(source,{...source}),true);
});
