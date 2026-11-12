# Módulo 01 — Comprovar a Fábrica Visual

Status: especificação operacional pronta; execução visual real, validação no Android/Render e round-trip no Tiled ainda pendentes.

## Objetivo de saída

Demonstrar, em uma única rodada controlada, que a fábrica consegue receber referências reais e produzir um conjunto visual coerente composto por:

1. um cenário;
2. um personagem;
3. uma criatura;
4. um objeto;
5. um tileset regular utilizável no Tiled.

O conjunto é uma prova de processo e consistência, não define o gênero, a história ou as mecânicas do RPG. Não usar conteúdo de EvoCreo como especificação do jogo.

## Restrições invioláveis

- Usar referências fornecidas/selecionadas pelo usuário. Não criar referências oficiais nem assets finais por conta própria.
- Antes de desenhar, ler a Bíblia Visual vigente e registrar a fonte/versão consultada.
- Preservar arquitetura, silhueta, proporções e detalhes reconhecíveis da referência. Não fazer mera pixelização automática.
- A direção de arte deve seguir a Bíblia Visual: pixel art angular e detalhada, clusters intencionais, pixels quadrados, sem bevel, volumes inflados, suavização arredondada ou aparência plástica/3D.
- Não inferir dimensões, escala de tile, resolução-base, perspectiva ou regras de animação que não estejam definidas na Bíblia Visual. Marcar lacunas como bloqueios/perguntas.
- Referências originais são imutáveis. Todos os resultados ficam em staging até aprovação explícita.
- Não executar save_asset, publicação, merge ou deploy manual durante a prova.
- Não reconstruir a taverna ou outro asset anterior sem pedido explícito.

## Entrada exigida

Para cada categoria, receber pelo menos uma referência visual selecionada pelo usuário e registrar:
- ID curto da referência e categoria pretendida;
- URL/origem (ex.: Pinterest) e arquivo efetivamente enviado;
- intenção do usuário: o que deve ser preservado e o que pode ser reinterpretado;
- elementos essenciais e elementos dispensáveis;
- incertezas que exigem decisão humana.

Uma referência pode ser foto, render 3D, ilustração ou pixel art. A origem/estilo da referência não determina o estilo final.

## Manifesto de análise visual

Criar um registro por asset antes de qualquer preparação ou recorte. Campos obrigatórios:

- `schema_version`: versão do formato;
- `asset_key`: identificador estável e legível;
- `category`: `scene | character | creature | object | tileset`;
- `reference`: `reference_id`, `source_url` (quando houver), `original_filename`, `source_sha256`;
- `intent`: descrição curta do papel do elemento no jogo;
- `preserve`: lista de silhuetas, proporções, arquitetura e detalhes que não podem ser perdidos;
- `reinterpret`: mudanças permitidas para adequação à direção de arte;
- `visual_rules`: referência à Bíblia Visual e versão/data consultada;
- `camera`: perspectiva observada, orientação e grau de certeza; nunca adivinhar partes ocultas;
- `scale`: relação com unidade/tile/personagem de referência, ou `unknown` até confirmação;
- `palette`: cores observadas e função (base, luz, sombra, acento); distinguir observação de proposta;
- `materials`: materiais e pistas de textura;
- `lighting`: direção, dureza e temperatura observadas/propostas;
- `layers`: ordem de profundidade/oclusão;
- `elements`: objetos/componentes nomeados com caixas x/y/width/height apenas quando confirmadas;
- `uncertainties`: perguntas e confiança por inferência;
- `approval`: estado `pending | approved | rejected`, aprovador e decisão registrada.

Não inventar valores ausentes. Campos desconhecidos devem ser explicitamente `unknown`, `null` ou pergunta pendente. Caixas delimitadoras só podem ser enviadas a `slice_asset_elements` depois de confirmadas.

## Fluxo obrigatório por asset

1. **Ingestão:** preservar original; registrar SHA-256, dimensões, formato e origem.
2. **Leitura visual:** analisar referência com Bíblia Visual; preencher manifesto; separar observação de hipótese.
3. **Revisão humana:** mostrar análise, elementos preservados, mudanças propostas e dúvidas. Aguardar correção/aprovação do plano.
4. **Preparação:** executar `prepare_asset` somente após plano aprovado. Evitar resize, crop, quantização ou chroma-key sem necessidade documentada.
5. **Reconstrução artística:** produzir/revisar pixel art mantendo a referência reconhecível e aplicando a linguagem visual do projeto. Ferramentas determinísticas não substituem decisões artísticas.
6. **Validação:** executar `validate_asset`, inspecionar prévia em escala nativa e ampliada, conferir contorno, clusters, paleta, transparência, proporção e artefatos.
7. **Recortes:** confirmar caixas e só então executar `slice_asset_elements`.
8. **Empacotamento:** usar `build_asset_atlas` para sprites/elementos independentes. Não confundir atlas irregular com tileset regular.
9. **Tiled:** usar `export_tiled_files` para TSX apenas com imagem de tileset em grade regular e geometria confirmada. Gerar TMX somente com dimensões de mapa, camada e placements reais/confirmados.
10. **Revisão cruzada:** comparar as cinco categorias em conjunto, lado a lado.
11. **Aprovação:** registrar decisão por asset. O módulo termina com os outputs ainda em staging; publicação final requer autorização explícita separada.

## Critérios artísticos de aceitação

Avaliar cada item como `pass | revise | blocked`, com evidência/observação:

- Reconhecimento: arquitetura/silhueta e detalhes essenciais da referência permanecem identificáveis.
- Direção de arte: pixels quadrados, desenho angular, clusters intencionais, sem blur/antialias acidental, bevel ou aparência plástica.
- Perspectiva: coerente com a Bíblia Visual e com as referências aprovadas; sem inventar faces ocultas.
- Escala: proporções relativas coerentes entre cenário, personagem, criatura, objeto e tileset; unidade de escala explicitamente confirmada.
- Paleta: cores e funções coerentes; sombras e luz compatíveis com a Bíblia Visual.
- Materiais: pedra, madeira, tecido, vegetação, metal etc. diferenciáveis por forma/cluster, não por ruído indiscriminado.
- Legibilidade: silhuetas e detalhes principais continuam legíveis no tamanho real de uso.
- Consistência: cinco assets parecem pertencer ao mesmo jogo, sem variação involuntária de contorno, densidade de detalhe, contraste ou iluminação.

Não usar pontuação média para esconder falha crítica. Reconhecimento, perspectiva, escala e consistência são gates obrigatórios.

## Critérios técnicos de aceitação

- Originais preservados e hash original estável.
- PNGs de saída válidos, dimensões registradas, alpha intencional e sem pixels/linhas perdidos.
- Grade/tile size e escala compatíveis com a Bíblia Visual; se indefinidas, marcar bloqueado, não escolher arbitrariamente.
- Manifestos vinculados ao SHA-256 da fonte preparada.
- IDs únicos e caixas dentro dos limites da imagem.
- Atlas determinístico, manifesto de coordenadas consistente e PNG íntegro.
- TSX referencia caminho real de tileset regular, dimensões e tile count coerentes.
- TMX só contém placements explícitos, GIDs válidos e dimensões finitas.
- Abrir o TSX/TMX no Tiled e salvar/reabrir (round-trip) sem erro, referência ausente ou deslocamento.
- Nenhum arquivo foi publicado no diretório de produção durante a prova.

## Gates do módulo

- **Gate 0 — referências:** cinco referências selecionadas e enviadas pelo usuário.
- **Gate 1 — especificação:** Bíblia Visual lida; escala, tile size, perspectiva e regras relevantes identificadas; manifestos revisados.
- **Gate 2 — produção individual:** cada categoria tem prévia e validação técnica/artística.
- **Gate 3 — coerência:** comparação conjunta aprovada, sem falhas críticas.
- **Gate 4 — integração:** TSX/TMX testados no Tiled; evidência de abertura e reabertura registrada.
- **Gate 5 — encerramento:** checklist preenchido, hashes/relatórios registrados, limitações remanescentes explícitas. Assets permanecem em staging até autorização de publicação.

## Plano de teste operacional

- Confirmar CI verde no SHA da branch.
- Confirmar Render servindo o SHA/versão esperada sem deploy manual.
- Confirmar Claude conectado ao endpoint e listando as ferramentas MCP necessárias.
- No Android Chrome, executar ingestão de uma referência, enviar rascunho, receber prévia e confirmar que export do editor não incorpora a imagem de referência à camada editável.
- Executar uma referência por categoria e o fluxo completo.
- Fazer round-trip Tiled em desktop ou ambiente compatível; se o usuário só dispõe de Android, registrar essa dependência como tarefa assistida, não declarar aprovado sem teste real.

## Critério de conclusão

O módulo só pode ser marcado como concluído quando os cinco assets existirem em staging, todos os gates artísticos e técnicos estiverem aprovados, a coerência cruzada estiver documentada, o fluxo móvel/Render tiver sido exercitado e o round-trip Tiled tiver evidência real. CI verde isolada não conclui o módulo.
