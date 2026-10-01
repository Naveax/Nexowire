type JsonSchema = Record<string, unknown>;

export interface SchemaCompatibilityIssue {
  path: string;
  message: string;
}

function asObject(value: unknown): JsonSchema | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function asStringSet(value: unknown): Set<string> | undefined {
  if (typeof value === 'string') return new Set([value]);
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
  ) {
    return new Set(value as string[]);
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function add(
  issues: SchemaCompatibilityIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function compareLowerBound(
  baseline: JsonSchema,
  current: JsonSchema,
  key: 'minimum' | 'exclusiveMinimum' | 'minLength' | 'minItems',
  path: string,
  issues: SchemaCompatibilityIssue[],
): void {
  const before = numeric(baseline[key]);
  const after = numeric(current[key]);
  if (before === undefined) {
    if (after !== undefined) {
      add(
        issues,
        path,
        `${key} was added at ${after}, which narrows accepted input.`,
      );
    }
    return;
  }
  if (after !== undefined && after > before) {
    add(
      issues,
      path,
      `${key} narrowed from ${before} to ${after}.`,
    );
  }
}

function compareUpperBound(
  baseline: JsonSchema,
  current: JsonSchema,
  key: 'maximum' | 'exclusiveMaximum' | 'maxLength' | 'maxItems',
  path: string,
  issues: SchemaCompatibilityIssue[],
): void {
  const before = numeric(baseline[key]);
  const after = numeric(current[key]);
  if (before === undefined) {
    if (after !== undefined) {
      add(
        issues,
        path,
        `${key} was added at ${after}, which narrows accepted input.`,
      );
    }
    return;
  }
  if (after !== undefined && after < before) {
    add(
      issues,
      path,
      `${key} narrowed from ${before} to ${after}.`,
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  const object = asObject(value);
  if (object) {
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + stableJson(object[key]),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function compareInputSchemas(
  baseline: unknown,
  current: unknown,
  path = '$',
): SchemaCompatibilityIssue[] {
  const issues: SchemaCompatibilityIssue[] = [];
  compareNode(baseline, current, path, issues);
  return issues;
}

function compareNode(
  baselineValue: unknown,
  currentValue: unknown,
  path: string,
  issues: SchemaCompatibilityIssue[],
): void {
  const baseline = asObject(baselineValue);
  const current = asObject(currentValue);
  if (!baseline || !current) {
    if (stableJson(baselineValue) !== stableJson(currentValue)) {
      add(issues, path, 'Schema node changed incompatibly.');
    }
    return;
  }

  const baselineTypes = asStringSet(baseline.type);
  const currentTypes = asStringSet(current.type);
  if (baselineTypes) {
    if (currentTypes) {
      for (const type of baselineTypes) {
        if (!currentTypes.has(type)) {
          add(
            issues,
            path,
            `Accepted type "${type}" was removed.`,
          );
        }
      }
    }
  } else if (currentTypes) {
    add(
      issues,
      path,
      'A type restriction was added where v1 accepted an unconstrained value.',
    );
  }

  const baselineEnum = Array.isArray(baseline.enum)
    ? baseline.enum
    : undefined;
  const currentEnum = Array.isArray(current.enum)
    ? current.enum
    : undefined;
  if (baselineEnum) {
    if (currentEnum) {
      const currentValues = new Set(currentEnum.map(stableJson));
      for (const value of baselineEnum) {
        if (!currentValues.has(stableJson(value))) {
          add(
            issues,
            path,
            `Enum value ${stableJson(value)} is no longer accepted.`,
          );
        }
      }
    }
  } else if (currentEnum) {
    add(
      issues,
      path,
      'An enum restriction was added where v1 accepted more values.',
    );
  }

  if ('const' in baseline) {
    if (
      'const' in current &&
      stableJson(current.const) !== stableJson(baseline.const)
    ) {
      add(issues, path, 'const value changed.');
    }
  } else if ('const' in current) {
    add(
      issues,
      path,
      'A const restriction was added where v1 accepted more values.',
    );
  }

  compareLowerBound(baseline, current, 'minimum', path, issues);
  compareLowerBound(
    baseline,
    current,
    'exclusiveMinimum',
    path,
    issues,
  );
  compareLowerBound(baseline, current, 'minLength', path, issues);
  compareLowerBound(baseline, current, 'minItems', path, issues);
  compareUpperBound(baseline, current, 'maximum', path, issues);
  compareUpperBound(
    baseline,
    current,
    'exclusiveMaximum',
    path,
    issues,
  );
  compareUpperBound(baseline, current, 'maxLength', path, issues);
  compareUpperBound(baseline, current, 'maxItems', path, issues);

  const baselinePattern =
    typeof baseline.pattern === 'string' ? baseline.pattern : undefined;
  const currentPattern =
    typeof current.pattern === 'string' ? current.pattern : undefined;
  if (baselinePattern === undefined && currentPattern !== undefined) {
    add(
      issues,
      path,
      'A string pattern restriction was added.',
    );
  } else if (
    baselinePattern !== undefined &&
    currentPattern !== undefined &&
    baselinePattern !== currentPattern
  ) {
    add(
      issues,
      path,
      'String pattern changed; compatibility cannot be proven.',
    );
  }

  const baselineRequired = new Set(
    Array.isArray(baseline.required)
      ? baseline.required.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  );
  const currentRequired = new Set(
    Array.isArray(current.required)
      ? current.required.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  );
  for (const field of currentRequired) {
    if (!baselineRequired.has(field)) {
      add(
        issues,
        path + '.required',
        `Field "${field}" became newly required.`,
      );
    }
  }

  const baselineProperties = asObject(baseline.properties);
  const currentProperties = asObject(current.properties);
  if (baselineProperties) {
    if (!currentProperties) {
      add(issues, path, 'Object properties were removed.');
    } else {
      for (const [key, baselineProperty] of Object.entries(
        baselineProperties,
      )) {
        if (!(key in currentProperties)) {
          add(
            issues,
            path + '.properties.' + key,
            'Existing v1 input field was removed.',
          );
          continue;
        }
        compareNode(
          baselineProperty,
          currentProperties[key],
          path + '.properties.' + key,
          issues,
        );
      }
    }
  }

  if ('additionalProperties' in baseline) {
    if (
      baseline.additionalProperties !== false &&
      current.additionalProperties === false
    ) {
      add(
        issues,
        path,
        'additionalProperties was narrowed to false.',
      );
    }
  } else if (current.additionalProperties === false) {
    add(
      issues,
      path,
      'additionalProperties was narrowed to false.',
    );
  }

  if ('items' in baseline) {
    if (!('items' in current)) {
      add(issues, path + '.items', 'Array item schema was removed.');
    } else {
      compareNode(
        baseline.items,
        current.items,
        path + '.items',
        issues,
      );
    }
  } else if ('items' in current) {
    add(
      issues,
      path + '.items',
      'An array item restriction was added.',
    );
  }

  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (!(combinator in baseline) && combinator in current) {
      add(
        issues,
        path + '.' + combinator,
        `${combinator} restriction was added.`,
      );
      continue;
    }
    if (
      combinator in baseline &&
      combinator in current &&
      stableJson(baseline[combinator]) !==
        stableJson(current[combinator])
    ) {
      add(
        issues,
        path + '.' + combinator,
        `${combinator} changed; compatibility requires explicit review.`,
      );
    }
    if (combinator in baseline && !(combinator in current)) {
      // Removing a combinator usually widens accepted input.
      continue;
    }
  }

  if ('$ref' in baseline) {
    if (
      typeof baseline.$ref !== 'string' ||
      current.$ref !== baseline.$ref
    ) {
      add(issues, path + '.$ref', '$ref changed.');
    }
  } else if ('$ref' in current) {
    add(issues, path + '.$ref', 'A $ref restriction was added.');
  }
}
