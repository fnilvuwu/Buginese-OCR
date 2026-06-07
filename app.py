import os
import uuid
import time
import shutil
import logging
import requests
import tarfile
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from flask import Flask, request, jsonify, render_template, send_from_directory, url_for, session
from werkzeug.utils import secure_filename

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
# Keep a stable secret so sessions survive Flask debug reloads.
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'buginese-ocr-dev-secret-key')

# Configure directories
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'static', 'uploads')
RESULTS_FOLDER = os.path.join(BASE_DIR, 'results')
MODELS_DIR = os.path.join(BASE_DIR, 'models')
TEST_IMAGES_FOLDER = os.path.join(BASE_DIR, 'test-images')

for folder in [UPLOAD_FOLDER, RESULTS_FOLDER, MODELS_DIR, TEST_IMAGES_FOLDER]:
    os.makedirs(folder, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024 # 16 MB max upload
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Download models before loading PaddleOCR
logger.info("Checking OCR models...")

# Import and initialize PaddleOCR after models are ready
try:
    from paddleocr import PaddleOCR
    logger.info("Initializing PaddleOCR model...")
    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_dir=os.path.join(MODELS_DIR, "PP-OCRv5_server_det_infer"),
        text_recognition_model_dir=os.path.join(MODELS_DIR, "PP-OCRv5_server_rec_infer"),
        device="cpu",
        enable_mkldnn=False,
    )
    logger.info("PaddleOCR model loaded successfully.")
except Exception as e:
    logger.error(f"Failed to initialize PaddleOCR: {e}")
    ocr = None

def cleanup_old_files():
    """Delete uploaded and result files older than 2 hours."""
    now = time.time()
    cutoff = now - 2 * 3600
    
    # Uploads cleanup
    if os.path.exists(UPLOAD_FOLDER):
        for f in os.listdir(UPLOAD_FOLDER):
            fp = os.path.join(UPLOAD_FOLDER, f)
            if os.path.getmtime(fp) < cutoff:
                try:
                    os.remove(fp)
                except Exception as e:
                    logger.warning(f"Failed to delete old upload file {fp}: {e}")
                    
    # Results cleanup
    if os.path.exists(RESULTS_FOLDER):
        for f in os.listdir(RESULTS_FOLDER):
            fp = os.path.join(RESULTS_FOLDER, f)
            if os.path.getmtime(fp) < cutoff:
                try:
                    os.remove(fp)
                except Exception as e:
                    logger.warning(f"Failed to delete old result file {fp}: {e}")

@app.before_request
def setup_session():
    # Simple CSRF token generation
    if 'csrf_token' not in session:
        session['csrf_token'] = str(uuid.uuid4())

def verify_csrf():
    token = request.headers.get('X-CSRF-Token')
    if not token or token != session.get('csrf_token'):
        return False
    return True

def load_ocr_font(size):
    """Load a font that can render Buginese script when available."""
    font_candidates = [
        os.path.join(BASE_DIR, 'fonts', 'NotoSansBuginese-Regular.ttf')
    ]
    for font_path in font_candidates:
        if os.path.exists(font_path):
            try:
                return ImageFont.truetype(font_path, size)
            except Exception as e:
                logger.warning(f"Could not load font {font_path}: {e}")
    return ImageFont.load_default()

def parse_ocr_result(result):
    """Normalize PaddleOCR output from v2 (nested lists) and v3+ (OCRResult dicts)."""
    polygons = []
    texts = []
    scores = []

    if not result:
        return polygons, texts, scores

    first = result[0]

    # PaddleOCR 3.x: predict() returns a list of OCRResult dict-like objects
    if hasattr(first, '__getitem__') and 'rec_texts' in first:
        polys = first.get('dt_polys') or first.get('rec_polys') or []
        for poly, txt, score in zip(polys, first['rec_texts'], first['rec_scores']):
            polygons.append([(int(p[0]), int(p[1])) for p in poly])
            texts.append(txt)
            scores.append(float(score))
        return polygons, texts, scores

    # PaddleOCR 2.x: [[polygon, (text, score)], ...]
    if first:
        for line in first:
            poly = [(int(pt[0]), int(pt[1])) for pt in line[0]]
            texts.append(line[1][0])
            scores.append(float(line[1][1]))
            polygons.append(poly)

    return polygons, texts, scores

def get_test_images():
    """List sample images available in test-images/."""
    images = []
    if not os.path.isdir(TEST_IMAGES_FOLDER):
        return images

    for filename in sorted(os.listdir(TEST_IMAGES_FOLDER)):
        if allowed_file(filename):
            images.append({
                'filename': filename,
                'url': url_for('serve_test_image', filename=filename),
            })
    return images

@app.route('/')
def index():
    return render_template(
        'index.html',
        csrf_token=session.get('csrf_token'),
        test_images=get_test_images(),
    )

@app.route('/test-images/<path:filename>')
def serve_test_image(filename):
    safe_name = secure_filename(filename)
    if not safe_name or not allowed_file(safe_name):
        return jsonify({'error': 'Invalid image filename'}), 400
    return send_from_directory(TEST_IMAGES_FOLDER, safe_name)

@app.route('/upload', methods=['POST'])
def upload_image():
    if not verify_csrf():
        return jsonify({'error': 'CSRF token missing or invalid'}), 403

    cleanup_old_files()

    if 'image' not in request.files:
        return jsonify({'error': 'No image file provided in request'}), 400
        
    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
        
    if not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type. Allowed formats: PNG, JPG, JPEG, WEBP'}), 400
        
    try:
        file_uuid = str(uuid.uuid4())
        ext = file.filename.rsplit('.', 1)[1].lower()
        filename = f"{file_uuid}.{ext}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        # Get dimensions
        img = Image.open(filepath)
        width, height = img.size
        
        logger.info(f"Image uploaded: {filename} ({width}x{height})")
        
        return jsonify({
            'image_id': file_uuid,
            'filename': filename,
            'url': url_for('static', filename=f'uploads/{filename}'),
            'width': width,
            'height': height
        })
    except Exception as e:
        logger.error(f"Upload error: {e}")
        return jsonify({'error': f"Failed to upload image: {str(e)}"}), 500

@app.route('/crop', methods=['POST'])
def crop_image():
    if not verify_csrf():
        return jsonify({'error': 'CSRF token missing or invalid'}), 403

    data = request.get_json()
    if not data or 'image_id' not in data or 'corners' not in data:
        return jsonify({'error': 'Missing image_id or corners in request data'}), 400
        
    image_id = data['image_id']
    corners = data['corners'] # Array of 4 coordinate dicts: [TL, TR, BR, BL]
    
    if len(corners) != 4:
        return jsonify({'error': 'Exactly 4 corner coordinates are required'}), 400

    # Locate uploaded image
    filename = None
    for ext in ALLOWED_EXTENSIONS:
        test_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{image_id}.{ext}")
        if os.path.exists(test_path):
            filename = f"{image_id}.{ext}"
            filepath = test_path
            break
            
    if not filename:
        return jsonify({'error': 'Uploaded image not found or expired'}), 404
        
    try:
        # Load image with OpenCV
        img = cv2.imread(filepath)
        if img is None:
            return jsonify({'error': 'Failed to load image for cropping'}), 500
            
        # Parse corners
        tl = [corners[0]['x'], corners[0]['y']]
        tr = [corners[1]['x'], corners[1]['y']]
        br = [corners[2]['x'], corners[2]['y']]
        bl = [corners[3]['x'], corners[3]['y']]
        
        src_pts = np.array([tl, tr, br, bl], dtype="float32")
        
        # Calculate width of the cropped image
        width_a = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
        width_b = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
        max_width = max(int(width_a), int(width_b))
        
        # Calculate height
        height_a = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
        height_b = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
        max_height = max(int(height_a), int(height_b))
        
        # Ensure dimensions are valid
        if max_width <= 0 or max_height <= 0:
            return jsonify({'error': 'Invalid crop area dimensions'}), 400
            
        # Define destination points
        dst_pts = np.array([
            [0, 0],
            [max_width - 1, 0],
            [max_width - 1, max_height - 1],
            [0, max_height - 1]
        ], dtype="float32")
        
        # Warp perspective
        transform_matrix = cv2.getPerspectiveTransform(src_pts, dst_pts)
        warped_img = cv2.warpPerspective(img, transform_matrix, (max_width, max_height))
        
        # Save cropped image to results folder
        cropped_filename = f"{image_id}_cropped.jpg"
        cropped_path = os.path.join(RESULTS_FOLDER, cropped_filename)
        cv2.imwrite(cropped_path, warped_img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        
        logger.info(f"Image cropped: {cropped_filename} ({max_width}x{max_height})")
        
        return jsonify({
            'image_id': image_id,
            'cropped_filename': cropped_filename,
            'cropped_url': f"/results/{cropped_filename}",
            'width': max_width,
            'height': max_height
        })
    except Exception as e:
        logger.error(f"Cropping error: {e}")
        return jsonify({'error': f"Failed to crop image: {str(e)}"}), 500

@app.route('/ocr', methods=['POST'])
def run_ocr():
    if not verify_csrf():
        return jsonify({'error': 'CSRF token missing or invalid'}), 403

    if ocr is None:
        return jsonify({'error': 'PaddleOCR is not initialized on the server'}), 503

    data = request.get_json()
    if not data or 'image_id' not in data:
        return jsonify({'error': 'Missing image_id in request data'}), 400
        
    image_id = data['image_id']
    cropped_filename = f"{image_id}_cropped.jpg"
    cropped_path = os.path.join(RESULTS_FOLDER, cropped_filename)
    
    if not os.path.exists(cropped_path):
        return jsonify({'error': 'Cropped image not found. Please run the crop step first.'}), 404
        
    try:
        # Run PaddleOCR inference (v3+ uses predict(); cls arg was removed)
        logger.info(f"Running OCR on {cropped_filename}...")
        result = ocr.predict(cropped_path)
        logger.info("OCR completed successfully.")

        polygons, texts, scores = parse_ocr_result(result)
                
        # Draw annotations and write text summary below the image using PIL
        pil_img = Image.open(cropped_path).convert("RGB")
        w, h = pil_img.size
        
        font_size = max(24, int(w * 0.03))
        line_height = max(48, int(font_size * 1.25))
        font = load_ocr_font(font_size)
        index_font = load_ocr_font(max(12, int(font_size * 0.75)))

        draw = ImageDraw.Draw(pil_img)
        for i, poly in enumerate(polygons):
            draw.polygon(poly, outline="red", width=max(2, int(w * 0.003)))

            tl_x, tl_y = poly[0][0], poly[0][1]
            circle_r = max(8, int(font_size * 0.7))
            circle_bbox = [tl_x - circle_r, tl_y - circle_r, tl_x + circle_r, tl_y + circle_r]
            draw.ellipse(circle_bbox, fill="red")
            draw.text((tl_x - circle_r / 2, tl_y - circle_r), str(i + 1), fill="white", font=index_font)

        num_items = len(texts)
        footer_height = line_height * num_items + 40 if num_items > 0 else 60
        combined_img = Image.new("RGB", (w, h + footer_height), "white")
        combined_img.paste(pil_img, (0, 0))

        draw_combined = ImageDraw.Draw(combined_img)
        y_cursor = h + 20

        if num_items == 0:
            draw_combined.text((20, y_cursor), "No text detected.", fill="gray", font=font)
        else:
            for txt, score in zip(texts, scores):
                draw_combined.text((20, y_cursor), f"{txt}  ({score * 100:.1f}%)", fill="black", font=font)
                y_cursor += line_height

        # Save annotated image
        annotated_filename = f"{image_id}_annotated.jpg"
        annotated_path = os.path.join(RESULTS_FOLDER, annotated_filename)
        combined_img.save(annotated_path, "JPEG", quality=95)
        
        # Create extracted text file (.txt)
        txt_filename = f"{image_id}_extracted.txt"
        txt_path = os.path.join(RESULTS_FOLDER, txt_filename)
        with open(txt_path, 'w', encoding='utf-8') as tf:
            for i, txt in enumerate(texts):
                tf.write(f"{txt}\n")
                
        # Save JSON result summary
        result_summary = {
            "texts": texts,
            "scores": scores,
            "image_url": f"/results/{annotated_filename}",
            "text_file_url": f"/results/{txt_filename}"
        }
        
        import json
        summary_path = os.path.join(RESULTS_FOLDER, f"{image_id}_result.json")
        with open(summary_path, 'w', encoding='utf-8') as jf:
            json.dump(result_summary, jf, ensure_ascii=False)
            
        return jsonify(result_summary)
        
    except Exception as e:
        logger.error(f"OCR execution error: {e}")
        return jsonify({'error': f"Failed to run OCR: {str(e)}"}), 500

@app.route('/result/<image_id>', methods=['GET'])
def get_result(image_id):
    summary_path = os.path.join(RESULTS_FOLDER, f"{image_id}_result.json")
    if not os.path.exists(summary_path):
        return jsonify({'error': 'Result not found or expired'}), 404
        
    try:
        with open(summary_path, 'r', encoding='utf-8') as jf:
            import json
            result_summary = json.load(jf)
        return jsonify(result_summary)
    except Exception as e:
        logger.error(f"Error retrieving result: {e}")
        return jsonify({'error': 'Failed to retrieve result'}), 500

@app.route('/results/<path:filename>')
def serve_results(filename):
    return send_from_directory(RESULTS_FOLDER, filename)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)