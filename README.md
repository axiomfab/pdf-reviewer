<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="PDF Reviewer for AGY" />
</p>

<h1 align="center">📄 PDF Reviewer for Antigravity (AGY) 2.0</h1>

<p align="center">
  An official Antigravity 2.0 UI plugin, sidecar, and MCP tool suite that renders compiled PDFs live inside the <b>Right-Hand Auxiliary Pane</b> with automatic hot-reloading and empowers MCP-compliant agents to inspect, manage, and embed ISO 32000 PDF annotations directly.
</p>

<p align="center">
  <a href="https://github.com/axiomfab/pdf-reviewer"><b>Repository</b>: github.com/axiomfab/pdf-reviewer</a>
</p>

---

> [!NOTE]
> ### 🎨 100% Heavily Vibe Coded
> This plugin is **heavily vibe coded**. Built through fast, fluid pair programming sessions with Antigravity agents, it prioritizes immediate developer ergonomics, rapid iteration, and direct agent autonomy over enterprise ceremonial overhead. It works, it's fast, and the vibes are immaculate. If you spot code that looks delightfully unhinged or want to add a feature, tell your agent to vibe code a PR!

---

## 📦 Installation

### Quick Install (Antigravity CLI)
Run the following command in your terminal:
```bash
agy plugin install https://github.com/axiomfab/pdf-reviewer
```
Then install dependencies in the plugin directory:
```bash
cd ~/.gemini/config/plugins/pdf-reviewer && npm install
```

### Manual Install
Clone the repository directly into your Antigravity plugins directory:
```bash
git clone https://github.com/axiomfab/pdf-reviewer.git ~/.gemini/config/plugins/pdf-reviewer
cd ~/.gemini/config/plugins/pdf-reviewer
npm install
```
*Note: Restart your Antigravity session or reload the window after installation to discover the newly mounted plugin.*

---

## 🚀 Key Features

* **Embedded Auxiliary View**: Renders directly inside the Antigravity 2.0 auxiliary side panel (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
* **Instant Hot-Reload**: Automatically detects workspace file changes (e.g. from `pdflatex`, `typst watch`, or `marp`) and refreshes seamlessly without losing your current zoom or scroll position.
* **Native ISO 32000 Annotations**: Interactive in-panel reviewing with:
  * 🔤 **Text Comments**: Highlight text spans and attach comments.
  * ✂️ **Area Snip**: Box diagrams, math equations, or charts with custom comments.
* **Native MCP Server (`pdf_annotations`)**: Direct Model Context Protocol tool integration allowing your agent to inspect user feedback and manipulate annotations directly inside the PDF without CLI shell workarounds.
* **Zero Heavy Dependencies**: Built purely with `pdf-lib` for robust vector PDF manipulation and Node.js standard libraries for stdio JSON-RPC.
* **Multi-Document Scanner**: Automatically finds PDF documents across project workspaces (root, `build/`, `output/`) with a one-click dropdown switcher.

---

## 🛠️ Usage

### 1. Sidecar UI
Launch or open the PDF Reviewer from any Antigravity chat session using the sidecar link:
```markdown
[PDF Reviewer](sidecar://pdf-reviewer/panel/)
```

### 2. Native MCP Tool Suite
The plugin registers a local stdio MCP server exposing 4 core tools to the agent:

| MCP Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| **`mcp_pdf_annotations_list`** | Extract all ISO 32000 annotations (`/Highlight`, `/Text`, `/Square`, `/Stamp`, `/Ink`, `/FreeText`) | `{ pdfPath: string, page?: number }` |
| **`mcp_pdf_annotations_add`** | Programmatically embed an annotation into the PDF | `{ pdfPath, page, type, comment, selectedText?, rect? }` |
| **`mcp_pdf_annotations_delete`** | Remove a specific resolved annotation by ID | `{ pdfPath: string, commentId: string }` |
| **`mcp_pdf_annotations_clear`** | Clear all annotations from a target PDF once addressed | `{ pdfPath: string }` |

### 3. Terminal CLI Fallback
You can also run headless annotation management straight from your terminal:
```bash
# List all annotations
node sidecars/panel/pdf_annotations.mjs list <path-to-pdf>

# Delete a specific annotation
node sidecars/panel/pdf_annotations.mjs delete <path-to-pdf> <commentId>

# Clear all annotations
node sidecars/panel/pdf_annotations.mjs clear <path-to-pdf>
```

---

## 🧪 Testing

The plugin includes unit test coverage for PDF scanning, ISO 32000 annotation lifecycle, error handling, and MCP JSON-RPC protocol compliance:

```bash
npm test
```

---

## 📄 License

MIT © [axiomfab](https://github.com/axiomfab)
