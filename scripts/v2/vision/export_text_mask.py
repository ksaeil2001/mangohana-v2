"""Export reviewed safetensors via a standard SMP Unet; never load pickle/code.

Run only in the separate E: CPU export venv. Product inference uses ONNX.
"""
import argparse
import hashlib
import inspect
import json
import os
from pathlib import Path
import platform
import sys
import time
import uuid

import numpy as np
import onnx
import torch
import segmentation_models_pytorch as smp
from safetensors.torch import load_file

PIN="ab28dd8450462c4f87ddfd05d13601813bb90414f26bea5590bf6a0a7540f988"
REVISION="ebd37f1a9ae9298519678fb96a796573fb602977"

class InputNormalizedProbability(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model=model
        self.register_buffer("mean",torch.tensor([.485,.456,.406]).view(1,3,1,1))
        self.register_buffer("std",torch.tensor([.229,.224,.225]).view(1,3,1,1))

    def forward(self, images):
        normalized=(images.to(dtype=torch.float32)/255.0-self.mean)/self.std
        return torch.sigmoid(self.model(normalized))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--model-dir",required=True,type=Path)
    parser.add_argument("--output-dir",required=True,type=Path)
    args=parser.parse_args()
    args.output_dir.mkdir(parents=True,exist_ok=False)
    platform.system()
    def deny(event,_args):
        if event.startswith("socket.") or event in ("subprocess.Popen","os.system","os.posix_spawn","os.fork","os.exec"):
            raise RuntimeError("OFFLINE_EXPORT_ONLY")
    sys.addaudithook(deny)
    started=time.perf_counter()
    weights=args.model_dir/"model.safetensors"
    if weights.stat().st_size!=57377484 or hashlib.sha256(weights.read_bytes()).hexdigest()!=PIN:
        raise ValueError("SAFETENSORS_PIN_MISMATCH")
    metadata=json.loads((args.model_dir/"config.json").read_text("utf-8"))
    if (metadata.get("_model_class")!="Unet" or metadata.get("encoder_name")!="resnet18" or metadata.get("classes")!=1
            or metadata.get("in_channels")!=3 or metadata.get("encoder_weights") is not None or metadata.get("activation") is not None
            or metadata.get("decoder_channels")!=[256,128,64,32,16] or metadata.get("encoder_depth")!=5):
        raise ValueError("UNREVIEWED_MODEL_ARCHITECTURE")
    parameters=dict(encoder_name="resnet18",encoder_depth=5,encoder_weights=None,decoder_channels=(256,128,64,32,16),
                    decoder_attention_type=None,in_channels=3,classes=1,activation=None,aux_params=None)
    signature=inspect.signature(smp.Unet)
    if "decoder_use_norm" in signature.parameters:
        parameters["decoder_use_norm"]="batchnorm"
    else:
        parameters["decoder_use_batchnorm"]=True
    if "decoder_interpolation" in signature.parameters:
        parameters["decoder_interpolation"]="nearest"
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    model=smp.Unet(**parameters)
    state=load_file(str(weights),device="cpu")
    result=model.load_state_dict(state,strict=True)
    if result.missing_keys or result.unexpected_keys:
        raise ValueError("WEIGHT_ARCHITECTURE_MISMATCH")
    wrapper=InputNormalizedProbability(model).eval()
    generator=torch.Generator(device="cpu").manual_seed(442)
    sample=torch.randint(0,256,(1,3,384,384),dtype=torch.uint8,generator=generator)
    with torch.inference_mode():
        expected=wrapper(sample)
    if expected.shape!=(1,1,384,384) or not torch.isfinite(expected).all() or expected.min()<0 or expected.max()>1:
        raise ValueError("INVALID_REFERENCE_PROBABILITY")
    temporary=args.output_dir/("export-"+uuid.uuid4().hex+".partial.onnx")
    torch.onnx.export(wrapper,sample,str(temporary),input_names=["images"],output_names=["probability"],opset_version=17,
                      export_params=True,do_constant_folding=True,dynamo=False)
    exported=onnx.load(str(temporary),load_external_data=False)
    onnx.checker.check_model(exported,full_check=True)
    if any(tensor.data_location!=0 or tensor.external_data for tensor in exported.graph.initializer):
        raise ValueError("EXTERNAL_TENSOR_FORBIDDEN")
    domains={node.domain for node in exported.graph.node}
    if not domains.issubset({"","ai.onnx"}) or exported.functions:
        raise ValueError("CUSTOM_ONNX_GRAPH_FORBIDDEN")
    data=temporary.read_bytes()
    final=args.output_dir/"comic-text-mask-unet-resnet18-384.onnx"
    with final.open("xb") as target:
        target.write(data)
    temporary.unlink()
    np.savez_compressed(args.output_dir/"export-reference.npz",images=sample.numpy(),probability=expected.detach().numpy())
    report={"modelId":"TareHimself/comic-text-mask","revision":REVISION,"license":"mit","sourceSha256":PIN,
            "sourceFormat":"safetensors","remotePythonCodeExecuted":False,"torchScriptOrPickleLoaded":False,
            "architecture":"standard SMP Unet/resnet18","parameters":parameters,"onnxFile":str(final),"onnxBytes":len(data),
            "onnxSha256":hashlib.sha256(data).hexdigest(),"opsets":[{"domain":item.domain,"version":item.version} for item in exported.opset_import],
            "irVersion":exported.ir_version,"graphDomains":sorted(domains),"graphNodes":len(exported.graph.node),"externalTensorData":False,
            "input":{"name":"images","dtype":"uint8","shape":[1,3,384,384]},"output":{"name":"probability","dtype":"float32","shape":[1,1,384,384]},
            "normalization":{"input":"RGB uint8","divide":255,"mean":[.485,.456,.406],"std":[.229,.224,.225],"output":"sigmoid"},
            "torch":torch.__version__,"smp":smp.__version__,"onnx":onnx.__version__,"elapsedMs":(time.perf_counter()-started)*1000,
            "numericalParity":"PENDING_TARGET_CPU_RUNTIME_CHECK","pageQuality":"NOT_EVALUATED"}
    (args.output_dir/"export-report.json").write_text(json.dumps(report,indent=2),"utf-8")
    print(json.dumps(report),flush=True)

if __name__=="__main__":
    main()
