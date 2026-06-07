document.addEventListener('DOMContentLoaded', function() {
    // CSRF Configuration
    const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

    // State Variables
    let currentStep = 1;
    let imageId = null;
    let originalWidth = 0;
    let originalHeight = 0;
    let imageUrl = null;
    let croppedUrl = null;
    let scale = 1;
    let isUploading = false;
    
    // Konva Elements
    let stage = null;
    let imageLayer = null;
    let overlayLayer = null;
    let handles = {}; // tl, tr, br, bl
    let originalImageObj = null;

    // DOM Elements
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingTitle = document.getElementById('loading-title');
    const loadingDesc = document.getElementById('loading-desc');
    
    const cropCanvasContainer = document.getElementById('crop-canvas-container');
    const croppedPreviewImg = document.getElementById('cropped-preview-img');
    const annotatedResultImg = document.getElementById('annotated-result-img');
    const textListContainer = document.getElementById('text-list-container');
    const magnifier = document.getElementById('magnifier');
    const magnifierCanvas = document.getElementById('magnifier-canvas');

    // Step indicators
    const stepIndicators = [
        document.getElementById('step-indicator-1'),
        document.getElementById('step-indicator-2'),
        document.getElementById('step-indicator-3'),
        document.getElementById('step-indicator-4')
    ];
    const stepLines = [
        document.getElementById('step-line-1'),
        document.getElementById('step-line-2'),
        document.getElementById('step-line-3')
    ];
    const stepSections = [
        document.getElementById('step-upload'),
        document.getElementById('step-crop'),
        document.getElementById('step-ocr'),
        document.getElementById('step-results')
    ];

    // Buttons
    const btnCropBack = document.getElementById('btn-crop-back');
    const btnCropSubmit = document.getElementById('btn-crop-submit');
    const btnOcrBack = document.getElementById('btn-ocr-back');
    const btnOcrSubmit = document.getElementById('btn-ocr-submit');
    const btnRestart = document.getElementById('btn-restart');
    const btnDownloadImage = document.getElementById('btn-download-image');
    const btnDownloadCropped = document.getElementById('btn-download-cropped');
    const btnDownloadText = document.getElementById('btn-download-text');

    /* ==========================================================================
       Navigation and UI Helpers
       ========================================================================== */
    
    function showLoader(title, desc) {
        loadingTitle.textContent = title || "Processing...";
        loadingDesc.textContent = desc || "Please wait, this may take a moment.";
        loadingOverlay.style.display = 'flex';
    }

    function hideLoader() {
        loadingOverlay.style.display = 'none';
    }

    function showError(message) {
        alert(message || "An unexpected error occurred. Please try again.");
    }

    function setStep(stepNum) {
        currentStep = stepNum;
        
        // Update Indicators
        stepIndicators.forEach((ind, i) => {
            const stepIdx = i + 1;
            ind.classList.remove('active', 'completed');
            if (stepIdx === stepNum) {
                ind.classList.add('active');
            } else if (stepIdx < stepNum) {
                ind.classList.add('completed');
            }
        });

        stepLines.forEach((line, i) => {
            const lineIdx = i + 1;
            line.classList.remove('active');
            if (lineIdx < stepNum) {
                line.classList.add('active');
            }
        });

        // Show/Hide Sections
        stepSections.forEach((section, i) => {
            const sectionIdx = i + 1;
            if (sectionIdx === stepNum) {
                section.classList.add('active');
            } else {
                section.classList.remove('active');
            }
        });
        
        // Scroll to top of main card on step change
        document.querySelector('.main-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* ==========================================================================
       Step 1: Upload Logic
       ========================================================================== */

    // Drag and Drop
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, e => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, e => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
        }, false);
    });

    dropzone.addEventListener('drop', e => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleUpload(files[0]);
        }
    });

    dropzone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', function() {
        if (this.files.length > 0) {
            handleUpload(this.files[0]);
        }
    });

    const sampleImagesGrid = document.getElementById('sample-images-grid');
    if (sampleImagesGrid) {
        sampleImagesGrid.addEventListener('click', function(e) {
            const card = e.target.closest('.sample-image-card');
            if (!card) return;
            e.preventDefault();
            e.stopPropagation();
            handleSampleImage(card.dataset.filename, card.dataset.url);
        });
    }

    async function handleSampleImage(filename, url) {
        if (isUploading) {
            return;
        }

        showLoader("Loading Sample...", "Preparing the selected test image.");

        try {
            const response = await fetch(url, { credentials: 'same-origin' });
            if (!response.ok) {
                throw new Error(`Could not load sample image (${response.status}).`);
            }

            const blob = await response.blob();
            const mimeType = blob.type || 'image/jpeg';
            const file = new File([blob], filename, { type: mimeType });
            hideLoader();
            await handleUpload(file);
        } catch (err) {
            console.error("Sample image error:", err);
            hideLoader();
            showError(err.message || "Failed to load sample image.");
        }
    }

    async function parseJsonResponse(response) {
        const text = await response.text();
        if (!text) {
            throw new Error('Server returned an empty response.');
        }

        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.error('Non-JSON response:', text.slice(0, 200));
            throw new Error('Server returned an invalid response. Please refresh the page and try again.');
        }
    }

    async function handleUpload(file) {
        if (isUploading) {
            return;
        }

        if (!file.type.match('image.*')) {
            showError("Invalid file type. Please upload an image file (PNG, JPG, WEBP).");
            return;
        }

        const formData = new FormData();
        formData.append('image', file);

        isUploading = true;
        showLoader("Uploading Image...", "Sending your document to the server for processing.");

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData,
                headers: {
                    'X-CSRF-Token': csrfToken
                },
                credentials: 'same-origin'
            });

            const data = await parseJsonResponse(response);

            if (!response.ok || data.error) {
                showError(data.error || `Upload failed (${response.status}).`);
                return;
            }

            if (!data.image_id || !data.url || !data.width || !data.height) {
                showError('Upload succeeded but the server response was incomplete. Please try again.');
                return;
            }

            imageId = data.image_id;
            originalWidth = data.width;
            originalHeight = data.height;
            imageUrl = new URL(data.url, window.location.origin).href;

            hideLoader();
            initCropStage();
        } catch (err) {
            console.error("Upload error:", err);
            hideLoader();
            showError(err.message || "Network error. Could not upload image.");
        } finally {
            isUploading = false;
        }
    }

    /* ==========================================================================
       Step 2: Konva.js Perspective Crop Workspace
       ========================================================================== */

    function initCropStage() {
        setStep(2);
        showLoader("Loading editor...", "Preparing perspective cropping canvas.");

        // Destroy previous stage before clearing the container markup.
        if (stage) {
            stage.destroy();
            stage = null;
        }
        cropCanvasContainer.innerHTML = '';

        // Wait until the crop step is visible so layout dimensions are valid.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                buildCropStage();
            });
        });
    }

    function buildCropStage() {
        if (typeof Konva === 'undefined') {
            showError("Crop editor failed to load. Check your internet connection and refresh the page.");
            return;
        }

        const wrapper = document.querySelector('.crop-workspace-wrapper');
        const containerWidth = Math.max(wrapper.clientWidth - 32, 320);
        const containerHeight = Math.max(
            Math.min(window.innerHeight * 0.55, 480),
            240
        );

        scale = 1;
        if (originalWidth > containerWidth || originalHeight > containerHeight) {
            scale = Math.min(containerWidth / originalWidth, containerHeight / originalHeight);
        }
        scale = Math.max(scale, 0.01);

        const stageWidth = Math.max(1, Math.round(originalWidth * scale));
        const stageHeight = Math.max(1, Math.round(originalHeight * scale));

        stage = new Konva.Stage({
            container: 'crop-canvas-container',
            width: stageWidth,
            height: stageHeight
        });

        imageLayer = new Konva.Layer();
        overlayLayer = new Konva.Layer();
        stage.add(imageLayer);
        stage.add(overlayLayer);

        originalImageObj = new Image();
        originalImageObj.onload = function() {
            hideLoader();

            const konvaImg = new Konva.Image({
                x: 0,
                y: 0,
                image: originalImageObj,
                width: stageWidth,
                height: stageHeight
            });
            imageLayer.add(konvaImg);
            imageLayer.draw();

            setupCropHandles(stageWidth, stageHeight);
        };
        originalImageObj.onerror = function() {
            hideLoader();
            showError("Failed to load uploaded image in editor.");
        };
        originalImageObj.src = imageUrl;
    }

    function setupCropHandles(stageWidth, stageHeight) {
        // Initial crop layout points (inset 10% from corners)
        const insetX = stageWidth * 0.1;
        const insetY = stageHeight * 0.1;

        const defaultPoints = {
            tl: { x: insetX, y: insetY },
            tr: { x: stageWidth - insetX, y: insetY },
            br: { x: stageWidth - insetX, y: stageHeight - insetY },
            bl: { x: insetX, y: stageHeight - insetY }
        };

        // Custom function to create circular handles with large hit target
        function createHandle(name, initialPos) {
            const handle = new Konva.Circle({
                x: initialPos.x,
                y: initialPos.y,
                radius: 10,
                fill: '#6366f1',
                stroke: '#ffffff',
                strokeWidth: 3,
                draggable: true,
                dragBoundFunc: function(pos) {
                    // Lock position inside stage bounds
                    const stagePos = stage.absolutePosition();
                    let newX = pos.x - stagePos.x;
                    let newY = pos.y - stagePos.y;

                    newX = Math.max(0, Math.min(newX, stageWidth));
                    newY = Math.max(0, Math.min(newY, stageHeight));

                    return {
                        x: newX + stagePos.x,
                        y: newY + stagePos.y
                    };
                }
            });

            // Set a large hit region for comfortable touch support
            handle.hitStrokeWidth(25);

            // Drag event handlers
            handle.on('dragstart', function() {
                showMagnifier();
                updateMagnifierView(this);
            });

            handle.on('dragmove', function() {
                overlayLayer.draw();
                updateMagnifierView(this);
            });

            handle.on('dragend', function() {
                hideMagnifier();
            });

            // Visual enhancements on hover
            handle.on('mouseenter', function() {
                document.body.style.cursor = 'pointer';
                this.fill('#a855f7');
                overlayLayer.draw();
            });

            handle.on('mouseleave', function() {
                document.body.style.cursor = 'default';
                this.fill('#6366f1');
                overlayLayer.draw();
            });

            return handle;
        }

        // Add handles
        handles = {
            tl: createHandle('tl', defaultPoints.tl),
            tr: createHandle('tr', defaultPoints.tr),
            br: createHandle('br', defaultPoints.br),
            bl: createHandle('bl', defaultPoints.bl)
        };

        // Create overlay shape with cutout
        const overlay = new Konva.Shape({
            sceneFunc: function(context) {
                const tlPos = handles.tl.position();
                const trPos = handles.tr.position();
                const brPos = handles.br.position();
                const blPos = handles.bl.position();

                context.beginPath();
                context.rect(0, 0, stageWidth, stageHeight);
                context.moveTo(tlPos.x, tlPos.y);
                context.lineTo(blPos.x, blPos.y);
                context.lineTo(brPos.x, brPos.y);
                context.lineTo(trPos.x, trPos.y);
                context.closePath();
                context.setAttr('fillStyle', 'rgba(2, 6, 17, 0.65)');
                context.fill('evenodd');

                context.beginPath();
                context.moveTo(tlPos.x, tlPos.y);
                context.lineTo(trPos.x, trPos.y);
                context.lineTo(brPos.x, brPos.y);
                context.lineTo(blPos.x, blPos.y);
                context.closePath();
                context.setAttr('strokeStyle', '#6366f1');
                context.setAttr('lineWidth', 3);
                context.setAttr('shadowColor', 'rgba(99, 102, 241, 0.5)');
                context.setAttr('shadowBlur', 6);
                context.stroke();
                context.setAttr('shadowBlur', 0);
            }
        });

        // Add overlay and handles to layer
        overlayLayer.add(overlay);
        overlayLayer.add(handles.tl);
        overlayLayer.add(handles.tr);
        overlayLayer.add(handles.br);
        overlayLayer.add(handles.bl);
        
        overlayLayer.draw();
    }

    /* ==========================================================================
       Crop Loupe (precision magnifier)
       ========================================================================== */

    function isTouchLikeDevice() {
        return window.matchMedia('(max-width: 768px)').matches
            || window.matchMedia('(pointer: coarse)').matches;
    }

    function getLoupeSize() {
        return isTouchLikeDevice() ? 148 : 132;
    }

    function getHandleScreenPosition(activeHandle) {
        const containerRect = stage.container().getBoundingClientRect();
        return {
            x: containerRect.left + activeHandle.x(),
            y: containerRect.top + activeHandle.y()
        };
    }

    function positionLoupe(screenX, screenY) {
        const pad = 12;
        const gap = 28;
        const size = getLoupeSize();
        const half = size / 2;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        if (isTouchLikeDevice()) {
            magnifier.classList.add('is-docked');
            magnifier.style.left = '50%';

            const workspace = document.querySelector('.crop-workspace-wrapper');
            const workspaceRect = workspace ? workspace.getBoundingClientRect() : null;
            const dockTop = workspaceRect
                ? Math.max(pad, workspaceRect.top - size - 10)
                : (parseInt(getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-top)') || '0', 10) + 72);

            magnifier.style.top = `${dockTop}px`;
            magnifier.style.transform = 'translateX(-50%)';
            return;
        }

        magnifier.classList.remove('is-docked');
        magnifier.style.transform = 'translate(-50%, -50%)';

        const candidates = [
            { left: screenX, top: screenY - half - gap },
            { left: screenX - half - gap, top: screenY },
            { left: screenX + half + gap, top: screenY },
            { left: screenX, top: screenY + half + gap }
        ];

        let best = null;

        for (const candidate of candidates) {
            const fits =
                candidate.left - half >= pad &&
                candidate.top - half >= pad &&
                candidate.left + half <= vw - pad &&
                candidate.top + half <= vh - pad;

            if (!fits) continue;

            best = candidate;
            break;
        }

        if (!best) {
            best = {
                left: Math.max(pad + half, Math.min(screenX, vw - pad - half)),
                top: Math.max(pad + half, Math.min(screenY - half - gap, vh - pad - half))
            };
        }

        magnifier.style.left = `${best.left}px`;
        magnifier.style.top = `${best.top}px`;
    }

    function updateMagnifierView(activeHandle) {
        const hX = activeHandle.x();
        const hY = activeHandle.y();
        const origX = hX / scale;
        const origY = hY / scale;
        const zoom = isTouchLikeDevice() ? 4.5 : 5;
        const size = getLoupeSize();
        const radius = size / 2;

        magnifierCanvas.width = size;
        magnifierCanvas.height = size;

        const ctx = magnifierCanvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);

        ctx.save();
        ctx.beginPath();
        ctx.arc(radius, radius, radius - 1, 0, Math.PI * 2);
        ctx.clip();

        ctx.translate(radius, radius);
        ctx.scale(zoom, zoom);
        ctx.translate(-origX, -origY);
        ctx.drawImage(originalImageObj, 0, 0, originalWidth, originalHeight);
        ctx.restore();

        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(radius, radius, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(radius - 12, radius);
        ctx.lineTo(radius + 12, radius);
        ctx.moveTo(radius, radius - 12);
        ctx.lineTo(radius, radius + 12);
        ctx.stroke();

        const screenPos = getHandleScreenPosition(activeHandle);
        positionLoupe(screenPos.x, screenPos.y);
    }

    function hideMagnifier() {
        magnifier.style.display = 'none';
        magnifier.classList.remove('is-docked');
        magnifier.setAttribute('aria-hidden', 'true');
    }

    function showMagnifier() {
        magnifier.style.display = 'block';
        magnifier.setAttribute('aria-hidden', 'false');
    }

    // Handle submit crop
    btnCropSubmit.addEventListener('click', function() {
        if (!imageId || !handles.tl) return;

        // Map handle coordinates to original dimensions
        const cropCoords = [
            { x: Math.round(handles.tl.x() / scale), y: Math.round(handles.tl.y() / scale) }, // Top-Left
            { x: Math.round(handles.tr.x() / scale), y: Math.round(handles.tr.y() / scale) }, // Top-Right
            { x: Math.round(handles.br.x() / scale), y: Math.round(handles.br.y() / scale) }, // Bottom-Right
            { x: Math.round(handles.bl.x() / scale), y: Math.round(handles.bl.y() / scale) }  // Bottom-Left
        ];

        showLoader("Warping Perspective...", "Applying perspective correction and rendering cropped scan.");

        fetch('/crop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                image_id: imageId,
                corners: cropCoords
            })
        })
        .then(response => response.json())
        .then(data => {
            hideLoader();
            if (data.error) {
                showError(data.error);
            } else {
                croppedUrl = data.cropped_url;
                croppedPreviewImg.src = croppedUrl;
                setStep(3);
            }
        })
        .catch(err => {
            hideLoader();
            console.error("Crop error:", err);
            showError("Network error. Perspective correction failed.");
        });
    });

    btnCropBack.addEventListener('click', () => {
        hideMagnifier();
        setStep(1);
    });

    /* ==========================================================================
       Step 3: OCR Inference Trigger
       ========================================================================== */

    btnOcrBack.addEventListener('click', () => {
        setStep(2);
    });

    btnOcrSubmit.addEventListener('click', function() {
        if (!imageId) return;

        showLoader("Extracting Text (PaddleOCR)...", "Running neural network OCR models to detect and recognize text lines.");

        fetch('/ocr', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                image_id: imageId
            })
        })
        .then(response => response.json())
        .then(data => {
            hideLoader();
            if (data.error) {
                showError(data.error);
            } else {
                displayResults(data);
            }
        })
        .catch(err => {
            hideLoader();
            console.error("OCR error:", err);
            showError("Network error. Text extraction failed.");
        });
    });

    /* ==========================================================================
       Step 4: Display Results & Downloads
       ========================================================================== */

    function displayResults(data) {
        // Set images
        annotatedResultImg.src = data.image_url;
        
        // Setup download paths
        btnDownloadImage.href = data.image_url;
        btnDownloadCropped.href = croppedUrl;
        btnDownloadText.href = data.text_file_url;

        // Clear previous text list
        textListContainer.innerHTML = '';

        if (data.texts.length === 0) {
            textListContainer.innerHTML = `
                <div class="text-item" style="justify-content: center; color: var(--text-muted);">
                    <p><i class="fa-solid fa-circle-info"></i> No text was identified in this image scan.</p>
                </div>
            `;
        } else {
            data.texts.forEach((text, i) => {
                const conf = data.scores[i];
                const confPct = Math.round(conf * 100);
                
                // Classify confidence badge color
                let badgeClass = 'conf-low';
                if (confPct >= 85) {
                    badgeClass = 'conf-high';
                } else if (confPct >= 70) {
                    badgeClass = 'conf-mid';
                }

                const itemHTML = `
                    <div class="text-item">
                        <div class="text-idx">${i + 1}</div>
                        <div class="text-content-box">
                            <p class="text-value">${escapeHtml(text)}</p>
                            <div class="text-meta">
                                <span class="conf-badge ${badgeClass}">Confidence: ${confPct}%</span>
                            </div>
                        </div>
                    </div>
                `;
                textListContainer.insertAdjacentHTML('beforeend', itemHTML);
            });
        }

        setStep(4);
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    btnRestart.addEventListener('click', () => {
        // Reset state
        imageId = null;
        originalWidth = 0;
        originalHeight = 0;
        imageUrl = null;
        croppedUrl = null;
        fileInput.value = '';
        
        hideMagnifier();

        if (stage) {
            stage.destroy();
            stage = null;
        }

        setStep(1);
    });
});
