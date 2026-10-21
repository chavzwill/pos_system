# Total Tools presentation system

The selected reference is 12ui candidate B from hosted run crt-78e6badbcf8088781274e0ea365aa35b74141629. Operations and supporting views were expanded from that reference. Generated exports are design references; production data, totals and actions continue to use the certified modules.

Active layers: ui-tokens.css (brand, type, spacing), ui-workspaces.css (structural workspace layouts plus shared primitives and Guide Me), app-shell.css (neutral shell). All module loaders resolve to the same preloaded workspace bundle. Old feature CSS files remain historical source references and are not loaded by the active native shell. The identity, meeting/demo, workspace-quality and unified override layers are retired from that shell.

The structural bundle retains responsive layout and visibility rules from existing workflows, while removing their independent paint, typography, spacing and important overrides. Screen-level style injectors are retired; receipt/print styles are preserved.

ui-presentation.js mounts the existing module APIs into the shell, manages workspace close/navigation, labels otherwise unlabelled controls and provides modal keyboard containment/return. It does not implement transaction, stock, credit, approval or accounting logic. Receiving opens the existing fast-receiving module directly.

The implemented frontend at `d3fe9e4` passed all 91 source contract checks and all 34 focused browser checks. Browser coverage includes all twelve primary workspaces at 375, 390, 430, 768, 1024, 1280 and 1440 pixels, populated sales and receiving fixtures, keyboard dialogs, Guide Me and reduced motion. Original screenshots and asset manifests are retained in the Actions artifact. Final runtime certification and 12ui implementation alignment remain pending; no deployment has been performed.
