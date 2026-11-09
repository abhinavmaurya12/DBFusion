<p align="center"><img src="src/main/resources/static/logo.svg" alt="DBFusion" height="64"></p>

# Universal Database Workbench

Java 21 + Spring Boot backend, plain HTML/CSS/JS frontend (Monaco editor, Chart.js).

    mvn spring-boot:run      # then open http://localhost:8080

API (test with Postman):
- POST   /api/connect                       {type, host, port, database, username, password, uri}
- GET    /api/connections/{id}/schema
- GET    /api/connections/{id}/preview?table=NAME
- POST   /api/connections/{id}/query        {"query": "SELECT ..."}
- DELETE /api/connections/{id}

type is one of: postgresql, mysql, oracle, mongodb. For Oracle, "database" is the service name.
MongoDB queries are JSON: {"collection":"users","filter":{},"limit":50} or {"collection":"users","pipeline":[...]}.

## DBFusion vr.1.2.0 - Oracle tools
Run `mvn spring-boot:run`, then open http://localhost:9090 (the UI is served by the app, so no CORS setup is needed).
Oracle Tools tab: schema objects, DDL (DBMS_METADATA), columns/indexes/constraints/statistics, compile errors.
SQL Commands: PL/SQL blocks with DBMS_OUTPUT, Explain plan, Commit/Rollback with an Auto-commit switch, Oracle snippets.

## Oracle tools (more)
Object tabs now include Triggers, Privileges, Dependencies (uses / used by), Sequence info, and a Recompile button for PL/SQL objects and views.
Statistics tab has Gather statistics (DBMS_STATS). Toolbar: Recompile invalid, Scheduler jobs, Recycle bin, Purge recycle bin.

## MySQL tools
Open the MySQL Tools tab after connecting to a MySQL server (the database name is optional, you can pick one in the tool).
- Database switcher (`USE`), objects: tables, views, procedures, functions, triggers, events
- DDL (`SHOW CREATE`), columns, indexes, constraints and foreign keys, statistics, triggers
- Maintenance: Analyze, Optimize, Check table
- Explain plan (SQL Commands, uses `EXPLAIN FORMAT=TREE`, falls back to plain `EXPLAIN`)
- Server status, variables (with filter), processlist, my grants
- MySQL snippets in SQL Commands

API additions (all under `/api/connections/{id}`):
- `oracle/triggers`, `oracle/privileges`, `oracle/dependencies`, `oracle/sequence`, `oracle/jobs`, `oracle/recyclebin`, `POST oracle/recyclebin/purge`, `POST oracle/stats`, `POST oracle/compile`, `POST oracle/compile-all`
- `mysql/databases`, `POST mysql/use`, `mysql/objects`, `mysql/ddl`, `mysql/describe`, `POST mysql/explain`, `POST mysql/maintenance`, `mysql/status`, `mysql/variables`, `mysql/processlist`, `mysql/grants`

## Logo
`src/main/resources/static/logo-mark.svg` (app icon, also the favicon), `logo.svg` and `logo-dark.svg` (with wordmark). PNG exports are in `branding/`.

## vr.1.2.0 - SQL tool fixes, new UI, Oracle User Manager

**SQL Commands**
- Ctrl+Enter runs the statement at the cursor (or the selection). F5 / "Run script" runs every statement. Statements are split safely (strings, comments, `DELIMITER` in MySQL, `$$` in PostgreSQL, PL/SQL blocks ended by a line with `/` in Oracle).
- Oracle SQL*Plus commands: `DESC table`, `SHOW USER`, `SHOW ERRORS`, `EXEC proc(1)`, `SET SERVEROUTPUT ON`, `PROMPT`, `REM`.
- CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE now reports compile errors instead of a silent "0 rows changed".
- Messages tab with a log of each statement, the failing statement is highlighted in the editor, Stop button (cancels the running statement), row limit and timeout selectors, "Limited to N rows" flag, uncommitted-changes indicator.
- Fixed: results area was squashed on the SQL page, the Output tab stayed selected after PL/SQL so later results looked missing, large numbers lost precision, Oracle TIMESTAMP WITH TIME ZONE / ROWID values showed garbage, connections to an unreachable host hung, mixed-case tables could not be opened.
- API: `POST /api/connections/{id}/query` accepts `mode` (single | current | script), `offset`, `maxRows`, `timeout`, `stopOnError`; `POST /api/connections/{id}/cancel`.

**Oracle User Manager** (tab "User Manager", visible for Oracle connections; log in as SYSTEM, or SYS with "Connect as SYSDBA")
- Create user wizard: name, password (generator and strength meter), default/temporary tablespace, profile, quota, lock, force password change, system privileges, roles (presets: Login only, Developer, DBA), live SQL preview with the password hidden.
- List users with status, lock / unlock, reset password, expire, drop (with CASCADE choice), and see each user's roles, privileges and quotas.
- API under `/api/connections/{id}/oracle/users`: `GET info`, `GET ""`, `GET grants?name=`, `POST preview`, `POST ""` (create), `POST action`.
- In the CDB root Oracle only allows common users named `C##NAME`; connect to a pluggable database (XEPDB1 / FREEPDB1) for normal users.
- Connection dialog: Oracle service name, `sid:XE`, full TNS descriptor, and "Connect as SYSDBA/SYSOPER".

**UI**: command palette (Ctrl+K), icon navigation, toasts, row inspector, export menu (CSV, JSON, INSERT script, TSV, Markdown), SQL formatter (Ctrl+Shift+F), column and alias autocomplete, worksheets that survive a reload, dark mode that follows your system.

## DBFusion vr.1.5.0 - Designer (MySQL, PostgreSQL, Oracle)
Tab **Designer**: change databases and tables with the same screens on all three engines. Every change shows its SQL first and runs only after you confirm; dropping asks you to type the name.
- **Databases / schemas**: MySQL database = PostgreSQL schema = Oracle schema (user). Create, rename, drop, MySQL character set. PostgreSQL also manages server databases. Oracle schemas are users: use the User Manager.
- **Tables**: create, rename, duplicate, empty (truncate), drop.
- **Columns**: add, drop, rename, change type / NULL / default.
- **Indexes and keys**: index, unique, primary key, foreign key (with ON DELETE), drop.
- **Edit data** opens the table in the Object Browser (double-click cells, add/delete rows); it switches the connection to that database/schema first.
- API: `/api/connections/{id}/design/{overview,tables,table,apply,use}`. `apply` takes `{op, container, table, ..., dryRun}`. SQL is built in `DdlBuilder.java`.
- Notes: MySQL "rename database" moves the tables to a new database (refused if it has views/routines/events). PostgreSQL DDL waits for Commit when Auto-commit is off; CREATE/DROP DATABASE need Auto-commit on. Oracle DDL commits by itself. Oracle identity columns need 12c+.

### Designer, advanced features
- **Views**: New view / Edit view / Drop view (one SELECT; `CREATE OR REPLACE VIEW`).
- **Check constraints**: add and drop (tab "Checks"). MySQL needs 8.0.19+.
- **Comments**: table comment and column comments (MySQL `COMMENT`, PostgreSQL/Oracle `COMMENT ON`), shown in the Columns tab.
- **DDL tab**: the CREATE statement of a table or view (MySQL `SHOW CREATE`, Oracle `DBMS_METADATA`, PostgreSQL rebuilt from the structure), with Copy.
- **ER diagram**: tables and foreign keys of the selected database/schema (first 40 tables), Download SVG.
- API additions: `design/ddl`, `design/view`, `design/erd`; `apply` ops `createView dropView addCheck dropCheck commentTable commentColumn`.
