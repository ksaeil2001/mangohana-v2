"""Translate each saved OCR page once using the selected local ONNX model."""
import argparse
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import fingerprint, once
from quality import review_flags

REVISION = '9c374f0b7aca709787cea97b047bfbbd1559d177'
PINS = {'onnx/encoder_model_quantized.onnx':'13a94e354a9140764eb81102d77d3ec6952d796e6f113c651eeb3c3443da0386',
        'onnx/decoder_model_merged_quantized.onnx':'007654bcabb6cea6fd3bde34ce933137b431330b3755781145d7b6906270b45a',
        'sentencepiece.bpe.model':'d8f7c76ed2a5e0822be39f0a4f95a55eb19c78f4593ce609e2edbc2aea4d380a',
        'vocab.json':'380e263bf4efc45fa72251fb19336a9593307bc4', 'config.json':'4f466cf3049e59ef8bb5de9b67f4275fa8f7257a',
        'tokenizer.json':'cd68f923c35fc0da05d4bb83125bdcbe6ff9211b'}


def check_model(root):
    for rel, pin in PINS.items():
        file=root/rel
        if len(pin)==40:
            d=hashlib.sha1()
            d.update(('blob '+str(file.stat().st_size)+'\0').encode())
        else:
            d=hashlib.sha256()
        with file.open('rb') as stream:
            for chunk in iter(lambda:stream.read(4*1024*1024), b''):
                d.update(chunk)
        if d.hexdigest()!=pin:
            raise ValueError('model pin mismatch: '+rel)


class Translator:
    model='facebook/m2m100_418M'
    distribution='Xenova/m2m100_418M'
    revision=REVISION
    settings='ja-ko/greedy/127/v1'
    def __init__(self, root):
        import numpy as np
        import onnxruntime as ort
        sys.path.insert(0, str(root/'tokenizer-deps'))
        import sentencepiece
        if sentencepiece.__version__!='0.2.1' or not Path(sentencepiece.__file__).resolve().is_relative_to((root/'tokenizer-deps').resolve()):
            raise ValueError('unexpected tokenizer runtime')
        check_model(root)
        self.np=np
        self.tokenizer=sentencepiece.SentencePieceProcessor(model_file=str(root/'sentencepiece.bpe.model'))
        self.vocab=json.loads((root/'vocab.json').read_text('utf8'))
        self.by_id={v:k for k,v in self.vocab.items()}
        added=json.loads((root/'tokenizer.json').read_text('utf8'))['added_tokens']
        specials={r['content']:r['id'] for r in added}
        self.ko=specials['__ko__']
        self.ja=specials['__ja__']
        self.eos=specials['</s>']
        self.pad=specials['<pad>']
        self.unknown=self.vocab['<unk>']
        ort.disable_telemetry_events()
        opts=ort.SessionOptions()
        opts.intra_op_num_threads=3
        opts.inter_op_num_threads=1
        opts.enable_cpu_mem_arena=False
        opts.enable_mem_pattern=False
        opts.add_session_config_entry('session.intra_op.allow_spinning','0')
        opts.add_session_config_entry('session.inter_op.allow_spinning','0')
        sessions=[ort.InferenceSession(str(root/'onnx'/f),opts,providers=['CPUExecutionProvider'])
                  for f in ('encoder_model_quantized.onnx','decoder_model_merged_quantized.onnx')]
        self.encoder,self.decoder=sessions
        for sess in sessions:
            sess.disable_fallback()
        self.past=[v for v in self.decoder.get_inputs() if v.name.startswith('past_key_values.')]
        self.present=[v.name for v in self.decoder.get_outputs()][1:]

    def translate(self, lines):
        np=self.np
        if not lines:
            return []
        encoded=[[self.ja]+[self.vocab.get(piece,self.unknown) for piece in self.tokenizer.encode(line['source'], out_type=str)]+[self.eos] for line in lines]
        if max(map(len,encoded))>1024:
            raise ValueError('source exceeds model context')
        ids=np.full((len(lines),max(map(len,encoded))),self.pad,dtype=np.int64)
        attention=np.zeros_like(ids)
        for i, seq in enumerate(encoded):
            ids[i,:len(seq)]=seq
            attention[i,:len(seq)]=1
        hidden=self.encoder.run(None,{'input_ids':ids, 'attention_mask':attention})[0]
        batch=len(lines)
        cache={v.name:np.empty((batch,v.shape[1],0,v.shape[3]), dtype=np.float32) for v in self.past}
        tokens=np.tile(np.array([[self.eos,self.ko]],dtype=np.int64),(batch,1))
        generated=[[] for _ in lines]
        finished=np.zeros(batch,dtype=bool)
        for step in range(127):
            data={'input_ids':tokens,'encoder_attention_mask':attention,
                  'encoder_hidden_states':hidden,'use_cache_branch':np.array([step!=0]),**cache}
            output=self.decoder.run(None,data)
            next_ids=np.argmax(output[0][:,-1,:],axis=-1)
            for i, tok in enumerate(next_ids):
                if finished[i]:
                    continue
                if int(tok)==self.eos:
                    finished[i]=True
                else:
                    generated[i].append(int(tok))
            if finished.all():
                break
            for name, tensor in zip(self.present,output[1:]):
                if tensor.size:
                    cache[name.replace('present.','past_key_values.',1)]=tensor
            tokens=np.where(finished,self.eos,next_ids).astype(np.int64)[:,None]
            del output
        results=[]
        for i, line in enumerate(lines):
            pieces=[self.by_id.get(t,'<unk>') for t in generated[i] if t not in (self.pad,self.eos,self.ko)]
            target=self.tokenizer.decode(pieces).strip() if pieces else ''
            results.append({'id':line['id'],'source':line['source'],'ko':target,'inputTokens':len(encoded[i]),
                            'generatedTokens':len(generated[i]),'eos':bool(finished[i]),
                            'flags':review_flags(line['source'],target,finished[i])})
        return results


def translator_type(root):
    if (root/'onnx/model_q4.onnx').is_file():
        from context_translation import PageTranslator
        return PageTranslator
    return Translator


def translate_page(folder,saved,model_type,get_model):
    pid=saved['result']['page']
    lines=[r for r in saved['result']['lines'] if r['source']]
    identity=fingerprint({'page':pid,'ocr':saved['identity'],'revision':model_type.revision,'settings':model_type.settings})
    def generate():
        translator=get_model() if lines else None
        translated=translator.translate(lines) if lines else []
        result=dict(page=pid,model=model_type.model,distribution=model_type.distribution,revision=model_type.revision,
                    provider='ONNXRuntime CPU',sourceLanguage='ja',targetLanguage='ko',
                    batchCount=int(bool(lines)),lines=translated)
        if getattr(translator,'last_generation',None) is not None:
            result['pageGeneration']=translator.last_generation
        return result
    return once(folder/'translation.json',identity,generate)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',type=Path,required=True)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--manifest',type=Path)
    parser.add_argument('--synthetic',action='store_true')
    args=parser.parse_args()
    import platform
    platform.system()
    def offline(event,_):
        if event.startswith('socket.') or event in ('subprocess.Popen','os.system','os.posix_spawn'):
            raise PermissionError('local model only')
    sys.addaudithook(offline)
    model_root=args.model.resolve(strict=True)
    model_type=translator_type(model_root)
    @lru_cache(maxsize=1)
    def get_model():
        return model_type(model_root)
    if args.synthetic:
        probes=[{'id':'greeting','source':'ありがとうございます。'},{'id':'weather','source':'今日は晴れです。'}]
        rows=get_model().translate(probes)
        print(json.dumps(rows,ensure_ascii=False),flush=True)
        if any(r['flags'] for r in rows):
            raise ValueError('synthetic translation did not complete')
        return
    manifest=json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    started=time.monotonic()
    for p in manifest:
        pid=p['id']
        if not re.fullmatch(r'[\w-]{1,80}',pid):
            raise ValueError('invalid page ID')
        folder=args.output/'pages'/pid
        ocr=folder/'ocr.json'
        while not ocr.is_file():
            time.sleep(2)
        saved=json.loads(ocr.read_text('utf8'))
        if saved['result']['page']!=pid:
            raise ValueError('OCR receipt belongs to another page')
        result=translate_page(folder,saved,model_type,get_model)
        print(json.dumps({'page':pid,'stage':'translation','regions':len(result['lines']),
                          'flagged':sum(bool(r['flags']) for r in result['lines']),'elapsed':round(time.monotonic()-started)},ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
