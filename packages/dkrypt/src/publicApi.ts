type PublicApiDocument = {
  openapi?: unknown;
  info?: Record<string, unknown>;
  servers?: unknown;
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  security?: unknown;
  tags?: Array<Record<string, unknown>>;
};

export const publicApiOperations = {
  '/v1/decrypt': ['get'],
  '/v1/decrypts': ['post'],
  '/v1/jobs/{id}': ['get'],
  '/v1/jobs/{id}/wait': ['get'],
  '/v1/jobs/status': ['post'],
  '/v1/testflight/decrypt': ['post'],
  '/v1/artifacts': ['get'],
  '/v1/artifacts/{id}': ['get'],
  '/v1/artifacts/{id}/file': ['get'],
} as const;

const publicApiRoutePatterns = Object.entries(publicApiOperations).flatMap(([path, methods]) =>
  methods.map((method) => ({ method: method.toUpperCase(), path, pattern: pathPattern(path) })),
);

export function isPublicApiKeyRoute(method: string, path: string | undefined): boolean {
  if (!path) return false;
  const normalizedPath = path.split('?', 1)[0].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const normalizedMethod = method.toUpperCase();
  return publicApiRoutePatterns.some((route) =>
    route.method === normalizedMethod && (route.path === normalizedPath || route.pattern.test(normalizedPath)),
  );
}

export function createPublicOpenApiDocument(value: unknown): PublicApiDocument {
  const document = asRecord(value) as PublicApiDocument;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, methods] of Object.entries(publicApiOperations)) {
    const pathItem = document.paths?.[path];
    if (!pathItem) continue;
    const allowedMethods = new Set<string>(methods);
    const selected = Object.fromEntries(Object.entries(pathItem).filter(([key]) =>
      !isHttpMethod(key) || allowedMethods.has(key.toLowerCase()),
    ));
    if (Object.keys(selected).length > 0) {
      paths[path] = Object.fromEntries(Object.entries(selected).map(([key, value]) => [
        key,
        isHttpMethod(key) ? withApiCompatibilityHeader(value) : value,
      ]));
    }
  }

  const sourceComponents = document.components ?? {};
  const sourceSchemas = asRecord(sourceComponents.schemas);
  const schemas = reachableSchemas(paths, sourceSchemas);
  const securitySchemeNames = referencedSecuritySchemes({ security: document.security, paths });
  const sourceSecuritySchemes = asRecord(sourceComponents.securitySchemes);
  const securitySchemes = Object.fromEntries(Object.entries(sourceSecuritySchemes).filter(([name]) => securitySchemeNames.has(name)));
  const usedTagNames = referencedTags(paths);
  const tags = document.tags?.filter((tag) => typeof tag.name === 'string' && usedTagNames.has(tag.name));
  const components: Record<string, unknown> = {};
  if (Object.keys(schemas).length > 0) components.schemas = schemas;
  if (Object.keys(securitySchemes).length > 0) components.securitySchemes = securitySchemes;

  return {
    openapi: document.openapi,
    info: {
      ...document.info,
      title: 'dkrypt Public API',
      description: 'Use API keys to submit decrypt jobs, inspect job status, and access IPA artifacts. All responses include X-Dkrypt-API-Version: 1. Additive response fields are compatible within v1; breaking changes use documented deprecation and sunset dates.',
    },
    servers: document.servers,
    paths,
    components,
    security: document.security,
    ...(tags ? { tags } : {}),
  };
}

function pathPattern(path: string): RegExp {
  const escaped = path.split('/').map((segment) => /^\{[^{}]+\}$/.test(segment)
    ? '[^/]+'
    : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('/')}$`);
}

function isHttpMethod(value: string): boolean {
  return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(value.toLowerCase());
}

function withApiCompatibilityHeader(value: unknown): unknown {
  const operation = asRecord(value);
  const responses = asRecord(operation.responses);
  return {
    ...operation,
    responses: Object.fromEntries(Object.entries(responses).map(([status, response]) => {
      const record = asRecord(response);
      const headers = asRecord(record.headers);
      return [status, {
        ...record,
        headers: {
          ...headers,
          'X-Dkrypt-API-Version': {
            description: 'Public API compatibility version for this response.',
            schema: { type: 'string', const: '1' },
          },
        },
      }];
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function componentSchemaReferences(value: unknown): Set<string> {
  const references = new Set<string>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    const reference = (current as Record<string, unknown>).$ref;
    const prefix = '#/components/schemas/';
    if (typeof reference === 'string' && reference.startsWith(prefix)) {
      references.add(decodeURIComponent(reference.slice(prefix.length)).replace(/~1/g, '/').replace(/~0/g, '~'));
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return references;
}

function reachableSchemas(paths: Record<string, Record<string, unknown>>, schemas: Record<string, unknown>): Record<string, unknown> {
  const reachable = new Set<string>();
  const pending = [...componentSchemaReferences(paths)];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reachable.has(name) || schemas[name] === undefined) continue;
    reachable.add(name);
    pending.push(...componentSchemaReferences(schemas[name]));
  }
  return Object.fromEntries([...reachable].map((name) => [name, schemas[name]]));
}

function referencedSecuritySchemes(value: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    if ('security' in current && Array.isArray((current as Record<string, unknown>).security)) {
      for (const requirement of (current as { security: unknown[] }).security) {
        for (const name of Object.keys(asRecord(requirement))) names.add(name);
      }
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return names;
}

function referencedTags(paths: Record<string, Record<string, unknown>>): Set<string> {
  const names = new Set<string>();
  for (const pathItem of Object.values(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method)) continue;
      const tags = asRecord(operation).tags;
      if (Array.isArray(tags)) tags.forEach((tag) => typeof tag === 'string' && names.add(tag));
    }
  }
  return names;
}
