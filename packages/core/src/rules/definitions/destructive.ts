import { certainRule } from '../define';

// After DROP in an ALTER, these words name a constraint-like object, not data.
const ALTER_DROPS_DATA =
  /\bDROP\s+(?!(?:CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN|CHECK|DEFAULT|NOT)\b)[\w"`]|\bTRUNCATE\s+PARTITION\b/i;

const alterDropsData = (kind: string, stripped: string) => kind === 'ALTER' && ALTER_DROPS_DATA.test(stripped);

export const dropTruncate = certainRule({
  id: 'drop-truncate',
  level: 'high',
  reason: (s) =>
    alterDropsData(s.kind, s.stripped)
      ? 'This ALTER statement drops a column, partition or other object and the data in it.'
      : `This ${s.kind} statement permanently removes ${s.kind === 'DROP' ? 'a database object and its data' : 'all rows from a table'}.`,
  changesData: true,
  matchesModel:
    /\b(drop|dropp\w*|truncat\w*|irreversibl\w*|permanently|destroy\w*|cannot be undone|removes? (the )?(table|column|all))\b/i,
  when: (s) => s.kind === 'DROP' || s.kind === 'TRUNCATE' || alterDropsData(s.kind, s.stripped),
});

const CREATE_TABLE_AS =
  /^CREATE\s+(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|OR\s+REPLACE)\s+)*TABLE\b[\s\S]*?\bAS\s*\(*\s*(?:SELECT|WITH|TABLE|VALUES)\b/i;

type RowWriter = 'insert' | 'select-into' | 'create-table-as';

function rowWriter(kind: string, stripped: string): RowWriter | null {
  if (kind === 'INSERT') return 'insert';
  if (kind === 'SELECT' && /\bINTO\b/i.test(stripped)) return 'select-into';
  if (kind === 'CREATE' && CREATE_TABLE_AS.test(stripped)) return 'create-table-as';
  return null;
}

const ROW_WRITER_REASON: Record<RowWriter, string> = {
  insert: 'This INSERT statement adds rows to a table.',
  'select-into': 'This SELECT ... INTO statement writes its result into another table or file.',
  'create-table-as': 'This CREATE TABLE ... AS statement creates a new table filled from a query.',
};

export const insertSelectInto = certainRule({
  id: 'insert-select-into',
  level: 'low',
  reason: (s) => ROW_WRITER_REASON[rowWriter(s.kind, s.stripped) ?? 'insert'],
  changesData: true,
  matchesModel:
    /\b(inserts?|inserting|adds? (new )?rows|writes? (rows|data)|creates? (a )?(new )?table|SELECT\s+INTO|copies)\b/i,
  when: (s) => rowWriter(s.kind, s.stripped) !== null,
});

export const grantRevoke = certainRule({
  id: 'grant-revoke',
  level: 'high',
  reason: (s) => `This ${s.kind} statement changes who is allowed to access the database.`,
  changesData: false,
  matchesModel: /\b(grant\w*|revok\w*|privileges?|permissions?)\b/i,
  when: (s) => s.kind === 'GRANT' || s.kind === 'REVOKE',
});

export const replaceInto = certainRule({
  id: 'replace-into',
  level: 'medium',
  reason: 'This REPLACE statement deletes any existing row with the same key and inserts a new one.',
  changesData: true,
  matchesModel: /\bREPLACE\b|overwrit\w*\s+(existing|rows?)|(deletes?|removes?)\b[^.]*\b(existing|same key)/i,
  when: (s) => s.kind === 'REPLACE',
});

export const merge = certainRule({
  id: 'merge',
  level: 'medium',
  reason: 'This MERGE statement inserts, updates or deletes rows depending on whether they match.',
  changesData: true,
  matchesModel: /\bMERGE\b|\bupsert\b|\bWHEN\s+(NOT\s+)?MATCHED\b/i,
  when: (s) => s.kind === 'MERGE',
});
