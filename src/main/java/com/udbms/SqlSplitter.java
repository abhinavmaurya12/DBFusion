package com.udbms;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Splits a SQL script into single statements the way SQL Developer / SQL*Plus / the mysql client do.
 *  - ';' ends a statement, unless it is inside a string, quoted identifier or comment
 *  - Oracle: PL/SQL blocks (BEGIN, DECLARE, CREATE PROCEDURE ...) end with a line holding only '/'
 *  - MySQL: DELIMITER command is honoured (needed for procedures and triggers)
 *  - PostgreSQL: $$ ... $$ and $tag$ ... $tag$ bodies are kept intact
 */
public final class SqlSplitter {

    public record Stmt(String text, int start, int end, boolean plsql) {}

    private static final Pattern PLSQL = Pattern.compile(
        "^(begin|declare|create\\s+(or\\s+replace\\s+)?(and\\s+(resolve|compile)\\s+)?(noforce\\s+)?(editionable\\s+|noneditionable\\s+)?"
        + "(procedure|function|package|trigger|type|java\\s+source))\\b", Pattern.CASE_INSENSITIVE);
    /** SQL*Plus style one-line commands that Oracle users put in scripts. Each one is its own statement. */
    private static final Pattern SQLPLUS = Pattern.compile(
        "^\\s*(prompt|rem|remark|spool|exit|quit|exec|execute|desc|describe"
        + "|set\\s+(serveroutput|pagesize|pages|linesize|lines|feedback|feed|echo|verify|ver|timing|timi|define|def|heading|head|termout|term|trimspool|trims|long|sqlprompt|colsep|numwidth|numw|autotrace|time|wrap|trimout|autoprint|scan|sqlblanklines|sqlterminator|newpage)"
        + "|show\\s+(user|err|errors))\\b.*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern DELIM = Pattern.compile("^[ \\t]*delimiter[ \\t]+(\\S+)[ \\t]*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern LEADING_JUNK = Pattern.compile("^(\\s+|--[^\\n]*(\\n|$)|/\\*.*?\\*/)+", Pattern.DOTALL);

    private SqlSplitter() {}

    /** True when the statement is an Oracle PL/SQL unit that must keep its final semicolon. */
    public static boolean isPlsql(String sql) {
        return PLSQL.matcher(stripLeading(sql)).find();
    }

    static String stripLeading(String s) {
        Matcher m = LEADING_JUNK.matcher(s);
        return m.find() ? s.substring(m.end()) : s;
    }

    /** True when nothing but whitespace and comments is left. */
    public static boolean isBlank(String s) { return stripLeading(s).isBlank(); }

    public static List<Stmt> split(String sql, String dialect) {
        boolean ora = "oracle".equals(dialect), my = "mysql".equals(dialect), pg = "postgresql".equals(dialect);
        List<Stmt> out = new ArrayList<>();
        int n = sql.length(), i = 0, from = 0;
        String delim = ";";
        StringBuilder cur = new StringBuilder();
        int curStart = 0;
        boolean atLineStart = true;

        while (i < n) {
            char c = sql.charAt(i);

            // line start: DELIMITER command (MySQL) or a lone slash (Oracle)
            if (atLineStart) {
                int eol = sql.indexOf('\n', i); if (eol < 0) eol = n;
                String line = sql.substring(i, eol).replace("\r", "");
                if (my) {
                    Matcher dm = DELIM.matcher(line);
                    if (dm.matches() && cur.toString().isBlank()) { delim = dm.group(1); i = Math.min(n, eol + 1); from = i; cur.setLength(0); continue; }
                }
                if (ora && isBlank(cur.toString()) && SQLPLUS.matcher(line).matches()) {
                    cur.setLength(0);
                    String cmd = line.strip().replaceAll(";+$", "");
                    out.add(new Stmt(cmd, i, eol, false));
                    i = Math.min(n, eol + 1); from = i; curStart = i; atLineStart = true; continue;
                }
                if (ora && line.trim().equals("/") && !cur.toString().isBlank()) {
                    add(out, cur, curStart, i, ora);
                    i = Math.min(n, eol + 1); from = i; cur.setLength(0); curStart = i; atLineStart = true; continue;
                }
                if (ora && line.trim().equals("/")) { i = Math.min(n, eol + 1); from = i; curStart = i; continue; }
            }
            atLineStart = false;
            if (cur.isEmpty() && Character.isWhitespace(c)) { // skip leading blanks so offsets point at real text
                if (c == '\n') atLineStart = true;
                i++; curStart = i; continue;
            }

            // comments
            if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-' || (my && c == '#')) {
                int eol = sql.indexOf('\n', i); if (eol < 0) eol = n;
                cur.append(sql, i, eol); i = eol; continue;
            }
            if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2); end = end < 0 ? n : end + 2;
                cur.append(sql, i, end); i = end; continue;
            }
            // Oracle alternative quoting: q'[ ... ]'
            if (ora && (c == 'q' || c == 'Q') && i + 2 < n && sql.charAt(i + 1) == '\'' && !Character.isLetterOrDigit(prev(sql, i))) {
                char open = sql.charAt(i + 2), close = switch (open) { case '[' -> ']'; case '(' -> ')'; case '{' -> '}'; case '<' -> '>'; default -> open; };
                int end = sql.indexOf("" + close + "'", i + 3); end = end < 0 ? n : end + 2;
                cur.append(sql, i, end); i = end; continue;
            }
            // strings and quoted identifiers
            if (c == '\'' || c == '"' || (my && c == '`')) {
                int j = i + 1;
                while (j < n) {
                    char d = sql.charAt(j);
                    if (my && d == '\\' && c != '`') { j += 2; continue; }
                    if (d == c) { if (j + 1 < n && sql.charAt(j + 1) == c) { j += 2; continue; } break; }
                    j++;
                }
                int end = Math.min(n, j + 1);
                cur.append(sql, i, end); i = end; continue;
            }
            // PostgreSQL dollar quoting
            if (pg && c == '$') {
                Matcher m = Pattern.compile("\\$([A-Za-z_][A-Za-z0-9_]*)?\\$").matcher(sql);
                if (m.find(i) && m.start() == i) {
                    String tag = m.group();
                    int end = sql.indexOf(tag, i + tag.length()); end = end < 0 ? n : end + tag.length();
                    cur.append(sql, i, end); i = end; continue;
                }
            }
            // terminator
            if (sql.startsWith(delim, i)) {
                boolean block = ora && PLSQL.matcher(stripLeading(cur.toString())).find();
                if (!block) {
                    add(out, cur, curStart, i, ora);
                    i += delim.length(); from = i; cur.setLength(0); curStart = i; continue;
                }
            }
            cur.append(c);
            if (c == '\n') atLineStart = true;
            i++;
        }
        if (!cur.toString().isBlank()) add(out, cur, curStart, n, ora);
        return out;
    }

    private static char prev(String s, int i) { return i == 0 ? ' ' : s.charAt(i - 1); }

    private static void add(List<Stmt> out, StringBuilder cur, int start, int end, boolean ora) {
        String t = cur.toString().strip();
        if (t.isEmpty() || isBlank(t)) return;
        out.add(new Stmt(t, start, end, ora && isPlsql(t)));
    }

    /** The statement that contains the given offset, or the nearest one before it. */
    public static Stmt at(List<Stmt> list, int offset) {
        Stmt best = null;
        for (Stmt s : list) {
            if (offset >= s.start() && offset <= s.end()) return s;
            if (s.start() <= offset) best = s;
        }
        return best != null ? best : (list.isEmpty() ? null : list.get(0));
    }
}
