# Customers

Creating a customer: the form at `/customers/new` sends `POST /api/customers`.

The handler validates the body and calls `CustomerService.create`, which inserts a row into the
`customers` table and writes an entry to `audit_logs`.
