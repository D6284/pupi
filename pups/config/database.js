'use strict';

const fs = require('fs');
const path = require('path');

try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
    }
} catch (_) {}

const BUSINESS_ID = process.env.BUSINESS_ID || 'biz_001';
const JSON_FILE = process.env.PUPS_JSON_FILE || path.join(__dirname, '..', 'db.json');
const LOCAL_JSON_MODE = !process.env.VERCEL && process.env.NODE_ENV !== 'production' &&
    (process.env.PUPS_STORAGE === 'json' || (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL));
const SINGLETON_TABLES = {
    business_info: 'businesses',
    admin_settings: 'admin_settings',
    whatsapp_settings: 'whatsapp_settings',
    chat_settings: 'chat_settings',
    notifications_settings: 'notification_settings',
    ai_knowledge: 'ai_knowledge'
};
const COLLECTION_TABLES = {
    puppies: { table: 'puppies', id: 'record_id' },
    customers: { table: 'customers', id: 'record_id' },
    chats: { table: 'chat_sessions', id: 'session_id' },
    messages: { table: 'chat_messages', id: 'message_id' },
    orders: { table: 'orders', id: 'record_id' },
    payments: { table: 'payments', id: 'record_id' }
};

let pool;
const snapshots = new WeakMap();
let localData;
const localRateLimits = new Map();
let rateLimitCallCount = 0;

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getLocalData() {
    if (localData) return localData;
    try {
        localData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        localData = {};
    }
    return localData;
}

function getPool() {
    if (pool) return pool;
    const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL must be configured for PostgreSQL storage.');
    }
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString,
        max: Number(process.env.PG_POOL_MAX || 2),
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 8000,
        ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
    pool.on('error', error => console.error('[database] PostgreSQL pool error:', error.message));
    return pool;
}

function assertKnownKey(key) {
    if (!SINGLETON_TABLES[key] && !COLLECTION_TABLES[key]) {
        throw new Error(`Unknown database section: ${key}`);
    }
}

function getRecordId(key, record) {
    return record.id;
}

function getBusinessId(record) {
    return record.business_id || BUSINESS_ID;
}

async function get(key) {
    assertKnownKey(key);
    if (LOCAL_JSON_MODE) {
        const data = getLocalData();
        const value = data[key];
        if (Array.isArray(value)) {
            const result = clone(value);
            snapshots.set(result, clone(value));
            return result;
        }
        return clone(value);
    }

    const client = getPool();
    const table = SINGLETON_TABLES[key];
    if (table) {
        const idColumn = key === 'business_info' ? 'id' : 'business_id';
        const result = await client.query(`SELECT payload FROM ${table} WHERE ${idColumn} = $1`, [BUSINESS_ID]);
        return result.rows[0]?.payload || null;
    }

    const { table: collectionTable, id: idColumn } = COLLECTION_TABLES[key];
    const result = await client.query(
        `SELECT payload FROM ${collectionTable} WHERE business_id = $1 ORDER BY sort_order, ${idColumn}`,
        [BUSINESS_ID]
    );
    const records = result.rows.map(row => row.payload);
    snapshots.set(records, clone(records));
    return records;
}

async function set(key, value) {
    assertKnownKey(key);
    if (LOCAL_JSON_MODE) {
        const data = getLocalData();
        data[key] = clone(value);
        fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
        return clone(data[key]);
    }

    const client = getPool();
    const table = SINGLETON_TABLES[key];
    if (table) {
        const id = key === 'business_info' ? (value?.id || BUSINESS_ID) : BUSINESS_ID;
        if (key !== 'business_info') {
            await client.query(
                'INSERT INTO businesses (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
                [BUSINESS_ID, JSON.stringify({ id: BUSINESS_ID })]
            );
        }
        await client.query(
            `INSERT INTO ${table} (${key === 'business_info' ? 'id' : 'business_id'}, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (${key === 'business_info' ? 'id' : 'business_id'})
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
            [id, JSON.stringify(value)]
        );
        return clone(value);
    }

    if (!Array.isArray(value)) throw new TypeError(`${key} must be an array`);
    const { table: collectionTable, id: idColumn } = COLLECTION_TABLES[key];
    const baseline = snapshots.get(value);
    const clientConnection = await client.connect();
    try {
        await clientConnection.query('BEGIN');
        await clientConnection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${BUSINESS_ID}:${key}`]);
        await clientConnection.query(
            'INSERT INTO businesses (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
            [BUSINESS_ID, JSON.stringify({ id: BUSINESS_ID })]
        );

        if (!baseline) throw new Error(`Read ${key} before updating it`);
        const before = new Map(baseline.map(record => [getRecordId(key, record), record]));
        const after = new Map(value.map(record => [getRecordId(key, record), record]));
        for (const [id] of before) {
            if (!after.has(id)) {
                await clientConnection.query(
                    `DELETE FROM ${collectionTable} WHERE business_id = $1 AND ${idColumn} = $2`,
                    [BUSINESS_ID, id]
                );
            }
        }
        for (const [index, record] of value.entries()) {
            const id = getRecordId(key, record);
            if (!before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(record)) {
                await upsertRecord(clientConnection, key, record, index);
            }
        }
        const orderedIds = value.map(record => getRecordId(key, record));
        if (orderedIds.length) {
            await clientConnection.query(
                `UPDATE ${collectionTable} AS target
                 SET sort_order = source.ordinality::integer - 1
                 FROM unnest($1::text[]) WITH ORDINALITY AS source(record_id, ordinality)
                 WHERE target.business_id = $2 AND target.${idColumn} = source.record_id`,
                [orderedIds, BUSINESS_ID]
            );
        }

        await clientConnection.query('COMMIT');
        snapshots.set(value, clone(value));
        return clone(value);
    } catch (error) {
        await clientConnection.query('ROLLBACK');
        throw error;
    } finally {
        clientConnection.release();
    }
}

async function upsertRecord(client, key, record, sortOrder) {
    const { table, id: idColumn } = COLLECTION_TABLES[key];
    let id = getRecordId(key, record);
    if (!id) throw new Error(`${key} record is missing its ID`);
    const businessId = getBusinessId(record);
    const conversationId = key === 'messages' ? (record.conversation_id || record.session_id) : null;
    const chatConversationId = key === 'chats' ? (record.conversation_id || record.id) : null;
    let puppyId = key === 'orders' ? (record.puppy_id || null) : null;
    let orderId = key === 'payments' ? (record.order_id || null) : null;
    if (puppyId) {
        const relation = await client.query('SELECT 1 FROM puppies WHERE record_id = $1 AND business_id = $2', [puppyId, businessId]);
        if (!relation.rowCount) puppyId = null;
    }
    if (orderId) {
        const relation = await client.query('SELECT 1 FROM orders WHERE record_id = $1 AND business_id = $2', [orderId, businessId]);
        if (!relation.rowCount) orderId = null;
    }
    const timestamp = record.timestamp || record.created_at || record.date || new Date().toISOString();
    const columns = key === 'messages'
        ? `(${idColumn}, business_id, conversation_id, payload, sort_order, created_at, updated_at)`
        : key === 'chats'
            ? `(${idColumn}, business_id, conversation_id, payload, sort_order, created_at, updated_at)`
            : key === 'orders'
                ? `(${idColumn}, business_id, puppy_id, payload, sort_order, created_at, updated_at)`
                : key === 'payments'
                    ? `(${idColumn}, business_id, order_id, payload, sort_order, created_at, updated_at)`
                    : `(${idColumn}, business_id, payload, sort_order, created_at, updated_at)`;
    const values = key === 'messages'
        ? [id, businessId, conversationId, JSON.stringify(record), sortOrder, timestamp, timestamp]
        : key === 'chats'
            ? [id, businessId, chatConversationId, JSON.stringify(record), sortOrder, timestamp, timestamp]
            : key === 'orders'
                ? [id, businessId, puppyId, JSON.stringify(record), sortOrder, timestamp, timestamp]
                : key === 'payments'
                    ? [id, businessId, orderId, JSON.stringify(record), sortOrder, timestamp, timestamp]
                    : [id, businessId, JSON.stringify(record), sortOrder, timestamp, timestamp];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const updateColumns = key === 'messages'
        ? 'business_id = EXCLUDED.business_id, conversation_id = EXCLUDED.conversation_id, payload = EXCLUDED.payload, sort_order = EXCLUDED.sort_order, updated_at = NOW()'
        : key === 'chats'
            ? 'business_id = EXCLUDED.business_id, conversation_id = EXCLUDED.conversation_id, payload = EXCLUDED.payload, sort_order = EXCLUDED.sort_order, updated_at = NOW()'
            : key === 'orders'
                ? 'business_id = EXCLUDED.business_id, puppy_id = EXCLUDED.puppy_id, payload = EXCLUDED.payload, sort_order = EXCLUDED.sort_order, updated_at = NOW()'
                : key === 'payments'
                    ? 'business_id = EXCLUDED.business_id, order_id = EXCLUDED.order_id, payload = EXCLUDED.payload, sort_order = EXCLUDED.sort_order, updated_at = NOW()'
                    : 'business_id = EXCLUDED.business_id, payload = EXCLUDED.payload, sort_order = EXCLUDED.sort_order, updated_at = NOW()';
    await client.query(
        `INSERT INTO ${table} ${columns} VALUES (${placeholders})
     ON CONFLICT (${idColumn}) DO UPDATE SET ${updateColumns}`,
        values
    );
}

async function update(key, updater) {
    if (typeof updater !== 'function') throw new TypeError('Database update requires a function');
    const current = await get(key);
    const updated = updater(current);
    return set(key, updated);
}

async function consumeRateLimit(key, limit, windowMs) {
    if (LOCAL_JSON_MODE) {
        const now = Date.now();
        const current = localRateLimits.get(key);
        const entry = !current || current.resetAt <= now
            ? { count: 1, resetAt: now + windowMs }
            : { count: current.count + 1, resetAt: current.resetAt };
        localRateLimits.set(key, entry);
        return { allowed: entry.count <= limit, resetAt: entry.resetAt };
    }

    const result = await getPool().query(
        `INSERT INTO api_rate_limits (bucket_key, request_count, expires_at)
         VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
         ON CONFLICT (bucket_key) DO UPDATE SET
           request_count = CASE WHEN api_rate_limits.expires_at <= NOW() THEN 1 ELSE api_rate_limits.request_count + 1 END,
           expires_at = CASE WHEN api_rate_limits.expires_at <= NOW()
             THEN NOW() + ($2 * INTERVAL '1 millisecond') ELSE api_rate_limits.expires_at END
         RETURNING request_count, expires_at`,
        [key, windowMs]
    );
    rateLimitCallCount += 1;
    if (rateLimitCallCount % 1000 === 0) {
        getPool().query('DELETE FROM api_rate_limits WHERE expires_at < NOW()').catch(error => {
            console.error('[database] Rate-limit cleanup failed:', error.message);
        });
    }
    return {
        allowed: result.rows[0].request_count <= limit,
        resetAt: new Date(result.rows[0].expires_at).getTime()
    };
}

module.exports = { get, set, update, consumeRateLimit, isPostgres: !LOCAL_JSON_MODE };
