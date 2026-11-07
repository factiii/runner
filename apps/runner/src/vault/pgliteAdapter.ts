/*
 * Vendored from pglite-prisma-adapter 0.7.2
 * (https://github.com/lucasthevenet/pglite-utils, packages/prisma-adapter),
 * with the array parser of postgres-array 3.0.4
 * (https://github.com/bendrucker/postgres-array).
 *
 * pglite-prisma-adapter: MIT License, Copyright (c) Lucas Thevenet
 * postgres-array:        MIT License, Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  type ArgType,
  type ColumnType,
  ColumnTypeEnum,
  type ConnectionInfo,
  DriverAdapterError,
  type Error as DriverError,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions
} from '@prisma/driver-adapter-utils';

// The Vault's Prisma driver adapter for PGlite (.specs/vault-router.md →
// Decisions → 1). It runs in the database process (dbChild.ts), next to the
// PGlite it drives; the daemon's Prisma client reaches it over IPC
// (prismaIpc.ts), cut at this adapter's own boundary: a `SqlQuery` in, a
// `SqlResultSet` out, both plain data.
//
// Changes from the published package, which is why it is vendored (one
// maintainer, pinned to @prisma/driver-adapter-utils 7.2.0 against our 7.10.1):
//   - PGlite is handed in, not imported: it is installed into the Vault's
//     engine folder, never bundled (engine.ts). Its `types` and
//     `messages.DatabaseError` come from that same copy, so the error test
//     below is `instanceof` the class that threw.
//   - `executeScript` awaits the script, so a failed one rejects instead of
//     escaping as an unhandled rejection.
//   - No shadow database, no `Debug` logging, no factory: the runner runs its
//     own migrations (db.ts) and makes one adapter per database process.

type Parser = (value: string) => unknown;

type PgliteQueryOptions = { rowMode: 'array'; parsers: Record<number, Parser> };

type PgliteResults = {
  rows: SqlResultSet['rows'];
  fields: { name: string; dataTypeID: number }[];
  affectedRows?: number;
};

/** What the adapter asks of a PGlite connection or transaction. */
type PgliteQueryable = {
  query(sql: string, params: unknown[], options: PgliteQueryOptions): Promise<PgliteResults>;
  exec(sql: string): Promise<unknown>;
};

type PgliteTx = PgliteQueryable & { rollback(): Promise<void> };

export type PgliteClient = PgliteQueryable & {
  transaction<T>(fn: (tx: PgliteTx) => Promise<T>): Promise<T>;
};

/** The parts of the PGlite module the adapter reads (`types`, `messages`). */
export type PgliteModule = {
  types: Record<string, number>;
  messages: { DatabaseError: new (...args: never[]) => Error };
};

// ── postgres-array 3.0.4 ────────────────────────────────────────────────────

const BACKSLASH = '\\';
const DQUOT = '"';
const LBRACE = '{';
const RBRACE = '}';
const LBRACKET = '[';
const EQUALS = '=';
const COMMA = ',';
/** When the raw value is this, it means a literal `null` */
const NULL_STRING = 'NULL';

type Nested = (unknown | Nested)[];

/**
 * Parses an array according to
 * https://www.postgresql.org/docs/17/arrays.html#ARRAYS-IO
 *
 * Trusts the data (mostly), so only hook up to trusted Postgres servers.
 */
function parseArray(str: string, transform?: Parser): Nested {
  const rbraceIndex = str.length - 1;
  if (rbraceIndex === 1) {
    return [];
  }
  if (str[rbraceIndex] !== RBRACE) {
    throw new Error('Invalid array text - must end with }');
  }

  // If starts with `[`, it is specifying the index boundas. Skip past first `=`.
  let position = 0;
  if (str[position] === LBRACKET) {
    position = str.indexOf(EQUALS) + 1;
  }

  if (str[position++] !== LBRACE) {
    throw new Error('Invalid array text - must start with {');
  }
  const output: Nested = [];
  let current = output;
  const stack: Nested[] = [];

  let currentStringStart = position;
  let currentString = '';
  let expectValue = true;

  for (; position < rbraceIndex; ++position) {
    let char = str[position];
    // > The array output routine will put double quotes around element values if
    // > they are empty strings, contain curly braces, delimiter characters, double
    // > quotes, backslashes, or white space, or match the word NULL. Double quotes
    // > and backslashes embedded in element values will be backslash-escaped.
    if (char === DQUOT) {
      // It's escaped
      currentStringStart = ++position;
      let dquot = str.indexOf(DQUOT, currentStringStart);
      let backSlash = str.indexOf(BACKSLASH, currentStringStart);
      while (backSlash !== -1 && backSlash < dquot) {
        position = backSlash;
        const part = str.slice(currentStringStart, position);
        currentString += part;
        currentStringStart = ++position;
        if (dquot === position++) {
          // This was an escaped doublequote; find the next one!
          dquot = str.indexOf(DQUOT, position);
        }
        // Either way, find the next backslash
        backSlash = str.indexOf(BACKSLASH, position);
      }
      position = dquot;
      const part = str.slice(currentStringStart, position);
      currentString += part;
      current.push(transform ? transform(currentString) : currentString);
      currentString = '';
      expectValue = false;
    } else if (char === LBRACE) {
      const newArray: Nested = [];
      current.push(newArray);
      stack.push(current);
      current = newArray;
      currentStringStart = position + 1;
      expectValue = true;
    } else if (char === COMMA) {
      expectValue = true;
    } else if (char === RBRACE) {
      expectValue = false;
      const arr = stack.pop();
      if (arr === undefined) {
        throw new Error("Invalid array text - too many '}'");
      }
      current = arr;
    } else if (expectValue) {
      currentStringStart = position;
      while ((char = str[position]) !== COMMA && char !== RBRACE && position < rbraceIndex) {
        ++position;
      }
      const part = str.slice(currentStringStart, position--);
      current.push(part === NULL_STRING ? null : transform ? transform(part) : part);
      expectValue = false;
    } else {
      throw new Error('Was expecting delimeter');
    }
  }

  return output;
}

// ── conversion ──────────────────────────────────────────────────────────────

/**
 * Additional scalar column types not defined in `pg` types builtins.
 */
const AdditionalScalarColumnType = { NAME: 19 };

/**
 * PostgreSQL array column types (not defined in ScalarColumnType).
 *
 * See the semantics of each of this code in:
 *   https://github.com/postgres/postgres/blob/master/src/include/catalog/pg_type.dat
 */
const ArrayColumnType = {
  BIT: 1561,
  BOOL: 1000,
  BYTEA: 1001,
  BPCHAR: 1014,
  CHAR: 1002,
  CIDR: 651,
  DATE: 1182,
  FLOAT4: 1021,
  FLOAT8: 1022,
  INET: 1041,
  INT2: 1005,
  INT4: 1007,
  INT8: 1016,
  JSONB: 3807,
  JSON: 199,
  MONEY: 791,
  NUMERIC: 1231,
  OID: 1028,
  TEXT: 1009,
  TIMESTAMP: 1115,
  TIMESTAMPTZ: 1185,
  TIME: 1183,
  UUID: 2951,
  VARBIT: 1563,
  VARCHAR: 1015,
  XML: 143
};

class UnsupportedNativeDataType extends Error {
  // The upstream table names every builtin; the message only needs a name.
  type: string;
  constructor(code: number) {
    super();
    this.type = `oid ${code}`;
    this.message = `Unsupported column type ${this.type}`;
  }
}

/**
 * This is a simplification of quaint's value inference logic. Take a look at quaint's conversion.rs
 * module to see how other attributes of the field packet such as the field length are used to infer
 * the correct quaint::Value variant.
 */
function fieldToColumnType(t: Record<string, number>, fieldTypeId: number): ColumnType {
  switch (fieldTypeId) {
    case t.INT2:
    case t.INT4:
      return ColumnTypeEnum.Int32;
    case t.INT8:
      return ColumnTypeEnum.Int64;
    case t.FLOAT4:
      return ColumnTypeEnum.Float;
    case t.FLOAT8:
      return ColumnTypeEnum.Double;
    case t.BOOL:
      return ColumnTypeEnum.Boolean;
    case t.DATE:
      return ColumnTypeEnum.Date;
    case t.TIME:
    case t.TIMETZ:
      return ColumnTypeEnum.Time;
    case t.TIMESTAMP:
    case t.TIMESTAMPTZ:
      return ColumnTypeEnum.DateTime;
    case t.NUMERIC:
    case t.MONEY:
      return ColumnTypeEnum.Numeric;
    case t.JSON:
    case t.JSONB:
      return ColumnTypeEnum.Json;
    case t.UUID:
      return ColumnTypeEnum.Uuid;
    case t.OID:
      return ColumnTypeEnum.Int64;
    case t.BPCHAR:
    case t.TEXT:
    case t.VARCHAR:
    case t.BIT:
    case t.VARBIT:
    case t.INET:
    case t.CIDR:
    case t.XML:
    case AdditionalScalarColumnType.NAME:
      return ColumnTypeEnum.Text;
    case t.CHAR:
      return ColumnTypeEnum.Character;
    case t.BYTEA:
      return ColumnTypeEnum.Bytes;
    case ArrayColumnType.INT2:
    case ArrayColumnType.INT4:
      return ColumnTypeEnum.Int32Array;
    case ArrayColumnType.FLOAT4:
      return ColumnTypeEnum.FloatArray;
    case ArrayColumnType.FLOAT8:
      return ColumnTypeEnum.DoubleArray;
    case ArrayColumnType.NUMERIC:
    case ArrayColumnType.MONEY:
      return ColumnTypeEnum.NumericArray;
    case ArrayColumnType.BOOL:
      return ColumnTypeEnum.BooleanArray;
    case ArrayColumnType.CHAR:
      return ColumnTypeEnum.CharacterArray;
    case ArrayColumnType.BPCHAR:
    case ArrayColumnType.TEXT:
    case ArrayColumnType.VARCHAR:
    case ArrayColumnType.VARBIT:
    case ArrayColumnType.BIT:
    case ArrayColumnType.INET:
    case ArrayColumnType.CIDR:
    case ArrayColumnType.XML:
      return ColumnTypeEnum.TextArray;
    case ArrayColumnType.DATE:
      return ColumnTypeEnum.DateArray;
    case ArrayColumnType.TIMESTAMP:
    case ArrayColumnType.TIMESTAMPTZ:
      return ColumnTypeEnum.DateTimeArray;
    case ArrayColumnType.JSON:
    case ArrayColumnType.JSONB:
      return ColumnTypeEnum.JsonArray;
    case ArrayColumnType.BYTEA:
      return ColumnTypeEnum.BytesArray;
    case ArrayColumnType.UUID:
      return ColumnTypeEnum.UuidArray;
    case ArrayColumnType.INT8:
    case ArrayColumnType.OID:
      return ColumnTypeEnum.Int64Array;
    default:
      // An extension's type (halfvec, vector): its OID is past the builtins,
      // and it comes back as its text.
      if (fieldTypeId >= 10_000) return ColumnTypeEnum.Text;
      throw new UnsupportedNativeDataType(fieldTypeId);
  }
}

const normalizeArray =
  (elementNormalizer: Parser): Parser =>
  (str) =>
    parseArray(str, elementNormalizer);

const identity: Parser = (value) => value;

const normalizeTimestamp: Parser = (time) => `${time.replace(' ', 'T')}+00:00`;

const normalizeTimestampz: Parser = (time) =>
  time.replace(' ', 'T').replace(/[+-]\d{2}(:\d{2})?$/, '+00:00');

const normalizeTimez: Parser = (time) => time.replace(/[+-]\d{2}(:\d{2})?$/, '');

const normalizeMoney: Parser = (money) => money.slice(1);

const parsePgBytes = (x: string): Uint8Array => {
  const hexString = x.slice(2);
  return Uint8Array.from({ length: hexString.length / 2 }, (_, idx) =>
    Number.parseInt(hexString.substring(idx * 2, (idx + 1) * 2), 16)
  );
};

/**
 * Convert bytes to a JSON-encodable representation since we can't
 * currently send a parsed Buffer or ArrayBuffer across JS to Rust
 * boundary.
 */
const normalizeByteaArray: Parser = (x) =>
  (parseArray(x) as string[]).map((item) => parsePgBytes(item));

/**
 * The parsers Prisma expects: numbers, times and JSON left as their text for
 * the engine to read, bytes as bytes. JSON is handed off to the engine
 * entirely, so it stays stringified here; the parser has to exist, or the
 * default one would deserialise it.
 */
function customParsers(t: Record<string, number>): Record<number, Parser> {
  return {
    [t.NUMERIC]: identity,
    [ArrayColumnType.NUMERIC]: normalizeArray(identity),
    [t.TIME]: identity,
    [ArrayColumnType.TIME]: normalizeArray(identity),
    [t.TIMETZ]: normalizeTimez,
    [t.DATE]: identity,
    [ArrayColumnType.DATE]: normalizeArray(identity),
    [t.TIMESTAMP]: normalizeTimestamp,
    [ArrayColumnType.TIMESTAMP]: normalizeArray(normalizeTimestamp),
    [t.TIMESTAMPTZ]: normalizeTimestampz,
    [ArrayColumnType.TIMESTAMPTZ]: normalizeArray(normalizeTimestampz),
    [t.MONEY]: normalizeMoney,
    [ArrayColumnType.MONEY]: normalizeArray(normalizeMoney),
    [t.JSON]: identity,
    [ArrayColumnType.JSON]: normalizeArray(identity),
    [t.JSONB]: identity,
    [ArrayColumnType.JSONB]: normalizeArray(identity),
    [t.BYTEA]: parsePgBytes,
    [ArrayColumnType.BYTEA]: normalizeByteaArray,
    [ArrayColumnType.BIT]: normalizeArray(identity),
    [ArrayColumnType.VARBIT]: normalizeArray(identity),
    [ArrayColumnType.XML]: normalizeArray(identity),
    [t.INT8]: identity,
    [ArrayColumnType.INT8]: normalizeArray(identity)
  };
}

const pad = (n: number, z = 2) => String(n).padStart(z, '0');

function formatDateTime(date: Date): string {
  const ms = date.getUTCMilliseconds();
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${ms ? `.${String(ms).padStart(3, '0')}` : ''}`;
}

function formatDate(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function formatTime(date: Date): string {
  const ms = date.getUTCMilliseconds();
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${ms ? `.${String(ms).padStart(3, '0')}` : ''}`;
}

function mapArg(arg: unknown, argType: ArgType): unknown {
  if (arg === null) return null;
  if (Array.isArray(arg) && argType.arity === 'list') {
    return arg.map((value) => mapArg(value, argType));
  }
  let value = arg;
  if (typeof value === 'string' && argType.scalarType === 'datetime') value = new Date(value);
  if (value instanceof Date) {
    switch (argType.dbType) {
      case 'TIME':
      case 'TIMETZ':
        return formatTime(value);
      case 'DATE':
        return formatDate(value);
      default:
        return formatDateTime(value);
    }
  }
  if (typeof value === 'string' && argType.scalarType === 'bytes') {
    return Buffer.from(value, 'base64');
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

// ── errors ──────────────────────────────────────────────────────────────────

type PgError = {
  code: string;
  message: string;
  severity: string;
  detail?: string;
  column?: string;
  hint?: string;
  constraint?: string;
};

function isDriverError(error: unknown): error is PgError {
  const e = error as Partial<PgError>;
  return (
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    typeof e.severity === 'string' &&
    (typeof e.detail === 'string' || e.detail === undefined) &&
    (typeof e.column === 'string' || e.column === undefined) &&
    (typeof e.hint === 'string' || e.hint === undefined)
  );
}

const keyFields = (error: PgError) =>
  error.detail?.match(/Key \(([^)]+)\)/)?.at(1)?.split(', ');

const quoted = (text: string | undefined) => text?.split('"').at(1);

function mapDriverError(error: PgError): DriverError {
  switch (error.code) {
    case '22001':
      return { kind: 'LengthMismatch', column: error.column };
    case '22003':
      return { kind: 'ValueOutOfRange', cause: error.message };
    case '22P02':
      return { kind: 'InvalidInputValue', message: error.message };
    case '23505': {
      const fields = keyFields(error);
      return {
        kind: 'UniqueConstraintViolation',
        constraint: fields !== undefined ? { fields } : undefined
      };
    }
    case '23502': {
      const fields = keyFields(error);
      return {
        kind: 'NullConstraintViolation',
        constraint: fields !== undefined ? { fields } : undefined
      };
    }
    case '23503': {
      let constraint: { fields: string[] } | { index: string } | undefined;
      if (error.column) constraint = { fields: [error.column] };
      else if (error.constraint) constraint = { index: error.constraint };
      return { kind: 'ForeignKeyConstraintViolation', constraint };
    }
    case '3D000':
      return { kind: 'DatabaseDoesNotExist', db: quoted(error.message.split(' ').at(1)) };
    case '28000':
      return {
        kind: 'DatabaseAccessDenied',
        db: quoted(error.message.split(',').find((s) => s.startsWith(' database')))
      };
    case '28P01':
      return { kind: 'AuthenticationFailed', user: quoted(error.message.split(' ').pop()) };
    case '40001':
      return { kind: 'TransactionWriteConflict' };
    case '42P01':
      return { kind: 'TableDoesNotExist', table: quoted(error.message.split(' ').at(1)) };
    case '42703':
      return { kind: 'ColumnNotFound', column: quoted(error.message.split(' ').at(1)) };
    case '42P04':
      return { kind: 'DatabaseAlreadyExists', db: quoted(error.message.split(' ').at(1)) };
    case '53300':
      return { kind: 'TooManyConnections', cause: error.message };
    default:
      return {
        kind: 'postgres',
        code: error.code ?? 'N/A',
        severity: error.severity ?? 'N/A',
        message: error.message,
        detail: error.detail,
        column: error.column,
        hint: error.hint
      };
  }
}

function convertDriverError(error: unknown): DriverError {
  if (isDriverError(error)) {
    return {
      originalCode: error.code,
      originalMessage: error.message,
      ...mapDriverError(error)
    } as DriverError;
  }
  throw error;
}

// ── the adapter ─────────────────────────────────────────────────────────────

const ADAPTER_NAME = 'pglite-prisma-adapter';

class PgliteQueryableAdapter {
  readonly provider = 'postgres' as const;
  readonly adapterName = ADAPTER_NAME;

  constructor(
    protected readonly pglite: PgliteModule,
    protected readonly client: PgliteQueryable
  ) {}

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const { fields, rows } = await this.performIO(query);
    const columnNames = fields.map((field) => field.name);
    let columnTypes: ColumnType[] = [];
    try {
      columnTypes = fields.map((field) => fieldToColumnType(this.pglite.types, field.dataTypeID));
    } catch (e) {
      if (e instanceof UnsupportedNativeDataType) {
        throw new DriverAdapterError({ kind: 'UnsupportedNativeDataType', type: e.type });
      }
      throw e;
    }
    return { columnNames, columnTypes, rows };
  }

  /**
   * Execute a query given as SQL, interpolating the given parameters and
   * returning the number of affected rows.
   */
  async executeRaw(query: SqlQuery): Promise<number> {
    return (await this.performIO(query)).affectedRows ?? 0;
  }

  private async performIO(query: SqlQuery): Promise<PgliteResults> {
    const { sql, args } = query;
    const values = args.map((arg, i) => mapArg(arg, query.argTypes[i]));
    try {
      return await this.client.query(sql, values, {
        rowMode: 'array',
        parsers: customParsers(this.pglite.types)
      });
    } catch (e) {
      return this.onError(e);
    }
  }

  protected onError(error: unknown): never {
    if (error instanceof this.pglite.messages.DatabaseError) {
      throw new DriverAdapterError(convertDriverError(error));
    }
    throw error;
  }
}

class PgliteTransaction extends PgliteQueryableAdapter implements Transaction {
  constructor(
    pglite: PgliteModule,
    client: PgliteTx,
    readonly options: TransactionOptions,
    private readonly done: () => void,
    private readonly result: Promise<void>
  ) {
    super(pglite, client);
  }

  async commit(): Promise<void> {
    this.done();
    return this.result;
  }

  async rollback(): Promise<void> {
    await (this.client as PgliteTx).rollback();
    this.done();
    return this.result;
  }
}

class PgliteAdapter extends PgliteQueryableAdapter implements SqlDriverAdapter {
  constructor(
    pglite: PgliteModule,
    private readonly db: PgliteClient
  ) {
    super(pglite, db);
  }

  async executeScript(script: string): Promise<void> {
    try {
      await this.db.exec(script);
    } catch (e) {
      this.onError(e);
    }
  }

  getConnectionInfo(): ConnectionInfo {
    return { supportsRelationJoins: true };
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    const options: TransactionOptions = { usePhantomQuery: true };
    if (isolationLevel) {
      await this.db
        .exec(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`)
        .catch((error: unknown) => this.onError(error));
    }
    // PGlite's transaction runs while its callback's promise is pending: the
    // transaction is handed back from inside it, and commit or rollback
    // resolves that promise, which ends it.
    return new Promise<Transaction>((resolve, reject) => {
      let done = () => {};
      const finished = new Promise<void>((end) => {
        done = end;
      });
      const result = this.db
        .transaction(async (tx) => {
          resolve(new PgliteTransaction(this.pglite, tx, options, done, result));
          return finished;
        })
        .catch((error: unknown) => {
          reject(error);
        });
    });
  }

  async dispose(): Promise<void> {}
}

/** The Prisma driver adapter on one PGlite database. */
export function pgliteAdapter(pglite: PgliteModule, db: PgliteClient): SqlDriverAdapter {
  return new PgliteAdapter(pglite, db);
}
