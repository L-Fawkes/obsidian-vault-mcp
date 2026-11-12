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
- [ ] Confirmar variáveis ASSETS_GITHUB_TOKEN, ASSETS_GITHUB_OWNER, ASSETS_GITHUB_REPO e ASSETS_GITHUB_BRANCH no Render.
- [ ] Confirmar ASSETS_UPLOAD_SECRET para habilitar o formulário móvel.
- [ ] Confirmar que o conector Claude aponta para o serviço atualizado e lista as ferramentas.

## Bloqueador técnico encontrado

O transporte MCP está configurado como stateless: buildServer() cria uma instância nova por requisição HTTP. Porém asset-tools.js guarda os resultados de prepare_asset em um Map em memória. Assim, validate_asset, preview_asset e save_asset podem receber outra instância e não encontrar o asset_id. O próprio código retorna "Asset expirado ou sessão reiniciada".

Correção necessária antes de considerar o ciclo prepare → validate → preview → save testável: persistir os artefatos temporários fora da memória do processo (por exemplo, staging privado no repositório de assets, com IDs imprevisíveis, metadados e expiração/limpeza), ou usar armazenamento durável apropriado. Não confiar em memória local do Render Free.

## Segurança e integridade a validar

- [ ] Validar assinatura real do arquivo e não apenas extensão/MIME.
- [ ] Registrar SHA-256 do original e verificar que o original salvo é idêntico aos bytes recebidos.
- [ ] Validar caminhos e nomes; nunca aceitar path fornecido livremente pelo usuário.
- [ ] Tornar gravação final idempotente e tratar falha parcial ao salvar original, PNG e relatório.
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
- [ ] prepare_asset gera uma cópia; o asset continua disponível na chamada seguinte.
- [ ] validate_asset e preview_asset funcionam em requisições separadas.
- [ ] Editor abre a referência, permite desenhar em camada separada e exporta PNG.
- [ ] Recorte de um elemento com caixa delimitadora aprovada.
- [ ] Atlas + TSX gerados e validados.
- [ ] TMX mínimo com layer e tile placement abre no Tiled.
- [ ] save_asset exige aprovação explícita e mantém o original.
