### 🗺 codeloom review map

_Draft by codeloom — not checked._

**What it does:** _(Claude fills this in when it checks the PR.)_

**Where it matters:**
- **Create a customer** — page ` /customers/new ` (web)

**What it writes:** ` customers `

Reads only: ` cities `

**Code to check:**
- ` CustomerService.create ` — changed, +3/-1 (` api/app/services/customer_service.ts `)

```mermaid
flowchart LR
n1["NewCustomerPage"]
n2["POST /api/customers"]
n3["CustomersController.store"]
n4["✏️ CustomerService.create"]:::changed
n5["customers (insert)"]
n1 --> n2
n2 --> n3
n3 --> n4
n4 --> n5
classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px
```

Also changed: 2 files — tests, docs

→ Open the full review map: https://x.github.io/demo/pr-1/