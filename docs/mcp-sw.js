/**
 * Internal MCP Server — runs inside Service Worker.
 *
 * Intercepts HTTP requests to /__mcp/internal and handles the MCP
 * Streamable HTTP transport (JSON-RPC 2.0). Tool execution that needs
 * page context (eval, DOM) is proxied via MessageChannel.
 *
 * This file is hand-written pure JS in public/ — no build step.
 */

/**
 * MCP prefix — derived from the SW's own scope URL so it works
 * regardless of the deployment base path (e.g. /js-ai/__mcp/internal).
 */
const MCP_PREFIX = new URL('__mcp/internal', self.registration.scope).pathname;

// ── Server identity ──────────────────────────────────────────────
const SERVER_INFO = { name: 'internal-mcp-server', version: '1.0.0' };

// ── Tool definitions (MCP format) ────────────────────────────────
const TOOLS = [
  {
    name: 'execute_javascript',
    description:
      'Execute JavaScript code in the browser sandbox. ' +
      'Available globals: _ (lodash), axios, Dexie, nanoid, md5, clipboard, ' +
      'jszip, pako, yaml, JSON5, FileSaver, localforage, abcjs, etc. ' +
      'The last expression value is returned. Promises are auto-resolved. ' +
      'Use console.log() for debug output.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute (last expression is the return value).',
        },
        purpose: {
          type: 'string',
          description: 'Short explanation of what this code does.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'kv_store_set',
    description:
      'Store a value that persists across conversation turns in a key-value store.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Storage key.' },
        value: { description: 'Any JSON-serializable value.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'kv_store_get',
    description: 'Retrieve a previously stored value by key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to look up.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'render_html',
    description:
      'Render arbitrary HTML or SVG content on the visual canvas (an isolated iframe sandbox). ' +
      'Use this for charts, diagrams, data visualization, or any visual output. ' +
      'The canvas is sandboxed (no access to the main page). Interactive JS (e.g. D3) is supported.',
    inputSchema: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description: 'HTML or SVG markup to render on the canvas.',
        },
      },
      required: ['html'],
    },
  },
  {
    name: 'render_abc_music',
    description:
      'Render ABC music notation as sheet music on the visual canvas. ' +
      'Use this to display musical scores, melodies, or any ABC notation as formatted sheet music. ' +
      'The ABC notation will be rendered as SVG sheet music in the canvas iframe.',
    inputSchema: {
      type: 'object',
      properties: {
        abc_notation: {
          type: 'string',
          description: 'ABC notation string. Example: "X:1\\nM:4/4\\nK:C\\n| C D E F | G A B c |"',
        },
      },
      required: ['abc_notation'],
    },
  },
  {
    name: 'play_abc_music',
    description:
      'Play ABC music notation using the Web Audio API. ' +
      'Use this to play melodies, test musical ideas, or let the user hear the composed music.',
    inputSchema: {
      type: 'object',
      properties: {
        abc_notation: {
          type: 'string',
          description: 'ABC notation string to play. Example: "X:1\\nM:4/4\\nK:C\\n| C D E F | G A B c |"',
        },
      },
      required: ['abc_notation'],
    },
  },
  {
    name: 'notes_list',
    description:
      'List all notes. ' +
      'Use this to view saved notes, search through notes by content or title, or get an overview of all notes.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Optional search text to filter notes by content or title (case-insensitive).',
        },
      },
    },
  },
  {
    name: 'notes_get',
    description:
      'Get a single note by its id. ' +
      'Use this to retrieve the full content of a specific note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Note id to retrieve.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notes_create',
    description:
      'Create a new note with the given content and optional title. ' +
      'The note will be added with an auto-generated id and timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note content (markdown supported).' },
        title: { type: 'string', description: 'Optional note title.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'notes_update',
    description:
      'Update an existing note content and/or title by its id. ' +
      'Only provided fields will be updated; omitted fields keep their existing values.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Note id to update.' },
        content: { type: 'string', description: 'New note content (omit to keep existing).' },
        title: { type: 'string', description: 'New note title (omit to keep existing).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notes_delete',
    description:
      'Delete a note by its id. ' +
      'Use this to remove unwanted or outdated notes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Note id to delete.' },
      },
      required: ['id'],
    },
  },
];

// ── KV Store (SW-side, for tools handled directly in SW) ────────
const kvStore = {};

// ── Shutdown flag ────────────────────────────────────────────────
let swActive = true;

// ── Lifecycle hooks ──────────────────────────────────────────────

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Listen for shutdown signal from the page.
 * On shutdown: stop intercepting fetch requests so the MCP client
 * can no longer connect through this SW.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'mcp-shutdown') {
    swActive = false;
  }
});

// ── Fetch interception ──────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  if (!swActive) return; // Shut down — let all requests pass through
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(MCP_PREFIX)) return;

  if (event.request.method === 'DELETE') {
    event.respondWith(new Response(null, { status: 204 }));
    return;
  }

  event.respondWith(handleRequest(event.request));
});

// ── MCP request router ──────────────────────────────────────────

async function handleRequest(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  const { method, params, id } = body;

  try {
    switch (method) {
      case 'initialize':
        return jsonRpcResponse(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return jsonRpcResponse(id, { tools: TOOLS });
      case 'tools/call':
        return await handleToolCall(id, params);
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return jsonRpcError(id, -32603, err.message);
  }
}

// ── Tool call handling ──────────────────────────────────────────

async function handleToolCall(id, params) {
  // KV store operations handled directly in the SW (no page context needed)
  if (params.name === 'kv_store_set' || params.name === 'kv_store_get') {
    return jsonRpcResponse(id, executeToolInSw(params.name, params.arguments));
  }

  // execute_javascript, render_html, render_abc_music, play_abc_music need page context — proxy via MessageChannel
  const result = await proxyToPage(params);
  return jsonRpcResponse(id, result);
}

function executeToolInSw(name, args) {
  switch (name) {
    case 'kv_store_set':
      kvStore[args.key] = args.value;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, key: args.key }) }] };
    case 'kv_store_get': {
      const value = args.key in kvStore ? kvStore[args.key] : null;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, key: args.key, value }) }] };
    }
    default:
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }
}

// ── Page proxy via MessageChannel ───────────────────────────────

function proxyToPage(params) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      resolve(event.data);
    };
    channel.port1.onmessageerror = () => {
      reject(new Error('MessageChannel communication with page failed'));
    };

    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
      if (clients.length === 0) {
        reject(new Error('No page client available'));
        return;
      }
      // Prefer the focused client, fall back to the first one
      const target = clients.find((c) => c.focused) || clients[0];
      target.postMessage(
        { type: 'mcp-tool-call', name: params.name, arguments: params.arguments },
        [channel.port2],
      );
    });
  });
}

// ── JSON-RPC helpers ────────────────────────────────────────────

function jsonRpcResponse(id, result) {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}
