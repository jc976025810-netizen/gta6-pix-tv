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

// Pedidos criados nesta execução do servidor
const pedidos = new Map();

// Transações já processadas
const transacoesProcessadas = new Set();

let totalArrecadado = 0;

// =========================
// PÁGINAS
// =========================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/doar", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "donate.html"));
});

// =========================
// META
// =========================

app.get("/api/meta", (req, res) => {
  res.json({
    arrecadado: Number(totalArrecadado.toFixed(2)),
    meta: META
  });
});

// =========================
// CRIAR CHECKOUT
// =========================

app.post("/api/create-payment", async (req, res) => {
  try {
    const valor = Number(req.body.amount);

    if (!Number.isFinite(valor) || valor <= 0 || valor > META) {
      return res.status(400).json({
        error: "Valor inválido."
      });
    }

    if (!HANDLE || !BASE_URL) {
      console.error("Variáveis de ambiente ausentes.");

      return res.status(500).json({
        error: "Configuração do pagamento incompleta."
      });
    }

    const order_nsu =
      "GTA6-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    // Guardamos o pedido antes de enviar para a InfinitePay.
    pedidos.set(order_nsu, {
      valor: Number(valor.toFixed(2)),
      criadoEm: new Date().toISOString(),
      pago: false
    });

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

    console.log("Criando checkout:", {
      order_nsu,
      valor
    });

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
      console.error(
        "Erro da InfinitePay:",
        dados
      );

      pedidos.delete(order_nsu);

      return res.status(400).json({
        error:
          "A InfinitePay não conseguiu criar o pagamento."
      });
    }

    console.log(
      "Checkout criado:",
      order_nsu
    );

    res.json({
      url: dados.url
    });

  } catch (erro) {
    console.error(
      "Erro ao criar pagamento:",
      erro
    );

    res.status(500).json({
      error: "Erro ao criar pagamento."
    });
  }
});

// =========================
// WEBHOOK INFINITEPAY
// =========================

app.post("/webhook/infinitepay", (req, res) => {
  try {
    const pagamento = req.body || {};

    console.log(
      "Webhook InfinitePay recebido:",
      JSON.stringify(pagamento)
    );

    const order_nsu = pagamento.order_nsu;
    const transaction_nsu = pagamento.transaction_nsu;
    const capture_method = pagamento.capture_method;

    const paidAmount = Number(
      pagamento.paid_amount || 0
    );

    // O pedido precisa existir no nosso sistema.
    const pedido = pedidos.get(order_nsu);

    if (!pedido) {
      console.warn(
        "Pedido não encontrado:",
        order_nsu
      );

      return res.status(400).json({
        success: false,
        message: "Pedido não encontrado"
      });
    }

    // Impede contabilizar a mesma transação duas vezes.
    if (
      transaction_nsu &&
      transacoesProcessadas.has(transaction_nsu)
    ) {
      return res.status(200).json({
        success: true,
        message: null
      });
    }

    // Só contabilizamos Pix.
    if (capture_method !== "pix") {
      console.warn(
        "Pagamento não é Pix:",
        capture_method
      );

      return res.status(400).json({
        success: false,
        message: "Pagamento não é Pix"
      });
    }

    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valor inválido"
      });
    }

    const valorPago = paidAmount / 100;

    // Confere se o valor recebido bate com o pedido.
    if (
      Math.abs(valorPago - pedido.valor) > 0.01
    ) {
      console.warn(
        "Valor diferente do pedido:",
        {
          esperado: pedido.valor,
          recebido: valorPago
        }
      );

      return res.status(400).json({
        success: false,
        message: "Valor do pagamento diferente do pedido"
      });
    }

    // Marca como pago.
    pedido.pago = true;

    if (transaction_nsu) {
      transacoesProcessadas.add(
        transaction_nsu
      );
    }

    totalArrecadado = Number(
      (
        totalArrecadado +
        valorPago
      ).toFixed(2)
    );

    console.log(
      `Pagamento confirmado: R$ ${valorPago.toFixed(2)}`
    );

    // A InfinitePay espera resposta rápida com HTTP 200.
    return res.status(200).json({
      success: true,
      message: null
    });

  } catch (erro) {
    console.error(
      "Erro no webhook:",
      erro
    );

    return res.status(500).json({
      success: false,
      message: "Erro interno"
    });
  }
});

// =========================
// SERVIDOR
// =========================

app.listen(PORT, () => {
  console.log(
    `Servidor GTA VI funcionando na porta ${PORT}`
  );
});
