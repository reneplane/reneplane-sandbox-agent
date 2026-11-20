package com.notes.notes;

import com.notes.web.Errors.NotFoundException;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class NotesController {
  private static final String COLUMNS = "id, title, body, pinned, created_at";
  private final JdbcTemplate jdbc;

  public NotesController(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  /** Pinned notes first, then the newest */
  @GetMapping("/notes")
  public List<Map<String, Object>> list() {
    return jdbc.queryForList("SELECT " + COLUMNS + " FROM notes ORDER BY pinned DESC, created_at DESC, id DESC");
  }

  @PostMapping("/notes/{id}/pin")
  public Map<String, Object> pin(@PathVariable int id) {
    return setPinned(id, true);
  }

  @PostMapping("/notes/{id}/unpin")
  public Map<String, Object> unpin(@PathVariable int id) {
    return setPinned(id, false);
  }

  private Map<String, Object> setPinned(int id, boolean pinned) {
    if (jdbc.update("UPDATE notes SET pinned = ? WHERE id = ?", pinned, id) == 0) throw new NotFoundException("Note " + id + " not found");
    return jdbc.queryForList("SELECT " + COLUMNS + " FROM notes WHERE id = ?", id).get(0);
  }
}
