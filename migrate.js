import "./config/loadEnv.js";
import { Sequelize } from "sequelize";
import inquirer from "inquirer";
import { sequelize, Role } from "./models/index.js";
import {
  ensureApplicationIndexes, ensureEssLoginSchema, ensureHrIntegrationSchema, ensureIntegrationSchema, migrateLegacyUsers
} from "./models/legacyMigration.js";

const database = process.env.DB_NAME || "JohnVivz_Invntry_System";
const username = process.env.DB_USER || "root";
const password = process.env.DB_PASSWORD || "";
const host = process.env.DB_HOST || "localhost";
const port = Number(process.env.DB_PORT || 3306);

try {
  const { createDb } = await inquirer.prompt([{
    type: "confirm",
    name: "createDb",
    message: `Create database '${database}' if it does not exist?`,
    default: true
  }]);

  if (createDb) {
    const rootSequelize = new Sequelize("", username, password, {
      host, port, dialect: "mysql", logging: false
    });
    const safeDatabaseName = database.replace(/`/g, "");
    try {
      await rootSequelize.query(`CREATE DATABASE IF NOT EXISTS \`${safeDatabaseName}\`;`);
    } finally {
      await rootSequelize.close();
    }
  }

  await sequelize.authenticate();
  await ensureHrIntegrationSchema();
  const essSql = await ensureEssLoginSchema();
  for (const sql of essSql) console.log(`Applied: ${sql}`);
  await sequelize.sync();
  await migrateLegacyUsers();
  await Promise.all([
    Role.findOrCreate({ where: { name: "manager" } }),
    Role.findOrCreate({ where: { name: "supervisor" } }),
    Role.findOrCreate({ where: { name: "staff" } })
  ]);
  await ensureIntegrationSchema();
  await ensureApplicationIndexes();
  console.log("Database connected; tables and roles are ready.");
} catch (error) {
  console.error("Database setup failed:", error.message);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
