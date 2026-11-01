package com.udbms;

import org.springframework.web.bind.annotation.*;

import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;

/** MySQL-specific tools: databases, schema objects, DDL, describe, explain, maintenance and server information. */
@RestController
@RequestMapping("/api/connections/{id}/mysql")
public class MySqlController {
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_$]+");
    private static final Pattern EXPLAINABLE = Pattern.compile("^(select|with|insert|update|delete|replace|table|values)\\b", Pattern.CASE_INSENSITIVE);
    private static final Set<String> DDL_TYPES = Set.of("TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT");
    private static final Set<String> MAINT = Set.of("ANALYZE", "OPTIMIZE", "CHECK");
    private final DbService svc;
    public MySqlController(DbService svc) { this.svc = svc; }

    private Connection my(String id) {
        var s = svc.get(id);
        if (!"mysql".equals(s.type())) throw new IllegalArgumentException("This tool is only available for MySQL connections.");
        return s.jdbc();
    }
    private static String nm(String n) {
        if (n == null || !NAME.matcher(n).matches()) throw new IllegalArgumentException("Invalid object name.");
        return n;
    }
    private static String db(Connection c) throws SQLException {
        String d = c.getCatalog();
        if (d == null || d.isBlank()) throw new IllegalArgumentException("Select a database first.");
        return d;
    }
    private static Map<String, Object> qry(Connection c, String sql, Object... p) throws SQLException { return OracleController.qry(c, sql, p); }

    @GetMapping("/databases")
    public Map<String, Object> databases(@PathVariable String id) throws Exception {
        Connection c = my(id);
        Map<String, Object> m = new LinkedHashMap<>(qry(c, "SELECT schema_name AS name, default_character_set_name AS charset, default_collation_name AS collation "
            + "FROM information_schema.schemata ORDER BY 1"));
        m.put("current", c.getCatalog());
        return m;
    }

    @PostMapping("/use")
    public Map<String, Object> use(@PathVariable String id, @RequestBody Map<String, String> b) throws Exception {
        my(id);
        return Map.of("name", svc.switchDb(id, nm(b.get("database"))));
    }

    @GetMapping("/objects")
    public Map<String, Object> objects(@PathVariable String id) throws Exception {
        Connection c = my(id); String d = db(c);
        List<List<Object>> rows = new ArrayList<>();
        collect(rows, c, "SELECT table_name, IF(table_type = 'VIEW', 'VIEW', 'TABLE'), COALESCE(engine, ''), CAST(create_time AS CHAR) FROM information_schema.tables WHERE table_schema = ?", d);
        collect(rows, c, "SELECT routine_name, routine_type, COALESCE(dtd_identifier, ''), CAST(created AS CHAR) FROM information_schema.routines WHERE routine_schema = ?", d);
        collect(rows, c, "SELECT trigger_name, 'TRIGGER', event_object_table, CAST(created AS CHAR) FROM information_schema.triggers WHERE trigger_schema = ?", d);
        try { collect(rows, c, "SELECT event_name, 'EVENT', status, CAST(created AS CHAR) FROM information_schema.events WHERE event_schema = ?", d); } catch (SQLException ignored) {}
        rows.sort(Comparator.comparing((List<Object> r) -> String.valueOf(r.get(1))).thenComparing(r -> String.valueOf(r.get(0))));
        return Map.of("columns", List.of("object_name", "object_type", "detail", "created"), "rows", rows);
    }
    @SuppressWarnings("unchecked")
    private static void collect(List<List<Object>> out, Connection c, String sql, String d) throws SQLException {
        out.addAll((List<List<Object>>) qry(c, sql, d).get("rows"));
    }

    @GetMapping("/ddl")
    public Map<String, Object> ddl(@PathVariable String id, @RequestParam String name, @RequestParam String type) throws Exception {
        String t = type.toUpperCase();
        if (!DDL_TYPES.contains(t)) throw new IllegalArgumentException("DDL is not available for this object type.");
        try (Statement st = my(id).createStatement(); ResultSet rs = st.executeQuery("SHOW CREATE " + t + " `" + nm(name) + "`")) {
            if (!rs.next()) throw new IllegalArgumentException("Object not found.");
            ResultSetMetaData md = rs.getMetaData();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                String l = md.getColumnLabel(i);
                if (l.startsWith("Create ") || l.equals("SQL Original Statement")) {
                    String v = rs.getString(i);
                    return Map.of("ddl", v == null ? "-- The definition is hidden: your user lacks the privilege to read it." : v);
                }
            }
        }
        throw new IllegalArgumentException("No definition returned.");
    }

    @GetMapping("/describe")
    public Map<String, Object> describe(@PathVariable String id, @RequestParam String table) throws Exception {
        Connection c = my(id); String d = db(c), t = nm(table);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("columns", qry(c, "SELECT ordinal_position AS id, column_name, column_type, is_nullable AS nullable, column_key AS `key`, column_default AS default_value, extra, column_comment AS comment "
            + "FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position", d, t));
        m.put("indexes", qry(c, "SELECT index_name, index_type, IF(non_unique = 0, 'UNIQUE', 'NONUNIQUE') AS uniqueness, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS `columns` "
            + "FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name, index_type, non_unique ORDER BY index_name", d, t));
        m.put("constraints", qry(c, "SELECT tc.constraint_name AS constraint_name, tc.constraint_type AS type, GROUP_CONCAT(DISTINCT k.column_name ORDER BY k.ordinal_position) AS `columns`, "
            + "MAX(k.referenced_table_name) AS references_table, GROUP_CONCAT(DISTINCT k.referenced_column_name ORDER BY k.ordinal_position) AS references_columns "
            + "FROM information_schema.table_constraints tc LEFT JOIN information_schema.key_column_usage k ON k.constraint_schema = tc.constraint_schema "
            + "AND k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name WHERE tc.table_schema = ? AND tc.table_name = ? "
            + "GROUP BY tc.constraint_name, tc.constraint_type ORDER BY tc.constraint_type, tc.constraint_name", d, t));
        m.put("stats", qry(c, "SELECT engine, table_rows AS approx_rows, ROUND(data_length / 1048576, 2) AS data_mb, ROUND(index_length / 1048576, 2) AS index_mb, auto_increment, "
            + "table_collation, CAST(create_time AS CHAR) AS created, CAST(update_time AS CHAR) AS updated FROM information_schema.tables WHERE table_schema = ? AND table_name = ?", d, t));
        m.put("triggers", qry(c, "SELECT trigger_name, action_timing AS timing, event_manipulation AS event FROM information_schema.triggers "
            + "WHERE event_object_schema = ? AND event_object_table = ? ORDER BY trigger_name", d, t));
        return m;
    }

    @PostMapping("/explain")
    public Map<String, Object> explain(@PathVariable String id, @RequestBody Map<String, String> body) throws Exception {
        Connection c = my(id);
        String q = body.getOrDefault("query", "").strip().replaceAll(";+$", "");
        if (q.isEmpty()) throw new IllegalArgumentException("Type a statement first.");
        if (!EXPLAINABLE.matcher(q).find()) throw new IllegalArgumentException("MySQL can explain SELECT, INSERT, UPDATE, DELETE and REPLACE statements.");
        StringBuilder sb = new StringBuilder();
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("EXPLAIN FORMAT=TREE " + q)) {   // MySQL 8.0.16+
            while (rs.next()) sb.append(rs.getString(1)).append('\n');
        } catch (SQLException tree) {
            sb.setLength(0);
            try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("EXPLAIN " + q)) {
                ResultSetMetaData md = rs.getMetaData(); int n = md.getColumnCount();
                for (int i = 1; i <= n; i++) sb.append(md.getColumnLabel(i)).append(i < n ? " | " : "\n");
                while (rs.next()) for (int i = 1; i <= n; i++) sb.append(rs.getString(i)).append(i < n ? " | " : "\n");
            }
        }
        return Map.of("plan", sb.toString());
    }

    @PostMapping("/maintenance")
    public Map<String, Object> maintenance(@PathVariable String id, @RequestBody Map<String, String> b) throws Exception {
        String op = String.valueOf(b.get("op")).toUpperCase();
        if (!MAINT.contains(op)) throw new IllegalArgumentException("Unknown maintenance operation.");
        return qry(my(id), op + " TABLE `" + nm(b.get("table")) + "`");
    }

    @GetMapping("/status")
    public Map<String, Object> status(@PathVariable String id) throws Exception {
        return qry(my(id), "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Connections','Questions','Slow_queries',"
            + "'Aborted_connects','Bytes_received','Bytes_sent','Open_tables','Created_tmp_tables','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests')");
    }

    @GetMapping("/variables")
    public Map<String, Object> variables(@PathVariable String id, @RequestParam(defaultValue = "") String like) throws Exception {
        String f = like.replaceAll("[^A-Za-z0-9_%]", "");
        return qry(my(id), "SHOW VARIABLES LIKE ?", "%" + f + "%");
    }

    @GetMapping("/processlist")
    public Map<String, Object> processlist(@PathVariable String id) throws Exception { return qry(my(id), "SHOW FULL PROCESSLIST"); }

    @GetMapping("/grants")
    public Map<String, Object> grants(@PathVariable String id) throws Exception { return qry(my(id), "SHOW GRANTS"); }
}
