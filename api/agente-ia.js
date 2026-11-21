export default async function handler(req, res) {
  const SUPABASE_URL = "https://mnnjdxtqurcamyjbxbnz.supabase.co";
  const SUPABASE_KEY = "sb_publishable_298sbZg8l7mnS1wub9oyqg_GIhTwHXb";
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

  try {
    // 1. Lê o estado atual gravado pelo MT5 (Z-Score M1 + Order Flow + API xaus.com)
    const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/radar_xaus?id=eq.1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const rows = await supaRes.json();
    if (!rows.length) return res.status(404).json({ error: "Linha id=1 não encontrada" });
    const d = rows[0];

    // 2. Calcula horário atual em Brasília (UTC-3)
    const agoraBrt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const hora = agoraBrt.getHours();
    const min = agoraBrt.getMinutes();
    const minDia = hora * 60 + min;
    const horaTexto = `${String(hora).padStart(2, "0")}:${String(min).padStart(2, "0")} BRT`;

    // Janela de abertura explosiva NY (11:25 às 12:25) ou rollover (18:45 às 05:00)
    const janelaPerigosa = (minDia >= 685 && minDia <= 745) || (minDia >= 1125 || minDia < 300);

    let veredito = {
      ia_permissao: "BLOQUEADO",
      ia_ativo_foco: "NENHUM",
      ia_estilo: "GRADE_LIMIT",
      ia_confianca: 0,
      ia_justificativa: "Aguardando confluência entre Order Flow, Z-Score e fluxo institucional."
    };

    if (janelaPerigosa) {
      veredito = {
        ia_permissao: "BLOQUEADO",
        ia_ativo_foco: "TODOS",
        ia_estilo: "PAUSADO",
        ia_confianca: 95,
        ia_justificativa: `Janela de risco (${horaTexto}): abertura de NY ou rollover noturno. Operações travadas para proteger capital.`
      };
    } else if (GEMINI_API_KEY) {
      // 3A. Consulta o Agente Gemini 2.5 Flash com saída JSON estruturada
      const prompt = `Você é um Gestor Quantitativo Institucional especialista em XAUUSD, BTCUSD e XAGUSD.
Analise os dados ao vivo abaixo (${horaTexto}):
- API xaus.com: ${d.api_status} | PAXG Ratio: ${d.paxg_ratio} | XAUT Ratio: ${d.xaut_ratio} | Razão Ouro/Prata: ${d.au_ag_ratio}
- XAUUSD: Z-Score M1=${d.xau_z} | Score=${d.xau_score} | Sinal=${d.xau_sinal} | OrderFlow=${d.xau_absorcao} (POC: ${d.xau_poc})
- BTCUSD: Z-Score M1=${d.btc_z} | Score=${d.btc_score} | Sinal=${d.btc_sinal} | OrderFlow=${d.btc_absorcao} (POC: ${d.btc_poc})
- XAGUSD: Z-Score M1=${d.xag_z} | Score=${d.xag_score} | Sinal=${d.xag_sinal} | OrderFlow=${d.xag_absorcao} (POC: ${d.xag_poc})

Regras rígidas:
1. Só libere COMPRA se houver confluência de Z-Score negativo (-1.5 a -3.5) + OrderFlow ABSORBED_BUY ou desconto institucional PAXG/XAUT < 0.9990.
2. Só libere VENDA se houver Z-Score positivo (+1.5 a +3.5) + OrderFlow ABSORBED_SELL ou prêmio PAXG/XAUT > 1.0008.
3. Escolha TIRO_UNICO_TRAILING quando houver absorção confirmada no POC; escolha GRADE_LIMIT quando o mercado estiver oscilando sem rompimento.
4. Caso contrário, responda BLOQUEADO.

Responda APENAS um JSON válido neste formato exato:
{"ia_permissao":"LIBERADO_COMPRA|LIBERADO_VENDA|BLOQUEADO","ia_ativo_foco":"XAUUSD|BTCUSD|XAGUSD|NENHUM","ia_estilo":"TIRO_UNICO_TRAILING|GRADE_LIMIT","ia_confianca":0-100,"ia_justificativa":"frase objetiva de até 140 caracteres em português"}`;

      const aiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
          })
        }
      );
      const aiJson = await aiRes.json();
      const textoResposta = aiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (textoResposta) veredito = JSON.parse(textoResposta);
    } else {
      // 3B. Fallback Determinístico Institucional (Caso GEMINI_API_KEY ainda não esteja configurada)
      const mediaTokens = ((Number(d.paxg_ratio) || 1) + (Number(d.xaut_ratio) || 1)) / 2;
      if (d.xau_absorcao === "ABSORBED_BUY" || (d.xau_sinal === "COMPRA" && mediaTokens <= 0.9990)) {
        veredito = {
          ia_permissao: "LIBERADO_COMPRA",
          ia_ativo_foco: "XAUUSD",
          ia_estilo: d.xau_absorcao === "ABSORBED_BUY" ? "TIRO_UNICO_TRAILING" : "GRADE_LIMIT",
          ia_confianca: 84,
          ia_justificativa: `Ouro com absorção compradora (POC ${d.xau_poc}) e desconto institucional PAXG/XAUT (${mediaTokens.toFixed(4)}).`
        };
      } else if (d.xau_absorcao === "ABSORBED_SELL" || (d.xau_sinal === "VENDA" && mediaTokens >= 1.0008)) {
        veredito = {
          ia_permissao: "LIBERADO_VENDA",
          ia_ativo_foco: "XAUUSD",
          ia_estilo: d.xau_absorcao === "ABSORBED_SELL" ? "TIRO_UNICO_TRAILING" : "GRADE_LIMIT",
          ia_confianca: 84,
          ia_justificativa: `Ouro com absorção vendedora (POC ${d.xau_poc}) e prêmio institucional PAXG/XAUT (${mediaTokens.toFixed(4)}).`
        };
      } else if (d.btc_absorcao === "ABSORBED_BUY" || d.btc_sinal === "COMPRA") {
        veredito = {
          ia_permissao: "LIBERADO_COMPRA",
          ia_ativo_foco: "BTCUSD",
          ia_estilo: "TIRO_UNICO_TRAILING",
          ia_confianca: 80,
          ia_justificativa: `BTCUSD com defesa de liquidez no POC ${d.btc_poc} e virada de Z-Score M1 (${d.btc_z}).`
        };
      } else if (d.btc_absorcao === "ABSORBED_SELL" || d.btc_sinal === "VENDA") {
        veredito = {
          ia_permissao: "LIBERADO_VENDA",
          ia_ativo_foco: "BTCUSD",
          ia_estilo: "TIRO_UNICO_TRAILING",
          ia_confianca: 80,
          ia_justificativa: `BTCUSD com rejeição institucional no topo (POC ${d.btc_poc}) e Z-Score M1 (${d.btc_z}).`
        };
      }
    }

    // 4. Grava o veredito da IA no Supabase para o Painel Web e o Robô MT5 lerem
    await fetch(`${SUPABASE_URL}/rest/v1/radar_xaus?id=eq.1`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ ...veredito, ia_updated_at: new Date().toISOString() })
    });

    return res.status(200).json({ ok: true, veredito });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
