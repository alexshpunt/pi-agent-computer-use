# Window observation granularity

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

Choose the parts of a fresh window Read with the `image`, `ui` or `full` view. Omitting it keeps `full`. This choice applies only to fresh window reads, not displays, local refinement or temporal sequences.

| Mode | Fresh parts | Current input | Not available |
| --- | --- | --- | --- |
| full | Native UI tree and window PNG | Hints, tokens and window-image pixels | Nothing beyond the existing window contract |
| image | Window PNG, no accessibility walk | Window-image pixel targets | UI resources, hints and tokens |
| ui | Native UI tree, no screenshot | Current hints and tokens | Pixel targets, image guides and image detail |

The overview returns `granularity` and `captured:{image,ui}`. Omitted parts are absent, not cached substitutes. Native drivers can retain an older tree or screenshot context internally; the adapter does not expose those as current authority.

Each successful fresh read replaces that window's previous observation. An action consumes the current observation; refusal and uncertain delivery are not reasons to replay input. Classification does not consume or renew authority. Image-only reads follow the same window identity, access, cancellation and coordinate checks as full reads. Safe still allows only session-opened windows.

## Choose the smallest useful read

Start with full when learning a layout or identifying controls. Use image-only for a bounded visual loop whose regions and pixel targets are already understood:

Do not carry a full read's hints into an image-only read. Determine selection or completion from current pixels if the loop has no current UI resource. Stop on layout changes, uncertain state or an expired decision.

Use UI-only when current reported labels, values and supported native control actions are enough. Local `search` and `inspect` work without another native read. `scope`, `highlight` and `crop` need image data and refuse after UI-only reads. Current UI nodes have native-screen bounds where reported, not window-image bounds. Do not convert those bounds into pixel input.

Image-only accepts image guides but rejects UI query, walk limits and enabled hint labels. UI-only accepts UI query/walk limits but rejects hints and guides. Full keeps the existing controls. Invalid combinations fail explicitly rather than silently changing mode.

This avoids unnecessary capture work; it does not guarantee fresh paint, instant input or a fixed speedup. Temporal sequence frames remain read-only. See [the computer-use skill](../skills/computer-use/SKILL.md) for reaction loops.
