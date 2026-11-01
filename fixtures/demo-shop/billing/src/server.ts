import express from "express";
import { createInvoice, payInvoice } from "./invoices";

const app = express();
const router = express.Router();

router.post("/invoices", createInvoice);
router.post("/invoices/:id/pay", payInvoice);
app.use("/billing", router);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(4000);
