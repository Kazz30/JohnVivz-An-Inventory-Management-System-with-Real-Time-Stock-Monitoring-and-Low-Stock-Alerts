import multer from "multer";
import { MAX_IMAGE_BYTES } from "../services/productImages.js";

// Reads the optional "image" file of the product forms into memory (nothing is written to disk here).
// It must run before the global CSRF check, which reads req.body._csrf, so it only parses requests from a
// signed-in manager; everyone else falls through and fails the CSRF check as before.
const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 40, fieldSize: 100 * 1024 }
}).single("image");

const PRODUCT_FORM = /^\/products(\/\d+\/update)?$/;

export const productImageUpload = (req, res, next) => {
  if (req.method !== "POST" || !PRODUCT_FORM.test(req.path)) return next();
  if (req.user?.Role?.name !== "manager" || !req.is("multipart/form-data")) return next();
  parser(req, res, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") error.message = "The image must be 5 MB or smaller.";
    else error.message = "The image upload could not be read. Choose a JPG, PNG or WEBP file.";
    error.status = 400;
    next(error);
  });
};
