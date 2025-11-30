// Point to the LOCAL worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.min.js';

/**
 * INDEXED DB MANAGER
 * Handles saving/loading large binary files locally without server uploads.
 */
class LocalStorageManager {
    constructor(dbName = 'PDFEditorDB', storeName = 'StateStore') {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = e => reject(e);
            request.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = e => {
                this.db = e.target.result;
                resolve();
            };
        });
    }

    async saveState(sourceFiles, pages) {
        if (!this.db) await this.init();
        
        // Prepare data for storage (convert complex File objects to simpler objects with Blobs)
        const serializedSources = sourceFiles.map(f => ({
            id: f.id,
            name: f.name,
            type: f.type,
            file: f.file // Blob is supported in IndexedDB
        }));

        const state = { sourceFiles: serializedSources, pages: pages };
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.storeName], 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.put(state, 'currentState');
            tx.oncomplete = () => resolve();
            tx.onerror = e => reject(e);
        });
    }

    async loadState() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.storeName], 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.get('currentState');
            req.onsuccess = () => resolve(req.result);
            req.onerror = e => reject(e);
        });
    }
    
    async clear() {
        if (!this.db) await this.init();
        const tx = this.db.transaction([this.storeName], 'readwrite');
        tx.objectStore(this.storeName).clear();
    }
}

/**
 * MAIN VISUAL PDF TOOL
 */
class VisualPDFTool {
    constructor() {
        // Data Structures
        this.sourceFiles = [];
        this.pages = []; 
        this.selectedPageIds = new Set();
        this.lastSelectedId = null;
        
        // History State
        this.historyStack = [];
        this.redoStack = [];
        this.maxHistory = 20;
        
        // Modules
        this.dbManager = new LocalStorageManager();
        this.observer = null; // Lazy load observer
        this.contextTargetId = null;

        // Editor State
        this.editingPageId = null;
        this.tempTextOverlays = [];
        this.activeTextIndex = -1;
        this.tempRotation = 0;

        // UI References
        this.pageGrid = document.getElementById('page-grid');
        this.mainView = document.getElementById('main-view');
        this.selectionCount = document.getElementById('selection-count');
        this.undoBtn = document.getElementById('undoBtn');
        this.redoBtn = document.getElementById('redoBtn');
        this.textModal = document.getElementById('text-modal');
        this.startScreen = document.getElementById('start-screen');
        this.appContainer = document.querySelector('.app-container');
        this.contextMenu = document.getElementById('context-menu');

        this.init();
    }

    // --- INITIALIZATION ---
    async init() {
        this.initSortable();
        this.initEventListeners();
        this.initIntersectionObserver();
        this.initContextMenu();
        this.initMarqueeSelection();
        this.checkTheme();
        document.documentElement.style.setProperty('--grid-size', '180px');
        
        // Check for saved work
        try {
            await this.dbManager.init();
            const saved = await this.dbManager.loadState();
            if(saved && saved.pages.length > 0) {
                const banner = document.getElementById('restore-banner');
                if(banner) {
                    banner.classList.remove('hidden');
                    document.getElementById('restoreBtn').addEventListener('click', () => this.restoreSession(saved));
                }
            }
        } catch(e) { console.log("DB Init Error", e); }
    }

    // --- SAFETY HELPER ---
    safeAddListener(id, event, handler) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(event, handler);
        } else {
            console.warn(`Element with ID '${id}' not found. Listener not attached.`);
        }
    }

    // --- EVENT LISTENERS ---
    initEventListeners() {
        // Global Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.performUndo(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.performRedo(); }
            if ((e.key === 'Delete' || e.key === 'Backspace') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { 
                this.deleteSelectedPages(); 
            }
        });

        // Prevent Accidental Closing
        window.addEventListener('beforeunload', (e) => {
            if (this.pages.length > 0) { e.preventDefault(); e.returnValue = ''; }
        });

        // Top Toolbar
        this.safeAddListener('undoBtn', 'click', () => this.performUndo());
        this.safeAddListener('redoBtn', 'click', () => this.performRedo());
        this.safeAddListener('zoomSlider', 'input', (e) => document.documentElement.style.setProperty('--grid-size', `${e.target.value}px`));
        this.safeAddListener('darkModeToggle', 'click', () => document.documentElement.classList.toggle('dark'));
        
        // Grid/List View Toggles
        this.safeAddListener('viewGridBtn', 'click', () => { document.getElementById('page-grid').className = 'grid gap-6 dynamic-grid pb-20 view-grid'; });
        this.safeAddListener('viewListBtn', 'click', () => { document.getElementById('page-grid').className = 'view-list pb-20'; });

        // File Inputs
        this.safeAddListener('filenameInput', 'input', (e) => e.target.value = e.target.value.replace(/[^a-zA-Z0-9-_ ]/g, ''));
        this.safeAddListener('startChooseFileBtn', 'click', () => document.getElementById('fileInput').click());
        this.safeAddListener('addFilesBtn', 'click', () => document.getElementById('fileInput').click());
        this.safeAddListener('fileInput', 'change', async (e) => { await this.addFiles(Array.from(e.target.files)); e.target.value = ''; });

        // Sidebar Actions
        this.safeAddListener('sidebar-close-btn', 'click', () => this.toggleSidebar(false));
        this.safeAddListener('menu-toggle-btn', 'click', () => this.toggleSidebar(true));
        this.safeAddListener('insertBlankBtn', 'click', () => this.insertBlankPage());
        this.safeAddListener('openTextModalBtn', 'click', () => { 
            if(this.pages.length > 0) this.openPageEditor(this.pages[0].id); 
            else this.showToast('Add pages first', 'error'); 
        });

        // --- EDITOR MODAL ACTIONS ---
        const closeBtn = document.querySelector('.close-text-modal');
        if(closeBtn) closeBtn.addEventListener('click', () => {
            this.textModal.classList.add('hidden', 'opacity-0');
            this.textModal.querySelector('div').classList.add('scale-95');
        });

        this.safeAddListener('addTextLayerBtn', 'click', () => this.addTextLayerToEditor());
        this.safeAddListener('editor-rotate-cw', 'click', () => this.editorRotate(90));
        this.safeAddListener('editor-rotate-ccw', 'click', () => this.editorRotate(-90));
        this.safeAddListener('savePageEdits', 'click', () => this.savePageEdits(false));
        
        // Editor Controls (Safe Loop)
        ['txt-content', 'txt-size', 'txt-color', 'txt-rotation', 'txt-font', 'txt-opacity'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.addEventListener('input', () => this.updateActiveTextLayer());
        });
        
        this.safeAddListener('delete-layer-btn', 'click', () => this.deleteActiveLayer());

        // Footer Actions
        this.safeAddListener('clearBtn', 'click', () => this.clearWorkspace());
        this.safeAddListener('selectAllBtn', 'click', () => this.selectAll());
        this.safeAddListener('deselectAllBtn', 'click', () => this.deselectAll());
        this.safeAddListener('sortByNumberBtn', 'click', () => this.sortByNumber());
        this.safeAddListener('deleteSelectedBtn', 'click', () => this.deleteSelectedPages());
        this.safeAddListener('rotateSelectedBtn', 'click', () => this.rotateSelectedPages(90));
        this.safeAddListener('duplicateSelectedBtn', 'click', () => this.duplicateSelected());
        this.safeAddListener('saveBtn', 'click', () => this.createPdf());
        
        // Grid Interaction
        this.pageGrid.addEventListener('click', this.handlePageClick.bind(this));
        this.pageGrid.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.page-item');
            if (item) this.openPageEditor(item.dataset.id);
        });

        // Drag & Drop Files
        ['startDropZone', 'main-view'].forEach(id => {
            const zone = document.getElementById(id);
            if(zone) {
                zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
                zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
                zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); this.addFiles(Array.from(e.dataTransfer.files)); });
            }
        });
    }

    // --- UX UTILITIES ---
    showToast(message, type='success') {
        const container = document.getElementById('toast-container');
        if(!container) return;
        const el = document.createElement('div');
        const color = type === 'error' ? 'bg-red-500' : 'bg-indigo-600';
        el.className = `${color} text-white px-4 py-3 rounded-lg shadow-lg transform transition-all duration-300 translate-y-10 opacity-0 flex items-center gap-2`;
        el.innerHTML = `<span>${type==='error'?'⚠️':'✓'}</span><span>${message}</span>`;
        container.appendChild(el);
        requestAnimationFrame(() => el.classList.remove('translate-y-10', 'opacity-0'));
        setTimeout(() => {
            el.classList.add('translate-y-10', 'opacity-0');
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    toggleSidebar(show) { 
        document.querySelector('.app-container').classList.toggle('sidebar-mobile-open', show); 
        const overlay = document.getElementById('sidebar-overlay');
        const sidebar = document.getElementById('sidebar');
        if(overlay) overlay.classList.toggle('hidden', !show); 
        if(sidebar) {
            if(show) sidebar.classList.remove('-translate-x-full'); 
            else sidebar.classList.add('-translate-x-full'); 
        }
    }

    checkTheme() { if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark'); }

    // --- FILE HANDLING ---
    async addFiles(files) {
        if (files.length === 0) return;
        this.saveState();
        this.showLoader(true, 'Processing Files...');

        if (this.pages.length === 0) {
            document.getElementById('start-screen').classList.add('hidden');
            document.querySelector('.app-container').classList.remove('hidden');
        }

        for (const file of files) {
            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const sourceFile = { id: fileId, name: file.name, type: file.type, file: file };
            
            if (file.type.startsWith('image/')) {
                this.sourceFiles.push(sourceFile);
                this.addPageToData(sourceFile, 0, 'image');
            } 
            else if (file.type === 'application/pdf') {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    sourceFile.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    sourceFile.pdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer); 
                    this.sourceFiles.push(sourceFile);
                    for (let i = 0; i < sourceFile.pdfDoc.numPages; i++) {
                        this.addPageToData(sourceFile, i, 'pdf');
                    }
                } catch (err) { console.error(err); this.showToast(`Error loading ${file.name}`, 'error'); }
            }
        }
        this.updateSourceFileList();
        this.renderNewPages();
        this.updateStatus();
        this.showLoader(false);
    }

    addPageToData(sourceFile, index, type) {
        this.pages.push({
            id: `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            sourceFile: sourceFile, sourcePageIndex: index, type: type, rotation: 0, textOverlays: []
        });
    }

    insertBlankPage() {
        this.saveState();
        let blankSource = this.sourceFiles.find(f => f.id === 'virtual_blank');
        if (!blankSource) {
            blankSource = { id: 'virtual_blank', name: 'Blank Page', type: 'blank' };
            this.sourceFiles.push(blankSource);
        }
        this.addPageToData(blankSource, 0, 'blank');
        this.renderNewPages();
        this.updateStatus();
    }

    updateSourceFileList() {
        const el = document.getElementById('sourceFileList');
        if(!el) return;
        const used = new Set(this.pages.map(p => p.sourceFile.id));
        const files = this.sourceFiles.filter(f => used.has(f.id) || f.type === 'blank');
        el.innerHTML = files.map(f => `<div class="p-2 text-xs bg-slate-100 dark:bg-slate-700 rounded mb-1 truncate shadow-sm border border-slate-200 dark:border-slate-600">${f.name}</div>`).join('');
    }

    // --- LAZY LOADING & RENDERING ---
    initIntersectionObserver() {
        const container = document.getElementById('page-grid-container');
        if(!container) return;
        const options = { root: container, rootMargin: '300px', threshold: 0 };
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.observer.unobserve(entry.target);
                    const p = this.pages.find(page => page.id === entry.target.dataset.id);
                    if(p) this.actuallyDrawCanvas(entry.target, p);
                }
            });
        }, options);
    }

    renderAllPages() { 
        this.pageGrid.innerHTML = ''; 
        this.pages.forEach((p, i) => this.renderThumbnail(p, i)); 
    }

    renderNewPages() {
        const existingIds = new Set([...this.pageGrid.children].map(el => el.dataset.id));
        this.pages.forEach((p, i) => {
            if (!existingIds.has(p.id)) this.renderThumbnail(p, i);
        });
    }

    async renderThumbnail(pageData, index) {
        const item = document.createElement('div');
        item.className = 'page-item group relative cursor-pointer rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col h-full';
        item.dataset.id = pageData.id;
        
        const hasText = pageData.textOverlays && pageData.textOverlays.length > 0;
        const badgeHtml = hasText ? '<div class="absolute top-2 right-2 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10">T</div>' : '';

        item.innerHTML = `
            <div class="absolute top-2 left-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity page-checkbox-wrapper"><input type="checkbox" class="page-checkbox w-5 h-5 cursor-pointer accent-indigo-600 rounded"></div>
            ${badgeHtml}
            <div class="canvas-wrapper flex-1 bg-slate-50 dark:bg-slate-900/50 relative overflow-hidden flex items-center justify-center p-2">
                <!-- Skeleton Loader -->
                <div class="skeleton-shimmer w-full h-full absolute inset-0 z-0"></div>
                <div class="relative shadow-sm bg-white z-10 opacity-0 transition-opacity duration-300 w-full h-full flex items-center justify-center" id="cv-cont-${pageData.id}">
                    <canvas class="page-canvas max-w-full max-h-full object-contain block"></canvas>
                </div>
            </div>
            <div class="page-info px-3 py-2 bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 text-xs flex justify-between items-center h-10">
                <div class="flex flex-col min-w-0">
                    <span class="font-medium text-slate-700 dark:text-slate-200 truncate" title="${pageData.sourceFile.name}">${pageData.sourceFile.name}</span>
                    <span class="text-[10px] text-slate-400">Page ${pageData.sourcePageIndex + 1}</span>
                </div>
                <div class="page-actions flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="rotate-ccw-btn hover:text-indigo-600 text-slate-400">↶</button>
                    <input type="number" class="page-order-input w-6 text-center bg-transparent font-bold text-slate-500" value="${index + 1}">
                    <button class="rotate-cw-btn hover:text-indigo-600 text-slate-400">↷</button>
                </div>
            </div>
        `;
        
        item.querySelector('.page-checkbox').addEventListener('click', (e) => { e.stopPropagation(); this.toggleSelection(pageData.id); });
        item.querySelector('input').addEventListener('click', e => e.stopPropagation());

        this.pageGrid.appendChild(item);
        
        // Lazy Load
        this.observer.observe(item);
    }

    async actuallyDrawCanvas(item, pageData) {
        const canvas = item.querySelector('canvas');
        const container = item.querySelector(`#cv-cont-${pageData.id}`);
        const skeleton = item.querySelector('.skeleton-shimmer');
        const dpr = window.devicePixelRatio || 1;

        if (pageData.type === 'blank') {
            canvas.width = 150 * dpr; canvas.height = 200 * dpr;
            const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,150,200); ctx.strokeStyle='#e2e8f0'; ctx.strokeRect(0,0,150,200);
        } else if (pageData.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(pageData.sourceFile.file);
            img.onload = () => {
                const ratio = img.height / img.width;
                canvas.width = 200 * dpr; canvas.height = 200 * ratio * dpr;
                const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
                // Simple logic for thumb, advanced rotation in editor
                ctx.translate(100, 100 * ratio);
                ctx.rotate((pageData.rotation * Math.PI) / 180);
                if(pageData.rotation % 180 !== 0) ctx.drawImage(img, -100 * ratio, -100, 200 * ratio, 200);
                else ctx.drawImage(img, -100, -100 * ratio, 200, 200 * ratio);
            };
        } else {
            try {
                const page = await pageData.sourceFile.pdfDoc.getPage(pageData.sourcePageIndex + 1);
                // Render small thumbnail
                const viewport = page.getViewport({ scale: (250 / page.getViewport({ scale: 1 }).width) * dpr, rotation: pageData.rotation });
                canvas.width = viewport.width; canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            } catch(e) {}
        }
        
        if(skeleton) skeleton.remove();
        container.classList.remove('opacity-0');
    }

    // --- MARQUEE SELECTION ---
    initMarqueeSelection() {
        const container = document.getElementById('page-grid-container');
        if(!container) return;
        let isSelecting = false;
        let startX, startY;
        let marquee = null;

        container.addEventListener('mousedown', e => {
            if(e.target !== container && e.target !== document.getElementById('page-grid')) return;
            isSelecting = true;
            const rect = container.getBoundingClientRect();
            startX = e.clientX - rect.left + container.scrollLeft;
            startY = e.clientY - rect.top + container.scrollTop;
            
            marquee = document.createElement('div');
            marquee.className = 'marquee-box';
            marquee.style.left = startX + 'px'; marquee.style.top = startY + 'px';
            container.appendChild(marquee);
            
            if(!e.ctrlKey && !e.shiftKey) { this.selectedPageIds.clear(); this.updateSelectionUI(); }
        });

        container.addEventListener('mousemove', e => {
            if(!isSelecting) return;
            const rect = container.getBoundingClientRect();
            const currentX = e.clientX - rect.left + container.scrollLeft;
            const currentY = e.clientY - rect.top + container.scrollTop;
            
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            const left = Math.min(currentX, startX);
            const top = Math.min(currentY, startY);
            
            marquee.style.width = width + 'px'; marquee.style.height = height + 'px';
            marquee.style.left = left + 'px'; marquee.style.top = top + 'px';
        });

        document.addEventListener('mouseup', e => {
            if(!isSelecting) return;
            isSelecting = false;
            // Intersection Logic
            if(marquee) {
                const marqueeRect = marquee.getBoundingClientRect();
                document.querySelectorAll('.page-item').forEach(item => {
                    const itemRect = item.getBoundingClientRect();
                    if (marqueeRect.left < itemRect.right && marqueeRect.right > itemRect.left && marqueeRect.top < itemRect.bottom && marqueeRect.bottom > itemRect.top) {
                        this.selectedPageIds.add(item.dataset.id);
                    }
                });
                marquee.remove();
            }
            this.updateSelectionUI();
        });
    }

    // --- EDITOR LOGIC ---
    async openPageEditor(pageId) {
        const page = this.pages.find(p => p.id === pageId);
        if(!page) return;
        this.editingPageId = pageId;
        // Deep copy overlays to temp state
        this.tempTextOverlays = JSON.parse(JSON.stringify(page.textOverlays || []));
        this.tempRotation = page.rotation;
        this.activeTextIndex = -1;
        
        document.getElementById('editor-page-info').innerText = `${page.sourceFile.name} (Page ${page.sourcePageIndex + 1})`;
        this.textModal.classList.remove('hidden', 'opacity-0');
        this.textModal.querySelector('div').classList.remove('scale-95');
        
        await this.renderEditorCanvas();
        this.renderOverlayLayers();
    }

    async renderEditorCanvas() {
        const page = this.pages.find(p => p.id === this.editingPageId);
        const canvas = document.getElementById('modal-bg-canvas');
        const ctx = canvas.getContext('2d');
        const containerHeight = 600; 
        const dpr = window.devicePixelRatio || 1;
        
        canvas.style.transform = `rotate(${this.tempRotation}deg)`;
        
        if (page.type === 'blank') {
            canvas.width = 420 * dpr; canvas.height = 600 * dpr;
            canvas.style.width = "420px"; canvas.style.height = "600px";
            ctx.scale(dpr, dpr); ctx.fillStyle = 'white'; ctx.fillRect(0,0,420,600);
        } else if (page.type === 'image') {
            const img = new Image(); img.src = URL.createObjectURL(page.sourceFile.file);
            await new Promise(r => img.onload = r);
            const ratio = img.height / img.width;
            canvas.width = (containerHeight / ratio) * dpr; canvas.height = containerHeight * dpr;
            canvas.style.width = `${containerHeight / ratio}px`; canvas.style.height = `${containerHeight}px`;
            ctx.scale(dpr, dpr); ctx.drawImage(img, 0, 0, containerHeight / ratio, containerHeight);
        } else {
            const pdfPage = await page.sourceFile.pdfDoc.getPage(page.sourcePageIndex + 1);
            const viewport = pdfPage.getViewport({ scale: 2 }); // Base high res scale
            const scaleFactor = containerHeight / viewport.height;
            
            canvas.width = viewport.width * scaleFactor * dpr; canvas.height = containerHeight * dpr;
            canvas.style.width = `${viewport.width * scaleFactor}px`; canvas.style.height = `${containerHeight}px`;
            
            const renderViewport = pdfPage.getViewport({ scale: 2 * scaleFactor * dpr });
            await pdfPage.render({ canvasContext: ctx, viewport: renderViewport }).promise;
        }
    }

    renderOverlayLayers() {
        const container = document.getElementById('overlay-container');
        const canvas = document.getElementById('modal-bg-canvas');
        container.innerHTML = '';
        
        const w = parseFloat(canvas.style.width);
        const h = parseFloat(canvas.style.height);
        container.style.width = `${w}px`; container.style.height = `${h}px`;
        container.style.transform = `rotate(${this.tempRotation}deg)`;
        container.style.margin = 'auto'; container.style.position = 'absolute'; container.style.left='0'; container.style.right='0'; container.style.top='0'; container.style.bottom='0';

        this.tempTextOverlays.forEach((txt, index) => {
            const el = document.createElement('div');
            el.className = 'draggable-text';
            if(index === this.activeTextIndex) el.classList.add('active');
            el.innerText = txt.text;
            el.style.left = `${txt.xPercent}%`; el.style.top = `${txt.yPercent}%`;
            el.style.fontSize = `${txt.size}px`; el.style.color = txt.color; el.style.opacity = txt.opacity;
            el.style.transform = `translate(-50%, -50%) rotate(${txt.rotation}deg)`;
            el.style.fontFamily = txt.font === 'TimesRoman' ? 'serif' : (txt.font === 'Courier' ? 'monospace' : 'sans-serif');

            el.addEventListener('mousedown', e => { e.stopPropagation(); this.setActiveLayer(index); this.startDrag(e, index, container); });
            container.appendChild(el);
        });
        
        const controls = document.getElementById('layer-controls');
        if(controls) {
            if(this.activeTextIndex > -1) {
                controls.classList.remove('hidden', 'opacity-50', 'pointer-events-none');
                const l = this.tempTextOverlays[this.activeTextIndex];
                document.getElementById('txt-content').value = l.text;
                document.getElementById('txt-size').value = l.size;
                document.getElementById('txt-color').value = l.color;
                document.getElementById('txt-font').value = l.font;
                document.getElementById('txt-rotation').value = l.rotation;
                const opInput = document.getElementById('txt-opacity');
                if(opInput) opInput.value = l.opacity;
            } else {
                controls.classList.add('opacity-50', 'pointer-events-none');
            }
        }
    }

    addTextLayerToEditor() {
        const textInput = document.getElementById('txt-content');
        const text = textInput ? textInput.value : "New Text";
        if(!text) return;
        
        this.tempTextOverlays.push({ text, xPercent: 50, yPercent: 50, size: 24, color: '#000000', opacity: 1, rotation: 0, font: 'Helvetica' });
        this.activeTextIndex = this.tempTextOverlays.length - 1;
        this.renderOverlayLayers();
    }

    setActiveLayer(index) { this.activeTextIndex = index; this.renderOverlayLayers(); }
    
    deleteActiveLayer() { 
        if(this.activeTextIndex > -1) { 
            this.tempTextOverlays.splice(this.activeTextIndex, 1); 
            this.activeTextIndex = -1; 
            this.renderOverlayLayers(); 
        } 
    }
    
    updateActiveTextLayer() {
        if(this.activeTextIndex === -1) return;
        const l = this.tempTextOverlays[this.activeTextIndex];
        const content = document.getElementById('txt-content'); if(content) l.text = content.value;
        const size = document.getElementById('txt-size'); if(size) l.size = parseInt(size.value);
        const color = document.getElementById('txt-color'); if(color) l.color = color.value;
        const font = document.getElementById('txt-font'); if(font) l.font = font.value;
        const rot = document.getElementById('txt-rotation'); if(rot) l.rotation = parseInt(rot.value);
        const op = document.getElementById('txt-opacity'); if(op) l.opacity = parseFloat(op.value);
        this.renderOverlayLayers();
    }
    
    editorRotate(deg) {
        this.tempRotation = (this.tempRotation + deg) % 360;
        this.renderEditorCanvas();
        this.renderOverlayLayers();
    }

    startDrag(e, index, container) {
        let isDragging = true;
        const rect = container.getBoundingClientRect();
        const moveHandler = (ev) => {
            if(!isDragging) return;
            const x = ev.clientX - rect.left;
            const y = ev.clientY - rect.top;
            this.tempTextOverlays[index].xPercent = Math.max(0, Math.min(100, (x / rect.width) * 100));
            this.tempTextOverlays[index].yPercent = Math.max(0, Math.min(100, (y / rect.height) * 100));
            this.renderOverlayLayers();
        };
        const upHandler = () => { isDragging = false; document.removeEventListener('mousemove', moveHandler); document.removeEventListener('mouseup', upHandler); };
        document.addEventListener('mousemove', moveHandler); document.addEventListener('mouseup', upHandler);
    }

    savePageEdits(applyToAll) {
        this.saveState();
        if(applyToAll) {
            const baseRot = this.pages.find(x => x.id === this.editingPageId).rotation;
            this.pages.forEach(p => {
                // Adjust rotation relative to current
                p.rotation = (p.rotation + this.tempRotation - baseRot) % 360;
                p.textOverlays = JSON.parse(JSON.stringify(this.tempTextOverlays)); 
            });
            this.showToast("Applied to all pages");
        } else {
            const page = this.pages.find(p => p.id === this.editingPageId);
            page.textOverlays = JSON.parse(JSON.stringify(this.tempTextOverlays));
            page.rotation = this.tempRotation;
            this.showToast("Changes saved");
        }
        this.renderAllPages();
        this.textModal.classList.add('hidden', 'opacity-0');
        this.textModal.querySelector('div').classList.add('scale-95');
    }

    // --- STANDARD INTERACTIONS ---
    initContextMenu() {
        if(!this.contextMenu) return;
        document.addEventListener('click', () => this.contextMenu.classList.add('hidden'));
        this.pageGrid.addEventListener('contextmenu', e => {
            const item = e.target.closest('.page-item'); if(!item) return;
            e.preventDefault(); 
            this.contextTargetId = item.dataset.id;
            let x = e.clientX, y = e.clientY;
            if(x + 200 > window.innerWidth) x = window.innerWidth - 210;
            if(y + 200 > window.innerHeight) y = window.innerHeight - 210;
            this.contextMenu.style.left = `${x}px`; this.contextMenu.style.top = `${y}px`;
            this.contextMenu.classList.remove('hidden');
        });
        
        this.safeAddListener('ctx-edit', 'click', () => this.openPageEditor(this.contextTargetId));
        this.safeAddListener('ctx-delete', 'click', () => this.deletePages([this.contextTargetId]));
        this.safeAddListener('ctx-duplicate', 'click', () => { 
            this.selectedPageIds.clear(); this.selectedPageIds.add(this.contextTargetId); this.duplicateSelected(); 
        });
        this.safeAddListener('ctx-rotate-cw', 'click', () => this.rotatePages([this.contextTargetId], 90));
        this.safeAddListener('ctx-rotate-ccw', 'click', () => this.rotatePages([this.contextTargetId], -90));
    }

    async restoreSession(saved) {
        this.showLoader(true, 'Restoring Session...');
        this.sourceFiles = [];
        for (const f of saved.sourceFiles) {
            const source = { id: f.id, name: f.name, type: f.type, file: f.file };
            if(f.type === 'application/pdf') {
                const ab = await f.file.arrayBuffer();
                source.pdfDoc = await pdfjsLib.getDocument({ data: ab }).promise;
                source.pdfLibDoc = await PDFLib.PDFDocument.load(ab);
            }
            this.sourceFiles.push(source);
        }
        this.pages = [];
        saved.pages.forEach(p => {
            const source = this.sourceFiles.find(s => s.id === p.sourceFileId);
            if(source) this.pages.push({ id: p.id, sourceFile: source, sourcePageIndex: p.sourcePageIndex, type: p.type, rotation: p.rotation, textOverlays: p.textOverlays });
        });
        document.getElementById('start-screen').classList.add('hidden');
        document.querySelector('.app-container').classList.remove('hidden');
        this.renderAllPages(); this.updateStatus(); this.showLoader(false);
    }

    saveState() {
        const snapshot = this.snapshotCurrentState();
        this.historyStack.push(snapshot);
        if(this.historyStack.length > this.maxHistory) this.historyStack.shift();
        this.redoStack = []; this.updateHistoryButtons();
        this.dbManager.saveState(this.sourceFiles, snapshot);
    }
    restoreState(snapshot) {
        this.pages = [];
        snapshot.forEach(item => {
            const source = this.sourceFiles.find(f => f.id === item.sourceFileId);
            if(source) this.pages.push({ id: item.id, sourceFile: source, sourcePageIndex: item.sourcePageIndex, type: item.type, rotation: item.rotation, textOverlays: item.textOverlays || [] });
        });
        this.selectedPageIds.clear(); this.renderAllPages(); this.updateStatus();
        this.dbManager.saveState(this.sourceFiles, snapshot);
    }
    performUndo() { if(this.historyStack.length) { this.redoStack.push(this.snapshotCurrentState()); this.restoreState(this.historyStack.pop()); this.updateHistoryButtons(); } }
    performRedo() { if(this.redoStack.length) { this.historyStack.push(this.snapshotCurrentState()); this.restoreState(this.redoStack.pop()); this.updateHistoryButtons(); } }
    snapshotCurrentState() { return this.pages.map(p => ({ id: p.id, sourceFileId: p.sourceFile.id, sourcePageIndex: p.sourcePageIndex, type: p.type, rotation: p.rotation, textOverlays: JSON.parse(JSON.stringify(p.textOverlays || [])) })); }
    
    updateHistoryButtons() { 
        const u = document.getElementById('undoBtn'); if(u) u.disabled = !this.historyStack.length;
        const r = document.getElementById('redoBtn'); if(r) r.disabled = !this.redoStack.length;
    }

    initSortable() { Sortable.create(this.pageGrid, { animation: 200, ghostClass: 'sortable-ghost', onStart: () => this.saveState(), onEnd: () => this.updateDataOrderFromDOM() }); }

    // --- GRID INTERACTIONS ---
    handlePageClick(e) {
        const item = e.target.closest('.page-item'); if (!item) return;
        
        // Handle Hover Buttons
        if (e.target.closest('.page-actions button')) {
            const btn = e.target.closest('button');
            const id = item.dataset.id;
            if(btn.classList.contains('rotate-cw-btn')) this.rotatePages([id], 90);
            else if(btn.classList.contains('rotate-ccw-btn')) this.rotatePages([id], -90);
            return;
        }

        const id = item.dataset.id;
        if (e.shiftKey && this.lastSelectedId) {
            const all = [...this.pageGrid.children];
            const start = all.findIndex(el => el.dataset.id === this.lastSelectedId);
            const end = all.findIndex(el => el.dataset.id === id);
            all.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(el => this.selectedPageIds.add(el.dataset.id));
        } else if (e.ctrlKey || e.metaKey) {
            this.toggleSelection(id);
        } else {
            this.selectedPageIds.clear(); this.selectedPageIds.add(id);
        }
        this.lastSelectedId = id; this.updateSelectionUI();
    }

    toggleSelection(id) { if (this.selectedPageIds.has(id)) this.selectedPageIds.delete(id); else this.selectedPageIds.add(id); this.updateSelectionUI(); }
    
    updateSelectionUI() {
        [...this.pageGrid.children].forEach(el => {
            const s = this.selectedPageIds.has(el.dataset.id);
            if(s) { el.classList.add('selected'); el.querySelector('.page-checkbox').checked = true; el.querySelector('.page-checkbox-wrapper').classList.remove('opacity-0'); }
            else { el.classList.remove('selected'); el.querySelector('.page-checkbox').checked = false; el.querySelector('.page-checkbox-wrapper').classList.add('opacity-0'); }
        });
        const cnt = document.getElementById('selection-count');
        const footer = document.getElementById('contextual-footer');
        if(cnt) cnt.innerText = `${this.selectedPageIds.size} selected`;
        if(footer) {
            if(this.selectedPageIds.size > 0) footer.classList.remove('hidden-island');
            else footer.classList.add('hidden-island');
        }
    }

    // --- ACTIONS ---
    deleteSelectedPages() { if (this.selectedPageIds.size) this.deletePages(Array.from(this.selectedPageIds)); }
    deletePages(ids) {
        this.saveState();
        this.pages = this.pages.filter(p => !ids.includes(p.id));
        this.selectedPageIds.clear(); this.renderAllPages(); this.updateStatus(); this.showToast('Pages deleted');
    }
    
    // MANUAL DUPLICATION (Prevents Circular JSON Error)
    duplicateSelected() {
        if (!this.selectedPageIds.size) return;
        this.saveState();
        const newPages = [];
        this.pages.forEach(p => {
            newPages.push(p);
            if (this.selectedPageIds.has(p.id)) {
                newPages.push({
                    id: `page_${Date.now()}_dup_${Math.random().toString(36).substr(2, 9)}`,
                    sourceFile: p.sourceFile,
                    sourcePageIndex: p.sourcePageIndex,
                    type: p.type,
                    rotation: p.rotation,
                    textOverlays: JSON.parse(JSON.stringify(p.textOverlays || []))
                });
            }
        });
        this.pages = newPages;
        this.renderAllPages();
        this.updateStatus();
        this.showToast('Pages duplicated');
    }

    rotateSelectedPages(deg) { if (this.selectedPageIds.size) this.rotatePages(Array.from(this.selectedPageIds), deg); }
    rotatePages(ids, deg) {
        this.saveState();
        ids.forEach(id => { const p = this.pages.find(x => x.id === id); if (p) p.rotation = (p.rotation + deg + 360) % 360; });
        this.renderAllPages();
        this.showToast('Pages rotated');
    }
    sortByNumber() {
        this.saveState();
        const map = new Map();
        document.querySelectorAll('.page-order-input').forEach(i => map.set(i.closest('.page-item').dataset.id, parseInt(i.value) || 9999));
        this.pages.sort((a, b) => map.get(a.id) - map.get(b.id));
        this.renderAllPages();
        this.showToast('Sorted by number');
    }
    updateDataOrderFromDOM() {
        const newPages = [];
        [...this.pageGrid.children].forEach(el => newPages.push(this.pages.find(p => p.id === el.dataset.id)));
        this.pages = newPages;
        this.renderAllPages(); // Re-render to update index numbers
    }
    selectAll() { this.pages.forEach(p => this.selectedPageIds.add(p.id)); this.updateSelectionUI(); }
    deselectAll() { this.selectedPageIds.clear(); this.updateSelectionUI(); }
    
    updateStatus() {
        this.updateSelectionUI();
        if(this.pages.length === 0) this.clearWorkspace();
    }
    async clearWorkspace() {
        this.saveState();
        this.pages = []; this.sourceFiles = []; this.selectedPageIds.clear();
        this.renderAllPages();
        document.getElementById('start-screen').classList.remove('hidden');
        document.querySelector('.app-container').classList.add('hidden');
        await this.dbManager.clear();
    }
    showLoader(show, text = 'Processing...') {
        const loader = document.getElementById('loader');
        if(loader) {
            loader.classList.toggle('hidden', !show);
            document.getElementById('loader-text').innerText = text;
        }
    }
    
    hexToRgb(hex) {
        const r = parseInt(hex.substr(1, 2), 16) / 255;
        const g = parseInt(hex.substr(3, 2), 16) / 255;
        const b = parseInt(hex.substr(5, 2), 16) / 255;
        return { r, g, b };
    }

    // --- PDF EXPORT ---
    async createPdf(preview) {
        if (!this.pages.length) return;
        this.showLoader(true, 'Generating PDF...');
        try {
            const doc = await PDFLib.PDFDocument.create();
            const fonts = {
                'Helvetica': await doc.embedFont(PDFLib.StandardFonts.Helvetica),
                'TimesRoman': await doc.embedFont(PDFLib.StandardFonts.TimesRoman),
                'Courier': await doc.embedFont(PDFLib.StandardFonts.Courier)
            };

            for (const p of this.pages) {
                let page;
                if (p.type === 'blank') page = doc.addPage([595, 842]);
                else if (p.type === 'image') {
                    const buff = await p.sourceFile.file.arrayBuffer();
                    const emb = p.sourceFile.type.includes('png') ? await doc.embedPng(buff) : await doc.embedJpg(buff);
                    const r = p.rotation % 360;
                    const isRotated = r === 90 || r === 270;
                    page = doc.addPage([isRotated ? emb.height : emb.width, isRotated ? emb.width : emb.height]);
                    
                    const opts = { x: 0, y: 0, width: emb.width, height: emb.height, rotate: PDFLib.degrees(r) };
                    if (r === 90) { opts.x = emb.height; opts.y = 0; }
                    else if (r === 180) { opts.x = emb.width; opts.y = emb.height; }
                    else if (r === 270) { opts.x = 0; opts.y = emb.width; }
                    page.drawImage(emb, opts);
                } else {
                    const [cp] = await doc.copyPages(p.sourceFile.pdfLibDoc, [p.sourcePageIndex]);
                    cp.setRotation(PDFLib.degrees((cp.getRotation().angle + p.rotation) % 360));
                    page = doc.addPage(cp);
                }

                if (p.textOverlays) {
                    const { width, height } = page.getSize();
                    p.textOverlays.forEach(t => {
                        const x = width * (t.xPercent / 100);
                        const y = height - (height * (t.yPercent / 100));
                        page.drawText(t.text, {
                            x, y, size: t.size,
                            font: fonts[t.font] || fonts['Helvetica'],
                            color: PDFLib.rgb(this.hexToRgb(t.color).r, this.hexToRgb(t.color).g, this.hexToRgb(t.color).b),
                            opacity: t.opacity || 1,
                            rotate: PDFLib.degrees(t.rotation || 0),
                            xCentered: true, yCentered: true
                        });
                    });
                }
            }

            const pdfBytes = await doc.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            if (preview) window.open(url, '_blank');
            else {
                const link = document.createElement('a');
                link.href = url;
                const nameInput = document.getElementById('filenameInput');
                link.download = (nameInput ? nameInput.value : 'document') + '.pdf';
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
                this.showToast('PDF Exported Successfully');
            }
        } catch (e) {
            console.error(e);
            this.showToast('Error: ' + e.message, 'error');
        }
        this.showLoader(false);
    }
}

document.addEventListener('DOMContentLoaded', () => new VisualPDFTool());
