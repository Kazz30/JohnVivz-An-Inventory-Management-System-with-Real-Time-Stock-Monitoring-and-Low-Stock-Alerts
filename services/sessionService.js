import { sequelize } from "../models/db.js";

// Deletes every stored browser session that belongs to the user. loadCurrentUser also
// rejects deactivated users on each request, so this is the second line of defence.
export const endUserSessions = async (userId, { transaction } = {}) => {
  const [result] = await sequelize.query(
    "DELETE FROM `Sessions` WHERE JSON_VALID(`data`) AND CAST(JSON_UNQUOTE(JSON_EXTRACT(`data`, '$.userId')) AS UNSIGNED) = ?",
    { replacements: [Number(userId)], transaction }
  );
  return result?.affectedRows ?? 0;
};
