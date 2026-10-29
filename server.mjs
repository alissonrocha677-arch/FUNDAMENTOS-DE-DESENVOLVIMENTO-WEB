import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
const allowedGoals = new Set(["general_fitness", "strength", "weight_loss"]);
const allowedExperience = new Set(["beginner", "intermediate", "advanced"]);
const requestWindows = new Map();
const rateWindowMs = 10 * 60 * 1000;
const rateLimit = 12;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT precisa ser um número entre 1 e 65535.");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function isLocalRequest(request) {
  const host = request.headers.host?.toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return Boolean(host && allowedHosts.has(host));
}

async function readJson(request) {
  const contentType = request.headers["content-type"]?.split(";")[0].trim();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type deve ser application/json.");
    error.status = 415;
    throw error;
  }

  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > 4096) {
    const error = new Error("Corpo da solicitação muito grande.");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) {
      const error = new Error("Corpo da solicitação muito grande.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("JSON inválido.");
    error.status = 400;
    throw error;
  }
}

function validatePreferences(body) {
  return Boolean(
    body &&
    allowedGoals.has(body.goal) &&
    allowedExperience.has(body.experience) &&
    Number.isInteger(body.daysPerWeek) &&
    body.daysPerWeek >= 2 &&
    body.daysPerWeek <= 5
  );
}

function isRateLimited(request) {
  const now = Date.now();
  const address = request.socket.remoteAddress || "local";
  const current = requestWindows.get(address);
  if (!current || now - current.startedAt >= rateWindowMs) {
    requestWindows.set(address, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > rateLimit;
}

async function generatePlan(preferences) {
  const goalLabels = {
    general_fitness: "melhorar a saúde geral e o condicionamento",
    strength: "desenvolver força e massa muscular de forma gradual",
    weight_loss: "apoiar a perda de peso por meio de atividade física e hábitos sustentáveis, sem promessas de resultados"
  };
  const experienceLabels = {
    beginner: "iniciante",
    intermediate: "intermediária",
    advanced: "avançada"
  };
  const instructions = [
    "Você é um assistente de atividade física que responde em português do Brasil.",
    "Crie sugestões gerais de musculação em academia, não uma prescrição clínica ou avaliação profissional.",
    "Não diagnostique, não prometa emagrecimento ou resultados e não recomende dietas restritivas, suplementos ou medicamentos.",
    "Se houver dor, lesão, gravidez, condição crônica ou outra limitação não informada, recomende conversar com profissional de saúde e de educação física antes de adaptar o treino.",
    "Dê preferência a máquinas comuns da academia, carga inicial leve, técnica controlada, descanso suficiente e recuperação entre sessões.",
    "Explique cada exercício com aparelho, séries, faixa de repetições, descanso e dois passos simples de execução; inclua aquecimento, desaquecimento e uma alternativa mais simples.",
    "Não recomende treinar até a falha. Oriente a interromper diante de dor, tontura ou mal-estar. Use linguagem acolhedora e concisa."
  ].join(" ");

  const input = [
    `Objetivo: ${goalLabels[preferences.goal]}.`,
    `Experiência: ${experienceLabels[preferences.experience]}.`,
    `Disponibilidade: ${preferences.daysPerWeek} dias por semana.`,
    "Monte uma sugestão semanal de musculação para academia, organizada por dia, com recuperação adequada. Não assuma idade, sexo, peso, histórico de saúde nem disponibilidade de equipamentos especiais."
  ].join(" ");

  let apiResponse;
  try {
    apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        max_output_tokens: 1200,
        store: false
      }),
      signal: AbortSignal.timeout(45000)
    });
  } catch (error) {
    console.error("Falha ao conectar à API da OpenAI:", error.name);
    const failure = new Error("Serviço de IA temporariamente indisponível.");
    failure.status = 502;
    throw failure;
  }

  if (!apiResponse.ok) {
    console.error(`A API da OpenAI respondeu com status ${apiResponse.status}.`);
    const failure = new Error("Serviço de IA temporariamente indisponível.");
    failure.status = 502;
    throw failure;
  }

  let result;
  try {
    result = await apiResponse.json();
  } catch {
    const failure = new Error("Resposta inválida do serviço de IA.");
    failure.status = 502;
    throw failure;
  }

  const outputText = result.output_text || result.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === "output_text")?.text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    const failure = new Error("O serviço de IA não retornou um plano.");
    failure.status = 502;
    throw failure;
  }
  return outputText.trim();
}

const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");

  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    sendJson(response, 400, { error: "INVALID_REQUEST", message: "Endereço inválido." });
    return;
  }

  if (!isLocalRequest(request)) {
    sendJson(response, 403, { error: "LOCAL_ONLY", message: "Acesso permitido apenas pelo endereço local do app." });
    return;
  }

  if (pathname === "/api/status") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "Método não permitido." });
      return;
    }
    sendJson(response, 200, { configured: Boolean(apiKey) });
    return;
  }

  if (pathname === "/api/coach") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "Método não permitido." });
      return;
    }
    if (request.headers.origin !== `http://${request.headers.host}`) {
      sendJson(response, 403, { error: "INVALID_ORIGIN", message: "Origem da solicitação não permitida." });
      return;
    }

    let preferences;
    try {
      preferences = await readJson(request);
    } catch (error) {
      sendJson(response, error.status || 400, {
        error: error.status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_INPUT",
        message: error.message
      });
      return;
    }

    if (!validatePreferences(preferences)) {
      sendJson(response, 400, { error: "INVALID_INPUT", message: "Revise as preferências selecionadas." });
      return;
    }
    if (!apiKey) {
      sendJson(response, 503, { error: "AI_NOT_CONFIGURED", message: "Configure OPENAI_API_KEY no servidor local." });
      return;
    }
    if (isRateLimited(request)) {
      sendJson(response, 429, { error: "RATE_LIMITED", message: "Aguarde antes de fazer outra solicitação." });
      return;
    }

    try {
      const plan = await generatePlan(preferences);
      sendJson(response, 200, { plan });
    } catch (error) {
      sendJson(response, error.status || 502, {
        error: "AI_UNAVAILABLE",
        message: "Não foi possível gerar uma sugestão agora. Tente novamente mais tarde."
      });
    }
    return;
  }

  if (request.method !== "GET" || !["/", "/index.html"].includes(pathname)) {
    sendJson(response, 404, { error: "NOT_FOUND", message: "Página não encontrada." });
    return;
  }

  try {
    const html = await readFile(join(root, "index.html"));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(html);
  } catch (error) {
    console.error("Não foi possível ler index.html:", error.message);
    sendJson(response, 500, { error: "APP_UNAVAILABLE", message: "Não foi possível abrir o app." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Viva está disponível em http://127.0.0.1:${port}`);
  console.log(`Integração OpenAI: ${apiKey ? "configurada" : "aguardando OPENAI_API_KEY"}`);
});

server.on("error", (error) => {
  console.error("Não foi possível iniciar o servidor local:", error.message);
  process.exitCode = 1;
});
