# Product SKU generation

Product creation offers **Use product number** or **Generate automatically** in
Products & Categories and the shared quick-create picker. The manual mode uses
the entered item number as the SKU; barcode and model number remain separate.
Automatic mode disables the manual field and allocates a code such as
`TT-000001` when saving. Switching modes retains the typed manual number.
Existing product edits never generate a replacement code.

The server accepts `auto_generate_sku: true` on POST /api/products or POST
/api/workspace-profile/catalog/items. A simultaneous manual SKU is rejected.
Legacy quick-create calls with no SKU retain their automatic behavior; ordinary
product API calls still require either a manual SKU or explicit automatic mode.

A database UPSERT counter allocates numbers across concurrent callers and both
entry points. Existing product and variation codes are checked without regard
to case or surrounding whitespace. An exact manual-create race is caught by
the product SKU unique constraint and retried with another generated code.
Other insert failures propagate. Numbers can have gaps and are not recycled
when generated products are deleted. This does not detect duplicate physical
products with different codes. After 1000 occupied candidates the allocator
returns an error; a later retry continues from the advanced sequence.

The sequence table is created lazily for automatic creation. Creation permissions
remain in the existing routes. Imports and manual editing retain their existing
SKU rules. Existing SKUs are not renumbered.

Validation covers concurrent allocation, existing product/variation collisions,
manual preservation, deletion, a simulated manual race and unrelated errors;
full-server API tests exercise both creation routes and eight concurrent saves.
Four browser cases cover both forms at desktop/phone widths and payloads. A
save-in-progress guard prevents repeated clicks while a request is pending; it
does not claim replay-safe product creation after an ambiguous network failure.
No dependencies or paid services are added. The accounting fix in PR #133 is
separate from this change.
