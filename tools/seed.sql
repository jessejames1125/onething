-- The demo's invented person: Robin, a Tuesday morning in March 2030. Nothing here is real.
INSERT INTO settings (key, value) VALUES ('day.wake', '06:30'), ('day.bed', '22:30');

INSERT INTO goals (id, title, weight, status, created_at, updated_at) VALUES
  (1, 'Run a half marathon in May', 1.5, 'active', '2030-03-01T12:00:00Z', '2030-03-01T12:00:00Z'),
  (2, 'Find a bigger place', 1, 'active', '2030-03-01T12:00:00Z', '2030-03-01T12:00:00Z');

INSERT INTO tasks (id, title, goal_id, due, status, energy, is_shallow, created_at, updated_at) VALUES
  (1, 'Sign up for the half marathon', 1, '2030-03-13', 'todo', 'low', 1, '2030-03-08T12:00:00Z', '2030-03-08T12:00:00Z'),
  (2, 'Draft the apartment wish list', 2, NULL, 'todo', 'high', 0, '2030-03-09T12:00:00Z', '2030-03-09T12:00:00Z'),
  (3, 'Plan this week''s long run', 1, NULL, 'todo', 'med', 0, '2030-03-10T12:00:00Z', '2030-03-10T12:00:00Z'),
  (4, 'Send Sam the hiking photos', NULL, NULL, 'todo', 'low', 1, '2030-03-11T12:00:00Z', '2030-03-11T12:00:00Z');
