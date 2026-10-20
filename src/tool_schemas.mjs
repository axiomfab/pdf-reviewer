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
    description: 'Embed a native ISO 32000 annotation into a PDF document.',
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
        type: {
          type: 'string',
          enum: ['text', 'area'],
          description: 'Annotation type: "text" (highlight) or "area" (bounding box).',
        },
        comment: {
          type: 'string',
          description: 'Annotation comment content text.',
        },
        selectedText: {
          type: 'string',
          description: 'Optional text snippet in the PDF document being annotated.',
        },
        imageB64: {
          type: 'string',
          description: 'Optional base64 image data associated with the annotation.',
        },
        rect: {
          type: 'object',
          description: 'Optional bounding box {xRatio, yRatio, wRatio, hRatio} for area annotations.',
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
      required: ['pdfPath', 'page', 'type', 'comment'],
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
