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

## Estado atualizado — 2026-11-12\n\n- [x] Rota web `/editor` adicionada ao servidor para servir o protótipo mobile.\n- [x] Configuração declarativa do Render ampliada com as variáveis ASSETS_*.\n- [ ] O protótipo ainda não possui API de comandos externos para o Claude; a interface manual é apenas a primeira fatia.\n- [x] O editor envia rascunho PNG para repositório privado por endpoint autenticado; ainda não há sincronização bidirecional/live.\n\n## Estado da persistência e publicação

O transporte MCP é stateless: cada requisição cria uma nova instância do servidor. Por isso, o fluxo não depende de Map em memória. `prepare_asset` grava original, PNG preparado e metadata em `.staging/<UUID>/` no repositório privado. `validate_asset`, `preview_asset` e `save_asset` recuperam os arquivos em chamadas independentes e verificam SHA-256. A leitura usa Git Blobs quando a Contents API não fornece conteúdo inline para arquivos maiores.

A publicação final usa Git Data API: cria blobs, uma árvore, um commit contendo original + PNG + relatório e exclusão dos três arquivos de staging; por fim avança a branch com `force:false`. Falha ao avançar a branch não é reportada como publicação concluída. A limpeza após publicação não é best-effort separada: faz parte do mesmo commit. Ainda faltam testes comportamentais reais com PNG e validação no Render.

## Segurança e integridade a validar

- [x] Validar formato real por detecção do Sharp, além de limitar os formatos aceitos.
- [ ] Adicionar limite de taxa e expiração automática/limpeza periódica do staging.
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
- [ ] Recorte de um elemento com caixa delimitadora aprovada.
- [ ] Atlas + TSX gerados e validados.
- [ ] TMX mínimo com layer e tile placement abre no Tiled.
- [ ] save_asset exige aprovação explícita e mantém o original.


## Alteração técnica — 2026-11-12

- [x] Removido o Map temporário que não sobrevivia ao ciclo stateless do MCP.
- [x] Staging privado no GitHub com UUID, original, PNG e metadados.
- [x] Verificação SHA-256 ao reler os artefatos.
- [x] Fallback para Git Blobs ao recuperar arquivos acima do limite de conteúdo inline da Contents API.
- [x] `npm run check` e `npm test` passaram na CI para dd981bb.
- [ ] Executar teste comportamental com PNG real e fluxo MCP stateless.
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
- [ ] Implementar autenticação e API própria para o editor; a rota estática atual é apenas um protótipo e não deve ser tratada como workspace compartilhado.

## CI e integração

- [x] Workflow GitHub Actions criado em `.github/workflows/validate.yml` para instalar dependências e executar `npm run check`.
- [x] GitHub Actions `Asset pipeline checks` passou no push e no pull_request para o commit dd981bb (2026-11-12).
- [ ] Revisar e testar o deploy no Render antes de qualquer publicação na branch principal.
