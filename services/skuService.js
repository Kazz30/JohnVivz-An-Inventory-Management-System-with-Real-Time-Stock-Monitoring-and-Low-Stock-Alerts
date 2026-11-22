import { Op } from "sequelize";
import { Category, Product } from "../models/index.js";

// SKU format: CATEGORY PREFIX - PRODUCT CODE - UNIQUE NUMBER, e.g. DRK-COC-0001.
// The number is one running sequence shared by every category.
const SKU_PATTERN = /^[A-Z]{3}-[A-Z0-9]{3}-(\d+)$/;
const NUMBER_WIDTH = 4;

export const categoryPrefix = categoryName => {
  const name = String(categoryName || "").toLowerCase();
  if (/drink|beverage/.test(name)) return "DRK";
  if (/goods?\b/.test(name)) return "GDS";
  if (/hygiene/.test(name)) return "HYG";
  return "GEN";
};

// First three letters/digits of the product name (accents removed), padded with X.
export const productCode = productName => {
  const letters = String(productName || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (letters || "PRD").slice(0, 3).padEnd(3, "X");
};

export const formatSku = (prefix, code, number) =>
  `${prefix}-${code}-${String(number).padStart(NUMBER_WIDTH, "0")}`;

// Next number after the highest one already used by any generated-format SKU (archived products
// included). Legacy SKUs that do not match the format are ignored and never changed.
const nextNumber = async transaction => {
  const rows = await Product.findAll({
    attributes: ["sku"],
    where: { sku: { [Op.like]: "___-___-%" } },
    transaction,
    raw: true
  });
  let highest = 0;
  for (const { sku } of rows) {
    const match = SKU_PATTERN.exec(sku);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
};

// Builds the next free SKU. Callers that save it must still rely on the database's unique index
// and retry on a collision, because two requests can read the same "next" number at once.
export const generateSku = async ({ categoryId, productName, transaction } = {}) => {
  const category = categoryId ? await Category.findByPk(Number(categoryId), { transaction }) : null;
  return formatSku(categoryPrefix(category?.name), productCode(productName), await nextNumber(transaction));
};
