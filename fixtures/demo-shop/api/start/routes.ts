import router from "@adonisjs/core/services/router";

const CustomersController = () => import("#controllers/customers_controller");

router
  .group(() => {
    router.post("/customers", [CustomersController, "store"]);
    router.get("/customers/:id", [CustomersController, "show"]);
  })
  .prefix("/api");
