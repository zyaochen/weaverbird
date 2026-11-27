declare module 'better-sqlite3' {
  type RunResult = { changes: number };

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    pragma(source: string): void;
    exec(source: string): void;
    close(): void;
    prepare(source: string): Statement;
  }

  interface DatabaseConstructor {
    new (path: string): Database;
  }

  const BetterSqlite3: DatabaseConstructor;
  export default BetterSqlite3;
}
