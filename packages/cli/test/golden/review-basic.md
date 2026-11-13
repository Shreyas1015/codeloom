### 🗺 codeloom review map

This PR touches 1 journeys, 1 chains, 1 tables, 0 queues.

```mermaid
flowchart LR
n1["NewCustomerPage"]
n2["useCreateCustomer"]
n3["POST /api/customers"]
n4["CustomersController.store"]
n5["✏️ CustomerService.create"]:::changed
n6["customers (insert)"]
n1 --> n2
n2 --> n3
n3 --> n4
n4 --> n5
n5 --> n6
classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px
```

| Journey | Changed stops | Spec |
|---|---|---|
| Create a customer | CustomerService.create | unchecked |

Not on any journey:
- `api/lib/gst.ts` (+1/-0)

→ Open the full review map: https://x.github.io/demo/pr-1/ (built for a41c9e2)