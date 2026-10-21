/**
 * Tool definitions and schemas for the PDF Annotations MCP server.
 */

export const TOOLS = [
  {
    name: 'mcp_pdf_annotations_list',
    description: 'List all ISO 32000 annotations (/Highlight, /Text, /Square, /Stamp, /Ink, /FreeText) from a target PDF, optionally filtered by page number.',
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
      },
      required: ['pdfPath'],
    },
  },
  {
    name: 'mcp_pdf_annotations_add',
    description: 'Embed a native ISO 32000 annotation or review comment into a PDF document. Used by LLMs and reviewers to attach feedback, notes, highlights, or area annotations to specific pages or text snippets.',
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
          description: 'Annotation or review comment content text.',
        },
        type: {
          type: 'string',
          enum: ['note', 'text', 'area', 'strike'],
          description: 'Annotation type: "note" (sticky note comment), "text" (highlight), "area" (bounding box), or "strike" (strikethrough & replace).',
        },
        replacement: {
          type: 'string',
          description: 'Optional proposed replacement text when type is "strike".',
        },
        author: {
          type: 'string',
          description: 'Optional name of the comment author (e.g. "AI Reviewer", "Gemini", "Antigravity").',
        },
        selectedText: {
          type: 'string',
          description: 'Optional text snippet in the PDF document being annotated or cited.',
        },
        imageB64: {
          type: 'string',
          description: 'Optional base64 image data associated with the annotation.',
        },
        rect: {
          type: 'object',
          description: 'Optional bounding box {xRatio, yRatio, wRatio, hRatio} for area or note position. Auto-positioned in margin if omitted.',
        },
        textRects: {
          type: 'array',
          description: 'Optional list of bounding boxes {xRatio, yRatio, wRatio, hRatio} for text highlights.',
        },
        id: {
          type: 'string',
          description: 'Optional unique identifier for the annotation.',
        },
      },
      required: ['pdfPath', 'page', 'comment'],
    },
  },
  {
    name: 'mcp_pdf_annotations_modify',
    description: 'Modify an existing annotation or review comment in a target PDF document (e.g. updating comment text, author, or status).',
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
          type: 'string',
          description: 'Optional updated comment text content.',
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
    description: 'Remove a specific annotation from a target PDF document by ID.',
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
    description: 'Clear all annotations from a target PDF document.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: {
          type: 'string',
          description: 'Absolute path to the target PDF file.',
        },
      },
      required: ['pdfPath'],
    },
  },
];
