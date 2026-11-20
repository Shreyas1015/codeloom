import Route from '@ioc:Adonis/Core/Route'

Route.get('/health', async () => ({ ok: true }))

Route.group(() => {
  Route.get('/customers', 'CustomersController.index')
  Route.post('/customers', 'CustomersController.store')
  Route.get('/customers/:id', 'CustomersController.show')

  Route.resource('orders', 'OrdersController').apiOnly().except(['destroy'])

  Route.post('/invoices', 'Billing/InvoicesController.create')
  Route.route('/invoices/:id/pay', ['POST', 'PUT'], 'Billing/InvoicesController.pay')

  Route.group(() => {
    Route.get('/customers', 'CustomersController.index')
    Route.any('/reports', 'ReportsController')
  })
    .prefix('/admin')
    .namespace('App/Controllers/Http/Admin')
}).prefix('/api')
