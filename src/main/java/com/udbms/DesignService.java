package com.udbms;

import org.springframework.stereotype.Service;

import java.sql.*;
import java.util.*;

/**
 * Database and table designer for MySQL, PostgreSQL and Oracle.
 * "container" = MySQL database, PostgreSQL schema, Oracle schema (user). The SQL itself comes from DdlBuilder.
 */
@Service
public class DesignService {
    private static final Set<String> MY_SYSTEM = Set.of("mysql", "sys", "information_schema", "performance_schema");
    private static final Set<String> ORA_SYSTEM = Set.of("SYS", "SYSTEM", "OUTLN", "DBSNMP", "APPQOSSYS", "DBSFWUSER", "GGSYS", "ANONYMOUS",
        "XDB", "WMSYS", "CTXSYS", "MDSYS", "ORDSYS", "ORDDATA", "ORDPLUGINS", "LBACSYS", "OJVMSYS", "AUDSYS", "GSMADMIN_INTERNAL", "DVSYS", "DVF",
        "SYSBACKUP", "SYSDG", "SYSKM", "SYSRAC", "GSMCATUSER", "GSMUSER", "XS$NULL", "DIP", "ORACLE_OCM", "OLAPSYS", "REMOTE_SCHEDULER_AGENT");
    private final DbService db;
    public DesignService(DbService db) { this.db = db; }

    // ------------------------------------------------------------------ helpers

    private DbService.Session sql(String id) {
        var s = db.get(id);
        if (s.jdbc() == null) throw new IllegalArgumentException("Table design works with MySQL, PostgreSQL and Oracle connections.");
        DdlBuilder.dialect(s.type());
        return s;
    }
    private static boolean my(DbService.Session s) { return DdlBuilder.MY.equals(s.type()); }
    private static boolean pg(DbService.Session s) { return DdlBuilder.PG.equals(s.type()); }
    private static boolean ora(DbService.Session s) { return DdlBuilder.ORA.equals(s.type()); }
    private static boolean blank(String x) { return x == null || x.isBlank(); }

    /** The database (MySQL) or schema (PostgreSQL, Oracle) this connection works in right now. */
    private static String current(DbService.Session s) throws SQLException {
        Connection c = s.jdbc();
        if (my(s)) return c.getCatalog();
        String x = c.getSchema();
        return blank(x) ? (s.user() == null ? null : s.user().toUpperCase()) : x;
    }
    private static String container(DbService.Session s, String c) throws SQLException {
        String r = blank(c) ? current(s) : c;
        if (blank(r)) throw new IllegalArgumentException("Choose a " + (my(s) ? "database" : "schema") + " first.");
        return r;
    }

    @SuppressWarnings("unchecked")
    private static List<List<Object>> rows(Connection c, String sql, Object... p) throws SQLException {
        return (List<List<Object>>) OracleController.qry(c, sql, p).get("rows");
    }
    private static String txt(Object o) { return o == null ? null : o.toString(); }

    /** Optional metadata (comments, check constraints): older servers may not have it. Not used for PostgreSQL, where a failed query would abort the transaction. */
    private static List<List<Object>> soft(DbService.Session s, Connection c, String sql, Object... p) throws SQLException {
        try { return rows(c, sql, p); } catch (SQLException e) { if (pg(s)) throw e; return List.of(); }
    }
    private static String one(Connection c, String sql, Object... p) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < p.length; i++) ps.setObject(i + 1, p[i]);
            try (ResultSet r = ps.executeQuery()) { return r.next() ? r.getString(1) : null; }
        }
    }

    /** Table names are LIKE patterns in DatabaseMetaData: escape _ and % so "my_table" does not also match "myXtable". */
    private static String lit(DatabaseMetaData md, String s) throws SQLException {
        String e = md.getSearchStringEscape();
        if (s == null || e == null || e.isEmpty()) return s;
        return s.replace(e, e + e).replace("_", e + "_").replace("%", e + "%");
    }

    // ------------------------------------------------------------------ reading

    public Map<String, Object> overview(String id) throws Exception {
        var s = sql(id); Connection c = s.jdbc();
        Map<String, Object> m = new LinkedHashMap<>();
        List<Map<String, Object>> cs = new ArrayList<>();
        synchronized (c) {
            m.put("type", s.type());
            m.put("current", current(s));
            m.put("label", my(s) ? "Database" : "Schema");
            m.put("version", c.getMetaData().getDatabaseProductVersion());
            if (my(s)) {
                for (var r : rows(c, "SELECT schema_name FROM information_schema.schemata ORDER BY 1"))
                    cs.add(Map.of("name", txt(r.get(0)), "system", MY_SYSTEM.contains(txt(r.get(0)).toLowerCase())));
            } else if (pg(s)) {
                for (var r : rows(c, "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' "
                    + "AND has_schema_privilege(nspname, 'USAGE') ORDER BY 1"))
                    cs.add(Map.of("name", txt(r.get(0)), "system", false));
                List<Map<String, Object>> dbs = new ArrayList<>();
                String cur = c.getCatalog();
                for (var r : rows(c, "SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY 1"))
                    dbs.add(Map.of("name", txt(r.get(0)), "current", txt(r.get(0)).equals(cur)));
                m.put("databases", dbs);
            } else {
                List<List<Object>> us;
                try { us = rows(c, "SELECT username, oracle_maintained FROM all_users ORDER BY 1"); }
                catch (SQLException e) { us = rows(c, "SELECT username, CASE WHEN 1 = 1 THEN 'N' END FROM all_users ORDER BY 1"); }
                for (var r : us) {
                    String n = txt(r.get(0));
                    cs.add(Map.of("name", n, "system", "Y".equals(txt(r.get(1))) || ORA_SYSTEM.contains(n)));
                }
            }
        }
        m.put("containers", cs);
        m.put("canManageContainers", !ora(s));
        return m;
    }

    public Map<String, Object> tables(String id, String container) throws Exception {
        var s = sql(id); Connection c = s.jdbc();
        List<Map<String, Object>> out = new ArrayList<>();
        String ct;
        synchronized (c) {
            ct = container(s, container);
            DatabaseMetaData md = c.getMetaData();
            try (ResultSet r = md.getTables(my(s) ? ct : null, my(s) ? null : lit(md, ct), "%", new String[]{"TABLE", "VIEW"})) {
                while (r.next()) {
                    String n = r.getString("TABLE_NAME");
                    if (n.startsWith("BIN$")) continue;
                    out.add(Map.of("name", n, "kind", "VIEW".equals(r.getString("TABLE_TYPE")) ? "VIEW" : "TABLE"));
                }
            }
        }
        out.sort(Comparator.comparing((Map<String, Object> x) -> ((String) x.get("name")).toLowerCase()));
        return Map.of("container", ct, "tables", out);
    }

    private static String typeText(String name, int jdbc, int size, int digits) {
        switch (jdbc) {
            case Types.CHAR, Types.VARCHAR, Types.NCHAR, Types.NVARCHAR, Types.BINARY, Types.VARBINARY:
                return size > 0 && size < 100000 ? name + "(" + size + ")" : name;
            case Types.NUMERIC, Types.DECIMAL:
                if (size <= 0 || size > 1000 || name.contains("(")) return name;
                return name + "(" + size + (digits > 0 ? "," + digits : "") + ")";
            default: return name;
        }
    }

    public Map<String, Object> describe(String id, String container, String table) throws Exception {
        var s = sql(id); Connection c = s.jdbc();
        List<Map<String, Object>> cols = new ArrayList<>(), fks = new ArrayList<>(), idxs = new ArrayList<>(), checks = new ArrayList<>();
        String pkName = null, tcomment = ""; List<String> pk = new ArrayList<>();
        synchronized (c) {
            String ct = container(s, container);
            DatabaseMetaData md = c.getMetaData();
            String cat = my(s) ? ct : null, sch = my(s) ? null : ct;
            try (ResultSet r = md.getColumns(cat, lit(md, sch), lit(md, table), "%")) {
                while (r.next()) {
                    String def = r.getString("COLUMN_DEF");
                    Map<String, Object> col = new LinkedHashMap<>();
                    col.put("name", r.getString("COLUMN_NAME"));
                    col.put("type", typeText(r.getString("TYPE_NAME"), r.getInt("DATA_TYPE"), r.getInt("COLUMN_SIZE"), r.getInt("DECIMAL_DIGITS")));
                    col.put("nullable", "YES".equals(r.getString("IS_NULLABLE")));
                    col.put("default", def == null ? null : def.strip());
                    col.put("auto", "YES".equals(r.getString("IS_AUTOINCREMENT")));
                    cols.add(col);
                }
            }
            if (cols.isEmpty()) throw new IllegalArgumentException("Table \"" + table + "\" was not found in " + ct + ".");
            TreeMap<Integer, String> byKey = new TreeMap<>();
            try (ResultSet r = md.getPrimaryKeys(cat, sch, table)) {
                while (r.next()) { pkName = r.getString("PK_NAME"); byKey.put(r.getInt("KEY_SEQ"), r.getString("COLUMN_NAME")); }
            }
            pk.addAll(byKey.values());
            for (var col : cols) col.put("pk", pk.contains((String) col.get("name")));

            record IR(int ord, String col, boolean unique) {}
            Map<String, List<IR>> ix = new LinkedHashMap<>();
            // approximate = true: with false the Oracle driver gathers statistics first, which is slow and needs extra privileges
            try (ResultSet r = md.getIndexInfo(cat, sch, table, false, true)) {
                while (r.next()) {
                    String n = r.getString("INDEX_NAME");
                    if (n == null) continue;
                    String cn = r.getString("COLUMN_NAME");
                    ix.computeIfAbsent(n, k -> new ArrayList<>()).add(new IR(r.getInt("ORDINAL_POSITION"), cn == null ? "(expression)" : cn, !r.getBoolean("NON_UNIQUE")));
                }
            }
            for (var e : ix.entrySet()) {
                var list = new ArrayList<>(e.getValue());
                list.sort(Comparator.comparingInt(IR::ord));
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", e.getKey());
                m.put("unique", list.get(0).unique());
                m.put("primary", e.getKey().equals(pkName) || (my(s) && e.getKey().equals("PRIMARY")));
                m.put("columns", list.stream().map(IR::col).toList());
                idxs.add(m);
            }

            record FR(int seq, String col, String refCol) {}
            Map<String, List<FR>> fm = new LinkedHashMap<>();
            Map<String, String[]> fmeta = new HashMap<>();
            try (ResultSet r = md.getImportedKeys(cat, sch, table)) {
                while (r.next()) {
                    String n = r.getString("FK_NAME"); if (n == null) n = "(unnamed)";
                    fm.computeIfAbsent(n, k -> new ArrayList<>()).add(new FR(r.getInt("KEY_SEQ"), r.getString("FKCOLUMN_NAME"), r.getString("PKCOLUMN_NAME")));
                    fmeta.put(n, new String[]{ my(s) ? r.getString("PKTABLE_CAT") : r.getString("PKTABLE_SCHEM"), r.getString("PKTABLE_NAME"),
                        switch (r.getShort("DELETE_RULE")) { case 0 -> "CASCADE"; case 1 -> "RESTRICT"; case 2 -> "SET NULL"; case 4 -> "SET DEFAULT"; default -> "NO ACTION"; } });
                }
            }
            for (var e : fm.entrySet()) {
                var list = new ArrayList<>(e.getValue());
                list.sort(Comparator.comparingInt(FR::seq));
                String[] me = fmeta.get(e.getKey());
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", e.getKey());
                m.put("columns", list.stream().map(FR::col).toList());
                m.put("refContainer", me[0]); m.put("refTable", me[1]);
                m.put("refColumns", list.stream().map(FR::refCol).toList());
                m.put("onDelete", me[2]);
                fks.add(m);
            }

            String qn = DdlBuilder.qualified(s.type(), ct, table);
            Map<String, String> cm = new HashMap<>();
            List<List<Object>> ck;
            if (my(s)) {
                for (var r : soft(s, c, "SELECT column_name, column_comment FROM information_schema.columns WHERE table_schema = ? AND table_name = ?", ct, table)) cm.put(txt(r.get(0)), txt(r.get(1)));
                var tr = soft(s, c, "SELECT table_comment FROM information_schema.tables WHERE table_schema = ? AND table_name = ?", ct, table);
                if (!tr.isEmpty() && txt(tr.get(0).get(0)) != null && !"VIEW".equals(txt(tr.get(0).get(0)))) tcomment = txt(tr.get(0).get(0));
                ck = soft(s, c, "SELECT cc.constraint_name, cc.check_clause FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc "
                    + "ON tc.constraint_schema = cc.constraint_schema AND tc.constraint_name = cc.constraint_name WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'CHECK'", ct, table);
            } else if (pg(s)) {
                for (var r : rows(c, "SELECT a.attname, col_description(a.attrelid, a.attnum) FROM pg_attribute a WHERE a.attrelid = to_regclass(?) AND a.attnum > 0 AND NOT a.attisdropped", qn)) cm.put(txt(r.get(0)), txt(r.get(1)));
                tcomment = txt(rows(c, "SELECT obj_description(to_regclass(?), 'pg_class')", qn).get(0).get(0));
                ck = rows(c, "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = to_regclass(?) AND contype = 'c' ORDER BY conname", qn);
            } else {
                for (var r : soft(s, c, "SELECT column_name, comments FROM all_col_comments WHERE owner = ? AND table_name = ?", ct, table)) cm.put(txt(r.get(0)), txt(r.get(1)));
                var tr = soft(s, c, "SELECT comments FROM all_tab_comments WHERE owner = ? AND table_name = ?", ct, table);
                if (!tr.isEmpty()) tcomment = txt(tr.get(0).get(0));
                ck = soft(s, c, "SELECT constraint_name, search_condition_vc FROM all_constraints WHERE owner = ? AND table_name = ? AND constraint_type = 'C' "
                    + "AND search_condition_vc NOT LIKE '%IS NOT NULL' ORDER BY constraint_name", ct, table);
            }
            for (var col : cols) col.put("comment", cm.get((String) col.get("name")) == null ? "" : cm.get((String) col.get("name")));
            for (var r : ck) {
                String e = txt(r.get(1)) == null ? "" : txt(r.get(1)).trim();
                if (e.regionMatches(true, 0, "CHECK ", 0, 6)) e = e.substring(6).trim();
                checks.add(Map.of("name", txt(r.get(0)), "expr", e));
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("columns", cols);
        out.put("primaryKey", Map.of("name", pkName == null ? "" : pkName, "columns", pk));
        out.put("indexes", idxs);
        out.put("foreignKeys", fks);
        out.put("checks", checks);
        out.put("comment", tcomment == null ? "" : tcomment);
        return out;
    }


    // ------------------------------------------------------------------ DDL text, view definitions, diagram

    /** The CREATE statement(s) of a table or view. MySQL and Oracle ask the server; PostgreSQL (and Oracle as a fallback) are rebuilt from the structure. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> ddl(String id, String container, String table) throws Exception {
        var s = sql(id); Connection c = s.jdbc();
        synchronized (c) {
            String ct = container(s, container), qn = DdlBuilder.qualified(s.type(), ct, table), text = null;
            if (my(s)) {
                try (Statement st = c.createStatement(); ResultSet r = st.executeQuery("SHOW CREATE TABLE " + qn)) { text = r.next() ? r.getString(2) : null; }
            } else if (ora(s)) {
                try {
                    String kind = one(c, "SELECT object_type FROM all_objects WHERE owner = ? AND object_name = ? AND object_type IN ('TABLE', 'VIEW')", ct, table);
                    if (kind != null) text = one(c, "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM dual", kind, table, ct);
                } catch (SQLException e) { text = null; }
            } else if ("v".equals(one(c, "SELECT relkind::text FROM pg_class WHERE oid = to_regclass(?)", qn))) {
                text = "CREATE OR REPLACE VIEW " + qn + " AS\n" + one(c, "SELECT pg_get_viewdef(to_regclass(?), true)", qn);
            }
            if (text == null || text.isBlank()) text = synth(id, s, c, ct, table, qn);
            return Map.of("ddl", text.trim());
        }
    }

    @SuppressWarnings("unchecked")
    private String synth(String id, DbService.Session s, Connection c, String ct, String table, String qn) throws Exception {
        String d = s.type();
        Map<String, Object> info = describe(id, ct, table);
        StringJoiner defs = new StringJoiner(",\n  ");
        for (Map<String, Object> col : (List<Map<String, Object>>) info.get("columns")) {
            StringBuilder x = new StringBuilder(DdlBuilder.ref(d, (String) col.get("name"))).append(' ').append(col.get("type"));
            if (Boolean.TRUE.equals(col.get("auto"))) x.append(" GENERATED BY DEFAULT AS IDENTITY");
            else if (col.get("default") != null) x.append(" DEFAULT ").append(col.get("default"));
            if (!Boolean.TRUE.equals(col.get("nullable"))) x.append(" NOT NULL");
            defs.add(x);
        }
        List<String> pk = (List<String>) ((Map<String, Object>) info.get("primaryKey")).get("columns");
        if (!pk.isEmpty()) defs.add("PRIMARY KEY (" + String.join(", ", pk.stream().map(n -> DdlBuilder.ref(d, n)).toList()) + ")");
        for (Map<String, Object> k : (List<Map<String, Object>>) info.get("checks")) {
            String e = (String) k.get("expr");
            defs.add("CONSTRAINT " + DdlBuilder.ref(d, (String) k.get("name")) + " CHECK " + (e.startsWith("(") ? e : "(" + e + ")"));
        }
        for (Map<String, Object> f : (List<Map<String, Object>>) info.get("foreignKeys")) {
            String od = (String) f.get("onDelete");
            defs.add("CONSTRAINT " + DdlBuilder.ref(d, (String) f.get("name")) + " FOREIGN KEY (" + String.join(", ", ((List<String>) f.get("columns")).stream().map(n -> DdlBuilder.ref(d, n)).toList())
                + ") REFERENCES " + DdlBuilder.qualified(d, (String) f.get("refContainer"), (String) f.get("refTable")) + " (" + String.join(", ", ((List<String>) f.get("refColumns")).stream().map(n -> DdlBuilder.ref(d, n)).toList()) + ")"
                + ("NO ACTION".equals(od) ? "" : " ON DELETE " + od));
        }
        StringBuilder out = new StringBuilder("CREATE TABLE " + qn + " (\n  " + defs + "\n);");
        if (pg(s)) {
            String pkName = (String) ((Map<String, Object>) info.get("primaryKey")).get("name");
            for (var r : rows(c, "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ? ORDER BY indexname", ct, table))
                if (!txt(r.get(0)).equals(pkName)) out.append("\n\n").append(txt(r.get(1))).append(';');
        } else {
            for (Map<String, Object> x : (List<Map<String, Object>>) info.get("indexes")) {
                if (Boolean.TRUE.equals(x.get("primary"))) continue;
                out.append("\n\nCREATE ").append(Boolean.TRUE.equals(x.get("unique")) ? "UNIQUE " : "").append("INDEX ").append(DdlBuilder.ref(d, (String) x.get("name"))).append(" ON ").append(qn)
                    .append(" (").append(String.join(", ", ((List<String>) x.get("columns")).stream().map(n -> DdlBuilder.ref(d, n)).toList())).append(");");
            }
        }
        return out.toString();
    }

    /** The SELECT behind a view, for editing. */
    public Map<String, Object> view(String id, String container, String name) throws Exception {
        var s = sql(id); Connection c = s.jdbc();
        synchronized (c) {
            String ct = container(s, container), def = my(s)
                ? one(c, "SELECT view_definition FROM information_schema.views WHERE table_schema = ? AND table_name = ?", ct, name)
                : pg(s) ? one(c, "SELECT pg_get_viewdef(to_regclass(?), true)", DdlBuilder.qualified(s.type(), ct, name))
                : one(c, "SELECT text FROM all_views WHERE owner = ? AND view_name = ?", ct, name);
            if (def == null) throw new IllegalArgumentException("View \"" + name + "\" was not found.");
            return Map.of("definition", def.trim().replaceAll(";\\s*$", ""));
        }
    }

    /** Tables, their columns and the foreign keys between them (first 40 tables) for the ER diagram. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> erd(String id, String container) throws Exception {
        var s = sql(id); Connection c = s.jdbc();
        synchronized (c) {
            String ct = container(s, container);
            List<Map<String, Object>> tabs = new ArrayList<>(), links = new ArrayList<>();
            int n = 0; boolean cut = false;
            for (Map<String, Object> t : (List<Map<String, Object>>) tables(id, ct).get("tables")) {
                if (!"TABLE".equals(t.get("kind"))) continue;
                if (n++ >= 40) { cut = true; break; }
                String name = (String) t.get("name");
                Map<String, Object> info = describe(id, ct, name);
                List<Map<String, Object>> cs = new ArrayList<>();
                for (Map<String, Object> col : (List<Map<String, Object>>) info.get("columns")) cs.add(Map.of("name", col.get("name"), "pk", col.get("pk")));
                tabs.add(Map.of("name", name, "columns", cs));
                for (Map<String, Object> f : (List<Map<String, Object>>) info.get("foreignKeys"))
                    if (f.get("refContainer") == null || ct.equals(f.get("refContainer")))
                        links.add(Map.of("from", name, "to", f.get("refTable"), "name", f.get("name"), "columns", f.get("columns"), "refColumns", f.get("refColumns")));
            }
            return Map.of("container", ct, "tables", tabs, "links", links, "truncated", cut);
        }
    }

    // ------------------------------------------------------------------ changing

    private static String str(Map<String, Object> b, String k) { Object o = b.get(k); return o == null ? null : o.toString(); }
    private static boolean flag(Map<String, Object> b, String k) { return Boolean.TRUE.equals(b.get(k)); }
    private static String need(Map<String, Object> b, String k) {
        String v = str(b, k);
        if (blank(v)) throw new IllegalArgumentException("\"" + k + "\" is missing.");
        return v;
    }
    private static List<String> list(Map<String, Object> b, String k) {
        if (!(b.get(k) instanceof List<?> l)) return List.of();
        return l.stream().map(String::valueOf).toList();
    }
    @SuppressWarnings("unchecked")
    private static DdlBuilder.Col col(Object o) {
        if (!(o instanceof Map<?, ?>)) throw new IllegalArgumentException("Column details are missing.");
        Map<String, Object> m = (Map<String, Object>) o;
        String def = str(m, "def");
        return new DdlBuilder.Col(need(m, "name"), need(m, "type"), flag(m, "pk"), flag(m, "notNull"), flag(m, "unique"), flag(m, "auto"), blank(def) ? null : def);
    }

    /**
     * body: op, dryRun, container, table plus the arguments of the operation. Returns the SQL that ran (or would run).
     * Ops: createTable renameTable dropTable truncate duplicate addColumn dropColumn renameColumn modifyColumn addIndex dropIndex
     *      addPrimaryKey dropPrimaryKey addUnique addForeignKey dropForeignKey createContainer alterContainer dropContainer
     *      renameContainer createDatabase renameDatabase dropDatabase (the last three: PostgreSQL only)
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(String id, Map<String, Object> b) throws Exception {
        var s = sql(id); Connection c = s.jdbc(); String d = s.type();
        String op = need(b, "op"); boolean dry = flag(b, "dryRun");
        String ct = blank(str(b, "container")) ? null : str(b, "container");
        String t = str(b, "table");
        List<String> out = new ArrayList<>();
        synchronized (c) {
            if (ct == null && !op.endsWith("Container") && !op.endsWith("Database")) ct = container(s, null);
            switch (op) {
                case "createTable" -> {
                    if (!(b.get("columns") instanceof List<?> l)) throw new IllegalArgumentException("Add at least one column.");
                    out.add(DdlBuilder.createTable(d, ct, need(b, "name"), l.stream().map(DesignService::col).toList()));
                }
                case "renameTable" -> out.add(DdlBuilder.renameTable(d, ct, need(b, "table"), need(b, "name")));
                case "dropTable" -> out.add(DdlBuilder.dropTable(d, ct, need(b, "table"), flag(b, "cascade")));
                case "truncate" -> out.add(DdlBuilder.truncate(d, ct, need(b, "table")));
                case "duplicate" -> out.add(DdlBuilder.duplicate(d, ct, need(b, "table"), need(b, "name"), flag(b, "withData")));
                case "addColumn" -> out.add(DdlBuilder.addColumn(d, ct, need(b, "table"), col(b.get("col"))));
                case "dropColumn" -> out.add(DdlBuilder.dropColumn(d, ct, need(b, "table"), need(b, "column")));
                case "renameColumn" -> out.add(DdlBuilder.renameColumn(d, ct, need(b, "table"), need(b, "column"), need(b, "name")));
                case "modifyColumn" -> {
                    Boolean nul = b.get("nullable") instanceof Boolean x ? x : null;
                    out.add(DdlBuilder.modifyColumn(d, ct, need(b, "table"), need(b, "column"), blank(str(b, "type")) ? null : str(b, "type"), nul,
                        blank(str(b, "defMode")) ? "keep" : str(b, "defMode"), str(b, "defValue"), my(s) ? myCurrent(c, ct, t, need(b, "column")) : null, my(s) ? str(b, "comment") : null));
                }
                case "addIndex" -> out.add(DdlBuilder.addIndex(d, ct, need(b, "table"), need(b, "name"), list(b, "columns"), flag(b, "unique")));
                case "dropIndex" -> {
                    String n = need(b, "name");
                    out.add(!my(s) && isConstraint(s, ct, need(b, "table"), n) ? DdlBuilder.dropConstraint(d, ct, t, n) : DdlBuilder.dropIndex(d, ct, need(b, "table"), n));
                }
                case "addPrimaryKey" -> out.add(DdlBuilder.addPrimaryKey(d, ct, need(b, "table"), str(b, "name"), list(b, "columns")));
                case "dropPrimaryKey" -> out.add(DdlBuilder.dropPrimaryKey(d, ct, need(b, "table"), pg(s) ? pkName(c, ct, t) : null));
                case "addUnique" -> out.add(DdlBuilder.addUnique(d, ct, need(b, "table"), str(b, "name"), list(b, "columns")));
                case "addForeignKey" -> out.add(DdlBuilder.addForeignKey(d, ct, need(b, "table"), str(b, "name"), list(b, "columns"),
                    blank(str(b, "refContainer")) ? ct : str(b, "refContainer"), need(b, "refTable"), list(b, "refColumns"), str(b, "onDelete")));
                case "createView" -> out.add(DdlBuilder.createView(d, ct, need(b, "name"), str(b, "select"), flag(b, "replace")));
                case "dropView" -> out.add(DdlBuilder.dropView(d, ct, need(b, "table")));
                case "addCheck" -> out.add(DdlBuilder.addCheck(d, ct, need(b, "table"), str(b, "name"), str(b, "expr")));
                case "dropCheck" -> out.add(DdlBuilder.dropCheck(d, ct, need(b, "table"), need(b, "name")));
                case "commentTable" -> out.add(DdlBuilder.commentTable(d, ct, need(b, "table"), str(b, "text")));
                case "commentColumn" -> out.add(DdlBuilder.commentColumn(d, ct, need(b, "table"), need(b, "column"), str(b, "text")));
                case "dropForeignKey" -> out.add(DdlBuilder.dropForeignKey(d, ct, need(b, "table"), need(b, "name")));

                case "createContainer" -> out.add(DdlBuilder.createContainer(d, need(b, "name"), str(b, "charset"), str(b, "collation")));
                case "alterContainer" -> out.add(DdlBuilder.alterContainer(d, need(b, "name"), str(b, "charset"), str(b, "collation")));
                case "dropContainer" -> {
                    String n = need(b, "name");
                    if (my(s) && MY_SYSTEM.contains(n.toLowerCase())) throw new IllegalArgumentException("System databases cannot be dropped.");
                    if (my(s) && n.equals(c.getCatalog())) throw new IllegalArgumentException("This is the database the connection is using. Open another database first.");
                    out.add(DdlBuilder.dropContainer(d, n, flag(b, "cascade")));
                }
                case "renameContainer" -> {
                    String n = need(b, "name"), neu = need(b, "newName");
                    if (pg(s)) out.add(DdlBuilder.renameSchemaPg(n, neu));
                    else if (my(s)) out.addAll(renameMyDatabase(c, n, neu));
                    else throw new IllegalArgumentException("In Oracle a schema is a user. Renaming a user is not supported by Oracle.");
                }
                case "createDatabase", "renameDatabase", "dropDatabase" -> {
                    if (!pg(s)) throw new IllegalArgumentException("Server databases are managed here for PostgreSQL. In MySQL a database is the same as a schema, use the database buttons.");
                    String n = need(b, "name");
                    if (!op.equals("createDatabase") && n.equals(c.getCatalog()))
                        throw new IllegalArgumentException("This is the database you are connected to. Connect to another database first (Home > New connection).");
                    if (!dry && !c.getAutoCommit()) throw new IllegalStateException("PostgreSQL cannot create, rename or drop a database inside a transaction. Turn Auto-commit on (SQL Commands) first.");
                    out.add(switch (op) {
                        case "createDatabase" -> DdlBuilder.createDatabasePg(n);
                        case "renameDatabase" -> DdlBuilder.renameDatabasePg(n, need(b, "newName"));
                        default -> DdlBuilder.dropDatabasePg(n);
                    });
                }
                default -> throw new IllegalArgumentException("Unknown operation \"" + op + "\".");
            }
            Map<String, Object> res = new LinkedHashMap<>();
            res.put("sql", out); res.put("executed", !dry);
            if (dry) return res;
            if ("renameColumn".equals(op) && my(s)) {
                try { run(s, out); }
                catch (SQLSyntaxErrorException e) {          // MySQL before 8.0 has no RENAME COLUMN
                    out = List.of(DdlBuilder.renameColumnLegacyMy(ct, t, b.get("column").toString(), b.get("name").toString(), myCurrent(c, ct, t, b.get("column").toString())));
                    run(s, out); res.put("sql", out);
                }
            } else run(s, out);
            res.put("pending", pg(s) && !c.getAutoCommit());      // PostgreSQL DDL waits for Commit when auto-commit is off
            return res;
        }
    }

    /** Runs the statements one after another. A failing PostgreSQL statement is rolled back to a savepoint so the open transaction stays usable. */
    private void run(DbService.Session s, List<String> sql) throws SQLException {
        Connection c = s.jdbc();
        Savepoint sp = pg(s) && !c.getAutoCommit() ? c.setSavepoint() : null;
        int n = 0;
        try (Statement st = c.createStatement()) {
            for (String q : sql) { n++; st.execute(q); }
        } catch (SQLException e) {
            if (sp != null) try { c.rollback(sp); } catch (SQLException ignored) {}
            if (sql.size() > 1)
                throw new SQLException("Step " + n + " of " + sql.size() + " failed: " + sql.get(n - 1) + "\n" + e.getMessage()
                    + (n > 1 ? "\nThe earlier steps already ran." : ""), e.getSQLState(), e.getErrorCode(), e);
            throw e;
        }
    }

    private DdlBuilder.Current myCurrent(Connection c, String ct, String table, String col) throws SQLException {
        var r = rows(c, "SELECT column_type, is_nullable, column_default, extra, character_set_name, collation_name, column_comment "
            + "FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?", blank(ct) ? c.getCatalog() : ct, table, col);
        if (r.isEmpty()) throw new IllegalArgumentException("Column \"" + col + "\" was not found.");
        var x = r.get(0);
        String extra = txt(x.get(3)) == null ? "" : txt(x.get(3)), def = txt(x.get(2));
        if (extra.toUpperCase().contains("DEFAULT_GENERATED") && !DdlBuilder.isPlainDefault(def))
            throw new IllegalArgumentException("This column's default is an expression (" + def + "). MySQL would lose it, so change this column with SQL Commands instead.");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)on update (\\S+)").matcher(extra);
        return new DdlBuilder.Current(txt(x.get(0)), "YES".equalsIgnoreCase(txt(x.get(1))), def, extra.toLowerCase().contains("auto_increment"),
            txt(x.get(4)), txt(x.get(5)), txt(x.get(6)), m.find() ? m.group(1) : null);
    }

    private boolean isConstraint(DbService.Session s, String ct, String table, String name) throws SQLException {
        Connection c = s.jdbc();
        if (pg(s)) return !rows(c, "SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = to_regclass(?)", name, DdlBuilder.qualified(s.type(), ct, table)).isEmpty();
        return !rows(c, "SELECT 1 FROM all_constraints WHERE owner = ? AND table_name = ? AND constraint_name = ? AND constraint_type IN ('U', 'P')",
            blank(ct) ? current(s) : ct, table, name).isEmpty();
    }

    private String pkName(Connection c, String ct, String table) throws SQLException {
        try (ResultSet r = c.getMetaData().getPrimaryKeys(null, ct, table)) { return r.next() ? r.getString("PK_NAME") : null; }
    }

    /** MySQL rename = new database + move the tables + drop the old one. Only safe when the old one holds nothing but tables. */
    private List<String> renameMyDatabase(Connection c, String old, String neu) throws SQLException {
        if (MY_SYSTEM.contains(old.toLowerCase())) throw new IllegalArgumentException("System databases cannot be renamed.");
        if (old.equals(c.getCatalog())) throw new IllegalArgumentException("This is the database the connection is using. Open another database first.");
        var sch = rows(c, "SELECT default_character_set_name, default_collation_name FROM information_schema.schemata WHERE schema_name = ?", old);
        if (sch.isEmpty()) throw new IllegalArgumentException("Database \"" + old + "\" was not found.");
        List<String> tables = new ArrayList<>();
        int views = 0;
        for (var r : rows(c, "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name", old)) {
            if ("BASE TABLE".equals(txt(r.get(1)))) tables.add(txt(r.get(0))); else views++;
        }
        int routines = ((Number) rows(c, "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = ?", old).get(0).get(0)).intValue();
        int events = ((Number) rows(c, "SELECT COUNT(*) FROM information_schema.events WHERE event_schema = ?", old).get(0).get(0)).intValue();
        if (views + routines + events > 0)
            throw new IllegalArgumentException("MySQL cannot rename a database directly, and \"" + old + "\" has " + views + " view(s), " + routines + " routine(s) and " + events
                + " event(s) that would be lost when its tables are moved. Drop or recreate those first.");
        return DdlBuilder.renameDatabaseMy(old, neu, txt(sch.get(0).get(0)), txt(sch.get(0).get(1)), tables);
    }

    /** Makes the Object Browser and SQL page work in this database/schema. */
    public Map<String, Object> use(String id, String container) throws Exception {
        var s = sql(id);
        if (blank(container)) throw new IllegalArgumentException("Choose a " + (my(s) ? "database" : "schema") + ".");
        if (my(s)) db.switchDb(id, container);
        else synchronized (s.jdbc()) {
            if (pg(s)) s.jdbc().setSchema(container);
            else try (Statement st = s.jdbc().createStatement()) { st.execute("ALTER SESSION SET CURRENT_SCHEMA = " + DdlBuilder.ref(DdlBuilder.ORA, container)); }
        }
        return Map.of("ok", true, "current", container);
    }
}
