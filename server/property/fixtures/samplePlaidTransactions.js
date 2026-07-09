// Mock Plaid-like transactions for 2026 (the "live" year) used to preview the
// attribution/matching layer without a real Plaid item linked to the rental
// property's bank account. Shape mirrors the fields the real Plaid
// `transactionsSync` response provides and that server/db.js already reads
// (see upsertTransactions/upsertPlaidTransactions in db.js).
export function sampleLivePlaidTransactions(year = new Date().getFullYear()) {
  const y = year;
  return [
    { transaction_id: `plaid_${y}_rent_01`, date: `${y}-01-04`, amount: -2050, merchant_name: "Airbnb Payouts", name: "AIRBNB PAYOUT", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_util_01`, date: `${y}-01-11`, amount: 128.44, merchant_name: "Florida Power & Light", name: "FPL AUTOPAY", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_hoa_01`, date: `${y}-01-15`, amount: 410, merchant_name: "Seaside Condo Association", name: "HOA DUES SEASIDE", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_rent_02`, date: `${y}-02-04`, amount: -2050, merchant_name: "Airbnb Payouts", name: "AIRBNB PAYOUT", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_util_02`, date: `${y}-02-12`, amount: 131.02, merchant_name: "Florida Power & Light", name: "FPL AUTOPAY", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_mgmt_01`, date: `${y}-02-18`, amount: 102.5, merchant_name: "Airbnb", name: "AIRBNB SERVICE FEE", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_insur_01`, date: `${y}-03-01`, amount: 975, merchant_name: "Citizens Property Insurance", name: "CITIZENS INS PREMIUM", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_hoa_02`, date: `${y}-03-15`, amount: 410, merchant_name: "Seaside Condo Association", name: "HOA DUES SEASIDE", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_rent_03`, date: `${y}-03-04`, amount: -2100, merchant_name: "Airbnb Payouts", name: "AIRBNB PAYOUT", account_id: "plaid_rental_checking", pending: false },
    // Unmatched / uncertain: a generic-named debit with no prior history — should land in the reconciliation queue.
    { transaction_id: `plaid_${y}_mystery_01`, date: `${y}-03-19`, amount: 84.17, merchant_name: "SQ *COASTAL HOME SVCS", name: "SQ *COASTAL HOME SVCS", account_id: "plaid_rental_checking", pending: false },
    { transaction_id: `plaid_${y}_pending_01`, date: `${y}-03-29`, amount: 59.99, merchant_name: "Ring Doorbell Plus", name: "RING SUBSCRIPTION", account_id: "plaid_rental_checking", pending: true },
  ];
}
