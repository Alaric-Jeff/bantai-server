import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Minimal query surface shared by DatabaseService and pg's PoolClient.
 * Mirrors pg's own signature so both are assignable without a union.
 */
export interface Queryable {
  query<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<QueryResult<T>>;
}
