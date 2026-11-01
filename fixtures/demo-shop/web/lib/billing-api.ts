import axios from "axios";

export const billingApi = axios.create({ baseURL: process.env.NEXT_PUBLIC_BILLING_URL });
