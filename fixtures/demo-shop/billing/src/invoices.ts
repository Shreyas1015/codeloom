import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { publishInvoiceCreated } from "./events";

const prisma = new PrismaClient();

export async function createInvoice(req: Request, res: Response) {
  const invoice = await prisma.invoice.create({ data: req.body });
  await publishInvoiceCreated(invoice.id);
  res.status(201).json(invoice);
}
