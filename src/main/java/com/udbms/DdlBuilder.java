package com.udbms;

import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Builds DDL for MySQL, PostgreSQL and Oracle. It never touches a database, so every method can be tested on its own.
 *
 * "container" means: the database in MySQL, the schema in PostgreSQL, the schema (user) in Oracle. It may be null.
 * Names of objects that already exist are quoted exactly as given. Names of new objects are validated and left unquoted,
 * so each database folds them the way it normally does (Oracle upper case, PostgreSQL lower case, MySQL unchanged).
 */
final class DdlBuilder {
    private DdlBuilder() {}

    static final String MY = "mysql", PG = "postgresql", ORA = "oracle";
    private static final Pattern ID = Pattern.compile("[A-Za-z_][A-Za-z0-9_$#]{0,127}");
    private static final Pattern TYPE = Pattern.compile(
        "[A-Za-z][A-Za-z0-9_ ]*(\\(\\s*\\d+(\\s+(CHAR|BYTE))?(\\s*,\\s*\\d+)?\\s*\\))?[A-Za-z0-9_ ]*", Pattern.CASE_INSENSITIVE);
    private static final Pattern NUMBER = Pattern.compile("[+-]?\\d+(\\.\\d+)?");
    private static final Pattern NOW_FN = Pattern.compile("(CURRENT_TIMESTAMP|NOW|LOCALTIMESTAMP)(\\(\\d?\\))?", Pattern.CASE_INSENSITIVE);
    private static final Set<String> KEYWORDS = Set.of("CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "SYSDATE", "SYSTIMESTAMP",
        "NOW()", "TRUE", "FALSE", "LOCALTIMESTAMP", "CURRENT_USER", "USER");
    private static final Set<String> FK_ACTIONS = Set.of("CASCADE", "SET NULL", "RESTRICT", "NO ACTION", "SET DEFAULT");
    private static final Pattern WORD = Pattern.compile("[A-Za-z0-9_]+");

    /** A column as typed in the designer. */
    record Col(String name, String type, boolean pk, boolean notNull, boolean unique, boolean auto, String def) {}

    /** What MySQL reports about a column. MySQL needs the full definition again when one part of it changes. */
    record Current(String type, boolean nullable, String def, boolean auto, String charset, String collation, String comment, String onUpdate) {}

    // ------------------------------------------------------------------ names and values

    static void dialect(String d) {
        if (!MY.equals(d) && !PG.equals(d) && !ORA.equals(d))
            throw new IllegalArgumentException("Table design works with MySQL, PostgreSQL and Oracle connections.");
    }

    /** A new object name: letters, digits, _ $ #, starting with a letter or underscore. */
    static String fresh(String n) {
        if (n == null || !ID.matcher(n.trim()).matches())
            throw new IllegalArgumentException("Invalid name \"" + n + "\". Use letters, digits and underscores, starting with a letter.");
        return n.trim();
    }

    /** An existing object name, quoted for the database. */
    static String ref(String d, String n) {
        if (n == null || n.isEmpty() || n.length() > 128 || n.chars().anyMatch(ch -> ch == '`' || ch == '"' || Character.isISOControl(ch)))
            throw new IllegalArgumentException("Invalid name.");
        return MY.equals(d) ? "`" + n + "`" : "\"" + n + "\"";
    }

    private static String q(String d, String container, String table) {
        return container == null || container.isBlank() ? ref(d, table) : ref(d, container) + "." + ref(d, table);
    }
    private static String qFresh(String d, String container, String name) {
        return container == null || container.isBlank() ? fresh(name) : ref(d, container) + "." + fresh(name);
    }

    static String type(String t) {
        if (t == null || t.isBlank() || t.length() > 80 || !TYPE.matcher(t.trim()).matches())
            throw new IllegalArgumentException("Invalid column type \"" + t + "\". Examples: INT, VARCHAR(100), DECIMAL(10,2), TIMESTAMP.");
        return t.trim().replaceAll("\\s+", " ");
    }

    /** Defaults cannot be bound as parameters in DDL, so they are turned into a safe literal: number, keyword, NULL or quoted text. */
    static String literal(String d, String v) {
        if (v == null) throw new IllegalArgumentException("Enter a default value.");
        String t = v.trim();
        if (t.equalsIgnoreCase("null")) return "NULL";
        if (NUMBER.matcher(t).matches()) return t;
        if (KEYWORDS.contains(t.toUpperCase()) || NOW_FN.matcher(t).matches()) return t.toUpperCase();
        if (t.length() >= 2 && t.startsWith("'") && t.endsWith("'") && !t.substring(1, t.length() - 1).replace("''", "").contains("'")) {
            return MY.equals(d) ? t.substring(0, 1) + t.substring(1, t.length() - 1).replace("\\", "\\\\") + "'" : t;
        }
        String s = v.replace("'", "''");
        if (MY.equals(d)) s = s.replace("\\", "\\\\");
        return "'" + s + "'";
    }

    /** True when the stored default is something literal() can write back faithfully (a number, NULL, a keyword or plain text). */
    static boolean isPlainDefault(String v) {
        if (v == null) return true;
        String t = v.trim();
        return !(t.endsWith(")") && !NOW_FN.matcher(t).matches() && !t.equalsIgnoreCase("NOW()"));
    }

    static String qualified(String d, String container, String table) { return q(d, container, table); }

    private static String cols(String d, List<String> names) {
        if (names == null || names.isEmpty()) throw new IllegalArgumentException("Choose at least one column.");
        return names.stream().map(n -> ref(d, n)).collect(Collectors.joining(", "));
    }
    private static String freshCols(List<String> names) {
        if (names == null || names.isEmpty()) throw new IllegalArgumentException("Choose at least one column.");
        return names.stream().map(DdlBuilder::fresh).collect(Collectors.joining(", "));
    }
    private static String named(String name) { return name == null || name.isBlank() ? "" : "CONSTRAINT " + fresh(name) + " "; }

    // ------------------------------------------------------------------ tables

    private static String colDef(String d, Col c) {
        StringBuilder s = new StringBuilder(fresh(c.name())).append(' ').append(type(c.type()));
        boolean hasDef = c.def() != null && !c.def().isEmpty();
        if (c.auto()) {
            s.append(MY.equals(d) ? " AUTO_INCREMENT" : " GENERATED BY DEFAULT AS IDENTITY");
        } else if (hasDef) {
            s.append(" DEFAULT ").append(literal(d, c.def()));
        }
        if (c.notNull() || c.pk()) s.append(" NOT NULL");
        if (c.unique() && !c.pk()) s.append(" UNIQUE");
        return s.toString();
    }

    static String createTable(String d, String container, String name, List<Col> cols) {
        dialect(d);
        if (cols == null || cols.isEmpty()) throw new IllegalArgumentException("Add at least one column.");
        Set<String> seen = new HashSet<>();
        StringJoiner defs = new StringJoiner(",\n  ");
        List<String> pk = new ArrayList<>();
        for (Col c : cols) {
            if (!seen.add(fresh(c.name()).toLowerCase())) throw new IllegalArgumentException("Column \"" + c.name() + "\" is listed twice.");
            defs.add(colDef(d, c));
            if (c.pk()) pk.add(c.name().trim());
        }
        if (!pk.isEmpty()) defs.add("PRIMARY KEY (" + freshCols(pk) + ")");
        return "CREATE TABLE " + qFresh(d, container, name) + " (\n  " + defs + "\n)";
    }

    static String renameTable(String d, String container, String old, String neu) {
        dialect(d);
        // MySQL resolves an unqualified new name in the default database, so it is qualified there. PostgreSQL and Oracle need it bare.
        return "ALTER TABLE " + q(d, container, old) + " RENAME TO " + (MY.equals(d) ? qFresh(d, container, neu) : fresh(neu));
    }

    static String dropTable(String d, String container, String table, boolean cascade) {
        dialect(d);
        return "DROP TABLE " + q(d, container, table) + (!cascade ? "" : PG.equals(d) ? " CASCADE" : ORA.equals(d) ? " CASCADE CONSTRAINTS" : "");
    }

    static String truncate(String d, String container, String table) { dialect(d); return "TRUNCATE TABLE " + q(d, container, table); }

    /** Copies the rows (or only the column layout when withData is false). Keys, indexes and defaults are not copied by the database. */
    static String duplicate(String d, String container, String src, String neu, boolean withData) {
        dialect(d);
        return "CREATE TABLE " + qFresh(d, container, neu) + " AS SELECT * FROM " + q(d, container, src) + (withData ? "" : " WHERE 1 = 0");
    }

    // ------------------------------------------------------------------ columns

    static String addColumn(String d, String container, String table, Col c) {
        dialect(d);
        String def = colDef(d, c);
        return "ALTER TABLE " + q(d, container, table) + (ORA.equals(d) ? " ADD (" + def + ")" : " ADD COLUMN " + def);
    }

    static String dropColumn(String d, String container, String table, String col) {
        dialect(d);
        return "ALTER TABLE " + q(d, container, table) + " DROP COLUMN " + ref(d, col);
    }

    static String renameColumn(String d, String container, String table, String old, String neu) {
        dialect(d);
        return "ALTER TABLE " + q(d, container, table) + " RENAME COLUMN " + ref(d, old) + " TO " + fresh(neu);
    }

    /** MySQL before 8.0 (and MariaDB before 10.5) cannot RENAME COLUMN: CHANGE needs the whole definition. */
    static String renameColumnLegacyMy(String container, String table, String old, String neu, Current cur) {
        return "ALTER TABLE " + q(MY, container, table) + " CHANGE COLUMN " + ref(MY, old) + " " + fresh(neu) + " " + myDef(cur, null, null, "keep", null);
    }

    private static String myDef(Current cur, String newType, Boolean nullable, String defMode, String defValue) {
        StringBuilder s = new StringBuilder(newType != null ? type(newType) : cur.type());
        if (newType == null && cur.charset() != null && cur.collation() != null && WORD.matcher(cur.charset()).matches() && WORD.matcher(cur.collation()).matches())
            s.append(" CHARACTER SET ").append(cur.charset()).append(" COLLATE ").append(cur.collation());
        s.append((nullable != null ? nullable : cur.nullable()) ? " NULL" : " NOT NULL");
        if ("set".equals(defMode)) s.append(" DEFAULT ").append(literal(MY, defValue));
        else if ("keep".equals(defMode) && cur.def() != null) s.append(" DEFAULT ").append(literal(MY, cur.def()));
        if (cur.auto()) s.append(" AUTO_INCREMENT");
        if (cur.onUpdate() != null && NOW_FN.matcher(cur.onUpdate()).matches()) s.append(" ON UPDATE ").append(cur.onUpdate().toUpperCase());
        if (cur.comment() != null && !cur.comment().isEmpty()) s.append(" COMMENT '").append(cur.comment().replace("\\", "\\\\").replace("'", "''")).append("'");
        return s.toString();
    }

    /**
     * Changes the type, nullability or default of a column in one statement.
     * newType: null keeps the type. nullable: null keeps it. defMode: keep | set | drop.
     * cur is required for MySQL only.
     */
    static String modifyColumn(String d, String container, String table, String col, String newType, Boolean nullable,
                               String defMode, String defValue, Current cur) {
        return modifyColumn(d, container, table, col, newType, nullable, defMode, defValue, cur, null);
    }

    /** comment: MySQL only (a column comment is part of its definition there); null keeps it. */
    static String modifyColumn(String d, String container, String table, String col, String newType, Boolean nullable,
                               String defMode, String defValue, Current cur, String comment) {
        dialect(d);
        if (MY.equals(d) && comment != null && cur != null)
            cur = new Current(cur.type(), cur.nullable(), cur.def(), cur.auto(), cur.charset(), cur.collation(), comment, cur.onUpdate());
        String t = q(d, container, table), c = ref(d, col);
        if (defMode == null) defMode = "keep";
        if (newType == null && nullable == null && "keep".equals(defMode) && comment == null) throw new IllegalArgumentException("Nothing to change.");
        if (MY.equals(d)) {
            if (cur == null) throw new IllegalArgumentException("The current column definition is needed for MySQL.");
            return "ALTER TABLE " + t + " MODIFY COLUMN " + c + " " + myDef(cur, newType, nullable, defMode, defValue);
        }
        if (PG.equals(d)) {
            List<String> a = new ArrayList<>();
            if (newType != null) a.add("ALTER COLUMN " + c + " TYPE " + type(newType) + " USING " + c + "::" + type(newType));
            if (nullable != null) a.add("ALTER COLUMN " + c + (nullable ? " DROP NOT NULL" : " SET NOT NULL"));
            if ("set".equals(defMode)) a.add("ALTER COLUMN " + c + " SET DEFAULT " + literal(d, defValue));
            if ("drop".equals(defMode)) a.add("ALTER COLUMN " + c + " DROP DEFAULT");
            return "ALTER TABLE " + t + " " + String.join(", ", a);
        }
        StringBuilder m = new StringBuilder(c);
        if (newType != null) m.append(' ').append(type(newType));
        if ("set".equals(defMode)) m.append(" DEFAULT ").append(literal(d, defValue));
        if ("drop".equals(defMode)) m.append(" DEFAULT NULL");
        if (nullable != null) m.append(nullable ? " NULL" : " NOT NULL");
        return "ALTER TABLE " + t + " MODIFY (" + m + ")";
    }

    // ------------------------------------------------------------------ indexes and keys

    static String addIndex(String d, String container, String table, String name, List<String> columns, boolean unique) {
        dialect(d);
        // PostgreSQL does not allow a schema on the index name. Oracle needs it, or the index lands in the connected user's schema.
        String idx = ORA.equals(d) ? qFresh(d, container, name) : fresh(name);
        return "CREATE " + (unique ? "UNIQUE " : "") + "INDEX " + idx + " ON " + q(d, container, table) + " (" + cols(d, columns) + ")";
    }

    static String dropIndex(String d, String container, String table, String name) {
        dialect(d);
        return MY.equals(d) ? "DROP INDEX " + ref(d, name) + " ON " + q(d, container, table) : "DROP INDEX " + q(d, container, name);
    }

    /** PostgreSQL and Oracle keep a UNIQUE constraint and its index together: the constraint has to be dropped, not the index. */
    static String dropConstraint(String d, String container, String table, String name) {
        dialect(d);
        return "ALTER TABLE " + q(d, container, table) + " DROP CONSTRAINT " + ref(d, name);
    }

    static String addPrimaryKey(String d, String container, String table, String name, List<String> columns) {
        dialect(d);
        return "ALTER TABLE " + q(d, container, table) + " ADD " + (MY.equals(d) ? "" : named(name)) + "PRIMARY KEY (" + cols(d, columns) + ")";
    }

    static String dropPrimaryKey(String d, String container, String table, String pkName) {
        dialect(d);
        if (PG.equals(d)) {
            if (pkName == null || pkName.isBlank()) throw new IllegalArgumentException("This table has no primary key.");
            return dropConstraint(d, container, table, pkName);
        }
        return "ALTER TABLE " + q(d, container, table) + " DROP PRIMARY KEY";
    }

    static String addUnique(String d, String container, String table, String name, List<String> columns) {
        dialect(d);
        return "ALTER TABLE " + q(d, container, table) + " ADD " + named(name) + "UNIQUE (" + cols(d, columns) + ")";
    }

    static String addForeignKey(String d, String container, String table, String name, List<String> columns,
                                String refContainer, String refTable, List<String> refColumns, String onDelete) {
        dialect(d);
        if (columns == null || refColumns == null || columns.size() != refColumns.size())
            throw new IllegalArgumentException("Choose the same number of columns on both sides.");
        StringBuilder s = new StringBuilder("ALTER TABLE ").append(q(d, container, table)).append(" ADD ").append(named(name))
            .append("FOREIGN KEY (").append(cols(d, columns)).append(") REFERENCES ").append(q(d, refContainer, refTable))
            .append(" (").append(cols(d, refColumns)).append(")");
        String a = onDelete == null ? "" : onDelete.trim().toUpperCase();
        if (!a.isEmpty()) {
            if (!FK_ACTIONS.contains(a)) throw new IllegalArgumentException("Unknown ON DELETE action.");
            // Oracle only knows CASCADE and SET NULL. NO ACTION is what it does when nothing is said.
            boolean skip = ORA.equals(d) && !a.equals("CASCADE") && !a.equals("SET NULL");
            if (!skip) s.append(" ON DELETE ").append(a);
        }
        return s.toString();
    }

    static String dropForeignKey(String d, String container, String table, String name) {
        dialect(d);
        return MY.equals(d) ? "ALTER TABLE " + q(d, container, table) + " DROP FOREIGN KEY " + ref(d, name) : dropConstraint(d, container, table, name);
    }


    // ------------------------------------------------------------------ views, checks, comments

    /** SQL typed by the user (a SELECT or a CHECK condition). One statement only: no semicolons, no comments. */
    private static String fragment(String v, String what) {
        String t = v == null ? "" : v.trim();
        while (t.endsWith(";")) t = t.substring(0, t.length() - 1).trim();
        if (t.isEmpty()) throw new IllegalArgumentException("Enter the " + what + ".");
        if (t.length() > 20000 || t.contains(";") || t.contains("--") || t.contains("/*") || t.contains("*/"))
            throw new IllegalArgumentException("The " + what + " must be a single statement without ; or comments.");
        return t;
    }

    private static String strLit(String d, String v) {
        String s = v.replace("'", "''");
        return "'" + (MY.equals(d) ? s.replace("\\", "\\\\") : s) + "'";
    }

    static String createView(String d, String container, String name, String select, boolean replace) {
        dialect(d);
        String q = fragment(select, "SELECT statement");
        if (!Pattern.compile("(?is)^\\(*\\s*(select|with)\\b.*").matcher(q).matches()) throw new IllegalArgumentException("A view must be defined by a SELECT statement.");
        return "CREATE " + (replace ? "OR REPLACE " : "") + "VIEW " + qFresh(d, container, name) + " AS\n" + q;
    }

    static String dropView(String d, String container, String name) { dialect(d); return "DROP VIEW " + q(d, container, name); }

    static String addCheck(String d, String container, String table, String name, String expr) {
        dialect(d);
        return "ALTER TABLE " + q(d, container, table) + " ADD " + named(name) + "CHECK (" + fragment(expr, "condition") + ")";
    }

    /** MySQL 8.0.19+, PostgreSQL and Oracle all accept DROP CONSTRAINT for a check. */
    static String dropCheck(String d, String container, String table, String name) { return dropConstraint(d, container, table, name); }

    static String commentTable(String d, String container, String table, String text) {
        dialect(d);
        String t = text == null ? "" : text;
        if (t.length() > 1000) throw new IllegalArgumentException("The comment is too long.");
        return MY.equals(d) ? "ALTER TABLE " + q(d, container, table) + " COMMENT = " + strLit(d, t)
            : "COMMENT ON TABLE " + q(d, container, table) + " IS " + strLit(d, t);
    }

    /** PostgreSQL and Oracle. (MySQL: pass the comment to modifyColumn.) */
    static String commentColumn(String d, String container, String table, String col, String text) {
        dialect(d);
        if (MY.equals(d)) throw new IllegalArgumentException("In MySQL a column comment is part of its definition.");
        String t = text == null ? "" : text;
        if (t.length() > 1000) throw new IllegalArgumentException("The comment is too long.");
        return "COMMENT ON COLUMN " + q(d, container, table) + "." + ref(d, col) + " IS " + strLit(d, t);
    }

    // ------------------------------------------------------------------ databases and schemas

    /** MySQL database, PostgreSQL schema. Oracle schemas are users: they are created in the User Manager. */
    static String createContainer(String d, String name, String charset, String collation) {
        dialect(d);
        if (ORA.equals(d)) throw new IllegalArgumentException("In Oracle a schema is a user. Create one in the User Manager tab.");
        StringBuilder s = new StringBuilder(PG.equals(d) ? "CREATE SCHEMA " : "CREATE DATABASE ").append(fresh(name));
        if (MY.equals(d)) {
            if (charset != null && !charset.isBlank()) s.append(" CHARACTER SET ").append(word(charset));
            if (collation != null && !collation.isBlank()) s.append(" COLLATE ").append(word(collation));
        }
        return s.toString();
    }

    static String alterContainer(String d, String name, String charset, String collation) {
        dialect(d);
        if (!MY.equals(d)) throw new IllegalArgumentException("Only MySQL databases have a character set and collation.");
        if ((charset == null || charset.isBlank()) && (collation == null || collation.isBlank())) throw new IllegalArgumentException("Nothing to change.");
        StringBuilder s = new StringBuilder("ALTER DATABASE ").append(ref(d, name));
        if (charset != null && !charset.isBlank()) s.append(" CHARACTER SET ").append(word(charset));
        if (collation != null && !collation.isBlank()) s.append(" COLLATE ").append(word(collation));
        return s.toString();
    }

    static String dropContainer(String d, String name, boolean cascade) {
        dialect(d);
        if (ORA.equals(d)) throw new IllegalArgumentException("In Oracle a schema is a user. Drop it in the User Manager tab.");
        return PG.equals(d) ? "DROP SCHEMA " + ref(d, name) + (cascade ? " CASCADE" : "") : "DROP DATABASE " + ref(d, name);
    }

    static String renameSchemaPg(String old, String neu) { return "ALTER SCHEMA " + ref(PG, old) + " RENAME TO " + fresh(neu); }

    /**
     * MySQL has no RENAME DATABASE. The tables are moved to a new database instead, which is the same thing as long as
     * the old database holds nothing but tables (the service checks that first).
     */
    static List<String> renameDatabaseMy(String old, String neu, String charset, String collation, List<String> tables) {
        List<String> out = new ArrayList<>();
        out.add(createContainer(MY, neu, charset, collation));
        if (!tables.isEmpty())
            out.add("RENAME TABLE " + tables.stream().map(t -> ref(MY, old) + "." + ref(MY, t) + " TO " + ref(MY, neu) + "." + ref(MY, t)).collect(Collectors.joining(", ")));
        out.add("DROP DATABASE " + ref(MY, old));
        return out;
    }

    // PostgreSQL databases (the server level above schemas)
    static String createDatabasePg(String name) { return "CREATE DATABASE " + fresh(name); }
    static String renameDatabasePg(String old, String neu) { return "ALTER DATABASE " + ref(PG, old) + " RENAME TO " + fresh(neu); }
    static String dropDatabasePg(String name) { return "DROP DATABASE " + ref(PG, name); }

    private static String word(String w) {
        if (!WORD.matcher(w.trim()).matches()) throw new IllegalArgumentException("Invalid character set or collation.");
        return w.trim();
    }
}
