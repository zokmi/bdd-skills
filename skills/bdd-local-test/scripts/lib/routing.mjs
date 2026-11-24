function assertSlotIp(ip) {
  const match = typeof ip === 'string' && /^127\.0\.0\.([1-9][0-9]{0,2})$/.exec(ip);
  if (!match || +match[1] < 2 || +match[1] > 254 || match[0] !== ip) {
    throw new Error('Slot IP must be 127.0.0.2 through 127.0.0.254');
  }
  return ip;
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return port;
}

function effectivePortMap(portMappings) {
  const effective = new Map(portMappings.map(({ originalPort, effectivePort }) =>
    [assertPort(originalPort), assertPort(effectivePort)]));
  if (effective.size !== portMappings.length) throw new Error('Duplicate original port mapping');
  return effective;
}

function routeOptions({ ip, frontendPorts = [], apiPorts = [], portMappings = [] }) {
  assertSlotIp(ip);
  const effective = effectivePortMap(portMappings);
  const routes = {};
  for (const [kind, ports] of [['frontend', frontendPorts], ['api', apiPorts]]) {
    if (!Array.isArray(ports)) throw new Error('Expected a port array');
    for (const port of ports) {
      assertPort(port);
      const target = effective.get(port) ?? port;
      for (const source of [port, target]) {
        const existing = routes[source];
        if (existing && (existing.kind !== kind || existing.target !== target)) {
          throw new Error('Conflicting localhost port mapping');
        }
        routes[source] = { kind, target };
      }
    }
  }
  return { ip, routes };
}

// Self-contained so the CLI can embed the exact handler in Playwright MCP.
async function installSlotRoutes(ctx, { ip, routes }) {
  const key = Symbol.for('bdd-local-test.slot-routes');
  const state = ctx[key] ??= { pending: Promise.resolve(), current: null };
  const pending = state.pending.catch(() => {}).then(async () => {
    if (!Object.keys(routes).length) {
      if (state.current) await ctx.unroute(state.current.match, state.current.handler);
      state.current = null;
      return;
    }
    if (state.current) {
      // Keep registration order so context mocks added after this handler retain precedence.
      state.current.settings = { ip, routes };
      return;
    }
    const entry = { settings: { ip, routes } };
    const portOf = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    entry.match = (url) => url.hostname === 'localhost' &&
      ['http:', 'https:'].includes(url.protocol) && Object.hasOwn(entry.settings.routes, portOf(url));
    entry.handler = async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const settings = entry.settings;
      const destination = settings.routes[portOf(url)];
      if (!destination) return route.fallback();
      const { kind, target } = destination;
      url.hostname = settings.ip;
      url.port = target;
      if (kind === 'frontend') return route.continue({ url: url.href });

      const headers = { ...request.headers() };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'host') delete headers[name];
      }
      let response;
      try {
        response = await ctx.request.fetch(url.href, {
          method: request.method(),
          headers,
          data: request.postDataBuffer() ?? undefined,
          ignoreHTTPSErrors: url.protocol === 'https:',
          failOnStatusCode: false,
          maxRedirects: 0,
          timeout: 30000,
        });
        await route.fulfill({ response });
      } catch (error) {
        await route.abort();
        throw error;
      } finally {
        await response?.dispose();
      }
    };
    await ctx.route(entry.match, entry.handler);
    state.current = entry;
  });
  state.pending = pending;
  await pending;
}

async function routeLocalhostToSlot(ctx, options) {
  await installSlotRoutes(ctx, routeOptions(options));
}

function buildMcpSnippet(options) {
  const settings = routeOptions(options);
  return 'async (page) => {\n' +
    '  const installSlotRoutes = ' + installSlotRoutes.toString() + ';\n' +
    '  await installSlotRoutes(page.context(), ' + JSON.stringify(settings) + ');\n' +
    '}';
}

export { assertSlotIp, assertPort, effectivePortMap, routeOptions, routeLocalhostToSlot, buildMcpSnippet };
