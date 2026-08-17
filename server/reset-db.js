'use strict';

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

function loadEnv() {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const parsed = dotenv.config({ path: envPath });
        if (parsed.error) {
            throw parsed.error;
        }
        return parsed.parsed || {};
    }
    return {};
}

function resolveDatabasePath(env) {
    if (env.DB_PATH) {
        return path.resolve(process.cwd(), env.DB_PATH);
    }
    return path.resolve(__dirname, '..', 'data', 'network.db');
}

function main() {
    const env = loadEnv();
    const dbPath = resolveDatabasePath(env);

    if (!fs.existsSync(dbPath)) {
        console.log(`No database file found at ${dbPath}. Nothing to reset.`);
        process.exit(0);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup.${timestamp}`;

    try {
        fs.copyFileSync(dbPath, backupPath);
        fs.unlinkSync(dbPath);
        for (const suffix of ['-wal', '-shm']) {
            const journal = `${dbPath}${suffix}`;
            if (fs.existsSync(journal)) {
                fs.unlinkSync(journal);
            }
        }
        console.log(`Backed up existing database to ${backupPath}`);
        console.log(`Database reset complete. Restart the openvibe-network service to recreate the schema.`);
        process.exit(0);
    } catch (err) {
        console.error(`Failed to reset database: ${err.message}`);
        process.exit(1);
    }
}

main();
