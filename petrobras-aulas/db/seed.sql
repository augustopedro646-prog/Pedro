-- Dados provisórios só pra tela não nascer vazia. Modalidades e siglas de
-- turma seguem o padrão que eles já usam na planilha (ex: TN7, TN14) —
-- trocar pelos nomes reais quando a planilha de migração chegar.
INSERT INTO modalidades (nome, nivel) VALUES
  ('Natação', 'Infantil A'),
  ('Natação', 'Adulto'),
  ('Tênis', 'Iniciante'),
  ('Tênis', 'Intermediário')
ON CONFLICT (nome, nivel) DO NOTHING;
