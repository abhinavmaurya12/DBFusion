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

## DBFusion vr.1.1.2 - Oracle tools
Run `mvn spring-boot:run`, then open http://localhost:9090 (the UI is served by the app, so no CORS setup is needed).
Oracle Tools tab: schema objects, DDL (DBMS_METADATA), columns/indexes/constraints/statistics, compile errors.
SQL Commands: PL/SQL blocks with DBMS_OUTPUT, Explain plan, Commit/Rollback with an Auto-commit switch, Oracle snippets.
