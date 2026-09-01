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

if (!HANDLE) {
  console.error("INFINITEPAY_HANDLE não configurado.");
  process.exit(1);
}

if (!BASE_URL) {
  console.error("PUBLIC_BASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

// =====================================================
// BANCO DE DADOS
// =====================================================

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

// =====================================================
// META
// =====================================================

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

// =====================================================
// PÁGINAS
// =====================================================

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

    console.log("Acesso /doar:", {
      order_nsu,
      slug,
      transaction_nsu,
      capture_method
    });

    // Se o comprador voltou da InfinitePay
    // depois de concluir o pagamento.
    if (
      order_nsu &&
      slug &&
      transaction_nsu
    ) {
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

// =====================================================
// CONFIRMAÇÃO PELO PAYMENT_CHECK
// =====================================================

async function confirmarPagamento({
  order_nsu,
  slug,
  transaction_nsu
}) {
  try {
    console.log("=================================");
    console.log("CONFIRMANDO PAGAMENTO");
    console.log("order_nsu:", order_nsu);
    console.log("slug:", slug);
    console.log("transaction_nsu:", transaction_nsu);
    console.log("=================================");

    // Verifica se o pedido existe
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

    // Se já foi pago, não contabiliza novamente
    if (pedido.pago) {
      console.log(
        "Pedido já contabilizado:",
        order_nsu
      );

      return true;
    }

    // Verifica duplicidade da transação
    const existente = await pool.query(
      `
      SELECT transaction_nsu
      FROM pagamentos
      WHERE transaction_nsu = $1
      `,
      [transaction_nsu]
    );

    if (existente.rows.length > 0) {
      console.log(
        "Transação já registrada:",
        transaction_nsu
      );

      return true;
    }

    // =================================================
    // PAYMENT CHECK OFICIAL
    // =================================================

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

    const texto = await resposta.text();

    let dados;

    try {
      dados = JSON.parse(texto);
    } catch {
      console.error(
        "Resposta inválida da InfinitePay:",
        texto
      );

      return false;
    }

    console.log(
      "Resposta payment_check:",
      JSON.stringify(dados)
    );

    // A InfinitePay precisa confirmar:
    // success = true
    // paid = true

    if (
      !resposta.ok ||
      dados.success !== true ||
      dados.paid !== true
    ) {
      console.warn(
        "Pagamento NÃO confirmado."
      );

      return false;
    }

    // =================================================
    // VALOR
    // =================================================

    // O amount representa o valor original
    // da cobrança em centavos.
    const valorPago =
      Number(dados.amount) / 100;

    if (
      !Number.isFinite(valorPago) ||
      valorPago <= 0
    ) {
      console.error(
        "Valor inválido recebido:",
        dados.amount
      );

      return false;
    }

    // Garante que o valor confirmado
    // corresponde ao pedido.
    const valorPedido =
      Number(pedido.valor);

    if (
      Math.abs(valorPago - valorPedido) > 0.01
    ) {
      console.error(
        "Valor diferente do pedido!",
        {
          pedido: valorPedido,
          recebido: valorPago
        }
      );

      return false;
    }

    // =================================================
    // SALVA PAGAMENTO
    // =================================================

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
      "================================="
    );

    console.log(
      `PAGAMENTO CONFIRMADO: R$ ${valorPago.toFixed(2)}`
    );

    console.log(
      "================================="
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

// =====================================================
// CRIAR CHECKOUT
// =====================================================

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

    const order_nsu =
      "GTA6-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    // Salva pedido no banco
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

      // A InfinitePay adicionará os parâmetros
      // order_nsu, slug e transaction_nsu
      // quando o pagamento for concluído.
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
      {
        order_nsu,
        valor
      }
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

    const texto = await resposta.text();

    let dados;

    try {
      dados = JSON.parse(texto);
    } catch {
      console.error(
        "Resposta inválida ao criar checkout:",
        texto
      );

      return res.status(500).json({
        error: "Resposta inválida da InfinitePay."
      });
    }

    if (
      !resposta.ok ||
      !dados.url
    ) {
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

// =====================================================
// WEBHOOK INFINITEPAY
// =====================================================

app.post(
  "/webhook/infinitepay",
  async (req, res) => {
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
        paid_amount,
        amount
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

      // Procura pedido
      const pedidoResult = await pool.query(
        `
        SELECT *
        FROM pedidos
        WHERE order_nsu = $1
        `,
        [order_nsu]
      );

      if (
        pedidoResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Pedido não encontrado"
        });
      }

      const pedido =
        pedidoResult.rows[0];

      // Já contabilizado
      if (pedido.pago) {
        return res.status(200).json({
          success: true,
          message: null
        });
      }

      // Valor original da venda
      const valor =
        Number(amount || 0) / 100;

      if (
        !Number.isFinite(valor) ||
        valor <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Valor inválido"
        });
      }

      // Confere o valor
      if (
        Math.abs(
          valor - Number(pedido.valor)
        ) > 0.01
      ) {
        return res.status(400).json({
          success: false,
          message: "Valor não corresponde ao pedido"
        });
      }

      // Salva pagamento
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
          capture_method || "pix"
        ]
      );

      // Marca como pago
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
  }
);

// =====================================================
// INICIAR SERVIDOR
// =====================================================

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
