const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const HANDLE = process.env.INFINITEPAY_HANDLE;
const BASE_URL = process.env.PUBLIC_BASE_URL;

const META = 550;

// =========================
// BANCO DE DADOS
// =========================

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_URL.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined
});

// Cria as tabelas automaticamente
async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      order_nsu TEXT PRIMARY KEY,
      valor NUMERIC(10,2) NOT NULL,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      pago BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      transaction_nsu TEXT PRIMARY KEY,
      order_nsu TEXT NOT NULL REFERENCES pedidos(order_nsu),
      valor NUMERIC(10,2) NOT NULL,
      capture_method TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Banco de dados conectado e tabelas prontas.");
}

// =========================
// META
// =========================

app.get("/api/meta", async (req, res) => {
  try {
    const resultado = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) AS total
      FROM pagamentos
    `);

    const arrecadado = Number(resultado.rows[0].total);

    res.json({
      arrecadado,
      meta: META
    });

  } catch (erro) {
    console.error("Erro ao consultar meta:", erro);

    res.status(500).json({
      error: "Erro ao consultar a meta."
    });
  }
});

// =========================
// PÁGINAS
// =========================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.get("/doar", async (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "donate.html")
  );
});

// =========================
// CRIAR CHECKOUT
// =========================

app.post("/api/create-payment", async (req, res) => {
  try {
    const valor = Number(req.body.amount);

    if (
      !Number.isFinite(valor) ||
      valor <= 0 ||
      valor > META
    ) {
      return res.status(400).json({
        error: "Valor inválido."
      });
    }

    if (!HANDLE || !BASE_URL) {
      console.error(
        "INFINITEPAY_HANDLE ou PUBLIC_BASE_URL não configurado."
      );

      return res.status(500).json({
        error: "Configuração do pagamento incompleta."
      });
    }

    // Identificação única do pedido
    const order_nsu =
      "GTA6-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    // Salva o pedido ANTES de criar o checkout
    await pool.query(
      `
      INSERT INTO pedidos
        (order_nsu, valor)
      VALUES
        ($1, $2)
      `,
      [
        order_nsu,
        Number(valor.toFixed(2))
      ]
    );

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
          description:
            "Contribuição para o presente GTA VI"
        }
      ]
    };

    console.log(
      "Criando checkout:",
      order_nsu,
      "R$",
      valor.toFixed(2)
    );

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

      await pool.query(
        `
        DELETE FROM pedidos
        WHERE order_nsu = $1
        `,
        [order_nsu]
      );

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

app.post("/webhook/infinitepay", async (req, res) => {
  try {
    const pagamento = req.body || {};

    console.log(
      "Webhook InfinitePay recebido:",
      JSON.stringify(pagamento)
    );

    const order_nsu =
      pagamento.order_nsu;

    const transaction_nsu =
      pagamento.transaction_nsu;

    const capture_method =
      pagamento.capture_method;

    const paid_amount =
      Number(pagamento.paid_amount || 0);

    if (!order_nsu) {
      return res.status(400).json({
        success: false,
        message: "order_nsu ausente"
      });
    }

    if (!transaction_nsu) {
      return res.status(400).json({
        success: false,
        message: "transaction_nsu ausente"
      });
    }

    // Procura o pedido no banco
    const pedidoResult = await pool.query(
      `
      SELECT *
      FROM pedidos
      WHERE order_nsu = $1
      `,
      [order_nsu]
    );

    if (pedidoResult.rows.length === 0) {
      console.warn(
        "Pedido não encontrado:",
        order_nsu
      );

      return res.status(400).json({
        success: false,
        message: "Pedido não encontrado"
      });
    }

    const pedido = pedidoResult.rows[0];

    // Se já foi pago, não conta novamente
    if (pedido.pago) {
      return res.status(200).json({
        success: true,
        message: null
      });
    }

    // Verifica se é Pix
    if (capture_method !== "pix") {
      return res.status(400).json({
        success: false,
        message: "Pagamento não é Pix"
      });
    }

    if (
      !Number.isFinite(paid_amount) ||
      paid_amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valor inválido"
      });
    }

    // paid_amount vem em centavos
    const valorPago = paid_amount / 100;

    // O valor da contribuição é o valor original do pedido.
    const valorContribuicao =
      Number(pedido.valor);

    // Evita duplicidade
    const pagamentoExistente =
      await pool.query(
        `
        SELECT transaction_nsu
        FROM pagamentos
        WHERE transaction_nsu = $1
        `,
        [transaction_nsu]
      );

    if (pagamentoExistente.rows.length > 0) {
      return res.status(200).json({
        success: true,
        message: null
      });
    }

    // Registra o pagamento
    await pool.query(
      `
      INSERT INTO pagamentos
        (
          transaction_nsu,
          order_nsu,
          valor,
          capture_method
        )
      VALUES
        ($1, $2, $3, $4)
      `,
      [
        transaction_nsu,
        order_nsu,
        valorContribuicao,
        capture_method
      ]
    );

    // Marca pedido como pago
    await pool.query(
      `
      UPDATE pedidos
      SET pago = TRUE
      WHERE order_nsu = $1
      `,
      [order_nsu]
    );

    console.log(
      `Pagamento confirmado: R$ ${valorContribuicao.toFixed(2)}`
    );

    // Resposta rápida para a InfinitePay
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
// INICIALIZAÇÃO
// =========================

async function iniciarServidor() {
  try {
    await iniciarBanco();

    app.listen(PORT, () => {
      console.log(
        `Servidor GTA VI funcionando na porta ${PORT}`
      );
    });

  } catch (erro) {
    console.error(
      "Não foi possível iniciar:",
      erro
    );

    process.exit(1);
  }
}

iniciarServidor();
