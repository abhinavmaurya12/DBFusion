package com.udbms;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class DbController {
    private final DbService svc;
    private final EditService ed;
    public DbController(DbService svc, EditService ed) { this.svc = svc; this.ed = ed; }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> m(Map<String, Object> b, String k) {
        Object o = b.get(k);
        return o == null ? new LinkedHashMap<>() : (Map<String, Object>) o;
    }
    private static String str(Map<String, Object> b, String k) { return String.valueOf(b.get(k)); }

    @GetMapping("/connections/{id}/columns")
    public Map<String, Object> columns(@PathVariable String id, @RequestParam String table) throws Exception { return ed.columns(id, table); }

    @PostMapping("/connections/{id}/rows")
    public Map<String, Object> insert(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        return Map.of("changed", ed.insert(id, str(b, "table"), m(b, "values")));
    }
    @PutMapping("/connections/{id}/rows")
    public Map<String, Object> update(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        return Map.of("changed", ed.update(id, str(b, "table"), m(b, "key"), m(b, "values")));
    }
    @PostMapping("/connections/{id}/rows/delete")
    public Map<String, Object> delete(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        return Map.of("changed", ed.delete(id, str(b, "table"), m(b, "key")));
    }
    @PostMapping("/connections/{id}/addcolumn")
    public Map<String, Object> addColumn(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        ed.addColumn(id, str(b, "table"), str(b, "name"), str(b, "type")); return Map.of("ok", true);
    }
    @SuppressWarnings("unchecked")
    @PostMapping("/connections/{id}/tables")
    public Map<String, Object> createTable(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        ed.createTable(id, str(b, "name"), (List<Map<String, Object>>) b.get("columns")); return Map.of("ok", true);
    }
    @PostMapping("/connections/{id}/tables/drop")
    public Map<String, Object> dropTable(@PathVariable String id, @RequestBody Map<String, Object> b) throws Exception {
        ed.dropTable(id, str(b, "table")); return Map.of("ok", true);
    }

    @PostMapping("/connect")
    public Map<String, Object> connect(@RequestBody ConnectRequest r) throws Exception { return svc.connect(r); }

    @DeleteMapping("/connections/{id}")
    public void disconnect(@PathVariable String id) throws Exception { svc.disconnect(id); }

    @GetMapping("/connections/{id}/schema")
    public List<String> schema(@PathVariable String id) throws Exception { return svc.schema(id); }

    @GetMapping("/connections/{id}/preview")
    public Map<String, Object> preview(@PathVariable String id, @RequestParam String table) throws Exception {
        return svc.preview(id, table);
    }

    @PostMapping("/connections/{id}/query")
    public Map<String, Object> query(@PathVariable String id, @RequestBody Map<String, String> body) throws Exception {
        return svc.run(id, body.getOrDefault("query", ""));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> error(Exception e) {
        return ResponseEntity.badRequest().body(Map.of("error", String.valueOf(e.getMessage())));
    }
}
