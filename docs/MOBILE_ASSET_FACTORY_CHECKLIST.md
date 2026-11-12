# Checklist operacional — RPG Pixel Art Mobile Asset Factory

Data da auditoria: 2026-11-12
Branch de trabalho: feature/asset-pipeline-foundation
Dispositivo-alvo: Android + Chrome
Princípio: preservar originais; nenhuma publicação final sem aprovação explícita.

## Auditoria do código nesta branch

- [x] Servidor Node.js/Express e transporte MCP existentes.
- [x] Sharp instalado como dependência para operações determinísticas.
- [x] Ferramentas MCP prepare_asset, validate_asset, preview_asset e save_asset registradas quando as credenciais ASSETS_* existem.
- [x] Upload móvel por página web /assets-upload, com limite declarado de 12 MB.
- [x] Separação de credenciais do vault e do repositório de assets via ASSETS_*.
- [x] Documentação inicial da arquitetura em docs/ASSET_PIPELINE.md.
- [ ] Confirmar que a branch está implantada no Render. A existência no GitHub não prova deploy.
- [x] Declarar ASSETS_GITHUB_TOKEN, ASSETS_GITHUB_OWNER, ASSETS_GITHUB_REPO e ASSETS_GITHUB_BRANCH em render.yaml (ainda requer sincronização/valores no painel Render).
- [x] Declarar ASSETS_UPLOAD_SECRET em render.yaml (ainda requer valor no painel Render).
- [ ] Confirmar que o conector Claude aponta para o serviço atualizado e lista as ferramentas.

## Estado atualizado — 2026-11-12

- [x] Rota web `/editor` adicionada ao servidor para servir o protótipo mobile.
- [x] Configuração declarativa do Render ampliada com as variáveis ASSETS_*.
- [x] Endpoint autenticado de rascunho existe; [ ] ainda não há API de comandos remotos do Claude para controlar o canvas em tempo real (fora do gate essencial do Módulo 01, salvo se o teste móvel demonstrar necessidade).
- [x] O editor envia rascunho PNG para repositório privado por endpoint autenticado; ainda não há sincronização bidirecional/live.
\n## Estado da persistência e publicação

O transporte MCP é stateless: cada requisição cria uma nova instância do servidor. Por isso, o fluxo não depende de Map em memória. `prepare_asset` grava original, PNG preparado e metadata em `.staging/<UUID>/` no repositório privado. `validate_asset`, `preview_asset` e `save_asset` recuperam os arquivos em chamadas independentes e verificam SHA-256. A leitura usa Git Blobs quando a Contents API não fornece conteúdo inline para arquivos maiores.

A publicação final usa Git Data API: cria blobs, uma árvore, um commit contendo original + PNG + relatório e exclusão dos três arquivos de staging; por fim avança a branch com `force:false`. Falha ao avançar a branch não é reportada como publicação concluída. A limpeza após publicação faz parte do mesmo commit. Os testes automatizados com PNG sintético existem; ainda faltam testes comportamentais reais com referências do módulo e validação no Render.

## Segurança e integridade a validar

- [x] Validar formato real por detecção do Sharp, além de limitar os formatos aceitos.
- [x] Ferramenta manual de limpeza por TTL existe, dry-run por padrão; [ ] agendamento periódico e rate limit não existem (não necessários para comprovar o Módulo 01; reavaliar antes de uso contínuo).
- [x] Registrar SHA-256 do original e do preparado; verificar integridade ao recuperar staging.
- [ ] Validar caminhos e nomes; nunca aceitar path fornecido livremente pelo usuário.
- [x] Publicação final transacional em um commit: original, PNG, relatório e remoção do staging; atualização de branch sem force.
- [ ] Adicionar chave idempotente explícita para impedir duplicação após repetição de requisição.
- [ ] Não salvar em production antes da aprovação vinculada ao asset_id e à versão exata.
- [ ] Não colocar tokens ou senhas no frontend, no repositório ou em mensagens do Claude.

## Entregas que podem ser feitas no servidor sem IA generativa

1. Persistência temporária durável.
2. Catálogo de referências com dimensões, formato, tamanho e SHA-256.
3. Editor web mobile: canvas com zoom/pan, camadas, grade, paleta, lápis/borracha, undo/redo e exportação PNG.
4. Manifesto JSON de elementos e caixas delimitadoras confirmadas pelo usuário.
5. Corte determinístico por caixas delimitadoras aprovadas.
6. Montagem determinística de atlas/spritesheet e manifesto de IDs.
7. Gerador TSX e TMX; TMX só quando houver mapa com posições/camadas, não apenas um atlas.
8. Testes automatizados e relatório de validação.

## Limites explícitos

- Nearest-neighbor, quantização e grade alinham/processam pixels; não corrigem automaticamente desenho ruim nem criam pixel art de qualidade artística.
- A primeira versão deve permitir desenho manual preciso no Chrome e comandos programáticos controlados. Claude pode enviar operações por MCP/API depois que essa API estiver implementada e protegida.
- Não há necessidade de instalar aplicativo Android agora. O editor será uma página web responsiva.
- Tiled/Pixelorama são opcionais para revisão futura; não são dependências do fluxo mobile inicial.

## Teste de aceitação inicial

- [ ] Upload de uma referência pixel art pelo Chrome.
- [ ] Imagem original armazenada sem alteração; SHA-256 verificado.
- [ ] Claude lista e abre a referência pelo MCP.
- [ ] prepare_asset grava staging durável; validate_asset e preview_asset recuperam o mesmo asset em chamadas MCP independentes (implementado, aguardando teste).
- [ ] validate_asset e preview_asset funcionam em requisições separadas.
- [x] Protótipo inicial do editor web criado em public/editor.html: abrir referência, camada transparente separada, lápis, borracha, conta-gotas, grade, zoom, desfazer e exportar PNG. Não foi testado em navegador real ainda.
- [x] Ferramenta MCP de recorte por caixas confirmadas; persistência de PNGs + manifesto no staging (validação visual real pendente).
- [x] Ferramenta MCP de atlas determinístico + manifesto; valida SHA-256 dos recortes (validação visual real pendente).
- [x] Ferramenta MCP de exportação TSX e TMX por parâmetros explícitos; arquivos ficam no staging.
- [ ] Confirmar que a imagem referenciada no TSX existe no caminho real do projeto.
- [ ] Abrir atlas/TSX/TMX no Tiled e validar compatibilidade real.
- [ ] save_asset exige aprovação explícita e mantém o original.


## Alteração técnica — 2026-11-12

- [x] Removido o Map temporário que não sobrevivia ao ciclo stateless do MCP.
- [x] Staging privado no GitHub com UUID, original, PNG e metadados.
- [x] Verificação SHA-256 ao reler os artefatos.
- [x] Fallback para Git Blobs ao recuperar arquivos acima do limite de conteúdo inline da Contents API.
- [x] `npm run check` e `npm test` passaram na CI para dd981bb.
- [x] Testes comportamentais com PNG sintético cobrem crop/atlas/TSX/TMX; [ ] executar fluxo MCP stateless com as referências reais do Módulo 01.
- [ ] Validar deploy Render e Android Chrome antes de integrar à branch principal.


## Controle programático de edição pelo Claude

- [x] Adicionada ferramenta MCP `edit_asset_pixels` para operações determinísticas de pixel, retângulo preenchido/vazado e linha.
- [x] As operações alteram somente o PNG preparado no staging; o original preservado não é alterado.
- [x] Cada edição atualiza o hash SHA-256 e persiste o novo PNG no staging.
- [x] O fluxo exige nova validação e prévia antes de `save_asset`; a publicação continua exigindo a frase de aprovação explícita.
- [x] Leitura de referências maiores usa Git Blobs quando a API Contents não inclui o conteúdo inline.
- [ ] Testar operações de edição com PNG real e verificar bordas, alpha, limites e linhas.
- [ ] Adicionar undo/redo no lado MCP (o editor mobile já tem undo local para a camada desenhada).
- [ ] Integrar edição por camadas e operações de seleção/recorte ao editor mobile.
- [x] Endpoint autenticado para upload de rascunho existe; [ ] comandos remotos de edição pelo Claude e workspace bidirecional ainda não existem. Não são pré-requisitos automáticos do Módulo 01.

## CI e integração

- [x] Workflow GitHub Actions criado em `.github/workflows/validate.yml` para instalar dependências e executar `npm run check`.
- [x] GitHub Actions `Asset pipeline checks` passou no push e no pull_request para o commit dd981bb (2026-11-12).
- [ ] Revisar e testar o deploy no Render antes de qualquer publicação na branch principal.


## Integração MCP de recorte e exportação — 2026-11-12

- [x] `slice_asset_elements`: aceita apenas caixas explícitas, valida limites e IDs, salva PNGs + manifesto com hash da fonte no staging.
- [x] `build_asset_atlas`: verifica hash da fonte e dos recortes antes de compor atlas e manifesto.
- [x] `export_tiled_files`: gera TSX e TMX opcional com placements explícitos; saída permanece no staging.
- [ ] Testar as três ferramentas em requisições MCP stateless reais no Render.
- [ ] Verificar imagem referenciada, TSX e TMX abrindo no Tiled.
- [ ] Validar que o conector Claude atualizado lista as novas ferramentas.


## Módulo 01 — fonte operacional vigente

Consultar `docs/VISUAL_FACTORY_MODULE_01.md` como roteiro principal. Ele substitui qualquer instrução antiga que contradiga o estado atual e define os cinco outputs obrigatórios: cenário, personagem, criatura, objeto e tileset.

### Estado reconciliado após auditoria

- [x] CI de `Asset pipeline checks` passou no SHA `b2b1dddaf0fabf9d9aa23abda00604b0f7824f10` (push e pull_request).
- [x] `cleanup_stale_asset_staging` implementado com dry-run por padrão; nenhuma limpeza real executada.
- [x] Recorte confirmado, atlas determinístico e exportação TSX/TMX expostos como ferramentas MCP e cobertos por testes de contrato/comportamento.
- [x] Retry limitado para conflito reconhecido de atualização concorrente da branch, sem force-push.
- [x] Especificação operacional do Módulo 01 criada.
- [ ] Confirmar Render na versão da branch; não presumir deploy pelo fato de existir commit.
- [ ] Confirmar Claude/MCP conectado e ferramentas listadas.
- [ ] Teste real no Android Chrome e fluxo de rascunho/prévia.
- [ ] Receber cinco referências escolhidas pelo usuário e executar análise/produção.
- [ ] Validar coerência artística entre os cinco outputs.
- [ ] Abrir TSX/TMX no Tiled e fazer round-trip.
- [ ] Registrar evidências, hashes e resultados dos gates do módulo.

Observação: checks estáticos/CI não comprovam reconstrução artística, deploy, funcionamento real no Android ou compatibilidade prática do Tiled. Não marcar módulo como concluído antes dos gates descritos no documento operacional.


## Revisão Lean — seguimento do Módulo 01

Data: 2026-11-12. Revisão feita após leitura da árvore Git completa da branch e dos documentos, workflows, configuração, código de exportação e testes relevantes.

### Desperdícios encontrados e decisão

| Desperdício | Evidência/risco | Ação no Módulo 01 |
|---|---|---|
| Informação contraditória (defeitos/retrabalho) | Checklist misturava endpoint de rascunho existente com ausência total de API; tratava testes sintéticos como inexistentes | Texto reconciliado para separar o que existe do que ainda precisa de teste real |
| Espera | Render/Claude/MCP e Tiled ainda não foram exercitados em ambiente real | Organizar validação em gates e não iniciar produção das cinco categorias antes de confirmar conexão |
| Transporte/movimentação | Referências precisam ser enviadas e lidas em fluxos separados; imagem pode gerar payload de visão/base64 grande | Medir o primeiro percurso real e evitar converter/reenviar imagem quando não necessário |
| Processamento excessivo | Crop/atlas/TSX/TMX já são determinísticos e não devem ser refeitos manualmente por Claude | Reutilizar as ferramentas MCP já existentes; não criar um segundo pipeline |
| Estoque | Staging pode acumular; cleanup manual dry-run-first já existe | Não executar limpeza durante a prova; revisar TTL depois do módulo |
| Defeitos | CI valida contratos e fixtures sintéticas, não fidelidade artística, integração Render nem round-trip Tiled | Usar cinco categorias, critérios artísticos e evidência de Tiled como gates reais |
| Superprodução | Implementar API bidirecional, undo/redo MCP, rate limit e scheduler antes de comprovar a fábrica aumentaria escopo | Adiar; só reabrir se um teste do módulo provar que é bloqueio |

### Próxima sequência de menor desperdício

1. Verificar CI no HEAD atual.
2. Confirmar versão ativa do Render e lista de ferramentas MCP; se não estiver atualizada, corrigir conexão antes de produzir assets.
3. Pedir ao usuário apenas as cinco referências e intenções essenciais, em uma coleta única.
4. Fazer uma análise comparativa das referências e preencher os manifestos antes de qualquer geração.
5. Aprovar escala/perspectiva/tile size a partir da Bíblia Visual; não fazer tentativas com dimensões arbitrárias.
6. Produzir uma categoria piloto e validar o fluxo completo antes de repetir para as outras quatro.
7. Só então executar revisão cruzada e round-trip Tiled.

### Indicadores Lean a medir no piloto

- tempo de ciclo por categoria (entrada → prévia aprovada);
- quantidade de chamadas Claude e tokens de entrada/saída por categoria;
- número de reenvios de imagem e bytes transferidos;
- iterações/retrabalho por asset;
- taxa de aprovação na primeira prévia;
- tempo de espera Render/MCP;
- falhas de validação e de abertura no Tiled.

Não há baseline real ainda; não inventar metas ou ganhos percentuais. O piloto estabelece a linha de base.
