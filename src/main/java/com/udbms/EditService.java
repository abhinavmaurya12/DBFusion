package com.udbms;

import org.bson.Document;
import org.bson.types.ObjectId;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.sql.*;
import java.util.*;
import java.util.stream.Collectors;

/** Row, column and table editing. Names are validated and quoted; values are always bound as parameters. */
@Service
public class EditService {
    private static final java.util.regex.Pattern ID = java.util.regex.Pattern.compile("[A-Za-z_][A-Za-z0-9_$#]*");
    private static final java.util.regex.Pattern TYPE = java.util.regex.Pattern.compile("[A-Za-z0-9_(), ]+");
    private final DbService db;
    public EditService(DbService db) { this.db = db; }

    private static String ident(String n) {
        if (n == null || !ID.matcher(n).matches())
            throw new IllegalArgumentException("Invalid name \"" + n + "\". Use letters, digits and underscores, starting with a letter.");
        return n;
    }
    private static String type(String t) {
        if (t == null || !TYPE.matcher(t.trim()).matches()) throw new IllegalArgumentException("Invalid column type.");
        return t.trim();
    }
    private static String quote(Connection c) throws SQLException {
        String q = c.getMetaData().getIdentifierQuoteString().trim();
        return q.isEmpty() ? "\"" : q;
    }
    private static String q(String Q, String n) { return Q + ident(n) + Q; }
    private static String[] scope(DbService.Session s) {
        return new String[]{ s.type().equals("mysql") ? s.db() : null,
            switch (s.type()) { case "postgresql" -> "public"; case "oracle" -> s.user().toUpperCase(); default -> null; } };
    }

    public Map<String, Object> columns(String id, String table) throws Exception {
        var s = db.get(id);
        List<Map<String, Object>> out = new ArrayList<>();
        if (s.mongo() != null) {
            Set<String> keys = new LinkedHashSet<>(List.of("_id"));
            s.mongo().getDatabase(s.db()).getCollection(table).find().limit(50).forEach(d -> keys.addAll(d.keySet()));
            for (String k : keys) out.add(Map.of("name", k, "type", "any", "pk", k.equals("_id")));
            return Map.of("columns", out);
        }
        String[] sc = scope(s);
        DatabaseMetaData md = s.jdbc().getMetaData();
        Set<String> pks = new HashSet<>();
        try (ResultSet r = md.getPrimaryKeys(sc[0], sc[1], table)) { while (r.next()) pks.add(r.getString("COLUMN_NAME")); }
        try (ResultSet r = md.getColumns(sc[0], sc[1], table, "%")) {
            while (r.next()) out.add(Map.of("name", r.getString("COLUMN_NAME"), "type", r.getString("TYPE_NAME"),
                "pk", pks.contains(r.getString("COLUMN_NAME"))));
        }
        return Map.of("columns", out);
    }

    private Map<String, Integer> types(DbService.Session s, String table) throws SQLException {
        String[] sc = scope(s);
        Map<String, Integer> m = new HashMap<>();
        try (ResultSet r = s.jdbc().getMetaData().getColumns(sc[0], sc[1], table, "%")) {
            while (r.next()) m.put(r.getString("COLUMN_NAME"), r.getInt("DATA_TYPE"));
        }
        return m;
    }

    public int insert(String id, String table, Map<String, Object> values) throws Exception {
        var s = db.get(id);
        if (s.mongo() != null) { s.mongo().getDatabase(s.db()).getCollection(table).insertOne(new Document(values)); return 1; }
        if (values.isEmpty()) throw new IllegalArgumentException("Enter a value for at least one column.");
        String Q = quote(s.jdbc());
        List<String> names = new ArrayList<>(values.keySet());
        String sql = "INSERT INTO " + q(Q, table) + " (" + names.stream().map(n -> q(Q, n)).collect(Collectors.joining(","))
            + ") VALUES (" + String.join(",", Collections.nCopies(names.size(), "?")) + ")";
        return exec(s, table, sql, names, new ArrayList<>(values.values()), false);
    }

    public int update(String id, String table, Map<String, Object> key, Map<String, Object> values) throws Exception {
        var s = db.get(id);
        if (values.isEmpty()) throw new IllegalArgumentException("Nothing to change.");
        if (s.mongo() != null) {
            var r = s.mongo().getDatabase(s.db()).getCollection(table)
                .updateOne(filter(key), new Document("$set", coerceAll(values)));
            return (int) r.getMatchedCount();
        }
        String Q = quote(s.jdbc());
        List<String> names = new ArrayList<>(); List<Object> vals = new ArrayList<>();
        StringJoiner set = new StringJoiner(", ");
        for (var e : values.entrySet()) { set.add(q(Q, e.getKey()) + " = ?"); names.add(e.getKey()); vals.add(e.getValue()); }
        String w = where(Q, key, names, vals);
        return exec(s, table, "UPDATE " + q(Q, table) + " SET " + set + " WHERE " + w, names, vals, true);
    }

    public int delete(String id, String table, Map<String, Object> key) throws Exception {
        var s = db.get(id);
        if (s.mongo() != null)
            return (int) s.mongo().getDatabase(s.db()).getCollection(table).deleteOne(filter(key)).getDeletedCount();
        String Q = quote(s.jdbc());
        List<String> names = new ArrayList<>(); List<Object> vals = new ArrayList<>();
        String w = where(Q, key, names, vals);
        return exec(s, table, "DELETE FROM " + q(Q, table) + " WHERE " + w, names, vals, true);
    }

    public void addColumn(String id, String table, String name, String type) throws Exception {
        var s = db.get(id);
        if (s.mongo() != null)
            throw new IllegalArgumentException("MongoDB collections have no fixed columns. Add the field when you add or edit a document.");
        ddl(s, "ALTER TABLE " + q(quote(s.jdbc()), table) + " ADD " + (s.type().equals("oracle") ? "" : "COLUMN ") + ident(name) + " " + type(type));
    }

    public void createTable(String id, String name, List<Map<String, Object>> cols) throws Exception {
        var s = db.get(id);
        ident(name);
        if (s.mongo() != null) { s.mongo().getDatabase(s.db()).createCollection(name); return; }
        if (cols == null || cols.isEmpty()) throw new IllegalArgumentException("Add at least one column.");
        StringJoiner defs = new StringJoiner(", "); List<String> pk = new ArrayList<>();
        for (var c : cols) {
            String n = ident((String) c.get("name"));
            defs.add(n + " " + type((String) c.get("type")));
            if (Boolean.TRUE.equals(c.get("pk"))) pk.add(n);
        }
        if (!pk.isEmpty()) defs.add("PRIMARY KEY (" + String.join(", ", pk) + ")");
        ddl(s, "CREATE TABLE " + name + " (" + defs + ")");
    }

    public void dropTable(String id, String table) throws Exception {
        var s = db.get(id);
        if (s.mongo() != null) { s.mongo().getDatabase(s.db()).getCollection(table).drop(); return; }
        ddl(s, "DROP TABLE " + q(quote(s.jdbc()), table));
    }

    // ---- helpers ----
    private void ddl(DbService.Session s, String sql) throws SQLException {
        try (Statement st = s.jdbc().createStatement()) { st.execute(sql); }
    }

    private String where(String Q, Map<String, Object> key, List<String> names, List<Object> vals) {
        if (key == null || key.isEmpty()) throw new IllegalArgumentException("No row key given.");
        StringJoiner j = new StringJoiner(" AND ");
        for (var e : key.entrySet()) {
            if (e.getValue() == null) j.add(q(Q, e.getKey()) + " IS NULL");
            else { j.add(q(Q, e.getKey()) + " = ?"); names.add(e.getKey()); vals.add(e.getValue()); }
        }
        return j.toString();
    }

    /** Runs inside the current transaction mode: commits by itself only while auto-commit is on. */
    private int exec(DbService.Session s, String table, String sql, List<String> names, List<Object> vals, boolean guard) throws Exception {
        Connection c = s.jdbc();
        Map<String, Integer> ty = types(s, table);
        boolean pg = s.type().equals("postgresql"), auto = c.getAutoCommit();
        c.setAutoCommit(false);
        Savepoint sp = c.setSavepoint();
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < vals.size(); i++) bind(ps, i + 1, vals.get(i), ty.getOrDefault(names.get(i), Types.VARCHAR), pg);
            int n = ps.executeUpdate();
            if (guard && n > 1) {
                c.rollback(sp);
                throw new IllegalStateException("That key matches " + n + " rows, so nothing was changed. Give this table a primary key to edit it safely.");
            }
            if (auto) c.commit();
            return n;
        } catch (Exception ex) {
            try { c.rollback(sp); } catch (SQLException ignored) {}
            if (auto) c.rollback();
            throw ex;
        } finally { if (auto) c.setAutoCommit(true); }
    }

    private static boolean text(int t) {
        return t == Types.CHAR || t == Types.VARCHAR || t == Types.LONGVARCHAR || t == Types.NCHAR
            || t == Types.NVARCHAR || t == Types.LONGNVARCHAR || t == Types.CLOB;
    }

    private static void bind(PreparedStatement ps, int i, Object v, int t, boolean pg) throws SQLException {
        if (v == null || (v instanceof String str && str.isEmpty() && !text(t))) { ps.setNull(i, t); return; }
        String s = v.toString().trim();
        switch (t) {
            case Types.TINYINT, Types.SMALLINT, Types.INTEGER, Types.BIGINT -> ps.setLong(i, Long.parseLong(s));
            case Types.NUMERIC, Types.DECIMAL, Types.DOUBLE, Types.FLOAT, Types.REAL -> ps.setBigDecimal(i, new BigDecimal(s));
            case Types.BOOLEAN, Types.BIT -> ps.setBoolean(i, s.equalsIgnoreCase("true") || s.equals("1"));
            case Types.DATE -> ps.setDate(i, java.sql.Date.valueOf(s));
            case Types.TIMESTAMP -> ps.setTimestamp(i, Timestamp.valueOf((s.length() == 10 ? s + " 00:00:00" : s).replace('T', ' ')));
            default -> { if (pg && !text(t)) ps.setObject(i, s, Types.OTHER); else ps.setString(i, v.toString()); }
        }
    }

    // ---- MongoDB helpers ----
    private static Document filter(Map<String, Object> key) {
        Document f = new Document();
        key.forEach((k, v) -> f.put(k, k.equals("_id") && v instanceof String s && s.matches("[0-9a-fA-F]{24}") ? new ObjectId(s) : coerce(v)));
        return f;
    }
    private static Document coerceAll(Map<String, Object> m) {
        Document d = new Document(); m.forEach((k, v) -> d.put(k, coerce(v))); return d;
    }
    private static Object coerce(Object v) {
        if (!(v instanceof String s)) return v;
        String t = s.trim();
        if (t.equals("true") || t.equals("false")) return Boolean.parseBoolean(t);
        try { return Long.parseLong(t); } catch (Exception ignored) {}
        try { return Double.parseDouble(t); } catch (Exception ignored) {}
        if (t.startsWith("{")) try { return Document.parse(t); } catch (Exception ignored) {}
        return s;
    }
}