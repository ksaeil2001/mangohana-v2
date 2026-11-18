'use strict';
// A whole Korean eojeol, including attached punctuation, is an atomic utterance.
// No region ids, word lists, normalization, size relaxation or pixel authority.
function requiresSingleUtteranceLine(text){return typeof text==='string'&&text.length>0&&/\p{Script=Hangul}/u.test(text)&&!/\s/u.test(text);}
function singleUtteranceLineVerified(source,lines){return !requiresSingleUtteranceLine(source)||Array.isArray(lines)&&lines.length===1&&lines[0]===source;}
module.exports={requiresSingleUtteranceLine,singleUtteranceLineVerified};
