export const renderModule = (res, options) => res.render("module", {
  title: options.title,
  subtitle: options.subtitle || "",
  section: options.section || "",
  columns: options.columns || [],
  rows: options.rows || [],
  fields: options.fields || [],
  formAction: options.formAction || "",
  formTitle: options.formTitle || "Add record",
  showForm: Boolean(options.showForm),
  showTable: options.showTable !== false,
  showActions: options.showActions !== false,
  emptyText: options.emptyText || "No records found.",
  filters: options.filters || [],
  details: options.details || [],
  bulkAction: options.bulkAction || "",
  statusFormAction: options.statusFormAction || "",
  statusValue: options.statusValue || "",
  statusOptions: options.statusOptions || [],
  summaryLines: options.summaryLines || [],
  actions: options.actions || [],
  postActions: options.postActions || [],
  printable: Boolean(options.printable),
  canManage: Boolean(options.canManage)
});

export const makeFields = (spec, record = {}) => spec.map(([name, label, type, required = false, options = []]) => ({
  name,
  label,
  type,
  required,
  value: record[name] ?? "",
  options: options.map(option => ({
    value: typeof option === "string" ? option : option.value,
    label: typeof option === "string" ? option : option.label,
    selected: String(record[name] ?? "") === String(typeof option === "string" ? option : option.value)
  }))
}));
