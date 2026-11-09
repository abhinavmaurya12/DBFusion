package com.udbms;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/** Database and table designer: structure, indexes, keys, foreign keys. Works for MySQL, PostgreSQL and Oracle. */
@RestController
@RequestMapping("/api/connections/{id}/design")
public class DesignController {
    private final DesignService svc;
    public DesignController(DesignService svc) { this.svc = svc; }

    /** Databases/schemas on the server, the current one, and what can be managed. */
    @GetMapping("/overview")
    public Map<String, Object> overview(@PathVariable String id) throws Exception { return svc.overview(id); }

    @GetMapping("/tables")
    public Map<String, Object> tables(@PathVariable String id, @RequestParam(required = false) String container) throws Exception {
        return svc.tables(id, container);
    }

    /** Columns, primary key, indexes and foreign keys of one table. */
    @GetMapping("/table")
    public Map<String, Object> table(@PathVariable String id, @RequestParam(required = false) String container, @RequestParam String name) throws Exception {
        return svc.describe(id, container, name);
    }

    @GetMapping("/ddl")
    public Map<String, Object> ddl(@PathVariable String id, @RequestParam(required = false) String container, @RequestParam String name) throws Exception { return svc.ddl(id, container, name); }

    @GetMapping("/view")
    public Map<String, Object> view(@PathVariable String id, @RequestParam(required = false) String container, @RequestParam String name) throws Exception { return svc.view(id, container, name); }

    @GetMapping("/erd")
    public Map<String, Object> erd(@PathVariable String id, @RequestParam(required = false) String container) throws Exception { return svc.erd(id, container); }

    /** body: op, dryRun (true = only return the SQL), container, table, ... see DesignService.apply */
    @PostMapping("/apply")
    public Map<String, Object> apply(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception { return svc.apply(id, b); }

    /** Switch the connection to this database/schema so the Object Browser and SQL page use it. */
    @PostMapping("/use")
    public Map<String, Object> use(@PathVariable String id, @RequestBody Map<String, String> b) throws Exception { return svc.use(id, b.get("container")); }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> error(Exception e) {
        return ResponseEntity.badRequest().body(Map.of("error", DbService.describe(e)));
    }
}
