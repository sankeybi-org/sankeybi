# Security

SankeyBI makes no network requests, writes nothing to the user's device, requests no Power BI privileges (`"privileges": []`) and runs no code from report data. It never uses `eval` or `innerHTML`: text from the data is set as text, never parsed as markup.

Background pictures and node icons are checked for size and format (an SVG must start with an `<svg>` element; an icon must be a base64 SVG `data:` URL) and kept as `data:` URLs. They are drawn as images, and a browser neither runs scripts nor loads external files from an SVG shown that way. The SVG's own contents are not rewritten, so that guarantee comes from how it is drawn.

Layouts, node edits, flow type edits and the background picture are saved inside the report file. The only browser storage the visual touches is a read of a `localStorage` debug switch (`sankeybi.debug`), which it never writes.

To report a vulnerability, open a private security advisory on the repository.
