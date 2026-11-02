# voltpt-recolha

Recolhe o estado em tempo real dos postos de carregamento em Portugal e grava-o na base de dados
do VoltPT (Supabase). Só tem código: não tem dados nem faturas, por isso pode ser público, e um
repositório público tem minutos de GitHub Actions ilimitados.

Fonte dos dados: Ponto de Acesso Nacional (NAP Portugal, IMT), dados da rede MOBI.E em DATEX II,
de livre acesso.

| Workflow | Quando | O que faz |
|---|---|---|
| `estado` | a cada 10 min (cron-job.org) | lê o estado de todas as tomadas e grava só as mudanças |
| `inventario` | 1x/dia | atualiza a lista oficial de postos, tomadas e potências |

A pasta `ingestion/` é uma cópia da do VoltPT (`tools/build_recolha.sh` volta a gerá-la).
Os registos das execuções são públicos: não mostram a ligação à base de dados.
