package com.udbms;

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import org.bson.Document;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Holds open connections and runs queries. Add a new database by extending connect(), schema() and run(). */
@Service
public class DbService {

    record Session(String type, String name, String db, String user, Connection jdbc, MongoClient mongo) {}

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    public Map<String, Object> connect(ConnectRequest r) throws Exception {
        String t = r.type() == null ? "" : r.type().toLowerCase();
        String host = blank(r.host()) ? "localhost" : r.host();
        String db = r.database() == null ? "" : r.database();
        Session s;
        if (t.equals("mongodb")) {
            String uri = !blank(r.uri()) ? r.uri() : mongoUri(r, host);
            MongoClient c = MongoClients.create(uri);
            String mdb = blank(db) ? "admin" : db;
            c.getDatabase(mdb).runCommand(new Document("ping", 1));
            s = new Session(t, host + "/" + mdb, mdb, r.username(), null, c);
        } else {
            int port = r.port() != null ? r.port() : switch (t) {
                case "mysql" -> 3306; case "postgresql" -> 5432; case "oracle" -> 1521;
                default -> throw new IllegalArgumentException("Unsupported database type: " + t);
            };
            String url = switch (t) {
                case "mysql" -> "jdbc:mysql://%s:%d/%s".formatted(host, port, db);
                case "postgresql" -> "jdbc:postgresql://%s:%d/%s".formatted(host, port, db);
                default -> "jdbc:oracle:thin:@//%s:%d/%s".formatted(host, port, db);
            };
            Connection c = DriverManager.getConnection(url, r.username(), r.password());
            s = new Session(t, host + "/" + db, db, r.username(), c, null);
        }
        String id = UUID.randomUUID().toString();
        sessions.put(id, s);
        return Map.of("id", id, "type", t, "name", s.name());
    }

    public void disconnect(String id) throws Exception {
        Session s = sessions.remove(id);
        if (s == null) return;
        if (s.jdbc() != null) s.jdbc().close();
        if (s.mongo() != null) s.mongo().close();
    }

    public List<String> schema(String id) throws Exception {
        Session s = get(id);
        List<String> names = new ArrayList<>();
        if (s.mongo() != null) {
            s.mongo().getDatabase(s.db()).listCollectionNames().into(names);
            return names;
        }
        String catalog = s.type().equals("mysql") ? s.db() : null;
        String schema = switch (s.type()) {
            case "postgresql" -> "public";
            case "oracle" -> s.user().toUpperCase();
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
        if (!table.matches("[A-Za-z0-9_$.]+")) throw new IllegalArgumentException("Invalid table name");
        return run(id, "SELECT * FROM " + table);
    }

    public Map<String, Object> run(String id, String query) throws Exception {
        Session s = get(id);
        long t0 = System.currentTimeMillis();
        Map<String, Object> out = new LinkedHashMap<>(s.mongo() != null ? runMongo(s, query) : runSql(s, query));
        out.put("ms", System.currentTimeMillis() - t0);
        if ("oracle".equals(s.type())) { String o = drainOutput(s); if (!o.isEmpty()) out.put("output", o); }
        return out;
    }

    private static final java.util.regex.Pattern PLSQL = java.util.regex.Pattern.compile(
        "^(begin|declare|create\\s+(or\\s+replace\\s+)?(editionable\\s+|noneditionable\\s+)?(procedure|function|package|trigger|type))\\b",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    private Map<String, Object> runSql(Session s, String sql) throws Exception {
        boolean ora = s.type().equals("oracle");
        String q = sql.strip();
        if (ora && PLSQL.matcher(q).find()) q = q.replaceAll("\\n/\\s*$", "");   // PL/SQL keeps its final semicolon
        else q = q.replaceAll(";+$", "");
        if (ora) enableOutput(s);
        try (Statement st = s.jdbc().createStatement()) {
            st.setMaxRows(1000);
            if (!st.execute(q)) return Map.of("updateCount", st.getUpdateCount());
            try (ResultSet rs = st.getResultSet()) {
                ResultSetMetaData md = rs.getMetaData();
                int n = md.getColumnCount();
                List<String> cols = new ArrayList<>();
                for (int i = 1; i <= n; i++) cols.add(md.getColumnLabel(i));
                List<List<Object>> rows = new ArrayList<>();
                while (rs.next()) {
                    List<Object> row = new ArrayList<>();
                    for (int i = 1; i <= n; i++) row.add(val(rs.getObject(i)));
                    rows.add(row);
                }
                return Map.of("columns", cols, "rows", rows);
            }
        }
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

    static Object val(Object o) {
        if (o == null || o instanceof Boolean || o instanceof String) return o;
        if (o instanceof java.math.BigDecimal bd) return bd.scale() <= 0 && bd.precision() <= 18 ? (Object) bd.longValue() : (Object) bd.doubleValue();
        if (o instanceof Number) return o;
        if (o instanceof Document doc) return doc.toJson();
        try {
            if (o instanceof Clob c) return c.getSubString(1, (int) Math.min(c.length(), 100000));
            if (o instanceof Blob bl) return "[BLOB " + bl.length() + " bytes]";
        } catch (SQLException e) { return "[unreadable LOB]"; }
        if (o instanceof byte[] a) return "[binary " + a.length + " bytes]";
        return o.toString();
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
