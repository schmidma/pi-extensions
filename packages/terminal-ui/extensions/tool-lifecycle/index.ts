import { stripVTControlCharacters } from "node:util";
import { createEditToolDefinition, type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, type TuiMouseEvent, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "../shared/terminal-text.ts";
import { Lifecycle, watchLifecycle } from "./lifecycle.ts";

// Optional cooperation for self-framed renderers. No cross-package imports or shared-state keys.
const headingMarker = Symbol.for("pi-extensions.tool-heading-marker");
type CallContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
// Public definitions expose stable native renderer identities, without executing a tool.
const nativeEdit = createEditToolDefinition(process.cwd());

class MarkedCall implements Component {
  private heading = -1;
  private innerWidth = 0;
  constructor(readonly inner: Component, private marker: () => string) {
    if ("focused" in inner) Object.defineProperty(this, "focused", {
      get: () => inner.focused, set: value => { inner.focused = value; },
    });
  }
  render(width: number): string[] {
    this.innerWidth = width;
    this.heading = -1;
    if (width <= 0) return [];
    // Leave space for a wide glyph before adding a two-column marker. Pi's Text
    // can overflow a one-column viewport on wide characters, so clamp that case.
    if (width <= 3) return this.inner.render(width).map(line => truncateToWidth(line, width, ""));
    let lines = this.inner.render(width);
    this.heading = lines.findIndex(line => sanitizeSingleLine(line).length > 0);
    // Keep body layout exactly as-is whenever the heading has room. When it
    // does not, let the original component reflow instead of dropping content.
    if (this.heading >= 0 && visibleWidth(stripVTControlCharacters(lines[this.heading]).trimEnd()) > width - 2) {
      this.innerWidth = width - 2;
      lines = this.inner.render(this.innerWidth);
      this.heading = lines.findIndex(line => sanitizeSingleLine(line).length > 0);
    }
    return lines.map((line, index) => index === this.heading ? truncateToWidth(`${this.marker()} ${line}`, width, "") : line);
  }
  invalidate() { this.inner.invalidate(); }
  handleInput(data: string) { this.inner.handleInput?.(data); }
  handleMouse(event: TuiMouseEvent) {
    return this.inner.handleMouse?.({ ...event, width: this.innerWidth,
      x: event.y === this.heading ? Math.max(0, event.x - 2) : event.x });
  }
  get wantsKeyRelease() { return this.inner.wantsKeyRelease; }
}

/** Native edit's Box(1, 1) owns a Text heading followed by its preview. Keep
 * that Box intact: the result renderer rebuilds it through state.callComponent. */
function markNativeEditHeading(component: unknown, marker: () => string) {
  if (!(component instanceof Box)) return;
  const first = component.children[0];
  const heading = first instanceof MarkedCall ? first.inner : first;
  if (!(heading instanceof Text)) return;
  component.children[0] = new MarkedCall(heading, marker);
  component.invalidate();
}

/** Equivalent to Pi 1.0.3's private call fallback; result/image fallback stays owned by Pi. */
function fallbackCall(name: string): NonNullable<ToolRenderers["renderCall"]> {
  return (args, theme, context) => {
    const heading = theme.fg("toolTitle", theme.bold(name));
    const entries = args == null ? [] : typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args) : [["args", args]];
    if (!entries.length) return new Text(heading, 0, 0);
    if (context.expanded) {
      const lines = entries.map(([key, value]) => {
        const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
        return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
      });
      return new Text(`${heading}\n${theme.fg("muted", lines.join("\n"))}`, 0, 0);
    }
    const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
    return new Text(`${heading} ${theme.fg("muted", pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs)}`, 0, 0);
  };
}

export function decorate(renderers: ToolRenderers | undefined, lifecycle: Lifecycle, name = "tool"): ToolRenderers | undefined {
  // A completely unknown tool uses a different, private legacy shell/result
  // fallback. Preserve it, rather than silently changing result truncation.
  if (!renderers || (renderers.renderShell === "self" && !renderers.renderCall)) return renderers;
  const renderCall = renderers.renderCall ?? fallbackCall(name);
  const isNativeEdit = renderCall === nativeEdit.renderCall && renderers.renderResult === nativeEdit.renderResult;
  return {
    ...renderers,
    renderCall(args, theme, context) {
      const marker = () => lifecycle.marker(context, theme);
      const previous = context.lastComponent;
      const innerContext: CallContext & { [key: symbol]: unknown } = { ...context,
        lastComponent: previous instanceof MarkedCall ? previous.inner : previous,
        [headingMarker]: marker };
      const component = renderCall(args, theme, innerContext);
      if (isNativeEdit) {
        markNativeEditHeading(component, marker);
        return component;
      }
      // Self-framed cards opt in to inserting the marker in their real heading.
      // An unknown shell may begin with a border, image, or blank padding; never guess.
      if (renderers.renderShell === "self") return component;
      return new MarkedCall(component, marker);
    },
    ...(isNativeEdit ? {
      renderResult(result, options, theme, context) {
        const component = renderers.renderResult!(result, options, theme, context);
        // A terminal diff/error may have replaced the native heading after renderCall.
        markNativeEditHeading(context.state.callComponent, () => lifecycle.marker(context, theme));
        return component;
      },
    } satisfies ToolRenderers : {}),
  };
}

export default function toolLifecycle(pi: ExtensionAPI) {
  const lifecycle = new Lifecycle();
  watchLifecycle(pi, lifecycle);
  pi.registerToolRenderer((name, next) => decorate(next(), lifecycle, name));
}
