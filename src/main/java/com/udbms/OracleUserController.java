package com.udbms;

import org.springframework.web.bind.annotation.*;

import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Oracle user management for DBA accounts (SYSTEM, SYS as SYSDBA, or any user with CREATE USER).
 * Every name is validated against a strict pattern and, where the dictionary can be read, against existing
 * tablespaces, profiles and roles. Passwords are only ever placed inside a double-quoted literal after
 * rejecting quotes and control characters, and they are masked in everything sent back to the browser.
 */
@RestController
@RequestMapping("/api/connections/{id}/oracle/users")
public class OracleUserController {

    private static final Pattern NAME = Pattern.compile("[A-Za-z][A-Za-z0-9_$#]{0,127}");
    private static final Pattern QUOTA = Pattern.compile("(?i)UNLIMITED|[0-9]{1,9}[KMGT]?");
    private static final Set<String> PROTECTED = Set.of("SYS", "SYSTEM", "SYSBACKUP", "SYSDG", "SYSKM", "SYSRAC", "AUDSYS", "XDB", "DBSNMP", "OUTLN");
    /** System privileges that can be granted from the form. Anything else can be granted in the SQL editor. */
    static final List<String> PRIVILEGES = List.of(
        "CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE", "CREATE TRIGGER", "CREATE TYPE",
        "CREATE SYNONYM", "CREATE MATERIALIZED VIEW", "CREATE DATABASE LINK", "CREATE JOB", "CREATE ANY TABLE", "SELECT ANY TABLE",
        "UNLIMITED TABLESPACE", "ALTER SESSION", "CREATE USER", "ALTER USER", "DROP USER");

    private final DbService svc;
    public OracleUserController(DbService svc) { this.svc = svc; }

    // ------------------------------------------------------------------ helpers

    private Connection ora(String id) {
        var s = svc.get(id);
        if (!"oracle".equals(s.type())) throw new IllegalArgumentException("User management is only available for Oracle connections.");
        return s.jdbc();
    }
    private String currentUser(String id) { return svc.get(id).user().toUpperCase(); }

    private static String scalar(Connection c, String sql) {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) { return rs.next() ? rs.getString(1) : null; }
        catch (SQLException e) { return null; }
    }
    private static List<String> list(Connection c, String sql) {
        List<String> out = new ArrayList<>();
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) { while (rs.next()) out.add(rs.getString(1)); }
        catch (SQLException ignored) {}
        return out;
    }
    private static boolean hasPrivilege(Connection c, String priv) {
        String n = scalar(c, "SELECT COUNT(*) FROM session_privs WHERE privilege = '" + priv + "'");
        return n != null && !n.equals("0");
    }
    private static Map<String, Object> safeQry(Connection c, String sql, Object... p) {
        try { return OracleController.qry(c, sql, p); }
        catch (SQLException e) { return Map.of("columns", List.of(), "rows", List.of()); }
    }
    private static String name(String label, Object v) {
        String s = v == null ? "" : v.toString().trim();
        if (!NAME.matcher(s).matches()) throw new IllegalArgumentException(label + " \"" + s + "\" is not valid. Use letters, digits, _ $ # and start with a letter.");
        return s.toUpperCase();
    }
    private static String optName(String label, Object v) {
        return v == null || v.toString().isBlank() ? null : name(label, v);
    }
    private static String password(Object v) {
        String p = v == null ? "" : v.toString();
        if (p.isEmpty()) throw new IllegalArgumentException("Enter a password.");
        if (p.length() > 128) throw new IllegalArgumentException("The password is too long (128 characters at most).");
        for (char ch : p.toCharArray())
            if (ch == '"' || Character.isISOControl(ch)) throw new IllegalArgumentException("The password cannot contain double quotes or control characters.");
        return p;
    }
    @SuppressWarnings("unchecked")
    private static List<String> strings(Object v) {
        List<String> out = new ArrayList<>();
        if (v instanceof List<?> l) for (Object o : l) if (o != null && !o.toString().isBlank()) out.add(o.toString().trim());
        return out;
    }

    // ------------------------------------------------------------------ read

    /** What the create-user form needs: privileges of the caller, tablespaces, profiles, roles, defaults. */
    @GetMapping("/info")
    public Map<String, Object> info(@PathVariable String id) {
        Connection c = ora(id);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("currentUser", currentUser(id));
        m.put("canCreate", hasPrivilege(c, "CREATE USER"));
        String dba = scalar(c, "SELECT COUNT(*) FROM session_roles WHERE role = 'DBA'");
        m.put("isDba", dba != null && !dba.equals("0"));
        String con = scalar(c, "SELECT SYS_CONTEXT('USERENV', 'CON_NAME') FROM dual");
        m.put("container", con);
        m.put("cdbRoot", "CDB$ROOT".equalsIgnoreCase(con));
        List<String> ts = list(c, "SELECT tablespace_name FROM dba_tablespaces WHERE contents = 'PERMANENT' ORDER BY 1");
        if (ts.isEmpty()) ts = list(c, "SELECT tablespace_name FROM user_tablespaces WHERE contents = 'PERMANENT' ORDER BY 1");
        List<String> temp = list(c, "SELECT tablespace_name FROM dba_tablespaces WHERE contents = 'TEMPORARY' ORDER BY 1");
        if (temp.isEmpty()) temp = list(c, "SELECT tablespace_name FROM user_tablespaces WHERE contents = 'TEMPORARY' ORDER BY 1");
        List<String> prof = list(c, "SELECT DISTINCT profile FROM dba_profiles ORDER BY 1");
        List<String> roles = list(c, "SELECT role FROM dba_roles ORDER BY 1");
        m.put("tablespaces", ts); m.put("tempTablespaces", temp);
        m.put("profiles", prof.isEmpty() ? List.of("DEFAULT") : prof);
        m.put("roles", roles);
        m.put("defaultTablespace", scalar(c, "SELECT property_value FROM database_properties WHERE property_name = 'DEFAULT_PERMANENT_TABLESPACE'"));
        m.put("defaultTemp", scalar(c, "SELECT property_value FROM database_properties WHERE property_name = 'DEFAULT_TEMP_TABLESPACE'"));
        m.put("privileges", PRIVILEGES);
        return m;
    }

    @GetMapping
    public Map<String, Object> users(@PathVariable String id) throws Exception {
        Connection c = ora(id);
        String base = "SELECT username, account_status AS status, TO_CHAR(created, 'YYYY-MM-DD') AS created, default_tablespace, temporary_tablespace AS temp_tablespace, profile, "
            + "TO_CHAR(lock_date, 'YYYY-MM-DD HH24:MI') AS locked_at, TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expires";
        for (String sql : new String[]{
                base + ", oracle_maintained AS system_account FROM dba_users ORDER BY username",
                base + ", 'N' AS system_account FROM dba_users ORDER BY username",
                "SELECT username, 'UNKNOWN' AS status, TO_CHAR(created, 'YYYY-MM-DD') AS created, '' AS default_tablespace, '' AS temp_tablespace, '' AS profile, '' AS locked_at, '' AS expires, 'N' AS system_account FROM all_users ORDER BY username"}) {
            try { return OracleController.qry(c, sql); } catch (SQLException ignored) {}
        }
        throw new IllegalStateException("Could not read the user list.");
    }

    @GetMapping("/grants")
    public Map<String, Object> grants(@PathVariable String id, @RequestParam String name) {
        Connection c = ora(id); String u = name("User name", name);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("systemPrivileges", safeQry(c, "SELECT privilege, admin_option FROM dba_sys_privs WHERE grantee = ? ORDER BY privilege", u));
        m.put("roles", safeQry(c, "SELECT granted_role AS role, admin_option, default_role FROM dba_role_privs WHERE grantee = ? ORDER BY granted_role", u));
        m.put("quotas", safeQry(c, "SELECT tablespace_name, ROUND(bytes / 1048576, 2) AS used_mb, CASE WHEN max_bytes = -1 THEN 'UNLIMITED' ELSE TO_CHAR(ROUND(max_bytes / 1048576, 2)) || ' MB' END AS quota "
            + "FROM dba_ts_quotas WHERE username = ? ORDER BY tablespace_name", u));
        return m;
    }

    // ------------------------------------------------------------------ create

    /** Builds the statements. Index 0 is always CREATE USER. Returns [real statements, masked statements]. */
    private List<List<String>> build(Connection c, Map<String, Object> b) {
        String user = name("User name", b.get("username"));
        String pw = password(b.get("password"));
        String ts = optName("Default tablespace", b.get("defaultTablespace"));
        String temp = optName("Temporary tablespace", b.get("tempTablespace"));
        String profile = optName("Profile", b.get("profile"));
        String qts = optName("Quota tablespace", b.get("quotaTablespace"));
        String quota = b.get("quota") == null ? "" : b.get("quota").toString().trim();
        if (!quota.isEmpty() && !QUOTA.matcher(quota).matches()) throw new IllegalArgumentException("Quota must be UNLIMITED or a size such as 100M, 2G or 500K.");
        if (!quota.isEmpty() && qts == null) qts = ts;
        if (!quota.isEmpty() && qts == null) throw new IllegalArgumentException("Choose a tablespace for the quota.");

        String con = scalar(c, "SELECT SYS_CONTEXT('USERENV', 'CON_NAME') FROM dual");
        if ("CDB$ROOT".equalsIgnoreCase(con) && !user.startsWith("C##"))
            throw new IllegalArgumentException("You are connected to the CDB root, where Oracle only allows common users whose name starts with C## (for example C##" + user
                + "). Connect to a pluggable database such as XEPDB1 or FREEPDB1 to create a normal user.");

        // verify names against the dictionary when this account is allowed to read it
        verify("Tablespace", ts, list(c, "SELECT tablespace_name FROM dba_tablespaces"));
        verify("Tablespace", qts, list(c, "SELECT tablespace_name FROM dba_tablespaces"));
        verify("Temporary tablespace", temp, list(c, "SELECT tablespace_name FROM dba_tablespaces"));
        verify("Profile", profile, list(c, "SELECT DISTINCT profile FROM dba_profiles"));

        StringBuilder cu = new StringBuilder("CREATE USER ").append(user).append(" IDENTIFIED BY \"%s\"");
        if (ts != null) cu.append(" DEFAULT TABLESPACE ").append(ts);
        if (temp != null) cu.append(" TEMPORARY TABLESPACE ").append(temp);
        if (!quota.isEmpty()) cu.append(" QUOTA ").append(quota.toUpperCase()).append(" ON ").append(qts);
        if (profile != null) cu.append(" PROFILE ").append(profile);
        if (Boolean.TRUE.equals(b.get("passwordExpire"))) cu.append(" PASSWORD EXPIRE");
        cu.append(Boolean.TRUE.equals(b.get("accountLocked")) ? " ACCOUNT LOCK" : " ACCOUNT UNLOCK");

        List<String> real = new ArrayList<>(), masked = new ArrayList<>();
        real.add(cu.toString().formatted(pw)); masked.add(cu.toString().formatted("********"));

        List<String> privs = new ArrayList<>();
        for (String p : strings(b.get("privileges"))) {
            String up = p.toUpperCase().replaceAll("\\s+", " ");
            if (!PRIVILEGES.contains(up)) throw new IllegalArgumentException("The privilege \"" + p + "\" cannot be granted from this form. Use the SQL editor for it.");
            if (!privs.contains(up)) privs.add(up);
        }
        List<String> roles = new ArrayList<>(), known = list(c, "SELECT role FROM dba_roles");
        for (String r : strings(b.get("roles"))) {
            String up = name("Role", r);
            if (!known.isEmpty() && !known.contains(up)) throw new IllegalArgumentException("The role " + up + " does not exist in this database.");
            if (!roles.contains(up)) roles.add(up);
        }
        if (!privs.isEmpty()) { String g = "GRANT " + String.join(", ", privs) + " TO " + user; real.add(g); masked.add(g); }
        if (!roles.isEmpty()) { String g = "GRANT " + String.join(", ", roles) + " TO " + user; real.add(g); masked.add(g); }
        return List.of(real, masked);
    }

    private static void verify(String label, String value, List<String> known) {
        if (value != null && !known.isEmpty() && !known.contains(value))
            throw new IllegalArgumentException(label + " " + value + " does not exist in this database.");
    }

    /** Shows the SQL that would run (password masked) without running it. */
    @PostMapping("/preview")
    public Map<String, Object> preview(@PathVariable String id, @RequestBody Map<String, Object> b) {
        Connection c = ora(id);
        Map<String, Object> pw = new LinkedHashMap<>(b);
        if (b.get("password") == null || b.get("password").toString().isEmpty()) pw.put("password", "placeholder");
        return Map.of("sql", build(c, pw).get(1));
    }

    @PostMapping
    public Map<String, Object> create(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        Connection c = ora(id);
        if (!hasPrivilege(c, "CREATE USER"))
            throw new IllegalArgumentException("Your account (" + currentUser(id) + ") does not have the CREATE USER privilege. Connect as SYSTEM or another DBA account.");
        List<List<String>> script = build(c, b);
        List<String> real = script.get(0), masked = script.get(1), done = new ArrayList<>();
        synchronized (c) {
            try (Statement st = c.createStatement()) {
                for (int i = 0; i < real.size(); i++) {
                    try { st.execute(real.get(i)); done.add(masked.get(i)); }
                    catch (SQLException e) {
                        String m = DbService.describe(e);
                        if (i > 0) throw new IllegalStateException("The user was created, but this step failed: " + masked.get(i) + "\n" + m);
                        throw new IllegalStateException(m);
                    }
                }
            }
        }
        return Map.of("ok", true, "username", name("User name", b.get("username")), "statements", done);
    }

    // ------------------------------------------------------------------ manage

    @PostMapping("/action")
    public Map<String, Object> action(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        Connection c = ora(id);
        String u = name("User name", b.get("username")), act = String.valueOf(b.get("action")), sql, shown;
        switch (act) {
            case "lock" -> sql = shown = "ALTER USER " + u + " ACCOUNT LOCK";
            case "unlock" -> sql = shown = "ALTER USER " + u + " ACCOUNT UNLOCK";
            case "expire" -> sql = shown = "ALTER USER " + u + " PASSWORD EXPIRE";
            case "password" -> { String pw = password(b.get("password")); sql = "ALTER USER " + u + " IDENTIFIED BY \"" + pw + "\""; shown = "ALTER USER " + u + " IDENTIFIED BY \"********\""; }
            case "drop" -> {
                if (PROTECTED.contains(u) || u.equals(currentUser(id))) throw new IllegalArgumentException("The account " + u + " cannot be dropped from here.");
                String sys = scalar(c, "SELECT oracle_maintained FROM dba_users WHERE username = '" + u + "'");
                if ("Y".equals(sys)) throw new IllegalArgumentException(u + " is an Oracle-maintained account and cannot be dropped from here.");
                sql = shown = "DROP USER " + u + (Boolean.TRUE.equals(b.get("cascade")) ? " CASCADE" : "");
            }
            default -> throw new IllegalArgumentException("Unknown action.");
        }
        if ((act.equals("lock")) && u.equals(currentUser(id))) throw new IllegalArgumentException("You cannot lock the account you are connected with.");
        synchronized (c) { try (Statement st = c.createStatement()) { st.execute(sql); } }
        return Map.of("ok", true, "sql", shown);
    }
}
