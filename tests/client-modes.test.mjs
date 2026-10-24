import test from 'node:test';
import assert from 'node:assert/strict';
import {ModeProbe,captureTerminalModes} from '../client-modes.mjs';
import modes from '../terminal-modes.js';
import {PassThrough} from 'node:stream';
const {TerminalModeTracker}=modes;
test('private reply split at every byte preserves typing and both Kitty stacks',()=>{
 const p=new ModeProbe('a'.repeat(32));const t=new TerminalModeTracker();
 t.consume(Buffer.from('\x1b[>1u\x1b[?1049h\x1b[>11u'));
 const reply=p.privatePrefix+Buffer.from(JSON.stringify(t.snapshot())).toString('base64')+'\x07';
 const out=[];for(const c of Buffer.from('before'+reply+'after'))out.push(p.consume(Buffer.from([c])));
 assert.equal(Buffer.concat(out).toString(),'beforeafter');assert.equal(p.complete,true);assert.deepEqual(p.state,t.snapshot());
 assert.equal(p.consume('\x1b').toString(),'\x1b','Escape is immediate after successful negotiation');
});
test('standard replies are consumed once; later application queries pass unchanged',()=>{
 const p=new ModeProbe();p.standardQuery();
 const replies='\x1b[?1049;2$y\x1b[?1002;1$y\x1b[?7;0$y\x1b[?11u';
 assert.equal(p.consume(replies).length,0);assert.equal(p.state.mouse,'DRAG');assert.equal(p.state.alternate,false);
 assert.equal(p.state.kitty.normal.flags,11);assert.equal(p.state.dec.wraparound,null);
 assert.equal(p.consume(replies).toString(),replies);
});
test('no reply does not mean defaults, nor intercept application replies forever',()=>{
 const p=new ModeProbe();p.standardQuery();p.replyDeadline=1;
 const reply='\x1b[?1049;1$y\x1b[?11u';assert.equal(p.consume(reply).toString(),reply);
 assert.equal(p.state.alternate,null);assert.equal(p.state.kitty.normal.flags,null);
});
test('foreign nonce, keys, mouse and a large paste are transparent',()=>{
 const p=new ModeProbe();const data=Buffer.from('\x1b]777;jsgotty-modes;other;ignored\x07\x1b[<64;3;4M'+ '漢字'.repeat(200000));
 assert.deepEqual(p.consume(data),data);
});
test('capture falls back after silence and restores stdin raw state',async()=>{
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=v=>{input.isRaw=v;};
 const output=new PassThrough();output.isTTY=true;const sent=[];output.on('data',b=>sent.push(b.toString()));
 const result=await captureTerminalModes(input,output,{timeout:30});
 assert.equal(input.isRaw,false);assert.equal(result.state.mouse,null);assert.equal(sent.length,2);
 assert.match(sent[0],/jsgotty-modes/);assert.match(sent[1],/\?1049\$p/);
});
