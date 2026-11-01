import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function startNotifier() {
  const conn = await amqp.connect(process.env.AMQP_URL ?? "amqp://localhost");
  const channel = await conn.createChannel();
  await channel.bindQueue("emails", "billing", "invoice.*");
  await channel.consume("emails", handleEmail);
}

async function handleEmail(msg: unknown) {
  await prisma.emailLog.create({ data: { invoiceId: 1 } });
}
