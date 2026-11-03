import type { ImageAttachment } from "./types";

export function imageAttachments(value: unknown): ImageAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("Attach up to 4 pictures.");
  let total = 0;
  return value.map((image: any) => {
    if (!image || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)
      || typeof image.data !== "string" || !image.data.length || image.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Invalid image attachment. Use PNG, JPEG, WebP or GIF.");
    const size = image.data.length / 4 * 3 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
    total += size;
    if (size > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) throw new Error("Pictures must be under 5 MB each and 10 MB combined.");
    return { name: String(image.name || "Picture").slice(0, 180), mimeType: image.mimeType, data: image.data };
  });
}

/** Separate encoded pictures from display text, including adapter replay formats. */
export function transcriptContent(text: string, existing: ImageAttachment[] = []): { text: string; images: ImageAttachment[] } {
  const images = [...existing];
  const original = text;
  const extract = (mimeType: string, data: string, name = "Picture") => {
    try {
      const [image] = imageAttachments([{ name, mimeType, data }]);
      if (!images.some((item) => item.mimeType === image.mimeType && item.data === image.data)) images.push(image);
      return "";
    } catch { return "[Picture data omitted]"; }
  };
  const uri = 'data:(image/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})';
  // Consume the Markdown wrapper as well so a removed URL cannot leave a broken image link.
  text = text.replace(new RegExp('!\\[([^\\]\\n]*)\\]\\(<?' + uri + '>?\\)', 'gi'), (_match, name, mime, data) => extract(mime.toLowerCase().replace('image/jpg', 'image/jpeg'), data, name || "Picture"));
  text = text.replace(new RegExp(uri, 'gi'), (_match, mime, data) => extract(mime.toLowerCase().replace('image/jpg', 'image/jpeg'), data));
  // Some adapters replay a bare encoded image. Only recognize known image signatures,
  // leaving ordinary code, hashes and other long tokens untouched.
  text = text.replace(/[A-Za-z0-9+/]{512,}={0,2}/g, (data) => {
    const mime = data.startsWith('/9j/') ? 'image/jpeg' : data.startsWith('iVBORw0KGgo') ? 'image/png' : data.startsWith('R0lGOD') ? 'image/gif' : data.startsWith('UklGR') && data.slice(11, 16) === 'XRUJQ' ? 'image/webp' : null;
    return mime ? extract(mime, data) : data;
  });
  return { text: text === original ? text : text.trim(), images };
}
