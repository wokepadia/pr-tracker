# Wireframe Reference

The canonical reviewer UI wireframe is the self-contained HTML file at the repo root:

- [Review Queue Wireframes (standalone).html](../Review%20Queue%20Wireframes%20%28standalone%29.html)

Use this HTML file directly as the source of truth for reviewer UI work. It preserves the interactive screen tabs, density controls, layout proportions, and annotations better than static PDF or image exports.

When implementing reviewer UI screens, open the HTML wireframe in a browser and compare against the relevant screen:

- Inbox lanes and quick peek: use the split queue / catch-up peek screen as the primary v1 reference.
- PR detail: use the catch-up detail and activity timeline screens as the primary v1 reference.

Do not treat screenshots or future exports as canonical unless the user explicitly replaces this HTML reference. Static exports may be useful for reviews, but the root HTML file remains the reference.
