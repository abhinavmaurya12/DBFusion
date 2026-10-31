package com.udbms;

import org.springframework.web.bind.annotation.*;

import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;

/** Oracle-specific tools (data dictionary, DDL, explain plan) plus transaction control for any SQL connection. */
@RestController
@RequestMapping("/api/connections/{id}")
public class OracleController {
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_$#]+");
    private final DbService svc;
    public OracleController(DbService svc) { this.svc = svc; }

    private Connection ora(String id) {
        var s = svc.get(id);
        if (!"oracle".equals(s.type())) throw new IllegalArgumentException("This tool is only available for Oracle connections.");
        return s.jdbc();
    }
    private Connection sql(String id) {
        var s = svc.get(id);
        if (s.jdbc() == null) throw new IllegalArgumentException("Transactions apply to SQL databases only.");
        return s.jdbc();
    }
    private static String nm(String n) {
        if (n == null || !NAME.matcher(n).matches()) throw new IllegalArgumentException("Invalid object name.");
        return n.toUpperCase();
    }
    private static Map<String, Object> qry(Connection c, String sql, Object... params) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) ps.setObject(i + 1, params[i]);
            try (ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData(); int n = md.getColumnCount();
                List<String> cols = new ArrayList<>();
                for (int i = 1; i <= n; i++) cols.add(md.getColumnLabel(i));
                List<List<Object>> rows = new ArrayList<>();
                while (rs.next()) {
                    List<Object> row = new ArrayList<>();
                    for (int i = 1; i <= n; i++) row.add(DbService.val(rs.getObject(i)));
                    rows.add(row);
                }
                return Map.of("columns", cols, "rows", rows);
            }
        }
    }

    @GetMapping("/oracle/objects")
    public Map<String, Object> objects(@PathVariable String id) throws Exception {
        return qry(ora(id), "SELECT object_name, object_type, status, TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI') AS last_ddl "
            + "FROM user_objects WHERE object_name NOT LIKE 'BIN$%' AND object_type NOT IN ('LOB', 'INDEX PARTITION', 'TABLE PARTITION') "
            + "ORDER BY object_type, object_name");
    }

    @GetMapping("/oracle/ddl")
    public Map<String, Object> ddl(@PathVariable String id, @RequestParam String name, @RequestParam String type) throws Exception {
        String t = type.toUpperCase().replace(' ', '_');
        if (t.equals("PACKAGE")) t = "PACKAGE_SPEC";
        if (t.equals("TYPE")) t = "TYPE_SPEC";
        if (!t.matches("[A-Z_]+")) throw new IllegalArgumentException("Invalid object type.");
        try (PreparedStatement ps = ora(id).prepareStatement("SELECT DBMS_METADATA.GET_DDL(?, ?) FROM dual")) {
            ps.setString(1, t); ps.setString(2, nm(name));
            try (ResultSet rs = ps.executeQuery()) { rs.next(); return Map.of("ddl", String.valueOf(rs.getString(1))); }
        }
    }

    @GetMapping("/oracle/describe")
    public Map<String, Object> describe(@PathVariable String id, @RequestParam String table) throws Exception {
        Connection c = ora(id); String t = nm(table);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("columns", qry(c, "SELECT column_id AS id, column_name, data_type, data_length, data_precision, data_scale, nullable "
            + "FROM user_tab_columns WHERE table_name = ? ORDER BY column_id", t));
        m.put("indexes", qry(c, "SELECT i.index_name, i.index_type, i.uniqueness, LISTAGG(c.column_name, ', ') WITHIN GROUP (ORDER BY c.column_position) AS columns "
            + "FROM user_indexes i JOIN user_ind_columns c ON c.index_name = i.index_name WHERE i.table_name = ? "
            + "GROUP BY i.index_name, i.index_type, i.uniqueness ORDER BY i.index_name", t));
        m.put("constraints", qry(c, "SELECT constraint_name, DECODE(constraint_type, 'P', 'Primary key', 'U', 'Unique', 'R', 'Foreign key', 'C', 'Check', constraint_type) AS type, "
            + "r_constraint_name AS references_constraint, status FROM user_constraints WHERE table_name = ? ORDER BY constraint_type, constraint_name", t));
        m.put("stats", qry(c, "SELECT num_rows, blocks, avg_row_len, last_analyzed FROM user_tables WHERE table_name = ?", t));
        return m;
    }

    @GetMapping("/oracle/errors")
    public Map<String, Object> errors(@PathVariable String id, @RequestParam String name) throws Exception {
        return qry(ora(id), "SELECT type, line, position, text FROM user_errors WHERE name = ? ORDER BY sequence", nm(name));
    }

    @PostMapping("/explain")
    public Map<String, Object> explain(@PathVariable String id, @RequestBody Map<String, String> body) throws Exception {
        Connection c = ora(id);
        String q = body.getOrDefault("query", "").strip().replaceAll(";+$", "");
        if (q.isEmpty()) throw new IllegalArgumentException("Type a statement first.");
        String sid = "DBF" + Math.abs(System.nanoTime() % 1_000_000_000L);
        StringBuilder sb = new StringBuilder();
        try (Statement st = c.createStatement()) {
            st.execute("EXPLAIN PLAN SET STATEMENT_ID = '" + sid + "' FOR " + q);
            try (ResultSet rs = st.executeQuery("SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', '" + sid + "', 'TYPICAL'))")) {
                while (rs.next()) sb.append(rs.getString(1)).append('\n');
            }
            try { st.execute("DELETE FROM plan_table WHERE statement_id = '" + sid + "'"); } catch (SQLException ignored) {}
        }
        return Map.of("plan", sb.toString());
    }

    @PostMapping("/autocommit")
    public Map<String, Object> autocommit(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        sql(id).setAutoCommit(Boolean.TRUE.equals(b.get("on")));
        return Map.of("ok", true);
    }
    @PostMapping("/commit")
    public Map<String, Object> commit(@PathVariable String id) throws Exception { return finish(sql(id), true); }
    @PostMapping("/rollback")
    public Map<String, Object> rollback(@PathVariable String id) throws Exception { return finish(sql(id), false); }

    private static Map<String, Object> finish(Connection c, boolean commit) throws SQLException {
        if (c.getAutoCommit()) throw new IllegalStateException("Auto-commit is on, so every statement is already saved. Turn it off to use Commit and Rollback.");
        if (commit) c.commit(); else c.rollback();
        return Map.of("ok", true);
    }
}
