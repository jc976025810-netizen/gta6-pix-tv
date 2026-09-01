const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

let totalArrecadado = 0;

// Página principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Página de contribuição
app.get("/doar", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "donate.html"));
});

// Meta atual
app.get("/api/meta", (req, res) => {
  res.json({
    arrecadado: totalArrecadado,
    meta: 550
  });
});

// Criar pagamento
app.post("/api/create-payment", (req, res) => {
  const valor = Number(req.body.amount);

  if (!valor || valor <= 0 || valor > 550) {
    return res.status(400).json({
      error: "Valor inválido."
    });
  }

  res.status(501).json({
    error: "Pagamento ainda não configurado."
  });
});

// Webhook InfinitePay
app.post("/webhook/infinitepay", (req, res) => {
  console.log("Webhook recebido:", req.body);

  const pagamento = req.body;

  if (
    pagamento.capture_method === "pix" &&
    pagamento.paid_amount
  ) {
    const valor = Number(pagamento.paid_amount) / 100;

    if (valor > 0) {
      totalArrecadado += valor;

      console.log(
        "Pix recebido: R$",
        valor.toFixed(2)
      );
    }
  }

  res.status(200).json({
    success: true
  });
});

app.listen(PORT, () => {
  console.log(
    `Servidor GTA VI funcionando na porta ${PORT}`
  );
});
