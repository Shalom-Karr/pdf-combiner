// Point to the LOCAL worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.min.js';

class LocalStorageManager {
    constructor(dbName='PDFEditorDB', storeName='StateStore') { this.dbName=dbName; this.storeName=storeName; this.db=null; }
    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onerror = e => reject(e);
            req.onupgradeneeded = e => { if(!e.target.result.objectStoreNames.contains(this.storeName)) e.target.result.createObjectStore(this.storeName); };
            req.onsuccess = e => { this.db = e.target.result; resolve(); };
        });
    }
    async saveState(sourceFiles, pages) {
        if(!this.db) await this.init();
        const serialized = sourceFiles.map(f => ({ id: f.id, name: f.name, type: f.type, file: f.file }));
        const state = { sourceFiles: serialized, pages: pages };
        return new Promise((r, j) => { const tx=this.db.transaction([this.storeName], 'readwrite'); tx.objectStore(this.storeName).put(state, 'currentState'); tx.oncomplete=r; tx.onerror=j; });
    }
    async loadState() {
        if(!this.db) await this.init();
        return new Promise((r, j) => { const tx=this.db.transaction([this.storeName], 'readonly'); const req=tx.objectStore(this.storeName).get('currentState'); req.onsuccess=()=>r(req.result); req.onerror=j; });
    }
    async clear() { if(!this.db) await this.init(); const tx=this.db.transaction([this.storeName], 'readwrite'); tx.objectStore(this.storeName).clear(); }
}

class VisualPDFTool {
    constructor() {
        this.sourceFiles = []; this.pages = []; this.selectedPageIds = new Set();
        this.historyStack = []; this.redoStack = []; this.maxHistory = 20;
        this.dbManager = new LocalStorageManager();
        this.observer = null; this.contextTargetId = null;
        
        // Editor State
        this.editingPageId = null;
        this.tempTextOverlays = [];
        this.activeTextIndex = -1;
        this.tempRotation = 0;

        // UI Refs
        this.pageGrid = document.getElementById('page-grid');
        this.textModal = document.getElementById('text-modal');
        this.contextMenu = document.getElementById('context-menu');
        this.init();
    }

    async init() {
        this.initSortable(); this.initEventListeners(); this.initIntersectionObserver(); this.initContextMenu(); this.initMarqueeSelection();
        this.checkTheme(); document.documentElement.style.setProperty('--grid-size', '180px');
        
        try {
            await this.dbManager.init();
            const saved = await this.dbManager.loadState();
            if(saved && saved.pages.length > 0) {
                document.getElementById('restore-banner').classList.remove('hidden');
                document.getElementById('restoreBtn').addEventListener('click', () => this.restoreSession(saved));
            }
        } catch(e) { console.log("DB Init Error", e); }
    }

    // --- UX UTILITIES ---
    showToast(message, type='success') {
        const container = document.getElementById('toast-container');
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

    // --- LAZY LOADING & HIGH DPI ---
    initIntersectionObserver() {
        const options = { root: document.getElementById('page-grid-container'), rootMargin: '300px', threshold: 0 };
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

    // --- RENDER GRID ---
    renderAllPages() { this.pageGrid.innerHTML=''; this.pages.forEach((p,i)=>this.renderThumbnail(p,i)); }
    renderNewPages() { const existing=new Set([...this.pageGrid.children].map(el=>el.dataset.id)); this.pages.forEach((p,i)=>{ if(!existing.has(p.id)) this.renderThumbnail(p,i); }); }
    
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
                    <span class="text-[10px] text-slate-400">Page ${pageData.sourcePageIndex+1}</span>
                </div>
                <div class="page-actions flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"><button class="rotate-ccw-btn hover:text-indigo-600 text-slate-400">↶</button><input type="number" class="page-order-input w-6 text-center bg-transparent font-bold text-slate-500" value="${index+1}"><button class="rotate-cw-btn hover:text-indigo-600 text-slate-400">↷</button></div>
            </div>`;
        item.querySelector('.page-checkbox').addEventListener('click', e => { e.stopPropagation(); this.toggleSelection(pageData.id); });
        item.querySelector('input').addEventListener('click', e=>e.stopPropagation());
        this.pageGrid.appendChild(item);
        this.observer.observe(item);
    }

    async actuallyDrawCanvas(item, pageData) {
        const canvas = item.querySelector('canvas');
        const container = item.querySelector(`#cv-cont-${pageData.id}`);
        const skeleton = item.querySelector('.skeleton-shimmer');
        const dpr = window.devicePixelRatio || 1;

        if(pageData.type==='blank'){
            canvas.width=150*dpr; canvas.height=200*dpr;
            const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
            ctx.fillStyle='white'; ctx.fillRect(0,0,150,200); ctx.strokeStyle='#e2e8f0'; ctx.strokeRect(0,0,150,200);
        } else if(pageData.type==='image'){
            const img=new Image(); img.src=URL.createObjectURL(pageData.sourceFile.file);
            img.onload=()=>{
                const r=img.height/img.width; 
                canvas.width=200*dpr; canvas.height=200*r*dpr;
                const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
                ctx.translate(100, 100*r); ctx.rotate((pageData.rotation*Math.PI)/180);
                if(pageData.rotation%180!==0) ctx.drawImage(img, -100*r, -100, 200*r, 200);
                else ctx.drawImage(img, -100, -100*r, 200, 200*r);
            };
        } else {
            try {
                const page=await pageData.sourceFile.pdfDoc.getPage(pageData.sourcePageIndex+1);
                const viewport=page.getViewport({scale: (250/page.getViewport({scale:1}).width) * dpr, rotation:pageData.rotation});
                canvas.width=viewport.width; canvas.height=viewport.height;
                // canvas.style.width = `${viewport.width/dpr}px`; canvas.style.height = `${viewport.height/dpr}px`;
                await page.render({canvasContext:canvas.getContext('2d'), viewport}).promise;
            } catch(e){}
        }
        
        // Reveal
        if(skeleton) skeleton.remove();
        container.classList.remove('opacity-0');
    }

    // --- MARQUEE SELECTION ---
    initMarqueeSelection() {
        const container = document.getElementById('page-grid-container');
        let isSelecting = false;
        let startX, startY;
        let marquee = null;

        container.addEventListener('mousedown', e => {
            if(e.target !== container && e.target !== document.getElementById('page-grid')) return;
            isSelecting = true;
            startX = e.clientX;
            startY = e.clientY + container.scrollTop;
            
            marquee = document.createElement('div');
            marquee.className = 'marquee-box';
            marquee.style.left = startX + 'px';
            marquee.style.top = startY + 'px'; // Fix scrolling offset logic
            container.appendChild(marquee);
            
            // If not holding ctrl/shift, clear
            if(!e.ctrlKey && !e.shiftKey) { this.selectedPageIds.clear(); this.updateSelectionUI(); }
        });

        container.addEventListener('mousemove', e => {
            if(!isSelecting) return;
            const currentX = e.clientX;
            const currentY = e.clientY + container.scrollTop; // Fix offset
            
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            const left = Math.min(currentX, startX);
            const top = Math.min(currentY, startY); // Fix offset
            
            marquee.style.width = width + 'px';
            marquee.style.height = height + 'px';
            marquee.style.left = left + 'px';
            marquee.style.top = (Math.min(e.clientY, startY - container.scrollTop) + container.scrollTop) + 'px'; // Tricky scrolling math fix
            
            // Note: Proper scroll handling for marquee in overflow containers is complex in raw JS.
            // Simplified: Just selecting based on viewport intersection for now.
        });

        document.addEventListener('mouseup', e => {
            if(!isSelecting) return;
            isSelecting = false;
            
            // Calculate intersection
            const rect = marquee.getBoundingClientRect();
            document.querySelectorAll('.page-item').forEach(item => {
                const itemRect = item.getBoundingClientRect();
                if (rect.left < itemRect.right && rect.right > itemRect.left && rect.top < itemRect.bottom && rect.bottom > itemRect.top) {
                    this.selectedPageIds.add(item.dataset.id);
                }
            });
            this.updateSelectionUI();
            if(marquee) marquee.remove();
        });
    }

    // --- EDITOR LOGIC ---
    async openPageEditor(pageId) {
        const page = this.pages.find(p => p.id === pageId);
        if(!page) return;
        this.editingPageId = pageId;
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
        
        // High quality render
        if (page.type === 'blank') {
            canvas.width = 420*dpr; canvas.height = 600*dpr;
            canvas.style.width="420px"; canvas.style.height="600px";
            ctx.scale(dpr,dpr); ctx.fillStyle='white'; ctx.fillRect(0,0,420,600);
        } else if (page.type === 'image') {
            const img = new Image(); img.src = URL.createObjectURL(page.sourceFile.file);
            await new Promise(r => img.onload = r);
            const ratio = img.height / img.width;
            canvas.width = (containerHeight/ratio)*dpr; canvas.height = containerHeight*dpr;
            canvas.style.width=`${containerHeight/ratio}px`; canvas.style.height=`${containerHeight}px`;
            ctx.scale(dpr,dpr); ctx.drawImage(img, 0, 0, containerHeight/ratio, containerHeight);
        } else {
            const pdfPage = await page.sourceFile.pdfDoc.getPage(page.sourcePageIndex + 1);
            const viewport = pdfPage.getViewport({ scale: 2 }); // Base high res scale
            const scaleFactor = containerHeight / viewport.height;
            canvas.width = viewport.width * scaleFactor * dpr; canvas.height = containerHeight * dpr;
            canvas.style.width=`${viewport.width * scaleFactor}px`; canvas.style.height=`${containerHeight}px`;
            
            // PDF.js render requires unscaled context usually, handled by viewport transform
            const renderViewport = pdfPage.getViewport({ scale: 2 * scaleFactor * dpr });
            await pdfPage.render({ canvasContext: ctx, viewport: renderViewport }).promise;
        }
    }

    renderOverlayLayers() {
        const container = document.getElementById('overlay-container');
        const canvas = document.getElementById('modal-bg-canvas');
        container.innerHTML = '';
        
        // Align container
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
        
        // Show/Hide Controls
        const controls = document.getElementById('layer-controls');
        if(this.activeTextIndex > -1) {
            controls.classList.remove('hidden', 'opacity-50', 'pointer-events-none');
            const l = this.tempTextOverlays[this.activeTextIndex];
            document.getElementById('txt-content').value = l.text;
            document.getElementById('txt-size').value = l.size;
            document.getElementById('txt-color').value = l.color;
            document.getElementById('txt-font').value = l.font;
            document.getElementById('txt-rotation').value = l.rotation;
        } else {
            controls.classList.add('opacity-50', 'pointer-events-none');
        }
    }

    addTextLayerToEditor() {
        const text = document.getElementById('txt-content').value || "New Text";
        this.tempTextOverlays.push({ text, xPercent: 50, yPercent: 50, size: 24, color: '#000000', opacity: 1, rotation: 0, font: 'Helvetica' });
        this.activeTextIndex = this.tempTextOverlays.length - 1;
        this.renderOverlayLayers();
    }

    setActiveLayer(index) { this.activeTextIndex = index; this.renderOverlayLayers(); }
    deleteActiveLayer() { if(this.activeTextIndex > -1) { this.tempTextOverlays.splice(this.activeTextIndex, 1); this.activeTextIndex = -1; this.renderOverlayLayers(); } }
    updateActiveTextLayer() {
        if(this.activeTextIndex === -1) return;
        const l = this.tempTextOverlays[this.activeTextIndex];
        l.text = document.getElementById('txt-content').value;
        l.size = parseInt(document.getElementById('txt-size').value);
        l.color = document.getElementById('txt-color').value;
        l.font = document.getElementById('txt-font').value;
        l.rotation = parseInt(document.getElementById('txt-rotation').value);
        this.renderOverlayLayers();
    }
    
    startDrag(e, index, container) {
        let isDragging = true;
        const rect = container.getBoundingClientRect();
        // Adjust for rotation if needed (simplified here)
        const moveHandler = (ev) => {
            if(!isDragging) return;
            // Calculate mouse pos relative to rotated container is tricky.
            // Simplified: Assuming 0 deg rotation for drag math logic for this snippet or using delta
            // For robust rotated drag, we map screen coordinates to the container's transform matrix.
            // Here we use simple bounding box logic for 0 deg.
            
            const x = ev.clientX - rect.left;
            const y = ev.clientY - rect.top;
            
            // Simple constraint
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
            this.pages.forEach(p => {
                p.rotation = (p.rotation + this.tempRotation - (this.pages.find(x=>x.id===this.editingPageId).rotation)) % 360;
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

    // --- STANDARD APP LOGIC (Restored from previous versions) ---
    initContextMenu() {
        document.addEventListener('click', () => this.contextMenu.classList.add('hidden'));
        this.pageGrid.addEventListener('contextmenu', e => {
            const item = e.target.closest('.page-item'); if(!item) return;
            e.preventDefault(); this.contextTargetId = item.dataset.id;
            let x = e.clientX, y = e.clientY;
            if(x + 200 > window.innerWidth) x = window.innerWidth - 210;
            if(y + 200 > window.innerHeight) y = window.innerHeight - 210;
            this.contextMenu.style.left = `${x}px`; this.contextMenu.style.top = `${y}px`;
            this.contextMenu.classList.remove('hidden');
        });
        document.getElementById('ctx-edit').onclick = () => this.openPageEditor(this.contextTargetId);
        document.getElementById('ctx-delete').onclick = () => this.deletePages([this.contextTargetId]);
        document.getElementById('ctx-duplicate').onclick = () => { this.selectedPageIds.clear(); this.selectedPageIds.add(this.contextTargetId); this.duplicateSelected(); };
        document.getElementById('ctx-rotate-cw').onclick = () => this.rotatePages([this.contextTargetId], 90);
        document.getElementById('ctx-rotate-ccw').onclick = () => this.rotatePages([this.contextTargetId], -90);
    }

    async restoreSession(saved) {
        this.showLoader(true, 'Restoring...');
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
    updateHistoryButtons() { document.getElementById('undoBtn').disabled = !this.historyStack.length; document.getElementById('redoBtn').disabled = !this.redoStack.length; }

    initSortable() { Sortable.create(this.pageGrid, { animation: 200, ghostClass: 'sortable-ghost', onStart: () => this.saveState(), onEnd: () => this.updateDataOrderFromDOM() }); }

    initEventListeners() {
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.performUndo(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.performRedo(); }
            if ((e.key === 'Delete' || e.key === 'Backspace') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) this.deleteSelectedPages();
        });
        window.addEventListener('beforeunload', e => { if(this.pages.length) { e.preventDefault(); e.returnValue=''; } });
        
        document.getElementById('undoBtn').addEventListener('click', () => this.performUndo());
        document.getElementById('redoBtn').addEventListener('click', () => this.performRedo());
        document.getElementById('zoomSlider').addEventListener('input', e => document.documentElement.style.setProperty('--grid-size', `${e.target.value}px`));
        document.getElementById('darkModeToggle').addEventListener('click', () => document.documentElement.classList.toggle('dark'));
        
        // Grid/List View
        document.getElementById('viewGridBtn').addEventListener('click', () => { document.getElementById('page-grid').className = 'grid gap-6 dynamic-grid pb-20 view-grid'; });
        document.getElementById('viewListBtn').addEventListener('click', () => { document.getElementById('page-grid').className = 'view-list pb-20'; });

        // Files
        document.getElementById('filenameInput').addEventListener('input', e => e.target.value = e.target.value.replace(/[^a-zA-Z0-9-_ ]/g, ''));
        document.getElementById('startChooseFileBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('addFilesBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput').addEventListener('change', async e => { await this.addFiles(Array.from(e.target.files)); e.target.value=''; });

        // Sidebar
        document.getElementById('sidebar-close-btn').addEventListener('click', () => this.toggleSidebar(false));
        document.getElementById('menu-toggle-btn').addEventListener('click', () => this.toggleSidebar(true));
        document.getElementById('insertBlankBtn').addEventListener('click', () => this.insertBlankPage());
        document.getElementById('openTextModalBtn').addEventListener('click', () => { if(this.pages.length) this.openPageEditor(this.pages[0].id); else this.showToast('Add pages first', 'error'); });

        // Editor
        document.querySelector('.close-text-modal').addEventListener('click', () => { this.textModal.classList.add('hidden', 'opacity-0'); this.textModal.querySelector('div').classList.add('scale-95'); });
        document.getElementById('addTextLayerBtn').addEventListener('click', () => this.addTextLayerToEditor());
        document.getElementById('editor-rotate-cw').addEventListener('click', () => this.editorRotate(90));
        document.getElementById('editor-rotate-ccw').addEventListener('click', () => this.editorRotate(-90));
        document.getElementById('savePageEdits').addEventListener('click', () => this.savePageEdits(false));
        ['txt-content', 'txt-size', 'txt-color', 'txt-rotation', 'txt-font'].forEach(id => document.getElementById(id).addEventListener('input', () => this.updateActiveTextLayer()));
        document.getElementById('delete-layer-btn').addEventListener('click', () => this.deleteActiveLayer());

        // Actions
        document.getElementById('selectAllBtn').addEventListener('click', () => this.selectAll());
        document.getElementById('deselectAllBtn').addEventListener('click', () => this.deselectAll());
        document.getElementById('sortByNumberBtn').addEventListener('click', () => this.sortByNumber());
        document.getElementById('deleteSelectedBtn').addEventListener('click', () => this.deleteSelectedPages());
        document.getElementById('rotateSelectedBtn').addEventListener('click', () => this.rotateSelectedPages(90));
        document.getElementById('duplicateSelectedBtn').addEventListener('click', () => this.duplicateSelected());
        document.getElementById('saveBtn').addEventListener('click', () => this.createPdf());
        
        // Grid
        this.pageGrid.addEventListener('click', this.handlePageClick.bind(this));
        this.pageGrid.addEventListener('dblclick', e => { const item = e.target.closest('.page-item'); if(item) this.openPageEditor(item.dataset.id); });

        ['startDropZone', 'main-view'].forEach(id => {
            const z = document.getElementById(id);
            z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('dragover'); });
            z.addEventListener('dragleave', e => { e.preventDefault(); z.classList.remove('dragover'); });
            z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('dragover'); this.addFiles(Array.from(e.dataTransfer.files)); });
        });
    }

    editorRotate(deg) {
        this.tempRotation = (this.tempRotation + deg) % 360;
        this.renderEditorCanvas();
        this.renderOverlayLayers();
    }

    toggleSidebar(show){ document.querySelector('.app-container').classList.toggle('sidebar-mobile-open', show); document.getElementById('sidebar-overlay').classList.toggle('hidden', !show); if(show) document.getElementById('sidebar').classList.remove('-translate-x-full'); else document.getElementById('sidebar').classList.add('-translate-x-full'); }
    updateSourceFileList(){ const u=new Set(this.pages.map(p=>p.sourceFile.id)); const f=this.sourceFiles.filter(x=>u.has(x.id)||x.type==='blank'); document.getElementById('sourceFileList').innerHTML=f.map(x=>`<div class="p-2 text-xs bg-slate-100 dark:bg-slate-700 rounded mb-1 truncate">${x.name}</div>`).join(''); }
    updateStatus(){ this.updateSelectionUI(); if(!this.pages.length) this.clearWorkspace(); }
    async clearWorkspace(){ this.saveState(); this.pages=[]; this.sourceFiles=[]; this.selectedPageIds.clear(); this.renderAllPages(); document.getElementById('start-screen').classList.remove('hidden'); document.querySelector('.app-container').classList.add('hidden'); await this.dbManager.clear(); }
    showLoader(s,t){ document.getElementById('loader').classList.toggle('hidden', !s); document.getElementById('loader-text').innerText=t; }
    checkTheme(){ if(window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark'); }
    
    // Core Actions (Delete, Dup, Rotate, Sort) - Same logic as before
    deleteSelectedPages(){ if(this.selectedPageIds.size) this.deletePages(Array.from(this.selectedPageIds)); }
    deletePages(ids){ this.saveState(); this.pages=this.pages.filter(p=>!ids.includes(p.id)); this.selectedPageIds.clear(); this.renderAllPages(); this.updateStatus(); this.showToast('Pages deleted'); }
    duplicateSelected(){ if(!this.selectedPageIds.size) return; this.saveState(); const n=[]; this.pages.forEach(p=>{ n.push(p); if(this.selectedPageIds.has(p.id)) n.push({id:`page_${Date.now()}_dup_${Math.random()}`, sourceFile:p.sourceFile, sourcePageIndex:p.sourcePageIndex, type:p.type, rotation:p.rotation, textOverlays:JSON.parse(JSON.stringify(p.textOverlays||[]))}); }); this.pages=n; this.renderAllPages(); this.updateStatus(); this.showToast('Pages duplicated'); }
    rotateSelectedPages(deg){ if(this.selectedPageIds.size) this.rotatePages(Array.from(this.selectedPageIds), deg); }
    rotatePages(ids,deg){ this.saveState(); ids.forEach(id=>{ const p=this.pages.find(x=>x.id===id); if(p) p.rotation=(p.rotation+deg+360)%360; }); this.renderAllPages(); this.showToast('Pages rotated'); }
    sortByNumber(){ this.saveState(); const m=new Map(); document.querySelectorAll('.page-order-input').forEach(i=>m.set(i.closest('.page-item').dataset.id, parseInt(i.value)||9999)); this.pages.sort((a,b)=>m.get(a.id)-m.get(b.id)); this.renderAllPages(); this.showToast('Sorted by number'); }
    updateDataOrderFromDOM(){ const n=[]; [...this.pageGrid.children].forEach(el=>n.push(this.pages.find(p=>p.id===el.dataset.id))); this.pages=n; this.renderAllPages(); }
    selectAll(){ this.pages.forEach(p=>this.selectedPageIds.add(p.id)); this.updateSelectionUI(); }
    deselectAll(){ this.selectedPageIds.clear(); this.updateSelectionUI(); }
    
    // Update Selection UI (Handle floating island)
    updateSelectionUI() {
        [...this.pageGrid.children].forEach(el => {
            const s=this.selectedPageIds.has(el.dataset.id);
            if(s) { el.classList.add('selected'); el.querySelector('.page-checkbox').checked=true; el.querySelector('.page-checkbox-wrapper').classList.remove('opacity-0'); }
            else { el.classList.remove('selected'); el.querySelector('.page-checkbox').checked=false; el.querySelector('.page-checkbox-wrapper').classList.add('opacity-0'); }
        });
        document.getElementById('selection-count').innerText = `${this.selectedPageIds.size} selected`;
        if(this.selectedPageIds.size > 0) document.getElementById('contextual-footer').classList.remove('hidden-island');
        else document.getElementById('contextual-footer').classList.add('hidden-island');
    }

    hexToRgb(h){ const r=parseInt(h.substr(1,2),16)/255, g=parseInt(h.substr(3,2),16)/255, b=parseInt(h.substr(5,2),16)/255; return {r,g,b}; }

    async createPdf(preview) {
        if(!this.pages.length) return; this.showLoader(true, 'Generating...');
        try {
            const doc = await PDFLib.PDFDocument.create();
            const fonts = { 'Helvetica': await doc.embedFont(PDFLib.StandardFonts.Helvetica), 'TimesRoman': await doc.embedFont(PDFLib.StandardFonts.TimesRoman), 'Courier': await doc.embedFont(PDFLib.StandardFonts.Courier) };
            
            for (const p of this.pages) {
                let page;
                if(p.type==='blank') page = doc.addPage([595,842]);
                else if(p.type==='image') {
                    const buff = await p.sourceFile.file.arrayBuffer();
                    const emb = p.sourceFile.type.includes('png') ? await doc.embedPng(buff) : await doc.embedJpg(buff);
                    const r=p.rotation%360, rot=r===90||r===270;
                    page = doc.addPage([rot?emb.height:emb.width, rot?emb.width:emb.height]);
                    const opts = {x:0, y:0, width:emb.width, height:emb.height, rotate:PDFLib.degrees(r)};
                    if(r===90){opts.x=emb.height;opts.y=0;} else if(r===180){opts.x=emb.width;opts.y=emb.height;} else if(r===270){opts.x=0;opts.y=emb.width;}
                    page.drawImage(emb, opts);
                } else {
                    const [cp] = await doc.copyPages(p.sourceFile.pdfLibDoc, [p.sourcePageIndex]);
                    cp.setRotation(PDFLib.degrees((cp.getRotation().angle + p.rotation) % 360));
                    page = doc.addPage(cp);
                }
                if(p.textOverlays) {
                    const {width, height} = page.getSize();
                    p.textOverlays.forEach(t => {
                        const x = width * (t.xPercent/100);
                        const y = height - (height * (t.yPercent/100));
                        page.drawText(t.text, {
                            x, y, size: t.size, font: fonts[t.font]||fonts['Helvetica'],
                            color: PDFLib.rgb(this.hexToRgb(t.color).r, this.hexToRgb(t.color).g, this.hexToRgb(t.color).b), 
                            opacity: t.opacity || 1,
                            rotate: PDFLib.degrees(t.rotation || 0),
                            xCentered: true, yCentered: true
                        });
                    });
                }
            }
            const pdfBytes = await doc.save();
            const blob = new Blob([pdfBytes], {type: 'application/pdf'});
            const url = URL.createObjectURL(blob);
            if(preview) window.open(url, '_blank');
            else {
                const a = document.createElement('a'); a.href = url;
                a.download = (document.getElementById('filenameInput').value || 'document') + '.pdf';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                this.showToast('PDF Exported Successfully');
            }
        } catch(e) { console.error(e); this.showToast('Error: '+e.message, 'error'); }
        this.showLoader(false);
    }
}

document.addEventListener('DOMContentLoaded', () => new VisualPDFTool());
