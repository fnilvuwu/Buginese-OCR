"""PaddleOCR 3.x inference example (matches the Colab workflow)."""

import os
import sys

from paddleocr import PaddleOCR
from PIL import Image, ImageDraw, ImageFont

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DET_MODEL = os.path.join(BASE_DIR, "models", "PP-OCRv5_server_det_infer")
REC_MODEL = os.path.join(BASE_DIR, "models", "PP-OCRv5_server_rec_infer")
FONT_PATH = os.path.join(BASE_DIR, "fonts", "NotoSansBuginese-Regular.ttf")


def run_ocr(image_path: str, output_path: str | None = None):
    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_dir=DET_MODEL,
        text_recognition_model_dir=REC_MODEL,
        device="cpu",
        enable_mkldnn=False,
    )

    results = ocr.predict(image_path)
    res = results[0]

    polys = res["dt_polys"]
    texts = res["rec_texts"]
    scores = res["rec_scores"]

    img = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(img)

    font_size = max(24, int(img.width * 0.03))
    line_height = max(48, int(font_size * 1.25))
    font = ImageFont.truetype(FONT_PATH, font_size) if os.path.exists(FONT_PATH) else ImageFont.load_default()

    detected_texts = []
    for pts, text, score in zip(polys, texts, scores):
        poly = [(int(p[0]), int(p[1])) for p in pts]
        draw.polygon(poly, outline="red")
        detected_texts.append((text, float(score)))

    footer_height = line_height * len(detected_texts) + 40
    final_img = Image.new("RGB", (img.width, img.height + footer_height), "white")
    final_img.paste(img, (0, 0))

    draw_final = ImageDraw.Draw(final_img)
    y = img.height + 20
    for text, score in detected_texts:
        draw_final.text((20, y), f"{text}  ({score * 100:.1f}%)", font=font, fill="black")
        y += line_height

    if output_path:
        final_img.save(output_path, "JPEG", quality=95)
        print(f"Saved annotated image to: {output_path}")

    print(f"Image: {image_path}")
    print(f"Detected {len(detected_texts)} text line(s):\n")
    for i, (text, score) in enumerate(detected_texts, start=1):
        print(f"[{i}] {text!r}  (confidence: {score * 100:.1f}%)")

    return detected_texts, final_img


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python example_inference.py <image_path> [output.jpg]")
        sys.exit(1)

    image_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(BASE_DIR, "results", "annotated_example.jpg")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    run_ocr(image_path, output_path)
