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

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

// =========================
// BANCO
// =========================

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      order_nsu TEXT PRIMARY KEY,
      valor NUMERIC(10,2) NOT NULL,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      pago BOOLEAN DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      transaction_nsu TEXT PRIMARY KEY,
      order_nsu TEXT NOT NULL,
      valor NUMERIC(10,2) NOT NULL,
      capture_method TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
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

    res.json({
      arrecadado: Number(resultado.rows[0].total),
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
  try {
    const {
      order_nsu,
      slug,
      transaction_nsu,
      capture_method
    } = req.query;

    // Se voltou da InfinitePay após um pagamento,
    // tenta confirmar automaticamente.
    if (
      order_nsu &&
      slug &&
      transaction_nsu
    ) {
      console.log(
        "Retorno da InfinitePay:",
        {
          order_nsu,
          slug,
          transaction_nsu,
          capture_method
        }
      );

      await confirmarPagamento({
        order_nsu,
        slug,
        transaction_nsu
      });
    }

    res.sendFile(
      path.join(__dirname, "public", "donate.html")
    );

  } catch (erro) {
    console.error(
      "Erro no retorno do pagamento:",
      erro
    );

    res.sendFile(
      path.join(__dirname, "public", "donate.html")
    );
  }
});

// =========================
// CONFIRMAR PAGAMENTO
// =========================

async function confirmarPagamento({
  order_nsu,
  slug,
  transaction_nsu
}) {
  try {
    console.log(
      "Consultando payment_check:",
      {
        order_nsu,
        transaction_nsu,
        slug
      }
    );

    // Procura o pedido
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

      return false;
    }

    const pedido = pedidoResult.rows[0];

    // Já foi contabilizado
    if (pedido.pago) {
      console.log(
        "Pedido já estava pago:",
        order_nsu
      );

      return true;
    }

    // Verifica se a transação já existe
    const existente = await pool.query(
      `
      SELECT transaction_nsu
      FROM pagamentos
      WHERE transaction_nsu = $1
      `,
      [transaction_nsu]
    );

    if (existente.rows.length > 0) {
      return true;
    }

    // Consulta oficial da InfinitePay
    const resposta = await fetch(
      "https://api.checkout.infinitepay.io/payment_check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          handle: HANDLE,
          order_nsu,
          transaction_nsu,
          slug
        })
      }
    );

    const dados = await resposta.json();

    console.log(
      "Resposta payment_check:",
      JSON.stringify(dados)
    );

    if (
      !resposta.ok ||
      dados.success !== true ||
      dados.paid !== true
    ) {
      console.warn(
        "Pagamento não confirmado."
      );

      return false;
    }

    const valorPago =
      Number(dados.paid_amount || dados.amount || 0) / 100;

    if (
      !Number.isFinite(valorPago) ||
      valorPago <= 0
    ) {
      return false;
    }

    // Registra pagamento
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
      ON CONFLICT (transaction_nsu)
      DO NOTHING
      `,
      [
        transaction_nsu,
        order_nsu,
        valorPago,
        dados.capture_method || "pix"
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
      `PAGAMENTO CONFIRMADO: R$ ${valorPago.toFixed(2)}`
    );

    return true;

  } catch (erro) {
    console.error(
      "Erro no payment_check:",
      erro
    );

    return false;
  }
}

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
      return res.status(500).json({
        error: "Configuração do pagamento incompleta."
      });
    }

    const order_nsu =
      "GTA6-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    // Salva pedido
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
        `${BASE_URL}/doar`,

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
      order_nsu
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
// WEBHOOK
// =========================

app.post("/webhook/infinitepay", async (req, res) => {
  try {
    const pagamento = req.body || {};

    console.log(
      "Webhook InfinitePay recebido:",
      JSON.stringify(pagamento)
    );

    const {
      order_nsu,
      transaction_nsu,
      capture_method,
      paid_amount
    } = pagamento;

    if (
      !order_nsu ||
      !transaction_nsu
    ) {
      return res.status(400).json({
        success: false,
        message: "Dados incompletos"
      });
    }

    const pedidoResult = await pool.query(
      `
      SELECT *
      FROM pedidos
      WHERE order_nsu = $1
      `,
      [order_nsu]
    );

    if (pedidoResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Pedido não encontrado"
      });
    }

    const pedido = pedidoResult.rows[0];

    if (pedido.pago) {
      return res.status(200).json({
        success: true,
        message: null
      });
    }

    if (capture_method !== "pix") {
      return res.status(400).json({
        success: false,
        message: "Pagamento não é Pix"
      });
    }

    const valor =
      Number(paid_amount || 0) / 100;

    if (valor <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valor inválido"
      });
    }

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
      ON CONFLICT (transaction_nsu)
      DO NOTHING
      `,
      [
        transaction_nsu,
        order_nsu,
        valor,
        capture_method
      ]
    );

    await pool.query(
      `
      UPDATE pedidos
      SET pago = TRUE
      WHERE order_nsu = $1
      `,
      [order_nsu]
    );

    console.log(
      `Pagamento confirmado pelo webhook: R$ ${valor.toFixed(2)}`
    );

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
// INICIAR
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
      "Erro ao iniciar servidor:",
      erro
    );

    process.exit(1);
  }
}

iniciarServidor();
