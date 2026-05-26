const defaultOptions = {
  nodeWidth: 190,
  nodeHeight: 70,
  portGap: 34,
  seriesGap: 64,
  parallelGap: 30,
  branchPad: 76,
  framePadX: 26,
  framePadTop: 44,
  framePadBottom: 18,
  margin: 18
};

const edgeKinds = new Set(["series", "parallel", "frame"]);

export function buildPlanarLayout(graph, options = {}) {
  const opts = { ...defaultOptions, ...options };
  const rootId = graph?.graph?.root;
  const nodesById = graph?.graph?.nodes;

  if (!rootId || !nodesById?.[rootId]) {
    throw new Error("Graph is missing a valid root node");
  }

  function graphNode(nodeId) {
    const node = nodesById[nodeId];
    if (!node) {
      throw new Error(`Unknown child node referenced by graph: ${nodeId}`);
    }
    return node;
  }

  function offsetPoint(point, dx, dy) {
    return { x: point.x + dx, y: point.y + dy };
  }

  function offsetComponent(component, dx, dy) {
    return {
      ...component,
      input: offsetPoint(component.input, dx, dy),
      output: offsetPoint(component.output, dx, dy),
      boxes: component.boxes.map((box) => ({ ...box, x: box.x + dx, y: box.y + dy })),
      frames: component.frames.map((frame) => ({ ...frame, x: frame.x + dx, y: frame.y + dy })),
      edges: component.edges.map((edge) => ({
        ...edge,
        points: edge.points.map((point) => offsetPoint(point, dx, dy))
      }))
    };
  }

  function mergeComponents(parts) {
    return {
      boxes: parts.flatMap((part) => part.boxes),
      frames: parts.flatMap((part) => part.frames),
      edges: parts.flatMap((part) => part.edges)
    };
  }

  function buildLeaf(nodeId) {
    const node = graphNode(nodeId);
    const width = opts.nodeWidth + opts.portGap * 2;
    const height = opts.nodeHeight;
    const centerY = height / 2;
    return {
      width,
      height,
      input: { x: 0, y: centerY },
      output: { x: width, y: centerY },
      boxes: [
        {
          id: nodeId,
          title: node.title || nodeId,
          kind: node.kind || "task",
          status: node.status || "pending",
          x: opts.portGap,
          y: 0,
          width: opts.nodeWidth,
          height: opts.nodeHeight
        }
      ],
      frames: [],
      edges: [
        { kind: "frame", points: [{ x: 0, y: centerY }, { x: opts.portGap, y: centerY }] },
        {
          kind: "frame",
          points: [
            { x: opts.portGap + opts.nodeWidth, y: centerY },
            { x: width, y: centerY }
          ]
        }
      ]
    };
  }

  function buildSeries(children) {
    if (children.length === 1) {
      return children[0];
    }

    const above = Math.max(...children.map((child) => child.input.y));
    const below = Math.max(...children.map((child) => child.height - child.input.y));
    const baseline = above;
    const height = above + below;
    const placed = [];
    const edges = [];
    let x = 0;
    let previousOutput = null;

    for (const child of children) {
      const placedChild = offsetComponent(child, x, baseline - child.input.y);
      placed.push(placedChild);

      if (previousOutput) {
        edges.push({ kind: "series", points: [previousOutput, placedChild.input] });
      }

      previousOutput = placedChild.output;
      x += child.width + opts.seriesGap;
    }

    const merged = mergeComponents(placed);
    return {
      width: x - opts.seriesGap,
      height,
      input: placed[0].input,
      output: placed[placed.length - 1].output,
      boxes: merged.boxes,
      frames: merged.frames,
      edges: [...merged.edges, ...edges]
    };
  }

  function buildParallel(children) {
    if (children.length === 1) {
      return children[0];
    }

    const maxChildWidth = Math.max(...children.map((child) => child.width));
    const width = opts.branchPad * 2 + maxChildWidth;
    const height = children.reduce((sum, child) => sum + child.height, 0) + opts.parallelGap * (children.length - 1);
    const centerY = height / 2;
    const splitX = opts.branchPad * 0.45;
    const joinX = width - splitX;
    const placed = [];
    const edges = [];
    let y = 0;

    for (const child of children) {
      const childY = y + child.input.y;
      const placedChild = offsetComponent(child, opts.branchPad, y);
      placed.push(placedChild);
      edges.push({
        kind: "parallel",
        points: [
          { x: 0, y: centerY },
          { x: splitX, y: centerY },
          { x: splitX, y: childY },
          placedChild.input
        ]
      });
      edges.push({
        kind: "parallel",
        points: [
          placedChild.output,
          { x: joinX, y: childY },
          { x: joinX, y: centerY },
          { x: width, y: centerY }
        ]
      });
      y += child.height + opts.parallelGap;
    }

    const merged = mergeComponents(placed);
    return {
      width,
      height,
      input: { x: 0, y: centerY },
      output: { x: width, y: centerY },
      boxes: merged.boxes,
      frames: merged.frames,
      edges: [...merged.edges, ...edges]
    };
  }

  function wrapFrame(nodeId, inner, depth) {
    const node = graphNode(nodeId);
    const x = opts.framePadX;
    const y = opts.framePadTop;
    const placed = offsetComponent(inner, x, y);
    const width = inner.width + opts.framePadX * 2;
    const height = inner.height + opts.framePadTop + opts.framePadBottom;
    const input = { x: 0, y: placed.input.y };
    const output = { x: width, y: placed.output.y };

    return {
      width,
      height,
      input,
      output,
      boxes: placed.boxes,
      frames: [
        {
          id: nodeId,
          title: node.title || nodeId,
          kind: node.kind || "series",
          status: node.status || "pending",
          x: 8,
          y: 10,
          width: width - 16,
          height: height - 18,
          depth
        },
        ...placed.frames
      ],
      edges: [
        ...placed.edges,
        { kind: "frame", points: [input, placed.input] },
        { kind: "frame", points: [placed.output, output] }
      ]
    };
  }

  function visit(nodeId, stack = [], depth = 0) {
    if (stack.includes(nodeId)) {
      throw new Error(`Cycle detected in graph: ${[...stack, nodeId].join(" -> ")}`);
    }

    const node = graphNode(nodeId);
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) {
      return buildLeaf(nodeId);
    }

    const childLayouts = children.map((childId) => visit(childId, [...stack, nodeId], depth + 1));
    const composition = node.kind === "parallel" ? buildParallel(childLayouts) : buildSeries(childLayouts);
    return wrapFrame(nodeId, composition, depth);
  }

  const root = visit(rootId);
  return {
    width: Math.ceil(root.width),
    height: Math.ceil(root.height),
    input: root.input,
    output: root.output,
    boxes: root.boxes,
    frames: root.frames,
    edges: root.edges.filter((edge) => edgeKinds.has(edge.kind))
  };
}

export function renderPlanarSvg(graph, options = {}) {
  const layout = options.layout || buildPlanarLayout(graph, options);
  const margin = options.margin ?? defaultOptions.margin;
  const width = layout.width + margin * 2;
  const height = layout.height + margin * 2;
  const body = [
    renderDefs(),
    `<g transform="translate(${margin} ${margin})">`,
    ...renderFrames(layout.frames),
    ...layout.edges.map(renderEdge),
    renderTerminal(layout.input, "source"),
    renderTerminal(layout.output, "sink"),
    ...layout.boxes.map(renderBox),
    "</g>"
  ].join("\n");

  return `<svg class="sp-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(graph.title || "Series-parallel graph")}">\n${body}\n</svg>`;
}

function renderDefs() {
  return `<defs>
  <filter id="sp-node-shadow" x="-10%" y="-20%" width="120%" height="140%">
    <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#17202a" flood-opacity="0.12"/>
  </filter>
</defs>`;
}

function renderFrames(frames) {
  return [...frames]
    .sort((a, b) => a.depth - b.depth)
    .map((frame) => {
      const className = `sp-frame status-${classToken(frame.status)}`;
      return `<g class="${className}" data-id="${escapeHtml(frame.id)}">
  <rect x="${round(frame.x)}" y="${round(frame.y)}" width="${round(frame.width)}" height="${round(frame.height)}" rx="8"/>
  <text x="${round(frame.x + 12)}" y="${round(frame.y + 22)}"><tspan class="sp-frame-id">${escapeHtml(frame.id)}</tspan> ${escapeHtml(frame.kind)}</text>
</g>`;
    });
}

function renderEdge(edge) {
  const path = edge.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`)
    .join(" ");
  return `<path class="sp-edge sp-edge-${edge.kind}" d="${path}"/>`;
}

function renderTerminal(point, label) {
  return `<g class="sp-terminal sp-terminal-${label}">
  <circle cx="${round(point.x)}" cy="${round(point.y)}" r="5"/>
  <text x="${round(point.x)}" y="${round(point.y - 10)}">${label}</text>
</g>`;
}

function renderBox(box) {
  const titleLines = wrapLabel(box.title, 26, 2);
  const className = `sp-node status-${classToken(box.status)}`;
  const idY = box.y + 20;
  const titleY = box.y + 42;
  const titleSpans = titleLines
    .map((line, index) => `<tspan x="${round(box.x + 12)}" dy="${index === 0 ? 0 : 15}">${escapeHtml(line)}</tspan>`)
    .join("");

  return `<g class="${className}" data-id="${escapeHtml(box.id)}">
  <rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" rx="8"/>
  <text class="sp-node-id" x="${round(box.x + 12)}" y="${round(idY)}">${escapeHtml(box.id)} · ${escapeHtml(box.kind)}</text>
  <text class="sp-node-title" x="${round(box.x + 12)}" y="${round(titleY)}">${titleSpans}</text>
</g>`;
}

function wrapLabel(value, maxChars, maxLines) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) {
      lines.push(line);
      line = word;
    } else {
      lines.push(word.slice(0, maxChars - 1));
      line = word.slice(maxChars - 1);
    }
    if (lines.length === maxLines) {
      break;
    }
  }

  if (line && lines.length < maxLines) {
    lines.push(line);
  }

  if (words.join(" ").length > lines.join(" ").length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\.+$/, "")}...`;
  }

  return lines.length > 0 ? lines : [""];
}

function classToken(value) {
  return String(value || "pending").toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function round(value) {
  return Number(value.toFixed(2));
}
