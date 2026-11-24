import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readJson } from './lib/kit-config.mjs';
import { toMssqlConfig } from './lib/connection-string.mjs';

function resolveConnectionString(settings, root, env = process.env) {
  if (settings?.enabled !== true) throw new Error('Database helper is disabled');
  if (settings.connectionEnv && env[settings.connectionEnv]) return env[settings.connectionEnv];
  let connection;
  for (const file of settings.appsettings ?? []) {
    const absolute = path.resolve(root, file);
    let data;
    try {
      data = readJson(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const strings = data.ConnectionStrings;
    const key = settings.connectionName ?? 'DefaultConnection';
    if (strings && Object.hasOwn(strings, key)) connection = strings[key];
  }
  if (typeof connection !== 'string' || !connection.trim()) {
    throw new Error('Configured database connection string is missing');
  }
  return connection;
}

function createDb(settings, { root = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(root);
  const projectRequire = createRequire(path.join(absoluteRoot, 'package.json'));

  async function openPool() {
    const config = toMssqlConfig(resolveConnectionString(settings, absoluteRoot), settings);
    let driverPath;
    try {
      driverPath = projectRequire.resolve('mssql');
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      throw new Error('Install mssql in the project to use the database helper', { cause: error });
    }
    const driver = await import(pathToFileURL(driverPath).href);
    const sql = driver.default ?? driver;
    return { sql, pool: new sql.ConnectionPool(config) };
  }

  async function withPool(action) {
    const { pool } = await openPool();
    try {
      await pool.connect();
      return await action(pool);
    } finally {
      await pool.close();
    }
  }

  function commands(useRequest) {
    return {
      run(text) {
        return useRequest(async request => (await request.batch(text)).recordsets);
      },
      query(text, params = {}) {
        return useRequest(async request => {
          for (const [name, value] of Object.entries(params)) request.input(name, value);
          return (await request.query(text)).recordset ?? [];
        });
      },
    };
  }

  async function withSession(verify) {
    if (typeof verify !== 'function') throw new TypeError('Expected a database session callback');
    return withPool(async pool => {
      const pending = new Set();
      let active = true;
      const session = commands(action => {
        if (!active) return Promise.reject(new Error('Database session is closed'));
        const operation = Promise.resolve().then(() => action(pool.request()));
        pending.add(operation);
        const complete = () => pending.delete(operation);
        operation.then(complete, complete);
        return operation;
      });
      try {
        return await verify(session);
      } finally {
        active = false;
        await Promise.allSettled(pending);
      }
    });
  }

  async function holdAppLock(resource, holdMs) {
    if (typeof resource !== 'string' || !resource || resource.length > 255 ||
        !Number.isInteger(holdMs) || holdMs < 1 || holdMs > 2147483647) {
      throw new Error('Invalid app lock resource or hold time');
    }
    const { sql, pool } = await openPool();
    let tx;
    let timer;
    let cleanup;

    function release() {
      clearTimeout(timer);
      return cleanup ??= (async () => {
        try {
          if (tx) await tx.rollback().catch((error) => {
            if (error.code !== 'ENOTBEGUN' && error.code !== 'EABORT') throw error;
          });
        } finally {
          await pool.close();
        }
      })();
    }

    try {
      await pool.connect();
      tx = new sql.Transaction(pool);
      await tx.begin();
      const result = await new sql.Request(tx).input('res', resource).query(
        "DECLARE @r int; EXEC @r = sp_getapplock @Resource=@res, @LockMode='Exclusive', " +
        "@LockOwner='Transaction', @LockTimeout=5000; SELECT @r AS r;"
      );
      const got = result.recordset[0]?.r;
      if (!Number.isInteger(got)) throw new Error('Missing app lock return code');
      if (got < 0) {
        await release();
        return { got, held: false, release };
      }
      timer = setTimeout(() => { release().catch(() => {}); }, holdMs);
      timer.unref();
      return { got, held: true, release };
    } catch (error) {
      try {
        await release();
      } catch (cleanupError) {
        if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'App lock and cleanup failed');
      }
      throw error;
    }
  }

  return { ...commands(action => withPool(pool => action(pool.request()))), withSession, holdAppLock };
}

export { createDb, resolveConnectionString };
