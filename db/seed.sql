-- Dados mínimos pra a tela de login não nascer vazia. Cargos são
-- provisórios (ver prompt inicial) — ajustar depois da visita à associação.
INSERT INTO cargos (nome, administrador) VALUES
  ('Administrador', true),
  ('Diretor', false),
  ('Atendente', false)
ON CONFLICT (nome) DO NOTHING;

INSERT INTO unidades (nome) VALUES
  ('CEPE'),
  ('ATPN')
ON CONFLICT (nome) DO NOTHING;
