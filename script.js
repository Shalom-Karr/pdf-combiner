// Point to the LOCAL worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.min.js';

/**
 * INDEXED DB MANAGER
 * Handles saving/loading large binary files locally
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
        
        // Prepare data for storage (convert files to simple objects + blobs)
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
 * MAIN APP
 */
class VisualPDFTool {
    constructor() {
        this.sourceFiles = [];
        this.pages = []; 
        this.selectedPageIds = new Set();
        this.historyStack = [];
        this.redoStack = [];
        this.maxHistory = 20;
        this.observer = null; // Lazy load observer
        this.contextTargetId = null;

        this.dbManager = new LocalStorageManager();

        // UI Refs
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

    async init() {
        this.initSortable();
        this.initEventListeners();
        this.initIntersectionObserver();
        this.initContextMenu();
        this.checkTheme();
        document.documentElement.style.setProperty('--grid-size', '180px');
        
        // Check for saved work
        try {
            await this.dbManager.init();
            const saved = await this.dbManager.loadState();
            if(saved && saved.pages.length > 0) {
                const banner = document.getElementById('restore-banner');
                banner.classList.remove('hidden');
                document.getElementById('restoreBtn').addEventListener('click', () => this.restoreSession(saved));
            }
        } catch(e) { console.log("DB Error", e); }
    }

    // --- LAZY LOADING ---
    initIntersectionObserver() {
        const options = { root: this.pageGrid.parentElement, rootMargin: '300px', threshold: 0 };
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const item = entry.target;
                    this.observer.unobserve(item);
                    const pageId = item.dataset.id;
                    const pageData = this.pages.find(p => p.id === pageId);
                    if(pageData) this.actuallyDrawCanvas(item, pageData);
                }
            });
        }, options);
    }

    // --- CONTEXT MENU ---
    initContextMenu() {
        document.addEventListener('click', () => this.contextMenu.classList.add('hidden'));
        this.pageGrid.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.page-item');
            if (!item) return;
            e.preventDefault();
            this.contextTargetId = item.dataset.id;
            // Adjust position if close to edge
            let x = e.clientX; let y = e.clientY;
            if(x + 200 > window.innerWidth) x = window.innerWidth - 210;
            if(y + 200 > window.innerHeight) y = window.innerHeight - 210;
            this.contextMenu.style.left = `${x}px`;
            this.contextMenu.style.top = `${y}px`;
            this.contextMenu.classList.remove('hidden');
        });

        document.getElementById('ctx-delete').addEventListener('click', () => { if(this.contextTargetId) this.deletePages([this.contextTargetId]); });
        document.getElementById('ctx-duplicate').addEventListener('click', () => { 
            if(this.contextTargetId) {
                this.selectedPageIds.clear(); this.selectedPageIds.add(this.contextTargetId);
                this.duplicateSelected();
            }
        });
        document.getElementById('ctx-rotate-cw').addEventListener('click', () => { if(this.contextTargetId) this.rotatePages([this.contextTargetId], 90); });
        document.getElementById('ctx-rotate-ccw').addEventListener('click', () => { if(this.contextTargetId) this.rotatePages([this.contextTargetId], -90); });
    }

    // --- SESSION RESTORE ---
    async restoreSession(saved) {
        this.showLoader(true, 'Restoring Session...');
        // Restore source files
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
        
        // Restore pages
        this.pages = [];
        saved.pages.forEach(p => {
            const source = this.sourceFiles.find(s => s.id === p.sourceFileId);
            if(source) {
                this.pages.push({
                    id: p.id, sourceFile: source, sourcePageIndex: p.sourcePageIndex,
                    type: p.type, rotation: p.rotation, textOverlays: p.textOverlays
                });
            }
        });
        
        this.startScreen.classList.add('hidden');
        this.appContainer.classList.remove('hidden');
        this.renderAllPages();
        this.updateStatus();
        this.showLoader(false);
    }

    // --- HISTORY ---
    saveState() {
        const stateSnapshot = this.pages.map(page => ({
            id: page.id,
            sourceFileId: page.sourceFile.id,
            sourcePageIndex: page.sourcePageIndex,
            type: page.type,
            rotation: page.rotation,
            textOverlays: page.textOverlays ? JSON.parse(JSON.stringify(page.textOverlays)) : []
        }));
        this.historyStack.push(stateSnapshot);
        if (this.historyStack.length > this.maxHistory) this.historyStack.shift();
        this.redoStack = [];
        this.updateHistoryButtons();
        
        // Auto-Save to DB
        this.dbManager.saveState(this.sourceFiles, stateSnapshot);
    }

    restoreState(stateSnapshot) {
        const newPages = [];
        for (const item of stateSnapshot) {
            const sourceFile = this.sourceFiles.find(f => f.id === item.sourceFileId);
            if (sourceFile) {
                newPages.push({
                    id: item.id,
                    sourceFile: sourceFile, 
                    sourcePageIndex: item.sourcePageIndex,
                    type: item.type,
                    rotation: item.rotation,
                    textOverlays: item.textOverlays || []
                });
            }
        }
        this.pages = newPages;
        this.selectedPageIds.clear();
        this.renderAllPages(); 
        this.updateStatus();
        
        // Sync DB
        this.dbManager.saveState(this.sourceFiles, stateSnapshot);
    }

    performUndo() {
        if (this.historyStack.length === 0) return;
        this.redoStack.push(this.snapshotCurrentState());
        this.restoreState(this.historyStack.pop());
        this.updateHistoryButtons();
    }

    performRedo() {
        if (this.redoStack.length === 0) return;
        this.historyStack.push(this.snapshotCurrentState());
        this.restoreState(this.redoStack.pop());
        this.updateHistoryButtons();
    }

    snapshotCurrentState() {
        return this.pages.map(p => ({
            id: p.id, sourceFileId: p.sourceFile.id, sourcePageIndex: p.sourcePageIndex, 
            type: p.type, rotation: p.rotation, textOverlays: p.textOverlays ? JSON.parse(JSON.stringify(p.textOverlays)) : []
        }));
    }

    updateHistoryButtons() {
        this.undoBtn.disabled = this.historyStack.length === 0;
        this.redoBtn.disabled = this.redoStack.length === 0;
    }

    // --- SETUP ---
    initSortable() {
        Sortable.create(this.pageGrid, { animation: 200, ghostClass: 'sortable-ghost', onStart: () => this.saveState(), onEnd: () => this.updateDataOrderFromDOM() });
    }

    initEventListeners() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.performUndo(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.performRedo(); }
            if ((e.key === 'Delete' || e.key === 'Backspace') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) this.deleteSelectedPages();
        });
        window.addEventListener('beforeunload', (e) => { if (this.pages.length > 0) { e.preventDefault(); e.returnValue = ''; } });
        
        this.undoBtn.addEventListener('click', () => this.performUndo());
        this.redoBtn.addEventListener('click', () => this.performRedo());
        document.getElementById('zoomSlider').addEventListener('input', (e) => document.documentElement.style.setProperty('--grid-size', `${e.target.value}px`));
        document.getElementById('darkModeToggle').addEventListener('click', () => document.documentElement.classList.toggle('dark'));
        document.getElementById('helpBtn').addEventListener('click', () => alert("⌨️ Shortcuts:\n• Ctrl/Shift + Click: Select\n• Drag: Reorder\n• Delete: Remove\n• Right Click: Menu"));

        // Files
        document.getElementById('filenameInput').addEventListener('input', (e) => e.target.value = e.target.value.replace(/[^a-zA-Z0-9-_ ]/g, ''));
        document.getElementById('startChooseFileBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('addFilesBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileSelect(e));
        
        // Sidebar
        document.getElementById('sidebar-close-btn').addEventListener('click', () => this.toggleSidebar(false));
        document.getElementById('menu-toggle-btn').addEventListener('click', () => this.toggleSidebar(true));
        document.getElementById('selectRangeBtn').addEventListener('click', () => this.selectByRange());
        document.getElementById('insertBlankBtn').addEventListener('click', () => this.insertBlankPage());
        
        // Text Modal
        document.getElementById('openTextModalBtn').addEventListener('click', () => this.openTextModal());
        document.querySelector('.close-text-modal').addEventListener('click', () => this.textModal.classList.add('hidden'));
        
        // Text Controls
        ['txt-content', 'txt-size', 'txt-color', 'txt-opacity', 'txt-rotation', 'txt-font'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.updateTextPreviewLayer());
        });
        
        // Position Buttons (Clean UI + Updates Logic)
        document.querySelectorAll('.pos-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.pos-btn').forEach(b => {
                    b.classList.remove('bg-indigo-100', 'border-indigo-500', 'text-indigo-700', 'dark:bg-indigo-900', 'dark:text-indigo-200');
                    b.classList.add('hover:bg-indigo-50', 'dark:hover:bg-slate-600');
                });
                e.target.classList.add('bg-indigo-100', 'border-indigo-500', 'text-indigo-700', 'dark:bg-indigo-900', 'dark:text-indigo-200');
                e.target.classList.remove('hover:bg-indigo-50', 'dark:hover:bg-slate-600');
                
                const pos = e.target.dataset.pos;
                // Update internal percent values based on preset
                if(pos === 'top-left') { this.setPos(10, 10); }
                else if(pos === 'top-center') { this.setPos(50, 10); }
                else if(pos === 'top-right') { this.setPos(90, 10); }
                else if(pos === 'bottom-left') { this.setPos(10, 90); }
                else if(pos === 'bottom-center') { this.setPos(50, 90); }
                else if(pos === 'bottom-right') { this.setPos(90, 90); }
                
                this.updateTextPreviewLayer();
            });
        });
        
        // Apply Buttons
        document.getElementById('applyTextSelected').addEventListener('click', () => this.applyTextToPages(true));
        document.getElementById('applyTextAll').addEventListener('click', () => this.applyTextToPages(false));

        // Draggable Logic
        this.setupDraggableText();

        // Footer Actions
        document.getElementById('clearBtn').addEventListener('click', () => this.clearWorkspace());
        document.getElementById('selectAllBtn').addEventListener('click', () => this.selectAll());
        document.getElementById('deselectAllBtn').addEventListener('click', () => this.deselectAll());
        document.getElementById('sortByNumberBtn').addEventListener('click', () => this.sortByNumber());
        document.getElementById('deleteSelectedBtn').addEventListener('click', () => this.deleteSelectedPages());
        document.getElementById('rotateSelectedBtn').addEventListener('click', () => this.rotateSelectedPages(90));
        document.getElementById('duplicateSelectedBtn').addEventListener('click', () => this.duplicateSelected());
        document.getElementById('saveBtn').addEventListener('click', () => this.createPdf());
        document.getElementById('previewBtn').addEventListener('click', (e) => { e.preventDefault(); this.createPdf(true); });
        
        // Toggles
        document.getElementById('exportDropdownToggle').addEventListener('click', () => document.getElementById('exportDropdownMenu').classList.toggle('hidden'));
        document.addEventListener('click', (e) => {
            if (!document.getElementById('exportDropdownToggle').contains(e.target)) document.getElementById('exportDropdownMenu').classList.add('hidden');
        });

        // Grid
        this.pageGrid.addEventListener('click', this.handlePageClick.bind(this));
        this.pageGrid.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.page-item');
            if (item) this.openPreviewModal(item.dataset.id);
        });
        document.querySelector('.close-modal-btn').addEventListener('click', () => document.getElementById('preview-modal').classList.add('hidden'));

        // Drag Drop
        ['startDropZone', 'main-view'].forEach(id => {
            const zone = document.getElementById(id);
            zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
            zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
            zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); this.addFiles(Array.from(e.dataTransfer.files)); });
        });
    }
    
    setPos(x, y) {
        document.getElementById('txt-x-percent').value = x;
        document.getElementById('txt-y-percent').value = y;
    }

    // --- LOGIC ---
    async handleFileSelect(e) {
        await this.addFiles(Array.from(e.target.files));
        e.target.value = ''; 
    }

    async addFiles(files) {
        if (files.length === 0) return;
        this.saveState();
        this.showLoader(true);
        if (this.pages.length === 0) {
            this.startScreen.classList.add('hidden');
            this.appContainer.classList.remove('hidden');
        }
        for (const file of files) {
            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const sourceFile = { id: fileId, name: file.name, file: file, type: file.type };
            if (file.type.startsWith('image/')) {
                this.sourceFiles.push(sourceFile);
                this.addPageToData(sourceFile, 0, 'image');
            } else if (file.type === 'application/pdf') {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    sourceFile.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    sourceFile.pdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer); 
                    this.sourceFiles.push(sourceFile);
                    for (let i = 0; i < sourceFile.pdfDoc.numPages; i++) {
                        this.addPageToData(sourceFile, i, 'pdf');
                    }
                } catch (err) { console.error(err); alert(`Error loading ${file.name}`); }
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

    // --- TEXT MODAL & DRAG PREVIEW ---
    async openTextModal() {
        if(this.pages.length === 0) { alert("Add a page first."); return; }
        this.textModal.classList.remove('hidden');
        
        // Determine context page
        let contextPage = this.pages[0];
        if(this.selectedPageIds.size > 0) {
            const firstId = this.selectedPageIds.values().next().value;
            contextPage = this.pages.find(p => p.id === firstId);
        }

        // Render page background
        const canvas = document.getElementById('modal-bg-canvas');
        const ctx = canvas.getContext('2d');
        const containerHeight = 600; 
        
        if (contextPage.type === 'blank') {
            canvas.width = 420; canvas.height = 600;
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,420,600); ctx.strokeStyle = '#ccc'; ctx.strokeRect(0,0,420,600);
        } else if (contextPage.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(contextPage.sourceFile.file);
            img.onload = () => {
                const ratio = img.height / img.width;
                canvas.height = containerHeight; canvas.width = containerHeight / ratio;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
        } else {
            const page = await contextPage.sourceFile.pdfDoc.getPage(contextPage.sourcePageIndex + 1);
            const viewport = page.getViewport({ scale: 1 });
            const scale = containerHeight / viewport.height;
            const scaledViewport = page.getViewport({ scale });
            canvas.height = scaledViewport.height; canvas.width = scaledViewport.width;
            await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
        }

        // Default to center if not set
        document.getElementById('txt-x-percent').value = 50;
        document.getElementById('txt-y-percent').value = 10;
        this.updateTextPreviewLayer();
    }

    setupDraggableText() {
        const textLayer = document.getElementById('preview-text-layer');
        const container = document.getElementById('preview-wrapper');
        let isDragging = false;

        textLayer.addEventListener('mousedown', (e) => { isDragging = true; e.preventDefault(); });
        document.addEventListener('mouseup', () => { isDragging = false; });
        
        container.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const rect = container.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            
            x = Math.max(0, Math.min(x, rect.width));
            y = Math.max(0, Math.min(y, rect.height));

            const xPercent = (x / rect.width) * 100;
            const yPercent = (y / rect.height) * 100;

            document.getElementById('txt-x-percent').value = xPercent;
            document.getElementById('txt-y-percent').value = yPercent;
            this.updateTextPreviewLayer();
        });
    }

    updateTextPreviewLayer() {
        const text = document.getElementById('txt-content').value || 'Type here...';
        const size = document.getElementById('txt-size').value;
        const color = document.getElementById('txt-color').value;
        const opacity = document.getElementById('txt-opacity').value;
        const rotation = document.getElementById('txt-rotation').value;
        const font = document.getElementById('txt-font').value;
        const xP = document.getElementById('txt-x-percent').value;
        const yP = document.getElementById('txt-y-percent').value;
        
        const preview = document.getElementById('preview-text-layer');
        preview.innerText = text;
        preview.style.fontSize = `${size}px`;
        preview.style.color = color;
        preview.style.opacity = opacity;
        
        // Font
        if(font === 'TimesRoman') preview.style.fontFamily = '"Times New Roman", serif';
        else if(font === 'Courier') preview.style.fontFamily = '"Courier New", monospace';
        else preview.style.fontFamily = 'Helvetica, Arial, sans-serif';
        
        // Transform: Center the text point
        preview.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
        preview.style.left = `${xP}%`;
        preview.style.top = `${yP}%`;
    }

    applyTextToPages(onlySelected) {
        const text = document.getElementById('txt-content').value;
        if (!text) { alert("Please enter text."); return; }
        
        const size = parseInt(document.getElementById('txt-size').value);
        const color = document.getElementById('txt-color').value;
        const opacity = parseFloat(document.getElementById('txt-opacity').value);
        const rotation = parseInt(document.getElementById('txt-rotation').value);
        const font = document.getElementById('txt-font').value;
        const xPercent = parseFloat(document.getElementById('txt-x-percent').value);
        const yPercent = parseFloat(document.getElementById('txt-y-percent').value);

        this.saveState();
        const targets = onlySelected ? this.pages.filter(p => this.selectedPageIds.has(p.id)) : this.pages;
        if (onlySelected && targets.length === 0) { alert("No pages selected."); return; }

        targets.forEach(page => {
            if (!page.textOverlays) page.textOverlays = [];
            page.textOverlays.push({ text, xPercent, yPercent, size, color, opacity, rotation, font });
            
            const el = this.pageGrid.querySelector(`.page-item[data-id="${page.id}"]`);
            if(el && !el.querySelector('.text-badge')) {
                const badge = document.createElement('div');
                badge.className = 'text-badge absolute top-3 right-10 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10';
                badge.innerText = 'T';
                el.appendChild(badge);
            }
        });
        this.textModal.classList.add('hidden');
        document.getElementById('txt-content').value = '';
    }

    // --- RENDERING ---
    renderAllPages() { this.pageGrid.innerHTML = ''; this.pages.forEach((p, i) => this.renderThumbnail(p, i)); }
    renderNewPages() {
        const existing = new Set([...this.pageGrid.children].map(el => el.dataset.id));
        this.pages.forEach((p, i) => { if(!existing.has(p.id)) this.renderThumbnail(p, i); });
    }

    async renderThumbnail(pageData, index) {
        const item = document.createElement('div');
        item.className = 'page-item group relative cursor-pointer rounded-xl bg-white dark:bg-slate-700 shadow-sm ring-1 ring-slate-200 dark:ring-slate-600 hover:-translate-y-1 hover:shadow-lg transition-all duration-200 overflow-hidden flex flex-col';
        item.dataset.id = pageData.id;
        
        const hasText = pageData.textOverlays && pageData.textOverlays.length > 0;
        const badgeHtml = hasText ? '<div class="text-badge absolute top-3 right-10 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10">T</div>' : '';

        item.innerHTML = `
            <div class="absolute top-3 left-3 z-20 opacity-0 group-hover:opacity-100 transition-opacity page-checkbox-wrapper">
                <div class="bg-white dark:bg-slate-800 rounded-md shadow-sm p-1">
                    <input type="checkbox" class="page-checkbox w-5 h-5 cursor-pointer accent-indigo-600 rounded">
                </div>
            </div>
            <div class="absolute top-3 right-3 z-20 opacity-0 group-hover:opacity-100 transition-opacity transform scale-90 hover:scale-105">
                <button class="delete-page-btn w-7 h-7 bg-white dark:bg-slate-800 text-slate-400 hover:text-red-500 rounded-full flex items-center justify-center shadow-md transition-colors border border-slate-100 dark:border-slate-600">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
            ${badgeHtml}
            <div class="flex-1 bg-slate-100 dark:bg-slate-800/50 relative overflow-hidden flex items-center justify-center p-4">
                <div class="relative shadow-md bg-white min-w-[100px] min-h-[140px] flex items-center justify-center">
                    <canvas class="page-canvas max-w-full max-h-[240px] object-contain block"></canvas>
                    <div class="loading-indicator text-slate-300">
                        <svg class="animate-spin h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    </div>
                </div>
            </div>
            <div class="px-3 py-2 bg-white dark:bg-slate-700 border-t border-slate-100 dark:border-slate-600 text-xs flex justify-between items-center h-11">
                <div class="flex flex-col min-w-0">
                    <span class="font-medium text-slate-700 dark:text-slate-200 truncate" title="${pageData.sourceFile.name}">${pageData.sourceFile.name}</span>
                    <span class="text-[10px] text-slate-400">Page ${pageData.sourcePageIndex + 1}</span>
                </div>
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-100 dark:bg-slate-600 rounded-lg p-1 ml-2">
                    <button class="rotate-ccw-btn w-6 h-6 flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:bg-white dark:hover:bg-slate-500 rounded transition-colors">↶</button>
                    <input type="number" class="page-order-input w-6 text-center bg-transparent text-slate-600 dark:text-slate-300 font-bold focus:outline-none appearance-none m-0" value="${index + 1}">
                    <button class="rotate-cw-btn w-6 h-6 flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:bg-white dark:hover:bg-slate-500 rounded transition-colors">↷</button>
                </div>
            </div>
        `;
        
        item.querySelector('.page-checkbox').addEventListener('click', (e) => { e.stopPropagation(); this.toggleSelection(pageData.id); });
        item.querySelector('input[type="number"]').addEventListener('click', e => e.stopPropagation());
        this.pageGrid.appendChild(item);
        
        // Lazy Load this item
        this.observer.observe(item);
    }
    
    // Actually draw the canvas when visible
    async actuallyDrawCanvas(item, pageData) {
        const canvas = item.querySelector('canvas');
        const loader = item.querySelector('.loading-indicator');
        
        if (pageData.type === 'blank') {
            canvas.width = 200; canvas.height = 280;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,200,280); ctx.strokeRect(0,0,200,280);
        } else if (pageData.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(pageData.sourceFile.file);
            img.onload = () => {
                const aspect = img.height / img.width;
                canvas.width = 200; canvas.height = 200 * aspect;
                const ctx = canvas.getContext('2d');
                ctx.translate(canvas.width/2, canvas.height/2);
                ctx.rotate((pageData.rotation * Math.PI) / 180);
                if(pageData.rotation % 180 !== 0) ctx.drawImage(img, -canvas.height/2, -canvas.width/2, canvas.height, canvas.width);
                else ctx.drawImage(img, -canvas.width/2, -canvas.height/2, canvas.width, canvas.height);
            };
        } else {
            try {
                const page = await pageData.sourceFile.pdfDoc.getPage(pageData.sourcePageIndex + 1);
                const viewport = page.getViewport({ scale: 200 / page.getViewport({ scale: 1 }).width, rotation: pageData.rotation });
                canvas.width = viewport.width; canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            } catch(e) {}
        }
        if(loader) loader.remove();
    }

    // --- INTERACTIONS ---
    handlePageClick(e) {
        const item = e.target.closest('.page-item');
        if (!item) return;
        if (e.target.closest('.delete-page-btn')) { this.deletePages([item.dataset.id]); return; }
        if (e.target.closest('.rotate-cw-btn')) { this.rotatePages([item.dataset.id], 90); return; }
        if (e.target.closest('.rotate-ccw-btn')) { this.rotatePages([item.dataset.id], -90); return; }
        if (e.target.closest('.page-order-input')) return;

        const id = item.dataset.id;
        if (e.shiftKey && this.lastSelectedId) {
            const allItems = [...this.pageGrid.children];
            const start = allItems.findIndex(el => el.dataset.id === this.lastSelectedId);
            const end = allItems.findIndex(el => el.dataset.id === id);
            const range = allItems.slice(Math.min(start, end), Math.max(start, end) + 1);
            range.forEach(el => this.selectedPageIds.add(el.dataset.id));
        } else if (e.ctrlKey || e.metaKey) {
            this.toggleSelection(id);
        } else {
            this.selectedPageIds.clear();
            this.selectedPageIds.add(id);
        }
        this.lastSelectedId = id;
        this.updateSelectionUI();
    }

    toggleSelection(id) {
        if (this.selectedPageIds.has(id)) this.selectedPageIds.delete(id);
        else this.selectedPageIds.add(id);
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        [...this.pageGrid.children].forEach(el => {
            const isSelected = this.selectedPageIds.has(el.dataset.id);
            const wrapper = el.querySelector('.page-checkbox-wrapper');
            const box = el.querySelector('.page-checkbox');
            if (isSelected) {
                el.classList.add('ring-2', 'ring-indigo-600');
                el.classList.remove('ring-slate-200');
                wrapper.classList.remove('opacity-0', 'group-hover:opacity-100');
                wrapper.classList.add('opacity-100');
                box.checked = true;
            } else {
                el.classList.remove('ring-2', 'ring-indigo-600');
                el.classList.add('ring-slate-200');
                wrapper.classList.add('opacity-0', 'group-hover:opacity-100');
                wrapper.classList.remove('opacity-100');
                box.checked = false;
            }
        });
        const count = this.selectedPageIds.size;
        this.selectionCount.innerText = `${count} selected`;
    }

    // --- ACTIONS ---
    deleteSelectedPages() { if (this.selectedPageIds.size > 0) this.deletePages(Array.from(this.selectedPageIds)); }
    deletePages(ids) {
        this.saveState();
        this.pages = this.pages.filter(p => !ids.includes(p.id));
        this.selectedPageIds.clear();
        this.renderAllPages();
        this.updateStatus();
    }
    duplicateSelected() {
        if (this.selectedPageIds.size === 0) return;
        this.saveState();
        const newPages = [];
        this.pages.forEach(page => {
            newPages.push(page);
            if (this.selectedPageIds.has(page.id)) {
                newPages.push({
                    id: `page_${Date.now()}_dup_${Math.random().toString(36).substr(2,9)}`,
                    sourceFile: page.sourceFile,
                    sourcePageIndex: page.sourcePageIndex,
                    type: page.type,
                    rotation: page.rotation,
                    textOverlays: page.textOverlays ? JSON.parse(JSON.stringify(page.textOverlays)) : []
                });
            }
        });
        this.pages = newPages;
        this.renderAllPages();
        this.updateStatus();
    }
    rotateSelectedPages(angle) { if (this.selectedPageIds.size > 0) this.rotatePages(Array.from(this.selectedPageIds), angle); }
    rotatePages(ids, angle) {
        this.saveState();
        ids.forEach(id => {
            const page = this.pages.find(p => p.id === id);
            if (page) { page.rotation = (page.rotation + angle + 360) % 360; }
        });
        this.renderAllPages();
    }
    sortByNumber() {
        this.saveState();
        const inputs = document.querySelectorAll('.page-order-input');
        const map = new Map();
        inputs.forEach(input => map.set(input.closest('.page-item').dataset.id, parseInt(input.value) || 9999));
        this.pages.sort((a, b) => map.get(a.id) - map.get(b.id));
        this.renderAllPages();
    }
    updateDataOrderFromDOM() {
        const newIds = [...this.pageGrid.children].map(el => el.dataset.id);
        const reordered = [];
        newIds.forEach(id => reordered.push(this.pages.find(p => p.id === id)));
        this.pages = reordered;
        [...this.pageGrid.children].forEach((el, i) => el.querySelector('.page-order-input').value = i + 1);
    }
    selectAll() { this.pages.forEach(p => this.selectedPageIds.add(p.id)); this.updateSelectionUI(); }
    deselectAll() { this.selectedPageIds.clear(); this.lastSelectedId = null; this.updateSelectionUI(); }
    selectByRange() {
        const input = this.rangeInput.value.trim();
        if (!input) return;
        this.selectedPageIds.clear();
        const parts = input.split(',');
        const total = this.pages.length;
        parts.forEach(part => {
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(n => parseInt(n));
                if (!isNaN(start) && !isNaN(end)) for (let i = start; i <= end; i++) if (i > 0 && i <= total) this.selectedPageIds.add(this.pages[i-1].id);
            } else {
                const num = parseInt(part); if (!isNaN(num) && num > 0 && num <= total) this.selectedPageIds.add(this.pages[num-1].id);
            }
        });
        this.updateSelectionUI();
    }
    
    // --- UTILS ---
    updateSourceFileList() {
        const el = document.getElementById('sourceFileList');
        const used = new Set(this.pages.map(p => p.sourceFile.id));
        const files = this.sourceFiles.filter(f => used.has(f.id) || f.type === 'blank');
        el.innerHTML = files.map(f => `<div class="p-2 text-xs bg-slate-100 dark:bg-slate-700 rounded mb-1 truncate">${f.name}</div>`).join('');
    }
    updateStatus() {
        this.updateSelectionUI();
        document.getElementById('clearBtn').disabled = this.pages.length === 0;
        if(this.pages.length === 0) this.clearWorkspace();
    }
    async clearWorkspace() {
        this.saveState();
        this.pages = []; this.sourceFiles = []; this.selectedPageIds.clear();
        this.renderAllPages();
        this.startScreen.classList.remove('hidden'); this.appContainer.classList.add('hidden');
        await this.dbManager.clear();
    }
    showLoader(show, text='Processing...') {
        document.getElementById('loader').classList.toggle('hidden', !show);
        document.getElementById('loader-text').innerText = text;
    }
    checkTheme() { if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark'); }
    hexToRgb(hex) {
        const r = parseInt(hex.substr(1, 2), 16) / 255;
        const g = parseInt(hex.substr(3, 2), 16) / 255;
        const b = parseInt(hex.substr(5, 2), 16) / 255;
        return { r, g, b };
    }

    async openPreviewModal(pageId) {
        const page = this.pages.find(p => p.id === pageId);
        if(!page) return;
        document.getElementById('preview-modal').classList.remove('hidden');
        const canvas = document.getElementById('preview-canvas');
        const ctx = canvas.getContext('2d');
        const container = document.querySelector('.modal-body');
        document.getElementById('preview-meta').innerText = `${page.sourceFile.name} - Page ${page.sourcePageIndex + 1}`;
        if(page.type === 'blank') {
            canvas.width = 400; canvas.height = 560;
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,400,560); ctx.strokeRect(0,0,400,560);
        } else if (page.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(page.sourceFile.file);
            img.onload = () => {
                const scale = Math.min((container.clientWidth-40)/img.width, (container.clientHeight-40)/img.height);
                canvas.width = img.width * scale; canvas.height = img.height * scale;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
        } else {
            const pdfPage = await page.sourceFile.pdfDoc.getPage(page.sourcePageIndex + 1);
            const viewport = pdfPage.getViewport({ scale: 1 });
            const scale = Math.min((container.clientWidth-40)/viewport.width, (container.clientHeight-40)/viewport.height);
            const scaledViewport = pdfPage.getViewport({ scale });
            canvas.width = scaledViewport.width; canvas.height = scaledViewport.height;
            await pdfPage.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
        }
    }

    async createPdf(isPreview = false) {
        if(this.pages.length === 0) return;
        this.showLoader(true, 'Generating PDF...');
        
        try {
            const newDoc = await PDFLib.PDFDocument.create();
            const fontMap = {
                'Helvetica': await newDoc.embedFont(PDFLib.StandardFonts.Helvetica),
                'TimesRoman': await newDoc.embedFont(PDFLib.StandardFonts.TimesRoman),
                'Courier': await newDoc.embedFont(PDFLib.StandardFonts.Courier)
            };
            
            for(const p of this.pages) {
                let page;
                if(p.type === 'blank') {
                    page = newDoc.addPage([595, 842]);
                } 
                else if (p.type === 'image') {
                    const imgBytes = await p.sourceFile.file.arrayBuffer();
                    let embedded;
                    if(p.sourceFile.type.includes('png')) embedded = await newDoc.embedPng(imgBytes);
                    else embedded = await newDoc.embedJpg(imgBytes);
                    
                    const { width, height } = embedded;
                    const rotation = p.rotation % 360;
                    const isRotated = rotation === 90 || rotation === 270;
                    page = newDoc.addPage([isRotated ? height : width, isRotated ? width : height]);
                    
                    const drawOpts = { x: 0, y: 0, width, height, rotate: PDFLib.degrees(rotation) };
                    if (rotation === 90) { drawOpts.x = height; drawOpts.y = 0; }
                    else if (rotation === 180) { drawOpts.x = width; drawOpts.y = height; }
                    else if (rotation === 270) { drawOpts.x = 0; drawOpts.y = width; }
                    page.drawImage(embedded, drawOpts);
                } 
                else {
                    const [copied] = await newDoc.copyPages(p.sourceFile.pdfLibDoc, [p.sourcePageIndex]);
                    copied.setRotation(PDFLib.degrees((copied.getRotation().angle + p.rotation) % 360));
                    page = newDoc.addPage(copied);
                }

                if (p.textOverlays && p.textOverlays.length > 0) {
                    const { width, height } = page.getSize();
                    p.textOverlays.forEach(txt => {
                        const rgb = this.hexToRgb(txt.color);
                        // Calculate PDF coords (Top-left origin mapping)
                        const x = width * (txt.xPercent / 100);
                        const y = height - (height * (txt.yPercent / 100));

                        const fontToUse = fontMap[txt.font] || fontMap['Helvetica'];
                        
                        // drawText in pdf-lib draws from bottom-left by default, but we centered our preview logic.
                        // We need to approximate centering based on font size.
                        page.drawText(txt.text, {
                            x: x,
                            y: y,
                            size: txt.size,
                            font: fontToUse,
                            color: PDFLib.rgb(rgb.r, rgb.g, rgb.b),
                            opacity: txt.opacity || 1,
                            rotate: PDFLib.degrees(txt.rotation || 0),
                            // Basic center origin approximation
                             xCentered: true,
                             yCentered: true
                        });
                    });
                }
            }

            const pdfBytes = await newDoc.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            if(isPreview) {
                window.open(url, '_blank');
            } else {
                const nameInput = document.getElementById('filenameInput');
                let filename = nameInput.value.trim() || 'document';
                if(!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        } catch(e) {
            console.error(e);
            alert('Error generating PDF: ' + e.message);
        } finally {
            this.showLoader(false);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => new VisualPDFTool());
