package com.notes;

import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.test.web.servlet.MockMvc;

/** Visible tests. Run them with ./mvnw test or the Run button. Submitting also runs hidden tests. */
@SpringBootTest
@AutoConfigureMockMvc
class NotesTest {
  @Autowired MockMvc mvc;
  @Autowired Flyway flyway;
  @Autowired DataSource dataSource;

  /** A fresh database before each test: every migration (yours too), then the seed */
  @BeforeEach
  void freshDatabase() {
    flyway.clean();
    flyway.migrate();
    new ResourceDatabasePopulator(new FileSystemResource("../db/seed.mysql.sql")).execute(dataSource);
  }

  @Test
  @DisplayName("GET /api/notes returns every note")
  void returnsEveryNote() throws Exception {
    mvc.perform(get("/api/notes")).andExpect(status().isOk()).andExpect(jsonPath("$", hasSize(6)));
  }

  @Test
  @DisplayName("GET /api/notes puts pinned notes first")
  void pinnedFirst() throws Exception {
    mvc.perform(get("/api/notes")).andExpect(jsonPath("$[*].pinned").value(contains(true, true, false, false, false, false)));
  }

  @Test
  @DisplayName("GET /api/notes lists the newest first within pinned and unpinned notes")
  void newestFirst() throws Exception {
    mvc.perform(get("/api/notes")).andExpect(jsonPath("$[*].id").value(contains(5, 2, 6, 4, 3, 1)));
  }

  @Test
  @DisplayName("POST /api/notes/{id}/pin moves a note to the top")
  void pinMovesUp() throws Exception {
    mvc.perform(post("/api/notes/1/pin")).andExpect(status().isOk());
    mvc.perform(get("/api/notes")).andExpect(jsonPath("$[0:3].id").value(contains(5, 2, 1)));
  }

  @Test
  @DisplayName("POST /api/notes/{id}/pin answers 404 for a note that does not exist")
  void missingNote() throws Exception {
    mvc.perform(post("/api/notes/999/pin")).andExpect(status().isNotFound());
  }
}
