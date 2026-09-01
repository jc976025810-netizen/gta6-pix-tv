const express = require("express");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

let totalArrecadado = 0;

app.get("/api/meta", (req, res) => {
  res.json({
    arrecadado: totalArrecadado,
    meta: 550
  });
});

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
      console.log("Pix recebido:", valor);
    }
  }

  res.status(200).json({
    success: true
  });
});

app.get("*", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando na porta ${PORT}`);
});
