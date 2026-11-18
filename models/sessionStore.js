import session from "express-session";
import { DataTypes, Op } from "sequelize";
import { sequelize } from "./db.js";

const SessionRecord = sequelize.define("Session", {
  sid: { type: DataTypes.STRING(128), primaryKey: true },
  expiresAt: { type: DataTypes.DATE, allowNull: false },
  data: { type: DataTypes.TEXT("long"), allowNull: false }
}, { updatedAt: false, indexes: [{ name: "idx_sessions_expires_at", fields: ["expiresAt"] }] });

export class SequelizeSessionStore extends session.Store {
  constructor() {
    super();
    this.cleanupTimer = setInterval(() => {
      SessionRecord.destroy({ where: { expiresAt: { [Op.lte]: new Date() } } })
        .catch(error => console.error("Unable to clean expired sessions:", error));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    SessionRecord.findByPk(sid).then(async record => {
      if (!record) return callback(null, null);
      if (record.expiresAt <= new Date()) {
        await record.destroy();
        return callback(null, null);
      }
      callback(null, JSON.parse(record.data));
    }).catch(callback);
  }

  set(sid, sessionData, callback = () => {}) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + Number(sessionData.cookie?.maxAge || 8 * 60 * 60 * 1000));
    SessionRecord.upsert({
      sid,
      expiresAt,
      data: JSON.stringify(sessionData)
    }).then(() => callback(null)).catch(callback);
  }

  touch(sid, sessionData, callback = () => {}) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + Number(sessionData.cookie?.maxAge || 8 * 60 * 60 * 1000));
    SessionRecord.update({ expiresAt }, { where: { sid } })
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    SessionRecord.destroy({ where: { sid } })
      .then(() => callback(null))
      .catch(callback);
  }
}
