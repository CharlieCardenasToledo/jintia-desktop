/**
 * Renderizado defensivo para contenido generado por los motores de Ask Jintia.
 * `marked` convierte Markdown a HTML; este módulo reduce ese HTML a una lista
 * explícita de elementos y atributos antes de insertarlo en el WebView.
 */

const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "table",
  "tbody", "td", "th", "thead", "tr", "ul",
]);

const DROP_WITH_CONTENT = new Set([
  "audio", "button", "embed", "form", "iframe", "input", "link", "math",
  "meta", "object", "script", "style", "svg", "textarea", "video",
]);

const TABLE_SPAN_ATTRIBUTES = new Set(["colspan", "rowspan"]);

function safeWebUrl(value) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function sanitizeMarkdownHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");

  for (const node of [...template.content.querySelectorAll("*")]) {
    const tag = node.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      if (DROP_WITH_CONTENT.has(tag)) node.remove();
      else node.replaceWith(...node.childNodes);
      continue;
    }

    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const keepTableSpan = ["td", "th"].includes(tag) && TABLE_SPAN_ATTRIBUTES.has(name);
      const keepAnchorTitle = tag === "a" && name === "title";
      const keepAnchorHref = tag === "a" && name === "href";
      if (!keepTableSpan && !keepAnchorTitle && !keepAnchorHref) {
        node.removeAttribute(attribute.name);
      }
    }

    if (tag === "a") {
      const url = safeWebUrl(node.getAttribute("href") || "");
      node.removeAttribute("href");
      if (url) {
        node.dataset.jcSourceUrl = url;
        node.setAttribute("role", "link");
        node.setAttribute("tabindex", "0");
        node.setAttribute("aria-label", `${node.textContent?.trim() || "Abrir fuente"} (abre en el navegador)`);
      } else {
        node.replaceWith(...node.childNodes);
      }
    }
  }

  return template.innerHTML;
}

export function renderSafeMarkdown(markdown, parser) {
  return sanitizeMarkdownHtml(parser.parse(String(markdown ?? "")));
}

export function collectMarkdownSources(root) {
  if (!root) return [];
  return [...root.querySelectorAll("[data-jc-source-url]")].map(link => ({
    url: link.dataset.jcSourceUrl,
    label: link.textContent?.trim() || "Fuente citada",
  }));
}
