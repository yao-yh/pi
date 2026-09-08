/** SQLite 预处理语句的执行结果。 */
export interface SqliteRunResult {
	changes: number;
	lastInsertRowid?: number;
}

/** SQLite 会话后端使用的预处理语句能力。 */
export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get<TRow extends object>(...params: unknown[]): TRow | undefined;
	all<TRow extends object>(...params: unknown[]): TRow[];
	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow>;
}

/** SQLite 会话后端使用的数据库能力。 */
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	/** 运行同步写事务。回调不得返回 Promise。 */
	transaction<T>(callback: () => T): T;
	close(): void;
}

export interface SqliteDatabaseFactory {
	/** 打开可写数据库；数据库不存在时创建。 */
	open(path: string): Promise<SqliteDatabase>;
	/** 打开可写数据库，但不创建不存在的数据库。 */
	openExisting(path: string): Promise<SqliteDatabase>;
	/** 以只读方式打开现有数据库。 */
	openReadOnly(path: string): Promise<SqliteDatabase>;
}
