/**
 * Conector Google Sheets (via Google Apps Script) — Pesquisa de Clima Remo Engenharia
 * ---------------------------------------------------------------------
 * Este arquivo é compartilhado por todas as páginas do questionário.
 *
 * COMO CONFIGURAR:
 * Siga as instruções em google-apps-script-codigo.gs.txt para publicar o
 * script como "App da Web" na sua planilha do Google Sheets. Depois, cole
 * a URL gerada (termina em /exec) abaixo em APPS_SCRIPT_CONFIG.apiUrl.
 *
 * Vantagem sobre o SheetDB: gratuito, sem limite mensal de requisições
 * (o Google Apps Script tem cotas de tempo de execução por dia, não de
 * quantidade de respostas — dificilmente é um problema real para uma
 * pesquisa respondida ao longo de dias/semanas).
 */

const APPS_SCRIPT_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/AKfycbw8d_vMTwnkPn_bIGvYHzmGjLJyNc_TfRi-VkE6udR7mnP58b1pTOa9Lv_UlcJF7baC/exec", // TODO: substitua pela URL /exec gerada no passo 11 das instruções
  idColumn: "response_id",
};

/**
 * fetch com timeout: evita que a chamada fique presa para sempre caso a
 * rede não responda. Depois de 15s, cancela e trata como erro.
 */
async function fetchComTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("Tempo esgotado ao conectar com o Google Sheets (verifique a URL configurada em APPS_SCRIPT_CONFIG.apiUrl)");
    }
    throw err;
  }
}

/**
 * Igual ao fetchComTimeout, mas tenta de novo automaticamente (com espera
 * progressiva: 1s, 2s, 4s) se a chamada falhar por instabilidade de rede
 * (ex: "Failed to fetch"). Isso evita perder respostas quando muita gente
 * está enviando ao mesmo tempo e a rede/servidor engasga momentaneamente.
 */
async function fetchComRetry(url, options = {}, timeoutMs = 15000, maxTentativas = 3) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      return await fetchComTimeout(url, options, timeoutMs);
    } catch (err) {
      ultimoErro = err;
      if (tentativa < maxTentativas) {
        const esperaMs = Math.min(1000 * Math.pow(2, tentativa - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, esperaMs));
      }
    }
  }
  throw ultimoErro;
}

/**
 * Gera (ou recupera) um ID único para esta sessão de resposta.
 * Usamos sessionStorage porque a pesquisa é anônima e feita em uma única
 * sessão (~8 min) — o ID não deve sobreviver ao fechar o navegador.
 */
function getResponseId() {
  let id = sessionStorage.getItem("remo_consorcio_response_id");
  if (!id) {
    id = "resp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("remo_consorcio_response_id", id);
  }
  return id;
}

/**
 * Salva (cria ou atualiza) os dados de UMA etapa/dimensão do questionário.
 * dadosEtapa: objeto simples, ex: { lideranca_q1: "4", lideranca_q2: "5", ... }
 * Retorna { ok: true|false, action: 'created'|'updated', error?: string }
 */
async function salvarRespostasEtapa(dadosEtapa) {
  const responseId = getResponseId();
  const payload = {
    [APPS_SCRIPT_CONFIG.idColumn]: responseId,
    ultima_atualizacao: new Date().toISOString(),
    ...dadosEtapa,
  };

  if (APPS_SCRIPT_CONFIG.apiUrl.includes("COLE_AQUI_A_URL")) {
    console.error(
      "Google Apps Script não configurado: cole a URL /exec em assets/sheetdb-connector.js"
    );
    guardarComoPendente(payload);
    return { ok: false, error: "Backend não configurado (URL ainda é o placeholder)" };
  }

  try {
    // O Apps Script Web App não lida bem com preflight CORS para JSON,
    // então enviamos como text/plain (o conteúdo continua sendo JSON válido).
    const resp = await fetchComRetry(APPS_SCRIPT_CONFIG.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      throw new Error("Falha ao salvar (status " + resp.status + "): " + bodyText);
    }

    const result = await resp.json().catch(() => ({}));
    if (!result.ok) {
      throw new Error(result.error || "Erro desconhecido ao salvar");
    }
    return { ok: true, action: result.action };
  } catch (err) {
    console.error("Erro ao salvar respostas no Google Sheets:", err);
    guardarComoPendente(payload);
    return { ok: false, error: err.message };
  }
}

function guardarComoPendente(payload) {
  const pendentes = JSON.parse(sessionStorage.getItem("remo_consorcio_pendentes") || "[]");
  pendentes.push(payload);
  sessionStorage.setItem("remo_consorcio_pendentes", JSON.stringify(pendentes));
}

/**
 * Busca os dados já salvos desta sessão (para pré-preencher campos quando
 * o usuário navega para "Anterior" e volta).
 * Retorna o objeto da linha (ou null se ainda não existir/erro).
 */
async function buscarRespostasSalvas() {
  const responseId = getResponseId();
  if (APPS_SCRIPT_CONFIG.apiUrl.includes("COLE_AQUI_A_URL")) return null;

  try {
    const resp = await fetchComRetry(
      `${APPS_SCRIPT_CONFIG.apiUrl}?${APPS_SCRIPT_CONFIG.idColumn}=${responseId}`
    );
    if (!resp.ok) return null;
    const row = await resp.json();
    return row && Object.keys(row).length ? row : null;
  } catch (err) {
    console.error("Erro ao buscar respostas salvas:", err);
    return null;
  }
}

/**
 * Reenvia quaisquer respostas que falharam ao salvar anteriormente
 * (guardadas em sessionStorage). Chame no início de cada página.
 */
async function reenviarPendentes() {
  const pendentes = JSON.parse(sessionStorage.getItem("remo_consorcio_pendentes") || "[]");
  if (!pendentes.length) return;
  if (APPS_SCRIPT_CONFIG.apiUrl.includes("COLE_AQUI_A_URL")) return;

  const restantes = [];
  for (const payload of pendentes) {
    try {
      const resp = await fetchComRetry(APPS_SCRIPT_CONFIG.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) restantes.push(payload);
    } catch {
      restantes.push(payload);
    }
  }
  sessionStorage.setItem("remo_consorcio_pendentes", JSON.stringify(restantes));
}
