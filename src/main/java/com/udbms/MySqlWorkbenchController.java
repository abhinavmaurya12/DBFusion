package com.udbms;

import org.springframework.web.bind.annotation.*;

import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;

/** MySQL Workbench style navigator: every schema, its objects, and table details without switching the current database. */
@RestController
@RequestMapping("/api/connections/{id}/mysql/wb")
public class MySqlWorkbenchController {
    private static final Set<String> SYSTEM = Set.of("mysql", "sys", "information_schema", "performance_schema");
    private static final Pattern WORD = Pattern.compile("[A-Za-z0-9_]+");
    private final DbService svc;
    public MySqlWorkbenchController(DbService svc) { this.svc = svc; }

    private Connection my(String id) {
        var s = svc.get(id);
        if (!"mysql".equals(s.type())) throw new IllegalArgumentException("The workbench is only available for MySQL connections.");
        return s.jdbc();
    }
    /** Backtick-quotes a schema or table name; any character is fine except a backtick or a control character. */
    private static String ident(String n) {
        if (n == null || n.isEmpty() || n.length() > 64 || n.chars().anyMatch(ch -> ch == '`' || Character.isISOControl(ch)))
            throw new IllegalArgumentException("Invalid name.");
        return "`" + n + "`";
    }

    @GetMapping("/schemas")
    public Map<String, Object> schemas(@PathVariable String id) throws Exception {
        Connection c = my(id);
        Map<String, Object> m = new LinkedHashMap<>(OracleController.qry(c,
            "SELECT s.schema_name AS name, s.default_character_set_name AS charset, s.default_collation_name AS collation, "
            + "COUNT(CASE WHEN t.table_type = 'BASE TABLE' THEN 1 END) AS tables, COUNT(CASE WHEN t.table_type = 'VIEW' THEN 1 END) AS views, "
            + "ROUND(COALESCE(SUM(t.data_length + t.index_length), 0) / 1048576, 2) AS size_mb "
            + "FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name "
            + "GROUP BY s.schema_name, s.default_character_set_name, s.default_collation_name ORDER BY s.schema_name"));
        m.put("current", c.getCatalog());
        m.put("system", new ArrayList<>(SYSTEM));
        return m;
    }

    @GetMapping("/objects")
    public Map<String, Object> objects(@PathVariable String id, @RequestParam String db) throws Exception {
        Connection c = my(id);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("tables", OracleController.qry(c, "SELECT table_name, table_type, COALESCE(engine, '') AS engine, COALESCE(table_rows, 0) AS table_rows, "
            + "ROUND((COALESCE(data_length, 0) + COALESCE(index_length, 0)) / 1024, 1) AS size_kb FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name", db));
        m.put("routines", OracleController.qry(c, "SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name", db));
        return m;
    }

    /** part: columns | indexes | ddl | data */
    @GetMapping("/table")
    public Map<String, Object> table(@PathVariable String id, @RequestParam String db, @RequestParam String name, @RequestParam String part) throws Exception {
        Connection c = my(id);
        String q = ident(db) + "." + ident(name);
        switch (part) {
            case "columns": return OracleController.qry(c,
                "SELECT column_name, column_type, is_nullable, column_key, column_default, extra FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position", db, name);
            case "indexes": return OracleController.qry(c,
                "SELECT index_name, IF(non_unique = 0, 'UNIQUE', '') AS uniqueness, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns, index_type "
                + "FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name, non_unique, index_type ORDER BY index_name", db, name);
            case "ddl":
                synchronized (c) {
                    try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("SHOW CREATE TABLE " + q)) {
                        return Map.of("ddl", rs.next() ? rs.getString(2) : "");
                    }
                }
            case "data": return svc.exec(id, "SELECT * FROM " + q, "single", 0, 200, 0, true);
            default: throw new IllegalArgumentException("Unknown part.");
        }
    }

    @PostMapping("/schema")
    public Map<String, Object> create(@PathVariable String id, @RequestBody Map<String, String> b) throws Exception {
        Connection c = my(id);
        String name = ident(b.get("name")), cs = b.get("charset"), co = b.get("collation");
        StringBuilder sql = new StringBuilder("CREATE DATABASE ").append(name);
        if (cs != null && !cs.isBlank()) { if (!WORD.matcher(cs).matches()) throw new IllegalArgumentException("Invalid character set."); sql.append(" CHARACTER SET ").append(cs); }
        if (co != null && !co.isBlank()) { if (!WORD.matcher(co).matches()) throw new IllegalArgumentException("Invalid collation."); sql.append(" COLLATE ").append(co); }
        synchronized (c) { try (Statement st = c.createStatement()) { st.execute(sql.toString()); } }
        return Map.of("ok", true, "sql", sql.toString());
    }

    @PostMapping("/schema/drop")
    public Map<String, Object> drop(@PathVariable String id, @RequestBody Map<String, String> b) throws Exception {
        Connection c = my(id);
        String raw = b.get("name"), name = ident(raw);
        if (SYSTEM.contains(raw.toLowerCase())) throw new IllegalArgumentException("System schemas cannot be dropped.");
        if (raw.equals(c.getCatalog())) throw new IllegalArgumentException("This is the current schema. Switch to another schema first.");
        synchronized (c) { try (Statement st = c.createStatement()) { st.execute("DROP DATABASE " + name); } }
        return Map.of("ok", true);
    }

    @GetMapping("/collations")
    public Map<String, Object> collations(@PathVariable String id) throws Exception {
        return OracleController.qry(my(id), "SELECT character_set_name, collation_name, is_default FROM information_schema.collations ORDER BY 1, 2");
    }
}
