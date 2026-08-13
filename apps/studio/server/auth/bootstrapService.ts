import crypto from 'node:crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db';

/**
 * Crea el primer SysAdmin al arrancar el servidor.
 * Idempotente: no hace nada si ya existe un SysAdmin en Platform.
 */
export async function bootstrapSysAdmin(): Promise<void> {
  const email = process.env.BOOTSTRAP_SYSADMIN_EMAIL?.trim();
  if (!email) return;

  if (!pool) {
    console.log(`[Bootstrap] Sin DB configurada — saltando bootstrap de SysAdmin.`);
    return;
  }

  const conn = await pool.getConnection();
  try {
    // Crear o recuperar el usuario indicado por BOOTSTRAP_SYSADMIN_EMAIL.
    const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
    await conn.execute<ResultSetHeader>(
      `INSERT INTO users (user_id, email, status, created_at, updated_at)
       VALUES (?, ?, 'active', NOW(), NOW())
       ON DUPLICATE KEY UPDATE status = 'active', updated_at = NOW()`,
      [userId, email],
    );

    const [userRows] = await conn.execute<RowDataPacket[]>(
      `SELECT user_id FROM users WHERE email = ?`,
      [email],
    );
    const actualUserId = userRows[0].user_id as string;

    const [existing] = await conn.execute<RowDataPacket[]>(
      `SELECT ra.assignment_id FROM role_assignments ra
       WHERE ra.user_id = ? AND ra.role = 'SysAdmin'
         AND ra.resource_type = 'Platform' AND ra.resource_id = 'global'
       LIMIT 1`,
      [actualUserId],
    );

    if (existing.length > 0) {
      console.log(`[Bootstrap] SysAdmin ya existe para: ${email} — omitiendo bootstrap.`);
      return;
    }

    // Asignar rol SysAdmin en Platform
    const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
    await conn.execute<ResultSetHeader>(
      `INSERT INTO role_assignments
         (assignment_id, user_id, role, resource_type, resource_id, granted_by_user_id, created_at)
       VALUES (?, ?, 'SysAdmin', 'Platform', 'global', ?, NOW())`,
      [assignmentId, actualUserId, actualUserId],
    );

    // Registrar security_event
    await conn.execute<ResultSetHeader>(
      `INSERT INTO security_events (event_type, severity, user_id, details_json)
       VALUES ('bootstrap.sysadmin_created', 'critical', ?, ?)`,
      [actualUserId, JSON.stringify({ email, source: 'BOOTSTRAP_SYSADMIN_EMAIL' })],
    );

    console.log(`[Bootstrap] ✅ SysAdmin creado para: ${email}`);
    console.log(`[Bootstrap] El admin debe hacer login con OTP en /login.`);
  } catch (err) {
    console.error(`[Bootstrap] ❌ Error al crear SysAdmin:`, err);
  } finally {
    conn.release();
  }
}
