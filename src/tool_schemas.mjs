/**
 * Tool definitions and schemas for the PDF Annotations MCP server.
 */

const ANNOTATION_TYPE_ENUM = ['note', 'text', 'area', 'highlight', 'underline', 'strikethrough', 'strike'];

export const TOOLS = [
  {
    name: 'mcp_pdf_annotations_list',
    description: 'List all ISO 32000 annotations and markups (/Highlight, /Underline, /StrikeOut, /Squiggly, /Text, /Square, /Stamp, /Ink, /FreeText) from a target PDF, optionally filtered by page number and/or annotation type.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: {
          type: 'string',
          description: 'Absolute path to the target PDF file.',
        },
        page: {
          type: 'integer',
          minimum: 1,
          description: 'Optional 1-based page number to filter annotations.',
        },
        type: {
          type: 'string',
          enum: ANNOTATION_TYPE_ENUM,
          description: 'Optional annotation type filter ("highlight", "underline", "strikethrough", "strike", "note", "text", or "area").',
        },
      },
      required: ['pdfPath'],
    },
  },
  {
    name: 'mcp_pdf_annotations_add',
    description: 'Embed a native ISO 32000 annotation or text markup (highlight, underline, strikethrough, sticky note, or area box) into a PDF document.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: {
          type: 'string',
          description: 'Absolute path to the target PDF file.',
        },
        page: {
          type: 'integer',
          minimum: 1,
          description: '1-based page number where the annotation will be placed.',
        },
        comment: {
          type: 'string',
          description: 'Annotation or review comment text. Required for "note", "text", and "area"; optional for "highlight", "underline", "strikethrough", and "strike".',
        },
        type: {
          type: 'string',
          enum: ANNOTATION_TYPE_ENUM,
          description: 'Annotation type: "highlight", "underline", "strikethrough" (or "strike"), "note" (sticky note), "text" (highlight with comment), or "area" (bounding box).',
        },
        replacement: {
          type: 'string',
          description: 'Optional proposed replacement text when type is "strikethrough" or "strike".',
        },
        author: {
          type: 'string',
          description: 'Optional name of the comment author (e.g. "AI Reviewer", "Gemini", "Antigravity").',
        },
        selectedText: {
          type: 'string',
          description: 'Optional text snippet in the PDF document being highlighted, underlined, struck through, or cited.',
        },
        imageB64: {
          type: 'string',
          description: 'Optional base64 image data associated with the annotation.',
        },
        rect: {
          type: 'object',
          description: 'Optional bounding box {xRatio, yRatio, wRatio, hRatio} for area, note, or single-span markup position.',
        },
        textRects: {
          type: 'array',
          description: 'Optional list of normalized bounding boxes {xRatio, yRatio, wRatio, hRatio} for highlights, underlines, or strikethroughs.',
        },
        id: {
          type: 'string',
          description: 'Optional unique identifier for the annotation.',
        },
      },
      required: ['pdfPath', 'page'],
    },
  },
  {
    name: 'mcp_pdf_annotations_modify',
    description: 'Modify an existing annotation or markup (highlight, underline, strikethrough, note, or area) in a target PDF document.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: {
          type: 'string',
          description: 'Absolute path to the target PDF file.',
        },
        commentId: {
          type: 'string',
          description: 'Unique ID of the annotation to modify.',
        },
        comment: {
          type: ['string', 'null'],
          description: 'Optional updated comment text content, or null to clear the note on a highlight/underline/strikethrough markup.',
        },
        type: {
          type: 'string',
          enum: ANNOTATION_TYPE_ENUM,
          description: 'Optional updated annotation type (e.g. convert between "highlight", "underline", and "strikethrough").',
        },
        replacement: {
          type: ['string', 'null'],
          description: 'Optional updated replacement text for strikethrough markups.',
        },
        selectedText: {
          type: ['string', 'null'],
          description: 'Optional updated text snippet associated with the annotation or markup.',
        },
        rect: {
          type: ['object', 'null'],
          description: 'Optional updated bounding box {xRatio, yRatio, wRatio, hRatio}.',
        },
        textRects: {
          type: ['array', 'null'],
          description: 'Optional updated list of bounding boxes {xRatio, yRatio, wRatio, hRatio} for markup QuadPoints.',
        },
        author: {
          type: 'string',
          description: 'Optional updated author name.',
        },
        status: {
          type: 'string',
          description: 'Optional updated status (e.g. "open", "resolved").',
        },
      },
      required: ['pdfPath', 'commentId'],
    },
  },
  {
    name: 'mcp_pdf_annotations_delete',
    description: 'Remove a specific annotation or markup (highlight, underline, strikethrough, note, area) from a target PDF document by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: {
          type: 'string',
          description: 'Absolute path to the target PDF file.',
        },
        commentId: {
          type: 'string',
          description: 'Unique ID of the annotation to remove.',
        },
      },
      required: ['pdfPath', 'commentId'],
    },
  },
  {
    name: 'mcp_pdf_annotations_clear',
    description: 'Clear all annotations (or all annotations of a specific type such as highlights, underlines, or strikethroughs) from a target PDF document.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: {
          type: 'string',
          description: 'Absolute path to the target PDF file.',
        },
        type: {
          type: 'string',
          enum: ANNOTATION_TYPE_ENUM,
          description: 'Optional annotation type filter to clear only matching annotations/markups.',
        },
      },
      required: ['pdfPath'],
    },
  },
];
