import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const invoiceService = {
  async create(data: { customerId: number }) {
    return prisma.invoice.create({ data });
  },
  async markPaid(id: number) {
    return prisma.invoice.update({ where: { id }, data: { paid: true } });
  },
};
