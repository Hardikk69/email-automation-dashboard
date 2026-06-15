const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function resp(statusCode, body) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const rawPath = (event.path || '').split('?')[0];
  const path = rawPath.replace(/^.*\/db/, '').replace(/^\/+/, '');

  try {
    const db = getPool();

    await db.query(`ALTER TABLE dashboard_config ADD COLUMN IF NOT EXISTS api_base_url TEXT`);
    await db.query(`ALTER TABLE dashboard_config ADD COLUMN IF NOT EXISTS sheet_url TEXT`);

    /* ── GET /config ── */
    if (event.httpMethod === 'GET' && path === 'config') {
      const { rows } = await db.query(
        `SELECT workspace, workflow, sheet_url, api_base_url FROM dashboard_config ORDER BY workspace, workflow`
      );
      const enriched = rows.map(r => ({
        workspace: r.workspace,
        workflow: r.workflow,
        sheet_url: r.sheet_url || '',
        apiBaseUrl: r.api_base_url || process.env.API_BASE_URL || 'http://localhost:8888',
      }));
      return resp(200, { campaigns: enriched });
    }

    /* ── POST /config ── */
    if (event.httpMethod === 'POST' && path === 'config') {
      const { workspace, workflow, sheet_url } = JSON.parse(event.body || '{}');
      if (!workspace || !workflow) return resp(400, { error: 'workspace and workflow required' });
      const defaultApi = process.env.API_BASE_URL || 'http://localhost:8888';
      await db.query(`
        INSERT INTO dashboard_config (workspace, workflow, sheet_url, api_base_url)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (workspace, workflow)
        DO UPDATE SET sheet_url = EXCLUDED.sheet_url, api_base_url = EXCLUDED.api_base_url
      `, [workspace, workflow, sheet_url || '', defaultApi]);
      return resp(200, { ok: true });
    }

    /* ── GET / — fetch email rows ── */
    if (event.httpMethod === 'GET' && path === '') {
      const q = event.queryStringParameters || {};
      const table = /^[a-z_][a-z0-9_]*$/i.test(q.table || '') ? q.table : 'email_logs';
      const params = [], where = [];
      if (q.workflow) { params.push(q.workflow); where.push(`workflow = $${params.length}`); }
      if (q.workspace) { params.push(q.workspace); where.push(`workspace = $${params.length}`); }
      // fallback support for old column names
      if (!q.workflow && q.workflow_id) { params.push(q.workflow_id); where.push(`workflow_id = $${params.length}`); }
      if (!q.workspace && q.employee) { params.push(q.employee); where.push(`employee = $${params.length}`); }
      const limit = Math.min(parseInt(q.limit) || 2000, 5000);
      params.push(limit);
      const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY sent_at DESC LIMIT $${params.length}`;
      const { rows } = await db.query(sql, params);
      return resp(200, rows);
    }
    
    if (event.httpMethod === 'GET' && path === 'sheet') {
      const url = event.queryStringParameters?.url;

      if (!url) {
        return resp(400, { error: 'url required' });
      }

      const r = await fetch(url);
      const text = await r.text();

      return {
        statusCode: 200,
        headers: {
          ...CORS,
          'Content-Type': 'text/plain'
        },
        body: text
      };
    }

    /* ── POST /retry ── */
    if (event.httpMethod === 'POST' && path === 'retry') {
      const { table = 'email_logs', id } = JSON.parse(event.body || '{}');
      if (!id) return resp(400, { error: 'id required' });
      const t = /^[a-z_][a-z0-9_]*$/i.test(table) ? table : 'email_logs';
      await db.query(`UPDATE ${t} SET status = 'pending' WHERE id = $1`, [id]);
      return resp(200, { ok: true });
    }

    /* ── POST /retry-bulk ── */
    if (event.httpMethod === 'POST' && path === 'retry-bulk') {
      const { table = 'email_logs', ids } = JSON.parse(event.body || '{}');
      if (!Array.isArray(ids) || !ids.length) return resp(400, { error: 'ids required' });
      const t = /^[a-z_][a-z0-9_]*$/i.test(table) ? table : 'email_logs';
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      await db.query(`UPDATE ${t} SET status = 'pending' WHERE id IN (${ph})`, ids);
      return resp(200, { ok: true, count: ids.length });
    }

    return resp(404, { error: 'Not found' });

  } catch (err) {
    console.error('db error:', err);
    return resp(500, { error: err.message });
  }
};