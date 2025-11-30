pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js`;

class VisualPDFTool {
    constructor() {
        this.sourceFiles = [];
        this.pages = []; 
        this.selectedPageIds = new Set();
        this.lastSelectedId = null;
        
        // History
        this.historyStack = [];
        this.redoStack = [];
        this.maxHistory = 20;

        // UI Refs
        this.pageGrid = document.getElementById('page-grid');
        this.mainView = document.getElementById('main-view');
        this.contextualFooter = document.getElementById('contextual-footer');
        this.selectionCount = document.getElementById('selection-count');
        
        // Buttons
        this.undoBtn = document.getElementById('undoBtn');
        this.redoBtn = document.getElementById('redoBtn');
        this.zoomSlider = document.getElementById('zoomSlider');
        this.darkModeToggle = document.getElementById('darkModeToggle');
        this.previewModal = document.getElementById('preview-modal');
        this.textModal = document.getElementById('text-modal');
        this.rangeInput = document.getElementById('rangeInput');
        this.startScreen = document.getElementById('start-screen');
        this.appContainer = document.querySelector('.app-container');

        this.init();
    }

    init() {
        this.initSortable();
        this.initEventListeners();
        this.checkTheme();
        // Set initial Grid Size
        document.documentElement.style.setProperty('--grid-size', '180px');
    }

    // --- HISTORY (UNDO/REDO) ---
    saveState() {
        const stateSnapshot = this.pages.map(page => ({
            id: page.id,
            sourceFileId: page.sourceFile.id,
            sourcePageIndex: page.sourcePageIndex,
            type: page.type,
            rotation: page.rotation,
            textOverlays: JSON.parse(JSON.stringify(page.textOverlays || [])) // Deep copy text data
        }));

        this.historyStack.push(stateSnapshot);
        if (this.historyStack.length > this.maxHistory) this.historyStack.shift();
        this.redoStack = [];
        this.updateHistoryButtons();
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
    }

    performUndo() {
        if (this.historyStack.length === 0) return;
        const currentState = this.snapshotCurrentState();
        this.redoStack.push(currentState);
        const prevState = this.historyStack.pop();
        this.restoreState(prevState);
        this.updateHistoryButtons();
    }

    performRedo() {
        if (this.redoStack.length === 0) return;
        const currentState = this.snapshotCurrentState();
        this.historyStack.push(currentState);
        const nextState = this.redoStack.pop();
        this.restoreState(nextState);
        this.updateHistoryButtons();
    }

    snapshotCurrentState() {
        return this.pages.map(p => ({
            id: p.id, sourceFileId: p.sourceFile.id, sourcePageIndex: p.sourcePageIndex, 
            type: p.type, rotation: p.rotation, textOverlays: JSON.parse(JSON.stringify(p.textOverlays || []))
        }));
    }

    updateHistoryButtons() {
        this.undoBtn.disabled = this.historyStack.length === 0;
        this.redoBtn.disabled = this.redoStack.length === 0;
    }

    // --- SETUP ---
    initSortable() {
        Sortable.create(this.pageGrid, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            onStart: () => this.saveState(),
            onEnd: () => this.updateDataOrderFromDOM(),
        });
    }

    initEventListeners() {
        // Global Keys
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.performUndo(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.performRedo(); }
            if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement.tagName !== 'INPUT') { 
                this.deleteSelectedPages(); 
            }
        });

        // Safety
        window.addEventListener('beforeunload', (e) => {
            if (this.pages.length > 0) { e.preventDefault(); e.returnValue = ''; }
        });

        // Toolbar
        this.undoBtn.addEventListener('click', () => this.performUndo());
        this.redoBtn.addEventListener('click', () => this.performRedo());
        this.zoomSlider.addEventListener('input', (e) => {
            document.documentElement.style.setProperty('--grid-size', `${e.target.value}px`);
        });
        this.darkModeToggle.addEventListener('click', () => this.toggleDarkMode());
        
        // Help
        document.getElementById('helpBtn').addEventListener('click', () => {
            alert("⌨️ Shortcuts:\n\n• Ctrl/Shift + Click: Select multiple\n• Ctrl + Z/Y: Undo/Redo\n• Delete: Remove pages\n• Drag: Reorder");
        });

        // File Inputs
        document.getElementById('startChooseFileBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('addFilesBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileSelect(e));
        
        // Sidebar
        document.getElementById('sidebar-close-btn').addEventListener('click', () => this.toggleSidebar(false));
        document.getElementById('menu-toggle-btn').addEventListener('click', () => this.toggleSidebar(true));
        
        // Tools
        document.getElementById('selectRangeBtn').addEventListener('click', () => this.selectByRange());
        document.getElementById('insertBlankBtn').addEventListener('click', () => this.insertBlankPage());
        document.getElementById('openTextModalBtn').addEventListener('click', () => this.textModal.classList.remove('hidden'));

        // Text Modal
        document.querySelector('.close-text-modal').addEventListener('click', () => this.textModal.classList.add('hidden'));
        document.getElementById('applyTextSelected').addEventListener('click', () => this.applyTextToPages(true));
        document.getElementById('applyTextAll').addEventListener('click', () => this.applyTextToPages(false));

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
        dropdownToggle.addEventListener('click', () => document.getElementById('exportDropdownMenu').classList.toggle('hidden'));
        document.addEventListener('click', (e) => {
            if (!dropdownToggle.contains(e.target) && !document.getElementById('exportDropdownMenu').contains(e.target)) {
                document.getElementById('exportDropdownMenu').classList.add('hidden');
            }
        });

        // Grid
        this.pageGrid.addEventListener('click', this.handlePageClick.bind(this));
        this.pageGrid.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.page-item');
            if (item) this.openPreviewModal(item.dataset.id);
        });

        // Drag Drop
        const dropZones = [document.getElementById('startDropZone'), this.mainView];
        dropZones.forEach(zone => {
            zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
            zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
            zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); this.addFiles(Array.from(e.dataTransfer.files)); });
        });

        // Preview Modal
        document.querySelector('.close-modal-btn').addEventListener('click', () => this.previewModal.classList.add('hidden'));
    }

    // --- LOGIC ---
    async handleFileSelect(e) {
        const files = Array.from(e.target.files);
        await this.addFiles(files);
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
                } catch (err) { console.error(err); alert(`Error loading ${file.name}`); }
            }
        }
        this.updateSourceFileList();
        this.renderNewPages();
        this.updateStatus();
        this.showLoader(false);
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

    addPageToData(sourceFile, index, type) {
        this.pages.push({
            id: `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            sourceFile: sourceFile, sourcePageIndex: index, type: type, rotation: 0, textOverlays: []
        });
    }

    // --- TEXT TOOL ---
    applyTextToPages(onlySelected) {
        const text = document.getElementById('txt-content').value;
        if (!text) return;
        
        const position = document.getElementById('txt-position').value;
        const size = parseInt(document.getElementById('txt-size').value) || 12;
        const color = document.getElementById('txt-color').value; // Hex string

        this.saveState();
        
        const targets = onlySelected 
            ? this.pages.filter(p => this.selectedPageIds.has(p.id))
            : this.pages;
        
        if (onlySelected && targets.length === 0) { alert("No pages selected."); return; }

        targets.forEach(page => {
            if (!page.textOverlays) page.textOverlays = [];
            page.textOverlays.push({ text, position, size, color });
            
            // Visual Indicator on Thumbnail
            const el = this.pageGrid.querySelector(`.page-item[data-id="${page.id}"]`);
            if(el && !el.querySelector('.text-badge')) {
                const badge = document.createElement('div');
                badge.className = 'text-badge absolute top-8 right-2 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10';
                badge.innerText = 'T';
                el.appendChild(badge);
            }
        });

        this.textModal.classList.add('hidden');
        document.getElementById('txt-content').value = ''; // Reset
    }

    // --- RENDERING (TAILWIND STYLES) ---
    renderAllPages() {
        this.pageGrid.innerHTML = '';
        this.pages.forEach((page, index) => this.renderThumbnail(page, index));
    }

    renderNewPages() {
        const existingIds = new Set([...this.pageGrid.children].map(el => el.dataset.id));
        this.pages.forEach((page, index) => {
            if (!existingIds.has(page.id)) this.renderThumbnail(page, index);
        });
    }

    async renderThumbnail(pageData, index) {
        const item = document.createElement('div');
        item.className = 'page-item group relative cursor-pointer rounded-lg bg-white dark:bg-slate-700 shadow-sm border-2 border-transparent hover:-translate-y-1 hover:shadow-md transition-all overflow-hidden flex flex-col';
        item.dataset.id = pageData.id;
        
        // Show badge if text exists
        const hasText = pageData.textOverlays && pageData.textOverlays.length > 0;
        const badgeHtml = hasText ? '<div class="text-badge absolute top-8 right-2 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10">T</div>' : '';

        item.innerHTML = `
            <div class="absolute top-2 left-2 z-10">
                <input type="checkbox" class="page-checkbox w-4 h-4 cursor-pointer accent-indigo-600 rounded">
            </div>
            <div class="absolute top-2 right-2 z-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="delete-page-btn w-6 h-6 bg-white/90 dark:bg-slate-800/90 text-red-500 rounded-full flex items-center justify-center hover:bg-red-500 hover:text-white transition shadow-sm">✕</button>
            </div>
            ${badgeHtml}
            <div class="flex-1 bg-slate-200 dark:bg-slate-800 relative overflow-hidden flex items-center justify-center">
                <canvas class="page-canvas max-w-full max-h-[300px] object-contain"></canvas>
            </div>
            <div class="px-2 py-2 bg-white dark:bg-slate-700 border-t border-slate-100 dark:border-slate-600 text-xs text-slate-500 dark:text-slate-400 truncate flex justify-between items-center h-10">
                <span class="truncate max-w-[60%]">${pageData.sourceFile.name}</span>
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-2 right-2 bg-white/90 dark:bg-slate-700/90 p-1 rounded shadow-sm">
                    <button class="rotate-ccw-btn w-5 h-5 flex items-center justify-center hover:text-indigo-600">↶</button>
                    <input type="number" class="page-order-input w-8 h-5 text-center border border-slate-300 dark:border-slate-500 rounded text-[10px] bg-transparent" value="${index + 1}">
                    <button class="rotate-cw-btn w-5 h-5 flex items-center justify-center hover:text-indigo-600">↷</button>
                </div>
            </div>
        `;
        
        item.querySelector('.page-checkbox').addEventListener('click', (e) => { e.stopPropagation(); this.toggleSelection(pageData.id); });
        item.querySelector('input[type="number"]').addEventListener('click', e => e.stopPropagation());

        this.pageGrid.appendChild(item);
        
        // Render Canvas
        const canvas = item.querySelector('canvas');
        if (pageData.type === 'blank') {
            canvas.width = 200; canvas.height = 280;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,200,280);
            ctx.font = '20px sans-serif'; ctx.fillStyle = '#cbd5e1'; ctx.fillText('BLANK', 65, 140);
        } else if (pageData.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(pageData.sourceFile.file);
            img.onload = () => {
                const aspect = img.height / img.width;
                canvas.width = 200; canvas.height = 200 * aspect;
                const ctx = canvas.getContext('2d');
                ctx.translate(canvas.width/2, canvas.height/2);
                ctx.rotate((pageData.rotation * Math.PI) / 180);
                // Adjust for rotation
                if(pageData.rotation % 180 !== 0) {
                     // Very simple drawing for thumb, not perfect rotation centering but enough for visual
                     ctx.drawImage(img, -canvas.height/2, -canvas.width/2, canvas.height, canvas.width);
                } else {
                     ctx.drawImage(img, -canvas.width/2, -canvas.height/2, canvas.width, canvas.height);
                }
            };
        } else if (pageData.type === 'pdf') {
            try {
                const page = await pageData.sourceFile.pdfDoc.getPage(pageData.sourcePageIndex + 1);
                const viewport = page.getViewport({ scale: 200 / page.getViewport({ scale: 1 }).width, rotation: pageData.rotation });
                canvas.width = viewport.width; canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            } catch(e) { console.error(e); }
        }
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
            if (isSelected) {
                el.classList.add('ring-4', 'ring-indigo-500/50', 'border-indigo-500');
                el.classList.remove('border-transparent');
                el.querySelector('.page-checkbox').checked = true;
            } else {
                el.classList.remove('ring-4', 'ring-indigo-500/50', 'border-indigo-500');
                el.classList.add('border-transparent');
                el.querySelector('.page-checkbox').checked = false;
            }
        });
        const count = this.selectedPageIds.size;
        this.selectionCount.innerText = `${count} selected`;
        if(count > 0) this.contextualFooter.classList.remove('translate-y-full');
        else this.contextualFooter.classList.add('translate-y-full');
    }

    // --- ACTIONS (Delete, Rotate, Sort, Etc) ---
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
        this.pages.forEach(page => {
            newPages.push(page);
            if (this.selectedPageIds.has(page.id)) {
                const dup = JSON.parse(JSON.stringify(page)); // Deep copy
                dup.id = `page_${Date.now()}_dup_${Math.random().toString(36).substr(2,5)}`;
                newPages.push(dup);
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
                // Re-rendering specific thumbnails is complex with rotation, easier to just update all for now or check rotation logic
                this.renderAllPages(); 
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
        const newOrderIds = [...this.pageGrid.children].map(el => el.dataset.id);
        const reordered = [];
        newOrderIds.forEach(id => reordered.push(this.pages.find(p => p.id === id)));
        this.pages = reordered;
        [...this.pageGrid.children].forEach((el, i) => el.querySelector('.page-order-input').value = i + 1);
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
                    for (let i = start; i <= end; i++) if (i > 0 && i <= total) this.selectedPageIds.add(this.pages[i-1].id);
                }
            } else {
                const num = parseInt(part);
                if (!isNaN(num) && num > 0 && num <= total) this.selectedPageIds.add(this.pages[num-1].id);
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
        const ctx = canvas.getContext('2d');
        const container = document.querySelector('.modal-body');
        document.getElementById('preview-meta').innerText = `${page.sourceFile.name} - Page ${page.sourcePageIndex + 1}`;

        // Simple render logic for preview (ignoring text overlay for simplicity in preview, text appears on export)
        if(page.type === 'blank') {
            canvas.width = 400; canvas.height = 560;
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,400,560);
            ctx.font = '30px sans-serif'; ctx.fillStyle = '#ccc'; ctx.fillText('BLANK', 100, 280);
        } else if (page.type === 'image') {
            const img = new Image();
            img.src = URL.createObjectURL(page.sourceFile.file);
            img.onload = () => {
                const maxWidth = container.clientWidth - 40;
                const maxHeight = container.clientHeight - 40;
                const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
                canvas.width = img.width * scale; canvas.height = img.height * scale;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
        } else {
            const pdfPage = await page.sourceFile.pdfDoc.getPage(page.sourcePageIndex + 1);
            const rawViewport = pdfPage.getViewport({ scale: 1, rotation: page.rotation });
            const maxWidth = container.clientWidth - 40;
            const maxHeight = container.clientHeight - 40;
            const scale = Math.min(maxWidth / rawViewport.width, maxHeight / rawViewport.height);
            const viewport = pdfPage.getViewport({ scale: scale, rotation: page.rotation });
            canvas.width = viewport.width; canvas.height = viewport.height;
            await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        }
    }

    // --- EXPORT PDF (With Text) ---
    async createPdf(isPreview = false) {
        if(this.pages.length === 0) return;
        this.showLoader(true, 'Generating PDF...');
        
        try {
            const newDoc = await PDFLib.PDFDocument.create();
            // Embed font for text
            const helveticaFont = await newDoc.embedFont(PDFLib.StandardFonts.Helvetica);
            
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
                    page = newDoc.addPage([width, height]); // Simplified page sizing for image
                    
                    // Rotation handling for images in PDF-lib is tricky, simplified here:
                    if (p.rotation === 0) page.drawImage(embedded, {x:0, y:0, width, height});
                    else {
                        page.setRotation(PDFLib.degrees(p.rotation));
                        if(p.rotation === 90) page.drawImage(embedded, {x:0, y:-height, width, height}); // Basic offset logic
                        else if (p.rotation === 180) page.drawImage(embedded, {x:-width, y:-height, width, height});
                        // Note: Robust image rotation usually requires calculating new page dimensions.
                        // For this demo, we assume user accepts basic rotation.
                    }
                } 
                else {
                    const [copied] = await newDoc.copyPages(p.sourceFile.pdfLibDoc, [p.sourcePageIndex]);
                    copied.setRotation(PDFLib.degrees((copied.getRotation().angle + p.rotation) % 360));
                    page = newDoc.addPage(copied);
                }

                // --- DRAW TEXT OVERLAYS ---
                if (p.textOverlays && p.textOverlays.length > 0) {
                    const { width, height } = page.getSize();
                    p.textOverlays.forEach(txt => {
                        const rgb = this.hexToRgb(txt.color);
                        const textWidth = helveticaFont.widthOfTextAtSize(txt.text, txt.size);
                        let x = 50, y = 50;

                        // Position Logic
                        if (txt.position.includes('top')) y = height - 50;
                        if (txt.position.includes('bottom')) y = 50;
                        if (txt.position === 'center') y = height / 2;
                        
                        if (txt.position.includes('left')) x = 50;
                        if (txt.position.includes('center')) x = (width - textWidth) / 2;
                        if (txt.position.includes('right')) x = width - textWidth - 50;

                        page.drawText(txt.text, {
                            x: x,
                            y: y,
                            size: txt.size,
                            font: helveticaFont,
                            color: PDFLib.rgb(rgb.r, rgb.g, rgb.b),
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
                const a = document.createElement('a');
                a.href = url;
                a.download = `combined_${Date.now()}.pdf`;
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

    // Helper
    hexToRgb(hex) {
        const r = parseInt(hex.substr(1, 2), 16) / 255;
        const g = parseInt(hex.substr(3, 2), 16) / 255;
        const b = parseInt(hex.substr(5, 2), 16) / 255;
        return { r, g, b };
    }
    
    // --- UTILS ---
    selectAll() { this.pages.forEach(p => this.selectedPageIds.add(p.id)); this.updateSelectionUI(); }
    deselectAll() { this.selectedPageIds.clear(); this.lastSelectedId = null; this.updateSelectionUI(); }
    toggleSidebar(show) { this.appContainer.classList.toggle('sidebar-mobile-open', show); document.getElementById('sidebar-overlay').classList.toggle('hidden', !show); 
         if(show) document.getElementById('sidebar').classList.remove('-translate-x-full');
         else document.getElementById('sidebar').classList.add('-translate-x-full');
    }
    toggleDarkMode() { 
        document.documentElement.classList.toggle('dark');
        // Need to update drag over styles or canvas backgrounds if dependent on class
    }
    checkTheme() { if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) this.toggleDarkMode(); }
    
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
