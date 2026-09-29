// Turn picked / pasted files into small base64 payloads for the chat composer.

export interface Att {
  kind: "image" | "pdf";
  dataUrl?: string; // image preview
  name?: string; // pdf chip label
  mediaType: string;
  data: string; // base64 (no prefix)
}

export const MAX_ATTACHMENTS = 4;
// Vercel's request-body limit is ~4.5MB; base64 inflates ~1.37×, so cap raw PDFs at 3MB.
export const MAX_PDF_BYTES = 3 * 1024 * 1024;

// Downscale + re-encode an image File to keep uploads small (and cheap to classify).
export function fileToImage(file: File): Promise<Att> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1600;
      let { width, height } = img;
      if (width > max || height > max) {
        const r = Math.min(max / width, max / height);
        width = Math.round(width * r);
        height = Math.round(height * r);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      resolve({ kind: "image", dataUrl, mediaType: "image/jpeg", data: dataUrl.split(",")[1] });
    };
    img.onerror = reject;
    img.src = url;
  });
}

// PDFs are sent as-is (no client-side shrinking possible).
export function fileToPdf(file: File): Promise<Att> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        kind: "pdf",
        name: file.name,
        mediaType: "application/pdf",
        data: (reader.result as string).split(",")[1],
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const isAttachable = (f: File) => f.type.startsWith("image/") || f.type === "application/pdf";

/** Encode a list of files; returns the attachments and any user-facing problem. */
export async function encodeFiles(files: File[]): Promise<{ atts: Att[]; error?: string }> {
  const atts: Att[] = [];
  let error: string | undefined;
  for (const f of files) {
    if (f.type.startsWith("image/")) atts.push(await fileToImage(f));
    else if (f.type === "application/pdf") {
      if (f.size > MAX_PDF_BYTES) {
        error = `${f.name} is too big — PDFs up to 3 MB.`;
        continue;
      }
      atts.push(await fileToPdf(f));
    }
  }
  return { atts, error };
}
