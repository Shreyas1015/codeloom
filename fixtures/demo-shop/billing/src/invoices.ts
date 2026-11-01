import type { Request, Response } from "express";
import { invoiceService } from "./invoice-service";
import { publishInvoiceCreated, publishInvoicePaid } from "./events";

export async function createInvoice(req: Request, res: Response) {
  const invoice = await invoiceService.create(req.body);
  await publishInvoiceCreated(invoice.id);
  res.status(201).json(invoice);
}

export async function payInvoice(req: Request, res: Response) {
  const invoice = await invoiceService.markPaid(Number(req.params.id));
  await publishInvoicePaid(invoice.id);
  res.json(invoice);
}
