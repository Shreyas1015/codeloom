import express from "express";
import { createInvoice } from "./invoices";

const app = express();
const router = express.Router();

router.post("/invoices", createInvoice);
app.use("/billing", router);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(4000);
