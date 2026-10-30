import amqp from "amqplib";

export async function publishInvoiceCreated(id: number) {
  const conn = await amqp.connect(process.env.AMQP_URL ?? "amqp://localhost");
  const channel = await conn.createChannel();
  channel.sendToQueue("invoice.created", Buffer.from(JSON.stringify({ id })));
}

export async function startConsumer() {
  const conn = await amqp.connect(process.env.AMQP_URL ?? "amqp://localhost");
  const channel = await conn.createChannel();
  await channel.consume("invoice.created", (msg) => {
    if (msg) channel.ack(msg);
  });
}
