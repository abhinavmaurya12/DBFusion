package com.udbms;

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import jakarta.annotation.PreDestroy;
import org.bson.Document;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Holds open connections and runs queries. Add a new database by extending connect(), schema() and run(). */
@Service
public class DbService {

    record Session(String type, String name, String db, String user, Connection jdbc, MongoClient mongo) {}
    record Opts(String id, int maxRows, int timeout) {}

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Map<String, Statement> running = new ConcurrentHashMap<>();

    private static final Pattern AS_ROLE = Pattern.compile("^(.*?)\\s+as\\s+(sysdba|sysoper|sysasm|sysbackup|sysdg|syskm)$", Pattern.CASE_INSENSITIVE);
    private static final Set<String> ROLES = Set.of("sysdba", "sysoper", "sysasm", "sysbackup", "sysdg", "syskm");

    // ------------------------------------------------------------------ connections

    public Map<String, Object> connect(ConnectRequest r) throws Exception {
        String t = r.type() == null ? "" : r.type().toLowerCase();
        String host = blank(r.host()) ? "localhost" : r.host().trim();
        String db = r.database() == null ? "" : r.database().trim();
        String user = r.username() == null ? "" : r.username().trim();
        String role = r.role() == null ? "" : r.role().trim().toLowerCase();
        Matcher am = AS_ROLE.matcher(user);
        if (am.matches()) { user = am.group(1).trim(); role = am.group(2).toLowerCase(); }
        Session s;
        if (t.equals("mongodb")) {
            String uri = !blank(r.uri()) ? r.uri() : mongoUri(r, host);
            MongoClient c = MongoClients.create(uri);
            String mdb = blank(db) ? "admin" : db;
            try { c.getDatabase(mdb).runCommand(new Document("ping", 1)); } catch (RuntimeException e) { c.close(); throw e; }
            s = new Session(t, host + "/" + mdb, mdb, r.username(), null, c);
        } else {
            int port = r.port() != null ? r.port() : switch (t) {
                case "mysql" -> 3306; case "postgresql" -> 5432; case "oracle" -> 1521;
                default -> throw new IllegalArgumentException("Unsupported database type: " + t);
            };
            Properties p = new Properties();
            if (!user.isEmpty()) p.setProperty("user", user);
            p.setProperty("password", r.password() == null ? "" : r.password());
            String url;
            switch (t) {
                case "mysql" -> url = "jdbc:mysql://%s:%d/%s?allowPublicKeyRetrieval=true&connectTimeout=10000".formatted(host, port, db);
                case "postgresql" -> { p.setProperty("connectTimeout", "10"); url = "jdbc:postgresql://%s:%d/%s".formatted(host, port, db); }
                default -> {
                    if (blank(db)) throw new IllegalArgumentException("Enter the Oracle service name (for example XE or FREEPDB1).");
                    url = oracleUrl(host, port, db);
                    p.setProperty("oracle.net.CONNECT_TIMEOUT", "10000");
                    if (!role.isEmpty()) {
                        if (!ROLES.contains(role)) throw new IllegalArgumentException("Unknown Oracle role: " + role);
                        p.setProperty("internal_logon", role);
                    }
                }
            }
            Connection c = DriverManager.getConnection(url, p);
            s = new Session(t, host + "/" + db, db, user, c, null);
        }
        String id = UUID.randomUUID().toString();
        sessions.put(id, s);
        return Map.of("id", id, "type", t, "name", s.name());
    }

    /** service name (default), SID ("sid:XE") or a full TNS descriptor ("(DESCRIPTION=...)"). */
    static String oracleUrl(String host, int port, String db) {
        if (db.startsWith("(")) return "jdbc:oracle:thin:@" + db;
        if (db.regionMatches(true, 0, "sid:", 0, 4)) return "jdbc:oracle:thin:@%s:%d:%s".formatted(host, port, db.substring(4).trim());
        return "jdbc:oracle:thin:@//%s:%d/%s".formatted(host, port, db);
    }

    public void disconnect(String id) throws Exception {
        Session s = sessions.remove(id);
        if (s == null) return;
        if (s.jdbc() != null) s.jdbc().close();
        if (s.mongo() != null) s.mongo().close();
    }

    @PreDestroy
    void closeAll() {
        for (String id : new ArrayList<>(sessions.keySet())) { try { disconnect(id); } catch (Exception ignored) {} }
    }

    /** MySQL only: change the current database of an open connection. */
    public String switchDb(String id, String database) throws Exception {
        Session s = get(id);
        if (!"mysql".equals(s.type())) throw new IllegalArgumentException("Switching database is only available for MySQL connections.");
        s.jdbc().setCatalog(database);
        String host = s.name().contains("/") ? s.name().substring(0, s.name().lastIndexOf('/')) : s.name();
        Session n = new Session(s.type(), host + "/" + database, database, s.user(), s.jdbc(), null);
        sessions.put(id, n);
        return n.name();
    }

    /** The schema this connection currently works in (the Designer can switch it), or the fallback if the driver cannot say. */
    static String curSchema(Session s, String fallback) {
        try { String x = s.jdbc().getSchema(); return x == null || x.isBlank() ? fallback : x; }
        catch (SQLException | RuntimeException e) { return fallback; }
    }

    public List<String> schema(String id) throws Exception {
        Session s = get(id);
        List<String> names = new ArrayList<>();
        if (s.mongo() != null) {
            s.mongo().getDatabase(s.db()).listCollectionNames().into(names);
            return names;
        }
        if (s.type().equals("mysql") && blank(s.db())) return names;   // no database selected yet
        String catalog = s.type().equals("mysql") ? s.db() : null;
        String schema = switch (s.type()) {
            case "postgresql" -> curSchema(s, "public");
            case "oracle" -> curSchema(s, s.user().toUpperCase());
            default -> null;
        };
        try (ResultSet rs = s.jdbc().getMetaData().getTables(catalog, schema, "%", new String[]{"TABLE", "VIEW"})) {
            while (rs.next()) { String n = rs.getString("TABLE_NAME"); if (!n.startsWith("BIN$")) names.add(n); }
        }
        return names;
    }

    public Map<String, Object> preview(String id, String table) throws Exception {
        Session s = get(id);
        if (s.mongo() != null)
            return run(id, new Document("collection", table).append("limit", 100).toJson());
        if (table == null || table.isEmpty() || !table.matches("[^\\x00-\\x1f\"`]+")) throw new IllegalArgumentException("Invalid table name");
        return run(id, "SELECT * FROM " + quoteTable(s, table));
    }

    private static String quoteTable(Session s, String t) {
        return switch (s.type()) {
            case "mysql" -> "`" + t + "`";
            case "postgresql" -> t.matches("[a-z_][a-z0-9_$]*") ? t : "\"" + t + "\"";
            default -> t.matches("[A-Z][A-Z0-9_$#]*") ? t : "\"" + t + "\"";
        };
    }

    // ------------------------------------------------------------------ running statements

    /** Legacy entry point: the whole text is one statement. */
    public Map<String, Object> run(String id, String query) throws Exception {
        return exec(id, query, "single", 0, 1000, 0, true);
    }

    /**
     * mode "single"  - the whole text is one statement (used by the tools and admin pages)
     * mode "current" - the statement that contains the cursor offset
     * mode "script"  - every statement in order (stops at the first error unless stopOnError is false)
     */
    public Map<String, Object> exec(String id, String query, String mode, int offset, int maxRows, int timeout, boolean stopOnError) throws Exception {
        Session s = get(id);
        long t0 = System.currentTimeMillis();
        if (s.mongo() != null) {
            Map<String, Object> out = new LinkedHashMap<>(runMongo(s, query));
            out.put("ms", System.currentTimeMillis() - t0);
            return out;
        }
        Opts o = new Opts(id, maxRows, timeout);
        boolean ora = "oracle".equals(s.type());
        synchronized (s.jdbc()) {
            if (ora) enableOutput(s);
            if ("single".equals(mode)) {
                Map<String, Object> out = new LinkedHashMap<>();
                try { out.putAll(runOne(s, query, o)); }
                finally { if (ora) { String txt = drainOutput(s); if (!txt.isEmpty()) out.put("output", txt); } }
                out.put("ms", System.currentTimeMillis() - t0);
                return out;
            }
            List<SqlSplitter.Stmt> list = SqlSplitter.split(query, s.type());
            if (list.isEmpty()) throw new IllegalArgumentException("Nothing to run. Type a statement first.");
            if ("current".equals(mode)) list = List.of(SqlSplitter.at(list, offset));

            List<Map<String, Object>> log = new ArrayList<>();
            Map<String, Object> main = null, last = null;
            String error = null; int errorOffset = -1;
            StringBuilder output = new StringBuilder();
            int n = 0;
            for (SqlSplitter.Stmt st : list) {
                n++;
                long a = System.currentTimeMillis();
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("n", n); entry.put("offset", st.start()); entry.put("sql", abbreviate(st.text(), 160));
                try {
                    Map<String, Object> r = runOne(s, st.text(), o);
                    entry.put("ok", true);
                    if (r.containsKey("columns")) { entry.put("rows", ((List<?>) r.get("rows")).size()); main = r; }
                    if (r.get("message") != null) entry.put("message", r.get("message"));
                    if (r.get("warnings") != null) entry.put("warnings", r.get("warnings"));
                    last = r;
                } catch (SQLException | RuntimeException e) {
                    entry.put("ok", false); entry.put("error", describe(e));
                    if (error == null) { error = describe(e); errorOffset = st.start(); }
                }
                entry.put("ms", System.currentTimeMillis() - a);
                log.add(entry);
                if (ora) { String txt = drainOutput(s); if (!txt.isEmpty()) output.append(txt); }
                if (error != null && stopOnError) break;
            }
            Map<String, Object> res = new LinkedHashMap<>();
            Map<String, Object> base = main != null ? main : last;
            if (base != null) res.putAll(base);
            res.remove("message"); res.remove("warnings");
            if (base != null && base == last && main == null && last.get("message") != null) res.put("message", last.get("message"));
            res.put("log", log);
            res.put("statements", list.size());
            if (error != null) { res.put("error", error); res.put("errorOffset", errorOffset); }
            if (output.length() > 0) res.put("output", output.toString());
            res.put("ms", System.currentTimeMillis() - t0);
            return res;
        }
    }

    /** Stops the statement that is currently running on this connection. */
    public boolean cancel(String id) throws SQLException {
        Statement st = running.get(id);
        if (st == null) return false;
        st.cancel();
        return true;
    }

    private static final Pattern O_DESC = Pattern.compile("^(?:desc|describe)\\s+(?:\"?([\\w$#]+)\"?\\.)?\"?([\\w$#]+)\"?$", Pattern.CASE_INSENSITIVE);
    private static final Pattern O_SHOW_USER = Pattern.compile("^show\\s+user$", Pattern.CASE_INSENSITIVE);
    private static final Pattern O_SHOW_ERR = Pattern.compile("^show\\s+err(ors)?\\b.*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern O_EXEC = Pattern.compile("^exec(?:ute)?\\s+(.+)$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern O_NOOP = Pattern.compile("^(prompt|rem|remark|spool|exit|quit|set)\\b.*$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern O_CREATE = Pattern.compile(
        "^create\\s+(?:or\\s+replace\\s+)?(?:(?:no)?force\\s+)?(?:(?:non)?editionable\\s+)?(procedure|function|package\\s+body|package|trigger|type\\s+body|type)\\s+(?:\"?([\\w$#]+)\"?\\.)?\"?([\\w$#]+)\"?",
        Pattern.CASE_INSENSITIVE);
    private static final Pattern DDL_WORDS = Pattern.compile("^(create(?:\\s+or\\s+replace)?|alter|drop|truncate)\\s+(\\w+(?:\\s+body)?)", Pattern.CASE_INSENSITIVE);

    /** Runs one statement and returns columns/rows, or an update count with a human readable message. */
    private Map<String, Object> runOne(Session s, String raw, Opts o) throws SQLException {
        boolean ora = "oracle".equals(s.type());
        String q = raw.strip();
        boolean plsql = ora && SqlSplitter.isPlsql(q);
        if (plsql) q = q.replaceAll("\\s*\\n/\\s*$", "");
        else q = q.replaceAll(";+\\s*$", "");
        if (q.isEmpty()) throw new IllegalArgumentException("Nothing to run. Type a statement first.");
        if (ora) {
            Map<String, Object> special = oracleCommand(s, q, o);
            if (special != null) return special;
            Matcher ex = O_EXEC.matcher(q);
            if (ex.matches()) { q = "BEGIN " + ex.group(1).strip().replaceAll(";+$", "") + "; END;"; plsql = true; }
        }
        Connection c = s.jdbc();
        try (Statement st = c.createStatement()) {
            running.put(o.id(), st);
            try {
                st.setMaxRows(o.maxRows() + 1);
                st.setFetchSize(Math.min(500, o.maxRows() + 1));
                if (o.timeout() > 0) st.setQueryTimeout(o.timeout());
                Map<String, Object> r = new LinkedHashMap<>();
                if (!st.execute(q)) {
                    int u = st.getUpdateCount();
                    r.put("updateCount", Math.max(u, 0));
                    r.put("message", message(q, plsql, u));
                    if (ora) compileErrors(c, q, r);
                    return r;
                }
                try (ResultSet rs = st.getResultSet()) {
                    ResultSetMetaData md = rs.getMetaData();
                    int n = md.getColumnCount();
                    List<String> cols = new ArrayList<>();
                    for (int i = 1; i <= n; i++) cols.add(md.getColumnLabel(i));
                    List<List<Object>> rows = new ArrayList<>();
                    boolean truncated = false;
                    while (rs.next()) {
                        if (rows.size() >= o.maxRows()) { truncated = true; break; }
                        List<Object> row = new ArrayList<>(n);
                        for (int i = 1; i <= n; i++) row.add(cell(rs, i));
                        rows.add(row);
                    }
                    r.put("columns", cols); r.put("rows", rows);
                    if (truncated) r.put("truncated", true);
                    return r;
                }
            } finally { running.remove(o.id(), st); }
        }
    }

    /** SQL*Plus commands that plain JDBC does not understand. Returns null for ordinary SQL. */
    private Map<String, Object> oracleCommand(Session s, String q, Opts o) throws SQLException {
        Connection c = s.jdbc();
        Matcher m = O_DESC.matcher(q);
        if (m.matches()) {
            String owner = m.group(1) == null ? null : m.group(1).toUpperCase(), name = m.group(2).toUpperCase();
            Map<String, Object> r = OracleController.qry(c,
                "SELECT column_id AS \"#\", column_name AS \"Name\", DECODE(nullable, 'N', 'NOT NULL', '') AS \"Null?\", "
                + "CASE WHEN data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR') THEN data_type || '(' || char_length || ')' "
                + "WHEN data_type = 'NUMBER' AND data_precision IS NOT NULL THEN 'NUMBER(' || data_precision || CASE WHEN NVL(data_scale, 0) > 0 THEN ',' || data_scale END || ')' "
                + "ELSE data_type END AS \"Type\" FROM all_tab_columns WHERE owner = NVL(?, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) AND table_name = ? ORDER BY column_id",
                owner, name);
            if (((List<?>) r.get("rows")).isEmpty()) throw new IllegalArgumentException("ORA-04043: object " + name + " does not exist");
            return r;
        }
        if (O_SHOW_USER.matcher(q).matches()) return OracleController.qry(c, "SELECT USER AS \"USER\" FROM dual");
        if (O_SHOW_ERR.matcher(q).matches())
            return OracleController.qry(c, "SELECT name, type, line, position AS pos, text FROM user_errors ORDER BY name, type, sequence");
        Matcher np = O_NOOP.matcher(q);
        if (np.matches() && !q.matches("(?is)^set\\s+(transaction|role|constraints?)\\b.*")) {
            String w = q.split("\\s+")[0].toLowerCase();
            String msg = w.equals("prompt") ? q.substring(6).strip()
                : w.equals("rem") || w.equals("remark") ? "Comment ignored."
                : "SQL*Plus command ignored (DBMS_OUTPUT is always shown in the Output tab).";
            return new LinkedHashMap<>(Map.of("updateCount", 0, "message", msg));
        }
        return null;
    }

    /** After CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE, report compile errors instead of silent success. */
    private static void compileErrors(Connection c, String q, Map<String, Object> r) {
        Matcher m = O_CREATE.matcher(SqlSplitter.stripLeading(q));
        if (!m.find()) return;
        String type = m.group(1).toUpperCase().replaceAll("\\s+", " "), name = m.group(3).toUpperCase();
        try (PreparedStatement ps = c.prepareStatement("SELECT line, position, text FROM user_errors WHERE name = ? AND type = ? ORDER BY sequence")) {
            ps.setString(1, name); ps.setString(2, type);
            try (ResultSet rs = ps.executeQuery()) {
                List<String> w = new ArrayList<>();
                while (rs.next()) w.add("Line " + rs.getInt(1) + ", column " + rs.getInt(2) + ": " + rs.getString(3));
                if (!w.isEmpty()) {
                    r.put("warnings", w);
                    r.put("message", type.charAt(0) + type.substring(1).toLowerCase() + " " + name + " created with compilation errors.");
                    r.put("compileErrors", true);
                }
            }
        } catch (SQLException ignored) {}
    }

    private static String message(String q, boolean plsql, int u) {
        String body = SqlSplitter.stripLeading(q);
        Matcher w = Pattern.compile("^[A-Za-z]+").matcher(body);
        String first = w.find() ? w.group().toUpperCase() : "";
        switch (first) {
            case "BEGIN", "DECLARE": return "PL/SQL procedure successfully completed.";
            case "INSERT": return u + " row(s) inserted.";
            case "UPDATE": return u + " row(s) updated.";
            case "DELETE": return u + " row(s) deleted.";
            case "MERGE": return u + " row(s) merged.";
            case "COMMIT": return "Commit complete.";
            case "ROLLBACK": return "Rollback complete.";
            case "GRANT": return "Grant succeeded.";
            case "REVOKE": return "Revoke succeeded.";
            default:
        }
        Matcher d = DDL_WORDS.matcher(body);
        if (d.find()) return d.group(1).toUpperCase().replaceAll("\\s+", " ") + " " + d.group(2).toUpperCase().replaceAll("\\s+", " ") + " succeeded.";
        return plsql ? "PL/SQL procedure successfully completed." : (u >= 0 ? u + " row(s) affected." : "Statement executed.");
    }

    private static void enableOutput(Session s) {
        try (CallableStatement cs = s.jdbc().prepareCall("{call DBMS_OUTPUT.ENABLE(1000000)}")) { cs.execute(); } catch (SQLException ignored) {}
    }

    private static String drainOutput(Session s) {
        StringBuilder sb = new StringBuilder();
        try (CallableStatement cs = s.jdbc().prepareCall("{call DBMS_OUTPUT.GET_LINE(?, ?)}")) {
            cs.registerOutParameter(1, Types.VARCHAR); cs.registerOutParameter(2, Types.INTEGER);
            for (int i = 0; i < 5000; i++) { cs.execute(); if (cs.getInt(2) != 0) break; sb.append(cs.getString(1)).append('\n'); }
        } catch (SQLException ignored) {}
        return sb.toString();
    }

    /** Mongo query format: {"collection":"users","filter":{},"limit":50} or {"collection":"users","pipeline":[...]} */
    private Map<String, Object> runMongo(Session s, String json) {
        Document q = Document.parse(json);
        var col = s.mongo().getDatabase(s.db()).getCollection(q.getString("collection"));
        List<Document> docs = new ArrayList<>();
        if (q.containsKey("pipeline")) col.aggregate(q.getList("pipeline", Document.class)).into(docs);
        else {
            Document filter = q.containsKey("filter") ? (Document) q.get("filter") : new Document();
            int limit = q.containsKey("limit") ? ((Number) q.get("limit")).intValue() : 100;
            col.find(filter).limit(limit).into(docs);
        }
        Set<String> cols = new LinkedHashSet<>();
        docs.forEach(d -> cols.addAll(d.keySet()));
        List<List<Object>> rows = new ArrayList<>();
        for (Document d : docs) {
            List<Object> row = new ArrayList<>();
            for (String c : cols) row.add(val(d.get(c)));
            rows.add(row);
        }
        return Map.of("columns", new ArrayList<>(cols), "rows", rows);
    }

    // ------------------------------------------------------------------ values

    /** Reads one cell in a form that is safe to send as JSON. */
    static Object cell(ResultSet rs, int i) throws SQLException {
        Object o;
        try { o = rs.getObject(i); } catch (SQLException e) { return rs.getString(i); }
        if (o == null || o instanceof Clob || o instanceof Blob || o instanceof byte[]) return val(o);
        // Oracle specific types (TIMESTAMP WITH TIME ZONE, ROWID, INTERVAL ...) print best through getString
        if (o.getClass().getName().startsWith("oracle.") || o instanceof java.sql.Array || o instanceof SQLXML) return rs.getString(i);
        return val(o);
    }

    static Object val(Object o) {
        if (o == null || o instanceof Boolean || o instanceof String) return o;
        if (o instanceof java.math.BigDecimal bd) {
            if (bd.scale() <= 0 && bd.precision() <= 15) return bd.longValue();
            if (bd.scale() > 0 && bd.precision() <= 15) return bd.doubleValue();
            return bd.toPlainString();                        // keep every digit of big numbers
        }
        if (o instanceof java.math.BigInteger bi) return bi.bitLength() < 53 ? (Object) bi.longValue() : bi.toString();
        if (o instanceof Long l) return Math.abs(l) <= 9007199254740991L ? o : l.toString();   // JavaScript safe integer range
        if (o instanceof Number) return o;
        if (o instanceof Document doc) return doc.toJson();
        if (o instanceof Timestamp ts) return ts.toString().replaceFirst("\\.0$", "");
        if (o instanceof LocalDateTime dt) return dt.toString().replace('T', ' ') + (dt.getSecond() == 0 && dt.getNano() == 0 ? ":00" : "");
        try {
            if (o instanceof Clob c) return c.getSubString(1, (int) Math.min(c.length(), 100000));
            if (o instanceof Blob bl) return "[BLOB " + bl.length() + " bytes]";
        } catch (SQLException e) { return "[unreadable LOB]"; }
        if (o instanceof byte[] a) return "[binary " + a.length + " bytes]";
        return o.toString();
    }

    static String describe(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.isBlank()) m = e.getClass().getSimpleName();
        m = m.strip();
        if (e instanceof SQLException se && "25P02".equals(se.getSQLState()))
            m += "\nTip: this transaction failed earlier. Press Rollback to reset it.";
        return m;
    }

    private static String abbreviate(String s, int max) {
        String t = s.replaceAll("\\s+", " ").strip();
        return t.length() <= max ? t : t.substring(0, max) + "…";
    }

    private static String mongoUri(ConnectRequest r, String host) {
        int port = r.port() != null ? r.port() : 27017;
        String cred = blank(r.username()) ? "" :
            URLEncoder.encode(r.username(), StandardCharsets.UTF_8) + ":" +
            URLEncoder.encode(r.password() == null ? "" : r.password(), StandardCharsets.UTF_8) + "@";
        return "mongodb://" + cred + host + ":" + port + (blank(r.username()) ? "" : "/?authSource=admin");
    }

    Session get(String id) {
        Session s = sessions.get(id);
        if (s == null) throw new IllegalArgumentException("Connection not found. Connect again.");
        return s;
    }

    private static boolean blank(String s) { return s == null || s.isBlank(); }
}
