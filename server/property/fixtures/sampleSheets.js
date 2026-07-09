// Mock intermediate-row-shape fixtures standing in for the old spreadsheet's
// per-year tabs (no literal file exists — see docs/property-finance.md).
// Each covers a documented column variant plus embedded summary rows and a
// couple of deliberately-broken rows to exercise the review queue.

// 2021: "direct expense" shape.
export const sheet2021 = {
  year: 2021,
  label: "2021 Transactions",
  rows: [
    ["Date", "Monthly Rents", "Direct Expense", "Notes", "Reconciled out of Reserve Account"],
    ["1/5/2021", 1800, "", "January rent - Smith", "Y"],
    ["1/10/2021", "", 145.32, "FPL electric", "N"],
    ["1/15/2021", "", 60, "HOA cable bundle", "N"],
    ["2/5/2021", 1800, "", "February rent - Smith", "Y"],
    ["2/12/2021", "", 220, "Plumber - leaky faucet repair", "N"],
    ["3/5/2021", 1800, "", "March rent - Smith", "Y"],
    ["3/20/2021", "", 950, "Condo insurance annual premium", "N"],
    ["TOTAL", 5400, 1375.32, "", ""],
    ["Depreciation", "", 1200, "non-cash", ""],
  ],
};

// 2022: "gross/type" shape.
export const sheet2022 = {
  year: 2022,
  label: "2022 Transactions",
  rows: [
    ["Date", "Gross", "Type", "Category", "Notes"],
    ["1/7/2022", 1850, "Income", "Rent", "January rent - Ortiz"],
    ["1/22/2022", -175.5, "Expense", "Utilities", "Water/sewer bill"],
    ["2/7/2022", 1850, "Income", "Rent", "February rent - Ortiz"],
    ["2/18/2022", -89, "Expense", "Management Fees", "Airbnb host service fee"],
    ["3/7/2022", 1850, "Income", "Rent", "March rent - Ortiz"],
    ["3/25/2022", -310, "Expense", "Repairs", "AC repair - capacitor"],
    ["", "", "", "", ""],
    ["Subtotal", 5450, "", "", ""],
    ["Net Rental Income", 4364.5, "", "", ""],
  ],
};

// 2023: "deposits received / implied expense / expense" shape.
export const sheet2023 = {
  year: 2023,
  label: "2023 Transactions",
  rows: [
    ["Date", "Deposits Received", "Implied Expense", "Expense", "Category", "Notes"],
    ["1/6/2023", 1900, "", "", "Rent", "January rent - Nguyen"],
    ["1/19/2023", "", "", 132.9, "Utilities", "Electric bill"],
    ["2/6/2023", 1900, "", "", "Rent", "February rent - Nguyen"],
    ["2/14/2023", "", "", 400, "Maintenance", "Cleaning turnover x2"],
    ["3/6/2023", 1900, "", "", "Rent", "March rent - Nguyen"],
    ["3/28/2023", "", 65, "", "Advertising", "Listing boost - Furnished Finder"],
    // Deliberately broken rows for the review queue:
    ["not a date", "", "", 50, "Repairs", "Unparseable date"],
    ["4/2/2023", "", "", "", "Notes only", "No amount present at all"],
    ["Grand Total", 5700, 65, 532.9, "", ""],
  ],
};

// 2024: "direct expense" shape plus days-rented/days-personal usage columns.
export const sheet2024 = {
  year: 2024,
  label: "2024 Transactions",
  rows: [
    ["Date", "Monthly Rents", "Direct Expense", "Notes", "Reconciled out of Reserve Account", "Days Rented", "Days Personal Use"],
    ["1/8/2024", 1950, "", "January rent - Patel", "Y", "", ""],
    ["1/12/2024", "", 180, "HOA special assessment portion", "N", "", ""],
    ["2/1/2024", "", "", "Owner personal stay", "", "", 14],
    ["2/8/2024", 1950, "", "February rent - Patel", "Y", "", ""],
    ["3/8/2024", 1950, "", "March rent - Patel", "Y", "", ""],
    ["3/15/2024", "", 275, "Property tax installment", "N", "", ""],
    ["Total", 5850, 455, "", "", "", ""],
  ],
};

// 2025: "gross/type" shape, most recent full backfill year.
export const sheet2025 = {
  year: 2025,
  label: "2025 Transactions",
  rows: [
    ["Date", "Gross", "Type", "Category", "Notes"],
    ["1/5/2025", 2000, "Income", "Rent", "January rent - Delgado"],
    ["1/21/2025", -210, "Expense", "Insurance", "Wind/flood endorsement true-up"],
    ["2/5/2025", 2000, "Income", "Rent", "February rent - Delgado"],
    ["2/17/2025", -95, "Expense", "Management Fees", "VRBO commission"],
    ["3/5/2025", 2000, "Income", "Rent", "March rent - Delgado"],
    ["3/22/2025", -640, "Expense", "Improvement", "New water heater"],
    ["Total", 5265, "", "", ""],
  ],
};

export const allBackfillSheets = [sheet2021, sheet2022, sheet2023, sheet2024, sheet2025];
