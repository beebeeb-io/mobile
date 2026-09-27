-- Beebeeb preview-matrix fixture — SQL (task 1565).
-- non-ASCII in a comment: café naïve 日本語 Ελληνικά Москва €19.99

CREATE TABLE fixture (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT
);

INSERT INTO fixture (id, name, note) VALUES
  (1, 'café naïve', 'first row'),
  (2, '日本語テスト', 'second row'),
  (3, 'long note', '0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 end-of-long-line');
