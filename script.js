pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js`;

class VisualPDFTool {
    constructor() {
        // Core Data
        this.sourceFiles = [];
        this.pages = []; // Current state of pages
        this.selectedPageIds = new Set();
        
        // History System
        this.historyStack = [];
        this.redoStack = [];
        this.maxHistory = 20;

        // DOM Elements
        this.pageGrid = document.getElementById('page-grid');
        this.mainView = document.getElementById('main-view');
        this.contextualFooter = document.getElementById('contextual-footer');
        this.selectionCount = document.getElementById('selection-count');
        
        // Buttons & Inputs
        this.undoBtn = document.getElementById('undoBtn');
        this.redoBtn = document.getElementById('redoBtn');
        this.zoomSlider = document.getElementById('zoomSlider');
        this.darkModeToggle = document.getElementById('darkModeToggle');
        this.previewModal = document.getElementById('preview-modal');
        this.rangeInput = document.getElementById('rangeInput');
        this.startScreen = document.getElementById('start-screen');
        this.appContainer = document.querySelector('.app-container');

        this.init();
    }

    init() {
        this.initSortable();
        this.initEventListeners();
        this.checkTheme();
    }

    // --- HISTORY SYSTEM (UNDO/REDO) ---
    saveState() {
        // Clone the pages array (metadata only). 
        // We don't clone the heavy PDF objects, just references to them.
        const stateSnapshot = this.pages.map(page => ({
            id: page.id,
            sourceFileId: page.sourceFile.id,
            sourcePageIndex: page.sourcePageIndex,
            type: page.type,
            rotation: page.rotation,
            // We might need to store the page ID if we want to preserve selection, but simpler to reset selection on undo
        }));

        this.historyStack.push(stateSnapshot);
        if (this.historyStack.length > this.maxHistory) this.historyStack.shift();
        
        // Clear redo stack on new action
        this.redoStack = [];
        this.updateHistoryButtons();
    }

    restoreState(stateSnapshot) {
        // 1. Map the snapshot back to real objects
        const newPages = [];
        for (const item of stateSnapshot) {
            const sourceFile = this.sourceFiles.find(f => f.id === item.sourceFileId);
            if (sourceFile) {
                newPages.push({
                    id: item.id,
                    sourceFile: sourceFile,
                    sourcePageIndex: item.sourcePageIndex,
                    type: item.type,
                    rotation: item.rotation
                });
            }
        }
        
        this.pages = newPages;
        this.selectedPageIds.clear();
        this.renderAllPages(); // Re-render the grid
        this.updateStatus();
    }

    performUndo() {
        if (this.historyStack.length === 0) return;
        
        // Save current state to redo stack
        const currentState = this.pages.map(p => ({
            id: p.id, sourceFileId: p.sourceFile.id, sourcePageIndex: p.sourcePageIndex, type: p.type, rotation: p.rotation
        }));
        this.redoStack.push(currentState);

        const prevState = this.historyStack.pop();
        this.restoreState(prevState);
        this.updateHistoryButtons();
    }

    performRedo() {
        if (this.redoStack.length === 0) return;

        // Save current state to history stack (without clearing redo)
        const currentState = this.pages.map(p => ({
            id: p.id, sourceFileId: p.sourceFile.id, sourcePageIndex: p.sourcePageIndex, type: p.type, rotation: p.rotation
        }));
        this.historyStack.push(currentState);

        const nextState = this.redoStack.pop();
        this.restoreState(nextState);
        this.updateHistoryButtons();
    }

    updateHistoryButtons() {
        this.undoBtn.disabled = this.historyStack.length === 0;
        this.redoBtn.disabled = this.redoStack.length === 0;
    }

    // --- INITIALIZATION ---
    initSortable() {
        Sortable.create(this.pageGrid, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            onStart: () => {
                this.saveState(); // Save before drag starts
            },
            onEnd: () => {
                this.updateDataOrderFromDOM();
            },
        });
    }

    initEventListeners() {
        // Global Keys
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.performUndo(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.performRedo(); }
            if (e.key === 'Delete' || e.key === 'Backspace') { 
                if(document.activeElement.tagName !== 'INPUT') this.deleteSelectedPages(); 
            }
        });

        // Toolbar
        this.undoBtn.addEventListener('click', () => this.performUndo());
        this.redoBtn.addEventListener('click', () => this.performRedo());
        this.zoomSlider.addEventListener('input', (e) => {
            document.documentElement.style.setProperty('--grid-size', `${e.target.value}px`);
        });
        this.darkModeToggle.addEventListener('click', () => this.toggleDarkMode());

        // Sidebar & File Input
        document.getElementById('startChooseFileBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('addFilesBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileSelect(e));
        document.getElementById('sidebar-close-btn').addEventListener('click', () => this.toggleSidebar(false));
        document.getElementById('menu-toggle-btn').addEventListener('click', () => this.toggleSidebar(true));
        
        // Sidebar Tools
        document.getElementById('selectRangeBtn').addEventListener('click', () => this.selectByRange());
        document.getElementById('insertBlankBtn').addEventListener('click', () => this.insertBlankPage());

        // Editor Actions
        document.getElementById('clearBtn').addEventListener('click', () => this.clearWorkspace());
        document.getElementById('selectAllBtn').addEventListener('click', () => this.selectAll());
        document.getElementById('deselectAllBtn').addEventListener('click', () => this.deselectAll());
        document.getElementById('sortByNumberBtn').addEventListener('click', () => this.sortByNumber());
        
        // Footer Actions
        document.getElementById('deleteSelectedBtn').addEventListener('click', () => this.deleteSelectedPages());
        document.getElementById('rotateSelectedBtn').addEventListener('click', () => this.rotateSelectedPages(90));
        document.getElementById('duplicateSelectedBtn').addEventListener('click', () => this.duplicateSelected());
        
        // Export
        document.getElementById('saveBtn').addEventListener('click', () => this.createPdf());
        document.getElementById('previewBtn').addEventListener('click', (e) => { e.preventDefault(); this.createPdf(true); });
        document.getElementById('printBtn').addEventListener('click', (e) => { e.preventDefault(); this.printPdf(); });
        
        const dropdownToggle = document.getElementById('exportDropdownToggle');
        dropdownToggle.addEventListener('click', () => {
            document.getElementById('exportDropdownMenu').classList.toggle('hidden');
        });
        document.addEventListener('click', (e) => {
            if (!dropdownToggle.contains(e.target) && !document.getElementById('exportDropdownMenu').contains(e.target)) {
                document.getElementById('exportDropdownMenu').classList.add('hidden');
            }
        });

        // Grid Interaction
        this.pageGrid.addEventListener('click', this.handlePageClick.bind(this));
        this.pageGrid.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.page-item');
            if (item) this.openPreviewModal(item.dataset.id);
        });

        // Drag Drop Files
        const dropZones = [document.getElementById('startDropZone'), this.mainView];
        dropZones.forEach(zone => {
            zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
            zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
            zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); this.addFiles(Array.from(e.dataTransfer.files)); });
        });

        // Modal
        document.querySelector('.close-modal-btn').addEventListener('click', () => this.previewModal.classList.add('hidden'));
        this.previewModal.addEventListener('click', (e) => { if (e.target === this.previewModal) this.previewModal.classList.add('hidden'); });
    }

    // --- CORE FILE HANDLING ---
    async addFiles(files) {
        if (files.length === 0) return;
        this.saveState(); // Save before adding
        this.showLoader(true);

        if (this.pages.length === 0) {
            this.startScreen.classList.add('hidden');
            this.appContainer.classList.remove('hidden');
        }

        for (const file of files) {
            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const sourceFile = { id: fileId, name: file.name, file: file, type: file.type };
            
            // If it's an image
            if (file.type.startsWith('image/')) {
                this.sourceFiles.push(sourceFile);
                this.addPageToData(sourceFile, 0, 'image');
            } 
            // If it's a PDF
            else if (file.type === 'application/pdf') {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    sourceFile.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    sourceFile.pdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer); // Load purely for metadata/page count initially
                    this.sourceFiles.push(sourceFile);
                    
                    for (let i = 0; i < sourceFile.pdfDoc.numPages; i++) {
                        this.addPageToData(sourceFile, i, 'pdf');
                    }
                } catch (err) {
                    console.error(err);
                    alert(`Error loading ${file.name}`);
                }
            }
        }
        
        this.updateSourceFileList();
        this.renderNewPages(); // Only render pages that aren't in the DOM yet
        this.updateStatus();
        this.showLoader(false);
    }

    insertBlankPage() {
        this.saveState();
        // Create a virtual source file for blanks
        let blankSource = this.sourceFiles.find(f => f.id === 'virtual_blank');
        if (!blankSource) {
            blankSource = { id: 'virtual_blank', name: 'Blank Page', type: 'blank' };
            this.sourceFiles.push(blankSource);
        }
        this.addPageToData(blankSource, 0, 'blank');
        this.renderNewPages();
        this.updateStatus();
    }

    addPageToData(sourceFile, index, type) {
        const pageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.pages.push({
            id: pageId,
            sourceFile: sourceFile,
            sourcePageIndex: index,
            type: type,
            rotation: 0
        });
    }

    // --- RENDERING ---
    // Efficiently renders only what is needed
    renderAllPages() {
        this.pageGrid.innerHTML = '';
        this.pages.forEach((page, index) => this.renderThumbnail(page, index));
    }

    renderNewPages() {
        // Find pages not yet in DOM
        const existingIds = new Set([...this.pageGrid.children].map(el => el.dataset.id));
        this.pages.forEach((page, index) => {
            if (!existingIds.has(page.id)) {
                this.renderThumbnail(page, index);
            }
        });
    }

    async renderThumbnail(pageData, index) {
        const item = document.createElement('div');
        item.className = 'page-item';
        item.dataset.id = pageData.id;
        
        // HTML Structure
        item.innerHTML = `
            <input type="checkbox" class="page-checkbox">
            <div class="page-top-actions">
                <button class="page-action-btn delete-page-btn" title="Delete">✕</button>
            </div>
            <canvas class="page-canvas"></canvas>
            <div class="page-info">${pageData.sourceFile.name} ${pageData.type === 'pdf' ? '#' + (pageData.sourcePageIndex + 1) : ''}</div>
            <div class="page-bottom-actions">
                <button class="page-action-btn rotate-ccw-btn">↶</button>
                <input type="number" class="page-order-input" value="${index + 1}">
                <button class="page-action-btn rotate-cw-btn">↷</button>
            </div>
        `;
        
        // Checkbox listener
        item.querySelector('.page-checkbox').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSelection(pageData.id);
        });
        
        // Input listener (stop propagation)
        item.querySelector('input[type="number"]').addEventListener('click', e => e.stopPropagation());

        this.pageGrid.appendChild(item);
        
        // Render Content
        const canvas = item.querySelector('canvas');
        if (pageData.type === 'blank') {
            canvas.width = 200; canvas.height = 280;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,200,280);
            ctx.strokeStyle = '#ddd'; ctx.strokeRect(0,0,200,280);
            ctx.fillStyle = '#eee'; ctx.font = '20px sans-serif'; ctx.fillText('BLANK', 65, 140);
        } else if (pageData.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(pageData.sourceFile.file);
            img.onload = () => {
                const aspect = img.height / img.width;
                canvas.width = 200; canvas.height = 200 * aspect;
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.style.transform = `rotate(${pageData.rotation}deg)`;
            };
        } else if (pageData.type === 'pdf') {
            try {
                const page = await pageData.sourceFile.pdfDoc.getPage(pageData.sourcePageIndex + 1);
                const viewport = page.getViewport({ scale: 200 / page.getViewport({ scale: 1 }).width });
                canvas.width = viewport.width; canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                canvas.style.transform = `rotate(${pageData.rotation}deg)`;
            } catch(e) { console.error(e); }
        }
    }

    // --- INTERACTIONS ---
    handlePageClick(e) {
        const item = e.target.closest('.page-item');
        if (!item) return;

        // Action Buttons
        if (e.target.closest('.delete-page-btn')) { this.deletePages([item.dataset.id]); return; }
        if (e.target.closest('.rotate-cw-btn')) { this.rotatePages([item.dataset.id], 90); return; }
        if (e.target.closest('.rotate-ccw-btn')) { this.rotatePages([item.dataset.id], -90); return; }
        if (e.target.closest('.page-order-input')) return;

        // Selection Logic
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
            el.classList.toggle('selected', isSelected);
            el.querySelector('.page-checkbox').checked = isSelected;
        });
        const count = this.selectedPageIds.size;
        this.selectionCount.innerText = `${count} selected`;
        this.contextualFooter.classList.toggle('visible', count > 0);
    }

    // --- ACTIONS ---
    deleteSelectedPages() {
        if (this.selectedPageIds.size === 0) return;
        this.deletePages(Array.from(this.selectedPageIds));
    }

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
        // Loop through current pages to maintain order
        this.pages.forEach(page => {
            newPages.push(page);
            if (this.selectedPageIds.has(page.id)) {
                // Create duplicate
                const dupId = `page_${Date.now()}_dup_${Math.random().toString(36).substr(2,5)}`;
                newPages.push({ ...page, id: dupId });
            }
        });
        
        this.pages = newPages;
        this.renderAllPages();
        this.updateStatus();
    }

    rotateSelectedPages(angle) {
        if (this.selectedPageIds.size === 0) return;
        this.rotatePages(Array.from(this.selectedPageIds), angle);
    }

    rotatePages(ids, angle) {
        this.saveState();
        ids.forEach(id => {
            const page = this.pages.find(p => p.id === id);
            if (page) {
                page.rotation = (page.rotation + angle + 360) % 360;
                const el = this.pageGrid.querySelector(`.page-item[data-id="${id}"] .page-canvas`);
                if(el) el.style.transform = `rotate(${page.rotation}deg)`;
            }
        });
    }

    sortByNumber() {
        this.saveState();
        const inputs = document.querySelectorAll('.page-order-input');
        const map = new Map();
        inputs.forEach(input => {
            const id = input.closest('.page-item').dataset.id;
            map.set(id, parseInt(input.value) || 9999);
        });
        
        this.pages.sort((a, b) => map.get(a.id) - map.get(b.id));
        this.renderAllPages();
    }

    updateDataOrderFromDOM() {
        // Called after Drag & Drop
        const newOrderIds = [...this.pageGrid.children].map(el => el.dataset.id);
        // We don't save state here because 'onStart' of Sortable already saved it
        const reordered = [];
        newOrderIds.forEach(id => {
            reordered.push(this.pages.find(p => p.id === id));
        });
        this.pages = reordered;
        
        // Update input numbers
        [...this.pageGrid.children].forEach((el, i) => {
            el.querySelector('.page-order-input').value = i + 1;
        });
    }

    selectByRange() {
        const input = this.rangeInput.value.trim();
        if (!input) return;
        
        this.selectedPageIds.clear();
        const parts = input.split(',');
        const total = this.pages.length;
        
        parts.forEach(part => {
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(n => parseInt(n));
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = start; i <= end; i++) {
                        if (i > 0 && i <= total) this.selectedPageIds.add(this.pages[i-1].id);
                    }
                }
            } else {
                const num = parseInt(part);
                if (!isNaN(num) && num > 0 && num <= total) {
                    this.selectedPageIds.add(this.pages[num-1].id);
                }
            }
        });
        this.updateSelectionUI();
    }

    // --- PREVIEW ---
    async openPreviewModal(pageId) {
        const page = this.pages.find(p => p.id === pageId);
        if(!page) return;
        
        this.previewModal.classList.remove('hidden');
        const canvas = document.getElementById('preview-canvas');
        const meta = document.getElementById('preview-meta');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,canvas.width,canvas.height);
        
        meta.innerText = `${page.sourceFile.name} - Page ${page.sourcePageIndex + 1}`;

        if(page.type === 'blank') {
            canvas.width = 400; canvas.height = 560;
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,400,560);
            ctx.font = '30px sans-serif'; ctx.fillStyle = '#ccc'; ctx.fillText('BLANK PAGE', 100, 280);
        } else if (page.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(page.sourceFile.file);
            img.onload = () => {
                canvas.width = img.width; canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
            };
        } else {
            // High res PDF render
            const pdfPage = await page.sourceFile.pdfDoc.getPage(page.sourcePageIndex + 1);
            const viewport = pdfPage.getViewport({ scale: 1.5, rotation: page.rotation });
            canvas.width = viewport.width; canvas.height = viewport.height;
            await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        }
    }

    // --- EXPORT ---
    async createPdf(isPreview = false) {
        if(this.pages.length === 0) return;
        this.showLoader(true, 'Generating PDF...');
        
        try {
            const newDoc = await PDFLib.PDFDocument.create();
            
            for(const p of this.pages) {
                if(p.type === 'blank') {
                    newDoc.addPage([595, 842]); // A4 size
                } 
                else if (p.type === 'image') {
                    const imgBytes = await p.sourceFile.file.arrayBuffer();
                    let embedded;
                    if(p.sourceFile.type.includes('png')) embedded = await newDoc.embedPng(imgBytes);
                    else embedded = await newDoc.embedJpg(imgBytes);
                    
                    const { width, height } = embedded;
                    const page = newDoc.addPage([width, height]);
                    
                    // Logic to draw image with rotation
                    const rad = (p.rotation * Math.PI) / 180;
                    page.drawImage(embedded, {
                        x: p.rotation === 90 ? width : (p.rotation === 180 ? width : 0),
                        y: p.rotation === 270 ? height : (p.rotation === 180 ? height : 0),
                        width: width, height: height,
                        rotate: PDFLib.degrees(p.rotation)
                    });
                } 
                else {
                    const [copied] = await newDoc.copyPages(p.sourceFile.pdfLibDoc, [p.sourcePageIndex]);
                    copied.setRotation(PDFLib.degrees((copied.getRotation().angle + p.rotation) % 360));
                    newDoc.addPage(copied);
                }
            }

            const pdfBytes = await newDoc.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            if(isPreview) {
                window.open(url, '_blank');
            } else {
                const a = document.createElement('a');
                a.href = url;
                a.download = `combined_${Date.now()}.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        } catch(e) {
            console.error(e);
            alert('Error generating PDF');
        } finally {
            this.showLoader(false);
        }
    }
    
    // --- UTILS ---
    selectAll() { this.pages.forEach(p => this.selectedPageIds.add(p.id)); this.updateSelectionUI(); }
    deselectAll() { this.selectedPageIds.clear(); this.lastSelectedId = null; this.updateSelectionUI(); }
    toggleSidebar(show) { this.appContainer.classList.toggle('sidebar-mobile-open', show); document.getElementById('sidebar-overlay').classList.toggle('hidden', !show); }
    toggleDarkMode() { 
        document.body.classList.toggle('dark-mode'); 
        document.querySelector('.moon-icon').classList.toggle('hidden');
        document.querySelector('.sun-icon').classList.toggle('hidden');
    }
    checkTheme() { if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) this.toggleDarkMode(); }
    
    updateSourceFileList() {
        const el = document.getElementById('sourceFileList');
        const used = new Set(this.pages.map(p => p.sourceFile.id));
        const files = this.sourceFiles.filter(f => used.has(f.id) || f.type === 'blank'); // Keep used files
        el.innerHTML = files.map(f => `<div class="source-file-item">${f.name}</div>`).join('');
    }

    updateStatus() {
        this.updateSelectionUI();
        document.getElementById('clearBtn').disabled = this.pages.length === 0;
        if(this.pages.length === 0) this.clearWorkspace();
    }

    clearWorkspace() {
        this.saveState();
        this.pages = [];
        this.sourceFiles = [];
        this.selectedPageIds.clear();
        this.renderAllPages();
        this.startScreen.classList.remove('hidden');
        this.appContainer.classList.add('hidden');
    }

    showLoader(show, text='Processing...') {
        document.getElementById('loader').classList.toggle('hidden', !show);
        document.getElementById('loader-text').innerText = text;
    }
}

document.addEventListener('DOMContentLoaded', () => new VisualPDFTool());
