# Receiving and invoice review improvements

Receiving shows ordered, previously received, outstanding and currently selected quantities together. Existing per-line receiving, traceability, actual receipt cost and separate retail approval remain authoritative.

Invoice matching supports delivery selection and item/SKU/receipt search without rerendering inputs. Hidden rows retain their selections and are included in the labelled total. The preview compares selected merchandise against the invoice's remaining merchandise amount, flags an excess, and disables allocation until a positive quantity is selected. A variance remains subject to existing server review rules; the UI does not declare it payment-cleared.

Captured and posted invoices show a direct accounting-state label. Allocation still calls only the existing evidence endpoint; posting remains a separate Finance action. No stock, AP or receiving endpoint behavior changes.

Five browser fixture cases cover three viewport widths, filtering and retained selections, variance feedback, allocation payload and failure recovery, receiving summaries and retained cost edits. These are UI checks; complete authenticated PO approval, partial receipt, invoice posting and reconciliation remains a separate verification task. No production business records were created by these checks.
