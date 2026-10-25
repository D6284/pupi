'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
    }
} catch (_) {}

const args = new Set(process.argv.slice(2));
const sourceFlag = process.argv.findIndex(arg => arg === '--file');
const sourceFile = sourceFlag >= 0
    ? path.resolve(process.argv[sourceFlag + 1])
    : path.join(__dirname, '..', 'db.json');
const applyChanges = args.has('--apply');
const businessId = process.env.BUSINESS_ID || 'biz_001';
const tableBySection = {
    puppies: { table: 'puppies', idColumn: 'record_id', getId: row => row.id },
    customers: { table: 'customers', idColumn: 'record_id', getId: row => row.id },
    chats: { table: 'chat_sessions', idColumn: 'session_id', getId: row => row.id || row.conversation_id },
    messages: { table: 'chat_messages', idColumn: 'message_id', getId: row => row.id },
    orders: { table: 'orders', idColumn: 'record_id', getId: row => row.id },
    payments: { table: 'payments', idColumn: 'record_id', getId: row => row.id }
};
const singletonTables = {
    whatsapp_settings: 'whatsapp_settings',
    chat_settings: 'chat_settings',
    notifications_settings: 'notification_settings',
    ai_knowledge: 'ai_knowledge'
};

function fail(message) {
    console.error(`Migration stopped: ${message}`);
    process.exitCode = 1;
}

function validate(data) {
    const required = [
        'admin_settings', 'business_info', 'whatsapp_settings', 'chat_settings',
        'notifications_settings', 'ai_knowledge', 'puppies', 'orders', 'payments',
        'customers', 'chats', 'messages'
    ];
    for (const section of required) {
        if (!(section in data)) throw new Error(`Missing JSON section: ${section}`);
    }

    for (const section of Object.keys(tableBySection)) {
        if (!Array.isArray(data[section])) throw new Error(`${section} must be an array`);
        const { getId } = tableBySection[section];
        const seen = new Set();
        for (const [index, row] of data[section].entries()) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
                throw new Error(`${section}[${index}] must be an object`);
            }
            const id = getId(row);
            if (typeof id !== 'string' || !id.trim()) throw new Error(`${section}[${index}] has no record ID`);
            if (seen.has(id)) throw new Error(`${section} contains duplicate ID ${id}`);
            seen.add(id);
            if (row.business_id && row.business_id !== businessId) {
                throw new Error(`${section} contains business_id ${row.business_id}; set BUSINESS_ID to match before importing`);
            }
        }
    }

    const sessionIds = new Set();
    const sessionAliases = new Set();
    for (const row of data.chats) {
        const conversationId = row.conversation_id || row.id;
        if (sessionIds.has(conversationId)) throw new Error(`chats contains duplicate conversation ID ${conversationId}`);
        sessionIds.add(conversationId);
        sessionAliases.add(row.id);
        sessionAliases.add(conversationId);
    }
    const orphanMessages = data.messages.filter(row => {
        const conversationId = row.conversation_id || row.session_id;
        return conversationId && !sessionAliases.has(conversationId);
    });
    if (orphanMessages.length) {
        throw new Error(`${orphanMessages.length} messages refer to conversations missing from chats`);
    }
    const puppyIds = new Set(data.puppies.map(row => row.id));
    const orphanPuppies = data.orders.filter(row => row.puppy_id && !puppyIds.has(row.puppy_id));
    if (orphanPuppies.length) throw new Error(`${orphanPuppies.length} orders refer to puppies missing from puppies`);
    const orderIds = new Set(data.orders.map(row => row.id));
    const orphanOrders = data.payments.filter(row => row.order_id && !orderIds.has(row.order_id));
    if (orphanOrders.length) throw new Error(`${orphanOrders.length} payments refer to orders missing from orders`);

    for (const section of ['business_info', 'whatsapp_settings', 'chat_settings', 'notifications_settings', 'ai_knowledge']) {
        if (!data[section] || typeof data[section] !== 'object' || Array.isArray(data[section])) {
            throw new Error(`${section} must be an object`);
        }
    }
}

function cleanSingleton(section, value) {
    const result = { ...value };
    if (section === 'ai_knowledge') delete result.gemini_api_key;
    return result;
}

function cleanAdminSettings(settings) {
    return {
        inactivity_timeout_mins: settings.inactivity_timeout_mins || 30,
        password_configured_in_db: false
    };
}

function recordTimestamp(record) {
    const value = record.timestamp || record.created_at || record.date;
    return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

async function main() {
    if (!fs.existsSync(sourceFile)) throw new Error(`Source file not found: ${sourceFile}`);
    if (applyChanges && !args.has('--backup-confirmed')) {
        throw new Error('Before applying, create and verify a database backup, then pass --backup-confirmed.');
    }
    const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (applyChanges && !connectionString) throw new Error('Set DATABASE_URL or SUPABASE_DB_URL before applying.');

    const data = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    validate(data);
    const canonicalConversationIds = new Map();
    for (const chat of data.chats) {
        const conversationId = chat.conversation_id || chat.id;
        canonicalConversationIds.set(chat.id, conversationId);
        canonicalConversationIds.set(conversationId, conversationId);
    }
    const counts = Object.fromEntries([
        ...Object.keys(tableBySection).map(section => [section, data[section].length]),
        ...Object.keys(singletonTables).map(section => [section, 1]),
        ['admin_settings', 1],
        ['business_info', 1]
    ]);
    console.log(`${applyChanges ? 'Import plan' : 'Dry-run validation'} for ${sourceFile}`);
    console.log(`Business: ${businessId}`);
    for (const [section, count] of Object.entries(counts)) console.log(`  ${section}: ${count}`);
    console.log(`  total records: ${Object.values(counts).reduce((sum, count) => sum + count, 0)}`);
    console.log('Existing database rows will be preserved; conflicts are skipped, not overwritten.');
    console.log('Admin hash/JWT secret and Gemini API key are excluded from the import.');
    if (!applyChanges) {
        console.log('Dry run only. Use --apply --backup-confirmed after reviewing this report.');
        return;
    }

    const pool = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 8000,
        ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
    const client = await pool.connect();
    try {
        const schema = fs.readFileSync(path.join(__dirname, '..', 'config', 'schema.sql'), 'utf8');
        await client.query(schema);
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO businesses (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
            [businessId, JSON.stringify({ ...data.business_info, id: businessId })]
        );

        const singletonValues = {
            admin_settings: cleanAdminSettings(data.admin_settings),
            business_info: { ...data.business_info, id: businessId },
            ...Object.fromEntries(Object.entries(singletonTables).map(([section]) => [section, cleanSingleton(section, data[section])]))
        };
        for (const [section, payload] of Object.entries(singletonValues)) {
            if (section === 'business_info') {
                await client.query(
                    'INSERT INTO businesses (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
                    [businessId, JSON.stringify(payload)]
                );
            } else if (section === 'orders') {
                await client.query(
                    `INSERT INTO orders (${config.idColumn}, business_id, puppy_id, payload, sort_order, created_at, updated_at)
                         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) ON CONFLICT (${config.idColumn}) DO NOTHING`,
                    [id, businessId, record.puppy_id || null, JSON.stringify(record), index, timestamp]
                );
            } else if (section === 'payments') {
                await client.query(
                    `INSERT INTO payments (${config.idColumn}, business_id, order_id, payload, sort_order, created_at, updated_at)
                         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) ON CONFLICT (${config.idColumn}) DO NOTHING`,
                    [id, businessId, record.order_id || null, JSON.stringify(record), index, timestamp]
                );
            } else {
                const table = section === 'admin_settings' ? 'admin_settings' : singletonTables[section];
                await client.query(
                    `INSERT INTO ${table} (business_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (business_id) DO NOTHING`,
                    [businessId, JSON.stringify(payload)]
                );
            }
        }

        for (const [section, config] of Object.entries(tableBySection)) {
            for (const [index, sourceRecord] of data[section].entries()) {
                const record = { ...sourceRecord, business_id: sourceRecord.business_id || businessId };
                const id = config.getId(record);
                const timestamp = recordTimestamp(record);
                if (section === 'messages') {
                    await client.query(
                        `INSERT INTO ${config.table} (${config.idColumn}, business_id, conversation_id, payload, sort_order, created_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) ON CONFLICT (${config.idColumn}) DO NOTHING`,
                        [
                            id,
                            businessId,
                            canonicalConversationIds.get(record.conversation_id || record.session_id) || null,
                            JSON.stringify(record),
                            index,
                            timestamp
                        ]
                    );
                } else if (section === 'chats') {
                    await client.query(
                        `INSERT INTO ${config.table} (${config.idColumn}, business_id, conversation_id, payload, sort_order, created_at, updated_at)
                         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) ON CONFLICT (${config.idColumn}) DO NOTHING`,
                        [id, businessId, record.conversation_id || record.id, JSON.stringify(record), index, timestamp]
                    );
                } else {
                    await client.query(
                        `INSERT INTO ${config.table} (${config.idColumn}, business_id, payload, sort_order, created_at, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $5) ON CONFLICT (${config.idColumn}) DO NOTHING`,
                        [id, businessId, JSON.stringify(record), index, timestamp]
                    );
                }
            }
        }
        for (const [section, config] of Object.entries(tableBySection)) {
            const ids = data[section].map(config.getId);
            if (ids.length === 0) continue;
            const result = await client.query(
                `SELECT COUNT(*)::integer AS count FROM ${config.table}
                 WHERE business_id = $1 AND ${config.idColumn} = ANY($2::text[])`,
                [businessId, ids]
            );
            if (result.rows[0].count !== ids.length) {
                throw new Error(`${section} verification found ${result.rows[0].count} of ${ids.length} source IDs`);
            }
            console.log(`  verified ${section}: ${result.rows[0].count}/${ids.length}`);
        }
        await client.query('COMMIT');
        console.log('Import completed. Re-run the script in dry-run mode and compare counts before deployment.');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => fail(error.message));
