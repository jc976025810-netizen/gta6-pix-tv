const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const HANDLE = process.env.INFINITEPAY_HANDLE;
const BASE_URL = process.env.PUBLIC_BASE_URL;

const META = 550;

let totalArrecadado = 0;
const transacoes = new Set();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/doar", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "donate.html"));
});

app.get("/api/meta", (req, res) => {
  res.json({
    arrecadado: totalArrecadado,
    meta: META
  });
});

app.post("/api/create-payment", async (req, res) => {
  try {
    const valor = Number(req.body.amount);

    if (!Number.isFinite(valor) || valor <= 0 || valor > META) {
      return res.status(400).json({
        error: "Valor inválido."
      });
    }

    if (!HANDLE || !BASE_URL) {
      return res.status(500).json({
        error: "Configuração do pagamento incompleta."
      });
    }

    const order_nsu =
      "GTA6-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    const pagamento = {
      handle: HANDLE,

      redirect_url:
        `${BASE_URL}/doar?pagamento=concluido`,

      webhook_url:
        `${BASE_URL}/webhook/infinitepay`,

      order_nsu,

      items: [
        {
          quantity: 1,
          price: Math.round(valor * 100),
          description: "Contribuição para o presente GTA VI"
        }
      ]
    };

    const resposta = await fetch(
      "https://api.checkout.infinitepay.io/links",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(pagamento)
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok || !dados.url) {
      console.error("Resposta InfinitePay:", dados);

      return res.status(400).json({
        error: "A InfinitePay não conseguiu criar o pagamento."
      });
    }

    res.json({
      url: dados.url
    });

  } catch (erro) {
    console.error("Erro:", erro);

    res.status(500).json({
      error: "Erro ao criar pagamento."
    });
  }
});

app.post("/webhook/infinitepay", (req, res) => {
  const pagamento = req.body || {};

  console.log("Webhook InfinitePay recebido:", pagamento);

  const transaction_nsu = pagamento.transaction_nsu;
  const capture_method = pagamento.capture_method;
  const paid_amount = Number(pagamento.paid_amount || 0);

  if (
    transaction_nsu &&
    !transacoes.has(transaction_nsu) &&
    capture_method === "pix" &&
    paid_amount > 0
  ) {
    const valor = paid_amount / 100;

    transacoes.add(transaction_nsu);

    totalArrecadado = Number(
      (totalArrecadado + valor).toFixed(2)
    );

    console.log(
      `Pix confirmado: R$ ${valor.toFixed(2)}`
    );
  }

  res.status(200).json({
    success: true,
    message: null
  });
});

app.listen(PORT, () => {
  console.log(
    `Servidor GTA VI funcionando na porta ${PORT}`
  );
});
