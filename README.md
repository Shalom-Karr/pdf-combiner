# Visual PDF Editor (Pro Local)


A professional-grade, browser-based toolkit for visually merging, splitting, editing, signing, and organizing PDF documents. 

**100% Client-Side Processing:** All file manipulations happen directly in your browser. Your documents are never uploaded to a server, ensuring absolute privacy and security.

**HIPAA Ready:** All file manipulations happen directly in your browser. Your documents are never uploaded to a server, making this tool safe for sensitive, medical, or legal documents.

## Live Demo

**Experience the live application here: [https://FileEditor.netlify.app/](https://FileEditor.netlify.app/)**

## Key Features

### 🎨 Advanced Page Editor
*   **Text Overlays**: Add text to any page with customizable fonts (Helvetica, Times, Courier), colors, sizes, and rotation.
*   **Signatures**: Draw and place signatures directly onto pages using the built-in signature pad.
*   **Stamps & Images**: Insert standard stamps (Confidential, Draft, Approved) or upload custom images/logos.
*   **Image Filters**: Adjust brightness and contrast for scanned documents or images.
*   **Non-Destructive Crop**: Visually crop pages or images to focus on specific content.

### 🗂️ Visual Organization & Workflow
*   **View Modes**: Toggle between **Grid View** (for sorting) and **List View** (for details). Use the **Zoom Slider** to adjust thumbnail sizes.
*   **Smart Selection**:
    *   **Marquee Select**: Click and drag to select multiple pages at once.
    *   **Range Input**: Type "1-3, 5" to instantly select specific page ranges.
    *   **Context Menu**: Right-click any page for quick actions (Rotate, Duplicate, Split, Delete).
*   **Session Restore**: Accidentally closed the tab? The app saves your state locally, allowing you to restore your previous session exactly where you left off.
*   **Undo/Redo**: Full history support (Ctrl+Z / Ctrl+Y) for peace of mind while editing.

### 📄 Document Manipulation
*   **Merge & Combine**: specific Drag and drop multiple PDFs and images (JPG/PNG) to combine them.
*   **Split Pages**: unique "Split Half" feature to divide a single page into two (Left/Right)—perfect for scanned book spreads.
*   **Insert Blank**: Add empty pages for notes or separators.
*   **Metadata Editor**: View and edit the PDF Title, Author, and Subject properties.
*   **Sorting**: Auto-sort pages **A-Z** by filename or **1-9** by custom page numbers.

### 📤 Export Options
*   **Flexible Saving**: Save **All Pages** or only **Selected Pages**.
*   **Page Numbering**: Optional checkbox to automatically add page numbers to the footer of the exported file.
*   **Print**: Print the composed document directly from the browser.
*   **Preview**: Open the generated PDF in a new tab for final verification.

## UI/UX Features
*   **Dark Mode**: Fully supported dark theme that respects system preferences or can be toggled manually.
*   **Floating Action Bar**: A contextual footer appears when pages are selected for quick access to bulk actions.
*   **Keyboard Shortcuts**: Support for Delete key, Arrow navigation, and Ctrl/Shift selection.

## How to Use

1.  **Start**: Drag and drop files onto the start screen or click "Browse Files".
2.  **Organize**: 
    *   Drag pages to reorder.
    *   Right-click a page for options like **Rotate** or **Split**.
    *   Use the sidebar to add blank pages or select ranges.
3.  **Edit**: 
    *   Double-click a page (or click "Edit Page" in the context menu) to open the **Editor Modal**.
    *   Add text, signatures, or adjust image settings, then click "Save & Close".
4.  **Export**: 
    *   Click the "Export PDF" button in the footer.
    *   Use the dropdown arrow to access Print, Save Selected, or Preview options.

## Technology Stack

This application is built with modern web technologies and requires no backend:

*   **PDF Manipulation**: [**pdf-lib**](https://pdf-lib.js.org/) (Creation, modification, and export).
*   **Rendering**: [**PDF.js**](https://mozilla.github.io/pdf.js/) (High-fidelity thumbnail generation).
*   **UI Styling**: [**Tailwind CSS**](https://tailwindcss.com/) (Responsive design and Dark Mode).
*   **Drag & Drop**: [**SortableJS**](https://sortablejs.github.io/Sortable/) (Smooth grid interactions).
*   **State Management**: **IndexedDB** (Local storage for session restoration).

## Browser Compatibility

Works in all modern desktop browsers including Chrome, Firefox, Edge, and Safari. 

---
*Note: Since this tool runs entirely in the browser, performance depends on your device's RAM and CPU, especially when handling very large or high-resolution PDF files.*
