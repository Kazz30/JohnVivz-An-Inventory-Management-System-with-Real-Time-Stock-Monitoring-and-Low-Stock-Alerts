import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Product images live under public/uploads/products and are served by the existing static handler.
// The stored value in Product.imagePath is the public path, e.g. /uploads/products/<32 hex>.png.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_PUBLIC_DIR = "/uploads/products";
export const imageDirectory = () => path.join(process.cwd(), "public", "uploads", "products");
const MANAGED_PATH = /^\/uploads\/products\/[a-f0-9]{32}\.(jpg|png|webp)$/;

const clientError = message => Object.assign(new Error(message), { status: 400 });

// Decide the real type from the file's first bytes. The browser-reported type and file name are never trusted.
export const detectImageType = buffer => {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: "jpg" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: "png" };
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return { extension: "webp" };
  return null;
};

export const isManagedImagePath = value => MANAGED_PATH.test(String(value || ""));

// Validates and stores an uploaded file (multer memory storage); returns the public path.
export const saveProductImage = async file => {
  if (!file || !file.buffer || file.size === 0) throw clientError("The selected image is empty.");
  if (file.size > MAX_IMAGE_BYTES) throw clientError("The image must be 5 MB or smaller.");
  const type = detectImageType(file.buffer);
  if (!type) throw clientError("Upload a JPG, PNG or WEBP image.");
  await fs.mkdir(imageDirectory(), { recursive: true });
  const name = `${randomBytes(16).toString("hex")}.${type.extension}`;
  await fs.writeFile(path.join(imageDirectory(), name), file.buffer, { flag: "wx" });
  return `${IMAGE_PUBLIC_DIR}/${name}`;
};

// Removes a stored image. Only paths this service created are ever deleted (no traversal, no external URLs).
export const deleteProductImage = async publicPath => {
  if (!isManagedImagePath(publicPath)) return;
  try { await fs.unlink(path.join(imageDirectory(), path.basename(publicPath))); } catch (error) { if (error.code !== "ENOENT") throw error; }
};
