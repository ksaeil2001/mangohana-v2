"""Offline detector comparison on local user-provided pages.

This evaluates region typing only. Bbox masks are geometry evidence, not
fine text-removal masks, and no OCR/translation/inpainting is performed.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

CLASSES = {0: "bubble", 1: "text_bubble", 2: "text_free"}
COLORS = {0: "#0088ff", 1: "#00d060", 2: "#ff5050"}
PINS = {
    "detector_int8.onnx": "b5022ad46416b6fe4f88b0cc082cfd2ff5b1cfc624088c2f19879485493f5913",
    "detector-v4-s_int8.onnx": "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79",
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def graph_attestation(file, proto):
    spec = importlib.util.spec_from_file_location("vision_onnx_pb2", proto)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.ModelProto()
    model.ParseFromString(file.read_bytes())
    domains = set()
    operators = set()
    tensors = 0
    nodes = 0
    def tensor(item):
        nonlocal tensors
        tensors += 1
        if item.data_location != 0 or item.external_data:
            raise ValueError("EXTERNAL_TENSOR_DATA_FORBIDDEN")
    def graph(item):
        nonlocal nodes
        for initializer in item.initializer:
            tensor(initializer)
        if item.sparse_initializer:
            raise ValueError("SPARSE_INITIALIZER_UNREVIEWED")
        for node in item.node:
            nodes += 1
            domains.add(node.domain)
            operators.add(node.domain + ":" + node.op_type)
            if node.domain not in ("", "ai.onnx", "com.microsoft"):
                raise ValueError("CUSTOM_OPERATOR_DOMAIN_FORBIDDEN")
            for attribute in node.attribute:
                if attribute.HasField("t"):
                    tensor(attribute.t)
                for child in attribute.tensors:
                    tensor(child)
                if attribute.HasField("g"):
                    graph(attribute.g)
                for child in attribute.graphs:
                    graph(child)
                if attribute.HasField("sparse_tensor") or attribute.sparse_tensors:
                    raise ValueError("SPARSE_ATTRIBUTE_UNREVIEWED")
    graph(model.graph)
    if model.functions:
        raise ValueError("LOCAL_FUNCTIONS_UNREVIEWED")
    return {"irVersion": model.ir_version, "opsets": [{"domain": op.domain, "version": op.version} for op in model.opset_import],
            "nodes": nodes, "tensors": tensors, "domains": sorted(domains), "operators": sorted(operators),
            "externalTensorData": False, "customOperatorLibraries": False}

def overlap(a, b):
    w = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return w * h

def compare_ocr(ocr, detections, width, height):
    result = []
    for bubble in ocr["speechBubbles"]:
        box = bubble["bbox"]
        source = [box["x"]*width, box["y"]*height, (box["x"]+box["width"])*width, (box["y"]+box["height"])*height]
        area = (source[2]-source[0])*(source[3]-source[1])
        matches = [{"class": item["class"], "score": item["score"], "sourceBoxCoverage": overlap(source, item["boxPx"])/area,
                    "id": item["id"]} for item in detections if item["label"] in (1,2) and overlap(source,item["boxPx"]) > 0]
        matches.sort(key=lambda item: item["sourceBoxCoverage"]*item["score"], reverse=True)
        result.append({"id": bubble["id"], "source": bubble["text"], "matches": matches[:3]})
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--proto", type=Path, required=True)
    parser.add_argument("--ocr", type=Path)
    parser.add_argument("--count", type=int, default=3)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    platform.system()
    def offline(event, _args):
        if event.startswith("socket.") or event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.exec"):
            raise RuntimeError("OFFLINE_ONLY")
    sys.addaudithook(offline)
    ort.disable_telemetry_events()
    ort.set_default_logger_severity(3)
    pages = sorted(args.inputs.glob("*.png"))[:args.count]
    ocr = json.loads(args.ocr.read_text("utf-8")) if args.ocr else None
    summaries = []
    for name, pinned in PINS.items():
        model_path = args.models/name
        digest = sha(model_path.read_bytes())
        if digest != pinned:
            raise ValueError("MODEL_CHECKSUM_MISMATCH")
        attestation = graph_attestation(model_path, args.proto)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        started = time.perf_counter()
        session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        session.disable_fallback()
        if session.get_providers() != ["CPUExecutionProvider"]:
            raise ValueError("CPU_PROVIDER_REQUIRED")
        load_ms = (time.perf_counter()-started)*1000
        model_result = {"model": name, "sha256": digest, "provider": session.get_providers(), "loadMs": load_ms,
                        "graph": attestation, "preprocess": {"resize": [640,640], "resample": "BICUBIC", "scale": "RGB/255", "origTargetSizes": "width,height"},
                        "confidenceThreshold": .3, "pages": []}
        for page_index, page in enumerate(pages):
            image = Image.open(page).convert("RGB")
            width, height = image.size
            square = image.resize((640,640), Image.Resampling.BICUBIC)
            tensor = np.transpose(np.asarray(square,dtype=np.float32)/255.0,(2,0,1))[None]
            started = time.perf_counter()
            labels, boxes, scores = session.run(None,{"images": tensor,"orig_target_sizes": np.array([[width,height]],dtype=np.int64)})[:3]
            inference_ms = (time.perf_counter()-started)*1000
            labels, boxes, scores = labels[0], boxes[0], scores[0]
            if not (len(labels)==len(boxes)==len(scores)) or not np.isfinite(boxes).all() or not np.isfinite(scores).all():
                raise ValueError("INVALID_DETECTOR_OUTPUT")
            detections = []
            for index, (label, box, score) in enumerate(zip(labels,boxes,scores)):
                if not 0 <= float(score) <= 1 or int(label) not in CLASSES:
                    raise ValueError("INVALID_LABEL_OR_SCORE")
                if float(score)<.3:
                    continue
                x1,y1,x2,y2 = map(float,box)
                x1,y1,x2,y2 = max(0,x1),max(0,y1),min(width,x2),min(height,y2)
                if x1>=x2 or y1>=y2:
                    continue
                detections.append({"id":f"{page_index+1}-{index}","label":int(label),"class":CLASSES[int(label)],"score":float(score),
                                   "boxPx":[x1,y1,x2,y2],"bbox":{"x":x1/width,"y":y1/height,"width":(x2-x1)/width,"height":(y2-y1)/height}})
            overlay = image.copy()
            draw = ImageDraw.Draw(overlay)
            font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf",24)
            text_region_mask = Image.new("L",image.size)
            mask_draw = ImageDraw.Draw(text_region_mask)
            for detection in detections:
                color = COLORS[detection["label"]]
                draw.rectangle(detection["boxPx"],outline=color,width=4)
                x,y,*_ = detection["boxPx"]
                label=f"{detection['class']} {detection['score']:.2f}"
                draw.text((x,max(0,y-28)),label,font=font,fill=color,stroke_width=2,stroke_fill="black")
                if detection["label"]==1:
                    mask_draw.rectangle(detection["boxPx"],fill=255)
            stem=f"{name[:-5]}-{page.stem[:3]}"
            overlay.save(args.output/(stem+"-overlay.png"))
            text_region_mask.save(args.output/(stem+"-text-bubble-bbox-mask.png"))
            page_result={"input":str(page),"inputSha256":sha(page.read_bytes()),"width":width,"height":height,"inferenceMs":inference_ms,
                         "detections":detections,"counts":{name:sum(d["label"]==key for d in detections) for key,name in CLASSES.items()},
                         "maskKind":"RECTANGLE_GEOMETRY_ONLY_NOT_TEXT_SEGMENTATION"}
            if ocr is not None and page_index==0:
                page_result["existingOcrMatches"]=compare_ocr(ocr,detections,width,height)
            model_result["pages"].append(page_result)
            print(json.dumps({"model":name,"page":page.stem[:3],"inferenceMs":round(inference_ms,2),"counts":page_result["counts"]}),flush=True)
        summaries.append(model_result)
        del session
    result={"scope":"OFFLINE_REGION_DETECTOR_POC","userImagesUploaded":False,"ocrExecuted":False,"translationExecuted":False,"inpaintingExecuted":False,"models":summaries}
    (args.output/"evaluation.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),"utf-8")
    print("VISION_OUTPUT="+str(args.output),flush=True)

if __name__ == "__main__":
    main()
